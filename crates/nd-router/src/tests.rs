use crate::state::RouterState;
use crate::types::{ComboEntry, SaveAccountInput, SaveComboInput, SaveProviderInput};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn provider_input(id: &str, base_url: &str, models: &[&str]) -> SaveProviderInput {
    SaveProviderInput {
        id: Some(id.to_owned()),
        kind: Some("openai-compatible".to_owned()),
        name: Some(id.to_owned()),
        base_url: Some(base_url.to_owned()),
        models: Some(models.iter().map(|model| (*model).to_owned()).collect()),
        is_active: Some(true),
        priority: Some(0),
        api_key: None,
        clear_secret: false,
    }
}

fn combo_entry(provider_id: &str, model: &str) -> ComboEntry {
    ComboEntry {
        provider_id: provider_id.to_owned(),
        model: model.to_owned(),
        weight: None,
        account_id: None,
    }
}

fn combo_input(name: &str, strategy: &str, entries: Vec<ComboEntry>) -> SaveComboInput {
    SaveComboInput {
        id: Some(format!("combo-{name}")),
        name: name.to_owned(),
        strategy: Some(strategy.to_owned()),
        models: entries,
    }
}

async fn mock_upstream() -> (String, Arc<Mutex<Vec<String>>>) {
    let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let handler_calls = Arc::clone(&calls);
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |Json(body): Json<Value>| {
            let calls = Arc::clone(&handler_calls);
            async move {
                let model = body.get("model").and_then(Value::as_str).unwrap_or_default().to_owned();
                calls.lock().unwrap().push(model.clone());
                if model == "fail" {
                    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "boom"})))
                } else {
                    (
                        StatusCode::OK,
                        Json(json!({
                            "id": "mock",
                            "model": model,
                            "choices": [{"message": {"role": "assistant", "content": "pong"}}],
                        })),
                    )
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind mock upstream");
    let address = listener.local_addr().expect("mock address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{address}"), calls)
}

#[test]
fn persists_providers_without_exposing_secrets() {
    let temp = tempfile::tempdir().expect("tempdir");
    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    let mut input = provider_input("free-lane", "http://127.0.0.1:8326", &["model-a"]);
    input.api_key = Some("sk-router-test-secret".to_owned());
    state.save_provider(input).expect("save provider");

    let snapshot = state.snapshot().to_string();
    assert!(snapshot.contains("\"hasSecret\":true"));
    assert!(!snapshot.contains("sk-router-test-secret"));
    assert!(!snapshot.contains("secretRef"));

    let reloaded = RouterState::new(temp.path().to_path_buf()).expect("reload");
    let value = reloaded.snapshot();
    assert_eq!(value["providers"][0]["id"], "free-lane");
    assert_eq!(value["providers"][0]["hasSecret"], true);
}

#[test]
fn resolves_priority_and_round_robin_combos() {
    let temp = tempfile::tempdir().expect("tempdir");
    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state.save_provider(provider_input("p1", "http://127.0.0.1:9001", &["m1"])).expect("p1");
    state.save_provider(provider_input("p2", "http://127.0.0.1:9002", &["m2"])).expect("p2");

    state.save_combo(combo_input("priority", "priority", vec![combo_entry("p1", "m1"), combo_entry("p2", "m2")])).expect("combo");
    let (_, entries) = state.resolve(Some("priority"), None).expect("resolve priority");
    let providers: Vec<&str> = entries.iter().map(|entry| entry.provider.id.as_str()).collect();
    assert_eq!(providers, vec!["p1", "p2"]);

    state.save_combo(combo_input("rr", "round-robin", vec![combo_entry("p1", "m1"), combo_entry("p2", "m2")])).expect("rr");
    let (_, first) = state.resolve(Some("rr"), None).expect("first");
    let (_, second) = state.resolve(Some("rr"), None).expect("second");
    assert_eq!(first[0].provider.id, "p1");
    assert_eq!(second[0].provider.id, "p2");
}

#[tokio::test]
async fn retries_the_next_lane_on_retryable_upstream_failure() {
    let temp = tempfile::tempdir().expect("tempdir");
    let (base_url, calls) = mock_upstream().await;
    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state.save_provider(provider_input("primary", &base_url, &["fail"])).expect("primary");
    state.save_provider(provider_input("backup", &base_url, &["ok"])).expect("backup");
    state
        .save_combo(combo_input("free", "priority", vec![combo_entry("primary", "fail"), combo_entry("backup", "ok")]))
        .expect("combo");

    let response = state
        .chat(
            json!({"model": "free", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
        )
        .await
        .expect("chat");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
    let value: Value = serde_json::from_slice(&bytes).expect("json");
    assert_eq!(value["model"], "ok");
    assert_eq!(calls.lock().unwrap().as_slice(), ["fail", "ok"]);

    let usage = state.usage_summary();
    assert_eq!(usage["requests"], 2);
    assert_eq!(usage["ok"], 1);
    assert_eq!(usage["failed"], 1);
}

#[tokio::test]
async fn does_not_fall_back_on_auth_failures() {
    let temp = tempfile::tempdir().expect("tempdir");
    let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let handler_calls = Arc::clone(&calls);
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |Json(_body): Json<Value>| {
            let calls = Arc::clone(&handler_calls);
            async move {
                calls.lock().unwrap().push("auth".to_owned());
                (StatusCode::UNAUTHORIZED, Json(json!({"error": "bad key"})))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    let address = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state.save_provider(provider_input("auth", &format!("http://{address}"), &["m"])).expect("p1");
    state.save_provider(provider_input("healthy", &format!("http://{address}"), &["m"])).expect("p2");
    state
        .save_combo(combo_input("strict", "priority", vec![combo_entry("auth", "m"), combo_entry("healthy", "m")]))
        .expect("combo");

    let error = state
        .chat(json!({"model": "strict", "messages": [{"role": "user", "content": "hi"}]}), None, "/v1/chat/completions")
        .await
        .expect_err("auth failure must stop the chain");
    assert_eq!(error.status, StatusCode::UNAUTHORIZED);
    assert_eq!(calls.lock().unwrap().as_slice(), ["auth"]);
}

/// The ND_AGY_BIN override is process-global, so agy-lane tests serialize on
/// this lock while it is set.
static AGY_ENV_LOCK: Mutex<()> = Mutex::new(());

fn antigravity_input(id: &str, models: &[&str]) -> SaveProviderInput {
    SaveProviderInput {
        id: Some(id.to_owned()),
        kind: Some("antigravity".to_owned()),
        name: Some("Antigravity".to_owned()),
        base_url: None,
        models: Some(models.iter().map(|model| (*model).to_owned()).collect()),
        is_active: Some(true),
        priority: Some(0),
        api_key: None,
        clear_secret: false,
    }
}

fn cli_account(provider_id: &str, selector: &str) -> SaveAccountInput {
    SaveAccountInput {
        provider_id: provider_id.to_owned(),
        id: None,
        label: selector.to_owned(),
        kind: Some("cli".to_owned()),
        api_key: None,
        env_dir: None,
        selector: Some(selector.to_owned()),
        is_active: Some(true),
        priority: Some(0),
        clear_secret: false,
    }
}

fn write_agy_stub(dir: &std::path::Path) -> std::path::PathBuf {
    let stub = dir.join("agy-stub.cmd");
    std::fs::write(
        &stub,
        "@echo off\r\necho {\"conversation_id\":\"stub\",\"status\":\"SUCCESS\",\"response\":\"acct:%AGY_ACCOUNT%\",\"duration_seconds\":1.5,\"num_turns\":1,\"usage\":{\"input_tokens\":11,\"output_tokens\":3,\"total_tokens\":14}}\r\n",
    )
    .expect("write stub");
    stub
}

#[tokio::test]
async fn antigravity_lane_runs_the_cli_with_the_account_selector() {
    let _env = AGY_ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let stub = write_agy_stub(temp.path());
    // Test-only override, serialized by AGY_ENV_LOCK.
    unsafe { std::env::set_var("ND_AGY_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state.save_provider(antigravity_input("agy", &["stub-model"])).expect("provider");
    state.save_account(cli_account("agy", "account-1")).expect("account");
    state
        .save_combo(combo_input("free-agy", "priority", vec![combo_entry("agy", "stub-model")]))
        .expect("combo");

    let response = state
        .chat(
            json!({"model": "free-agy", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
        )
        .await
        .expect("chat");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
    let value: Value = serde_json::from_slice(&bytes).expect("json");
    assert_eq!(value["model"], "stub-model");
    assert_eq!(value["choices"][0]["message"]["content"], "acct:account-1");
    assert_eq!(value["usage"]["prompt_tokens"], 11);
    assert_eq!(value["usage"]["total_tokens"], 14);

    let usage = state.usage_summary();
    assert_eq!(usage["ok"], 1);

    unsafe { std::env::remove_var("ND_AGY_BIN") };
}

#[tokio::test]
async fn antigravity_lane_streams_sse() {
    let _env = AGY_ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let stub = write_agy_stub(temp.path());
    unsafe { std::env::set_var("ND_AGY_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state.save_provider(antigravity_input("agy", &["stub-model"])).expect("provider");
    state
        .save_combo(combo_input("stream-agy", "priority", vec![combo_entry("agy", "stub-model")]))
        .expect("combo");

    let response = state
        .chat(
            json!({"model": "stream-agy", "messages": [{"role": "user", "content": "hi"}], "stream": true}),
            None,
            "/v1/chat/completions",
        )
        .await
        .expect("chat");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get("content-type").and_then(|value| value.to_str().ok()),
        Some("text/event-stream")
    );
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("body");
    let text = String::from_utf8(bytes.to_vec()).expect("utf8");
    assert!(text.contains("acct:"));
    assert!(text.contains("data: [DONE]"));

    unsafe { std::env::remove_var("ND_AGY_BIN") };
}

#[tokio::test]
async fn antigravity_test_provider_runs_the_cli() {
    let _env = AGY_ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let stub = write_agy_stub(temp.path());
    unsafe { std::env::set_var("ND_AGY_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state.save_provider(antigravity_input("agy", &["stub-model"])).expect("provider");
    let result = state.test_provider("agy").await.expect("test");
    assert_eq!(result["ok"], true);
    assert_eq!(result["statusCode"], 200);

    unsafe { std::env::remove_var("ND_AGY_BIN") };
}

#[test]
fn antigravity_prompt_flattens_messages_with_roles() {
    let prompt = crate::cli::prompt_from_messages(&[
        json!({"role": "system", "content": "Be terse."}),
        json!({"role": "user", "content": "hello"}),
        json!({"role": "assistant", "content": "hi"}),
        json!({"role": "user", "content": [{"type": "text", "text": "bye"}]}),
    ]);
    assert_eq!(prompt, "System: Be terse.\n\nUser: hello\n\nAssistant: hi\n\nUser: bye");
    let single = crate::cli::prompt_from_messages(&[json!({"role": "user", "content": "just this"})]);
    assert_eq!(single, "just this");
}
