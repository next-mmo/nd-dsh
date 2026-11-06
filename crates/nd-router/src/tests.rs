use crate::RouterServer;
use crate::state::{RouterOptions, RouterState};
use crate::types::{
    ComboEntry, CreateAgyApprovalInput, SaveAccountInput, SaveComboInput, SaveProviderInput,
    SetAgyEnabledInput, SetAgyPolicyInput, WebBridgeConfig,
};
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
        hidden_from_chat: None,
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
                let model = body
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                calls.lock().unwrap().push(model.clone());
                if model == "fail" {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({"error": "boom"})),
                    )
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
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind mock upstream");
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
    state
        .save_provider(provider_input("p1", "http://127.0.0.1:9001", &["m1"]))
        .expect("p1");
    state
        .save_provider(provider_input("p2", "http://127.0.0.1:9002", &["m2"]))
        .expect("p2");

    state
        .save_combo(combo_input(
            "priority",
            "priority",
            vec![combo_entry("p1", "m1"), combo_entry("p2", "m2")],
        ))
        .expect("combo");
    let (_, entries) = state
        .resolve(Some("priority"), None)
        .expect("resolve priority");
    let providers: Vec<&str> = entries
        .iter()
        .map(|entry| entry.provider.id.as_str())
        .collect();
    assert_eq!(providers, vec!["p1", "p2"]);

    state
        .save_combo(combo_input(
            "rr",
            "round-robin",
            vec![combo_entry("p1", "m1"), combo_entry("p2", "m2")],
        ))
        .expect("rr");
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
    state
        .save_provider(provider_input("primary", &base_url, &["fail"]))
        .expect("primary");
    state
        .save_provider(provider_input("backup", &base_url, &["ok"]))
        .expect("backup");
    state
        .save_combo(combo_input(
            "free",
            "priority",
            vec![combo_entry("primary", "fail"), combo_entry("backup", "ok")],
        ))
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
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let value: Value = serde_json::from_slice(&bytes).expect("json");
    assert_eq!(value["model"], "ok");
    assert_eq!(calls.lock().unwrap().as_slice(), ["fail", "ok"]);

    let usage = state.usage_summary();
    assert_eq!(usage["requests"], 2);
    assert_eq!(usage["ok"], 1);
    assert_eq!(usage["failed"], 1);
}

async fn mock_web_bridge() -> (String, String, Arc<Mutex<Vec<(Option<String>, Value)>>>) {
    let calls: Arc<Mutex<Vec<(Option<String>, Value)>>> = Arc::new(Mutex::new(Vec::new()));
    let token = "ndr_bridge_test".to_owned();
    let handler_calls = Arc::clone(&calls);
    let handler_token = token.clone();
    let app = Router::new().route(
        "/v1/web/chat",
        post(
            move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                let calls = Arc::clone(&handler_calls);
                let expected = format!("Bearer {handler_token}");
                async move {
                    let request_id = headers
                        .get("x-nd-request-id")
                        .and_then(|value| value.to_str().ok())
                        .map(ToOwned::to_owned);
                    calls.lock().unwrap().push((request_id, body.clone()));
                    let authorized = headers
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        == Some(expected.as_str());
                    if !authorized {
                        return (
                            StatusCode::UNAUTHORIZED,
                            Json(json!({"error": "bad bridge token"})),
                        );
                    }
                    let engine = body
                        .get("engine")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    let model = body
                        .get("model")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    (
                        StatusCode::OK,
                        Json(json!({
                            "ok": true,
                            "text": "web pong",
                            "engineId": engine,
                            "model": model,
                            "latencyMs": 1,
                        })),
                    )
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind web bridge");
    let address = listener.local_addr().expect("web bridge address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{address}"), token, calls)
}

fn web_provider_input(id: &str, kind: &str, models: &[&str]) -> SaveProviderInput {
    SaveProviderInput {
        id: Some(id.to_owned()),
        kind: Some(kind.to_owned()),
        name: Some(id.to_owned()),
        base_url: None,
        models: Some(models.iter().map(|model| (*model).to_owned()).collect()),
        is_active: Some(true),
        priority: Some(0),
        api_key: None,
        clear_secret: false,
    }
}

#[tokio::test]
async fn routes_web_lanes_through_the_bridge_and_keeps_web_combos_private() {
    let temp = tempfile::tempdir().expect("tempdir");
    let (bridge_url, bridge_token, calls) = mock_web_bridge().await;
    let state = RouterState::with_options(
        temp.path().to_path_buf(),
        RouterOptions {
            external_key: Some("ndr_ext_test_external_key_1234".to_owned()),
            web_bridge: Some(WebBridgeConfig {
                url: bridge_url,
                token: bridge_token,
            }),
            safe_mode: false,
            preferred_port: None,
            seed_defaults: false,
        },
    )
    .expect("state");
    state
        .save_provider(web_provider_input(
            "chatgpt-web",
            "chatgpt-web",
            &["default"],
        ))
        .expect("web provider");
    state
        .save_combo(combo_input(
            "web",
            "priority",
            vec![combo_entry("chatgpt-web", "default")],
        ))
        .expect("web combo");

    let snapshot = state.snapshot();
    assert_eq!(
        snapshot["combos"][0]["hiddenFromChat"].as_bool(),
        Some(true)
    );
    assert_eq!(snapshot["providers"][0]["models"][0], "default");
    assert!(state.accepts_key("ndr_ext_test_external_key_1234"));
    assert!(!state.accepts_key("ndr_ext_wrong_key_1234567890"));
    state
        .set_external_key("ndr_ext_rotated_key_123456")
        .expect("rotate key");
    assert!(state.accepts_key("ndr_ext_rotated_key_123456"));
    assert!(state.set_external_key("not-a-router-key").is_err());

    let response = state
        .chat_with_request(
            json!({"model": "web", "messages": [{"role": "user", "content": "hello web"}]}),
            None,
            "/v1/chat/completions",
            Some("req-web-1"),
            None,
        )
        .await
        .expect("web chat");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("x-nd-router-provider")
            .and_then(|value| value.to_str().ok()),
        Some("chatgpt-web")
    );
    assert_eq!(
        response
            .headers()
            .get("x-nd-router-model")
            .and_then(|value| value.to_str().ok()),
        Some("default")
    );
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let value: Value = serde_json::from_slice(&bytes).expect("json");
    assert_eq!(value["choices"][0]["message"]["content"], "web pong");

    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0.as_deref(), Some("req-web-1"));
    assert_eq!(calls[0].1["engine"], "chatgpt-web");
    assert_eq!(calls[0].1["prompt"], "hello web");
}

#[tokio::test]
async fn routes_deepseek_web_with_seeded_modes_through_the_bridge() {
    let temp = tempfile::tempdir().expect("tempdir");
    let (bridge_url, bridge_token, calls) = mock_web_bridge().await;
    let state = RouterState::with_options(
        temp.path().to_path_buf(),
        RouterOptions {
            external_key: Some("ndr_ext_test_external_key_1234".to_owned()),
            web_bridge: Some(WebBridgeConfig {
                url: bridge_url,
                token: bridge_token,
            }),
            safe_mode: false,
            preferred_port: None,
            seed_defaults: false,
        },
    )
    .expect("state");
    let saved = state
        .save_provider(SaveProviderInput {
            id: Some("deepseek-web".to_owned()),
            kind: Some("deepseek".to_owned()),
            name: None,
            base_url: None,
            models: None,
            is_active: Some(true),
            priority: Some(0),
            api_key: None,
            clear_secret: false,
        })
        .expect("deepseek provider");
    assert_eq!(saved["name"], "DeepSeek Web");
    assert_eq!(saved["kind"], "deepseek-web");
    assert_eq!(saved["models"], json!(["default", "deep-think"]));

    state
        .save_combo(combo_input(
            "deepseek",
            "priority",
            vec![combo_entry("deepseek-web", "deep-think")],
        ))
        .expect("deepseek combo");
    let response = state
        .chat_with_request(
            json!({"model": "deepseek", "messages": [{"role": "user", "content": "hello deepseek"}]}),
            None,
            "/v1/chat/completions",
            Some("req-deepseek-1"),
            None,
        )
        .await
        .expect("deepseek chat");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("x-nd-router-provider")
            .and_then(|value| value.to_str().ok()),
        Some("deepseek-web")
    );
    assert_eq!(
        response
            .headers()
            .get("x-nd-router-model")
            .and_then(|value| value.to_str().ok()),
        Some("deep-think")
    );

    let direct = state
        .chat_with_request(
            json!({"model": "deepseek-web/default", "messages": [{"role": "user", "content": "direct route"}]}),
            None,
            "/v1/chat/completions",
            Some("req-deepseek-2"),
            None,
        )
        .await
        .expect("direct deepseek chat");
    assert_eq!(
        direct
            .headers()
            .get("x-nd-router-provider")
            .and_then(|value| value.to_str().ok()),
        Some("deepseek-web")
    );
    assert_eq!(
        direct
            .headers()
            .get("x-nd-router-combo")
            .and_then(|value| value.to_str().ok()),
        Some("direct")
    );

    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].1["engine"], "deepseek-web");
    assert_eq!(calls[0].1["model"], "deep-think");
    assert_eq!(calls[0].1["prompt"], "hello deepseek");
    assert_eq!(calls[1].1["engine"], "deepseek-web");
    assert_eq!(calls[1].1["model"], "default");
    assert_eq!(calls[1].1["prompt"], "direct route");
}

#[tokio::test]
async fn routes_additional_web_lanes_through_the_bridge() {
    let temp = tempfile::tempdir().expect("tempdir");
    let (bridge_url, bridge_token, calls) = mock_web_bridge().await;
    let state = RouterState::with_options(
        temp.path().to_path_buf(),
        RouterOptions {
            external_key: Some("ndr_ext_test_external_key_1234".to_owned()),
            web_bridge: Some(WebBridgeConfig {
                url: bridge_url,
                token: bridge_token,
            }),
            safe_mode: false,
            preferred_port: None,
            seed_defaults: false,
        },
    )
    .expect("state");

    let kinds = [
        ("qwen-web", "Qwen Web", "qwen-max"),
        ("zai-web", "Z.ai Web", "glm-4-plus"),
        ("mistral-web", "Mistral Web", "mistral-large"),
        ("perplexity-web", "Perplexity Web", "sonar"),
        ("poe-web", "Poe Web", "assistant"),
        ("arena-web", "Arena AI Web", "battle"),
        ("meta-web", "Meta AI Web", "llama-3.3"),
        ("duck-web", "Duck.ai Web", "gpt-4o-mini"),
    ];

    for (kind, expected_name, sample_model) in kinds {
        let saved = state
            .save_provider(SaveProviderInput {
                id: Some(kind.to_owned()),
                kind: Some(kind.to_owned()),
                name: None,
                base_url: None,
                models: None,
                is_active: Some(true),
                priority: Some(0),
                api_key: None,
                clear_secret: false,
            })
            .expect("save provider");
        assert_eq!(saved["name"], expected_name);
        assert_eq!(saved["kind"], kind);
        assert!(
            saved["models"]
                .as_array()
                .unwrap()
                .contains(&json!(sample_model))
        );

        let response = state
            .chat_with_request(
                json!({"model": format!("{kind}/{sample_model}"), "messages": [{"role": "user", "content": "hello"}]}),
                None,
                "/v1/chat/completions",
                Some(&format!("req-{kind}")),
                None,
            )
            .await
            .expect("chat");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("x-nd-router-provider")
                .and_then(|v| v.to_str().ok()),
            Some(kind)
        );
        assert_eq!(
            response
                .headers()
                .get("x-nd-router-model")
                .and_then(|v| v.to_str().ok()),
            Some(sample_model)
        );
    }

    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 8);
    assert_eq!(calls[0].1["engine"], "qwen-web");
    assert_eq!(calls[7].1["engine"], "duck-web");
}

#[tokio::test]
async fn routes_grok_web_with_seeded_modes_through_the_bridge() {
    let temp = tempfile::tempdir().expect("tempdir");
    let (bridge_url, bridge_token, calls) = mock_web_bridge().await;
    let state = RouterState::with_options(
        temp.path().to_path_buf(),
        RouterOptions {
            external_key: Some("ndr_ext_test_external_key_1234".to_owned()),
            web_bridge: Some(WebBridgeConfig {
                url: bridge_url,
                token: bridge_token,
            }),
            safe_mode: false,
            preferred_port: None,
            seed_defaults: false,
        },
    )
    .expect("state");
    let saved = state
        .save_provider(SaveProviderInput {
            id: Some("grok-web".to_owned()),
            kind: Some("grok".to_owned()),
            name: None,
            base_url: None,
            models: None,
            is_active: Some(true),
            priority: Some(0),
            api_key: None,
            clear_secret: false,
        })
        .expect("grok provider");
    assert_eq!(saved["name"], "Grok Web");
    assert_eq!(saved["kind"], "grok-web");
    assert_eq!(
        saved["models"],
        json!(["default", "grok-3", "grok-2", "deepsearch", "think"])
    );

    state
        .save_combo(combo_input(
            "grok",
            "priority",
            vec![combo_entry("grok-web", "think")],
        ))
        .expect("grok combo");
    let response = state
        .chat_with_request(
            json!({"model": "grok", "messages": [{"role": "user", "content": "hello grok"}]}),
            None,
            "/v1/chat/completions",
            Some("req-grok-1"),
            None,
        )
        .await
        .expect("grok chat");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("x-nd-router-provider")
            .and_then(|value| value.to_str().ok()),
        Some("grok-web")
    );
    assert_eq!(
        response
            .headers()
            .get("x-nd-router-model")
            .and_then(|value| value.to_str().ok()),
        Some("think")
    );

    let direct = state
        .chat_with_request(
            json!({"model": "grok-web/default", "messages": [{"role": "user", "content": "direct route"}]}),
            None,
            "/v1/chat/completions",
            Some("req-grok-2"),
            None,
        )
        .await
        .expect("direct grok chat");
    assert_eq!(
        direct
            .headers()
            .get("x-nd-router-provider")
            .and_then(|value| value.to_str().ok()),
        Some("grok-web")
    );
    assert_eq!(
        direct
            .headers()
            .get("x-nd-router-combo")
            .and_then(|value| value.to_str().ok()),
        Some("direct")
    );

    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].1["engine"], "grok-web");
    assert_eq!(calls[0].1["model"], "think");
    assert_eq!(calls[0].1["prompt"], "hello grok");
    assert_eq!(calls[1].1["engine"], "grok-web");
    assert_eq!(calls[1].1["model"], "default");
    assert_eq!(calls[1].1["prompt"], "direct route");
}

#[tokio::test]
async fn safe_mode_locks_external_auth_and_web_lanes_but_keeps_internal_routing() {
    let temp = tempfile::tempdir().expect("tempdir");
    let (bridge_url, bridge_token, calls) = mock_web_bridge().await;
    let state = RouterState::with_options(
        temp.path().to_path_buf(),
        RouterOptions {
            external_key: Some("ndr_ext_test_external_key_1234".to_owned()),
            web_bridge: Some(WebBridgeConfig {
                url: bridge_url,
                token: bridge_token,
            }),
            safe_mode: false,
            preferred_port: None,
            seed_defaults: false,
        },
    )
    .expect("state");
    state
        .save_provider(web_provider_input(
            "chatgpt-web",
            "chatgpt-web",
            &["default"],
        ))
        .expect("web provider");
    state
        .save_provider(provider_input("api", "http://127.0.0.1:9", &["model"]))
        .expect("api provider");
    state
        .save_combo(combo_input(
            "mixed",
            "priority",
            vec![
                combo_entry("chatgpt-web", "default"),
                combo_entry("api", "model"),
            ],
        ))
        .expect("combo");
    assert!(state.accepts_key("ndr_ext_test_external_key_1234"));
    assert_eq!(state.safe_mode_enabled(), false);

    state.set_safe_mode(true);
    assert!(state.accepts_key(&state.key().to_owned()));
    assert!(!state.accepts_key("ndr_ext_test_external_key_1234"));
    assert_eq!(state.snapshot()["safeMode"].as_bool(), Some(true));

    let web_only = state
        .chat_with_request(
            json!({"model": "chatgpt-web/default", "messages": [{"role": "user", "content": "blocked"}]}),
            None,
            "/v1/chat/completions",
            Some("req-safe-web"),
            None,
        )
        .await
        .expect_err("web lane must be blocked");
    assert_eq!(web_only.status, StatusCode::FORBIDDEN);
    assert_eq!(calls.lock().unwrap().len(), 0);

    let test = state
        .test_provider("chatgpt-web")
        .await
        .expect("provider test");
    assert_eq!(test["ok"], false);
    assert_eq!(test["statusCode"], 403);
    assert!(
        test["error"]
            .as_str()
            .unwrap_or_default()
            .contains("Safe Mode")
    );

    state.set_safe_mode(false);
    assert!(state.accepts_key("ndr_ext_test_external_key_1234"));
    assert_eq!(state.snapshot()["safeMode"].as_bool(), Some(false));
}

#[tokio::test]
async fn an_explicit_visible_override_keeps_a_web_combo_in_chat() {
    let temp = tempfile::tempdir().expect("tempdir");
    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(web_provider_input(
            "gemini-web",
            "gemini-web",
            &["3.5 Flash-Lite"],
        ))
        .expect("web provider");
    let mut input = combo_input(
        "web-visible",
        "priority",
        vec![combo_entry("gemini-web", "3.5 Flash-Lite")],
    );
    input.hidden_from_chat = Some(false);
    state.save_combo(input).expect("combo");
    assert_eq!(
        state.snapshot()["combos"][0]["hiddenFromChat"].as_bool(),
        Some(false)
    );
}

#[test]
fn preferred_port_falls_back_when_occupied() {
    let occupied = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("occupied listener");
    let port = occupied.local_addr().expect("occupied address").port();
    let temp = tempfile::tempdir().expect("tempdir");
    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    let server = RouterServer::start(Arc::clone(&state), port).expect("router server");
    assert_ne!(server.port, port);
    assert!(server.port > 0);
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
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind");
    let address = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(provider_input("auth", &format!("http://{address}"), &["m"]))
        .expect("p1");
    state
        .save_provider(provider_input(
            "healthy",
            &format!("http://{address}"),
            &["m"],
        ))
        .expect("p2");
    state
        .save_combo(combo_input(
            "strict",
            "priority",
            vec![combo_entry("auth", "m"), combo_entry("healthy", "m")],
        ))
        .expect("combo");

    let error = state
        .chat(
            json!({"model": "strict", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
        )
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

/// A stub whose status string names the failure the classifier should catch.
fn write_agy_failure_stub(dir: &std::path::Path, status: &str) -> std::path::PathBuf {
    let stub = dir.join("agy-stub-failure.cmd");
    std::fs::write(
        &stub,
        format!(
            "@echo off\r\necho {{\"status\":\"{status}\",\"response\":\"\",\"usage\":{{}}}}\r\n"
        ),
    )
    .expect("write stub");
    stub
}

fn enable_agy(state: &RouterState) {
    state
        .set_agy_policy(SetAgyPolicyInput {
            enabled: Some(true),
            manual_approval_required: None,
            max_concurrent_jobs: None,
            max_jobs_per_hour: None,
            max_jobs_per_day: None,
            max_tokens_per_day: None,
            approval_ttl_secs: None,
        })
        .expect("enable agy");
}

fn agy_approval(state: &RouterState) -> String {
    let result = state
        .create_agy_approval(CreateAgyApprovalInput {
            category: "coding".to_owned(),
        })
        .expect("approval");
    result["token"].as_str().expect("token").to_owned()
}

#[tokio::test]
async fn antigravity_lane_runs_the_cli_with_the_account_selector() {
    let _env = AGY_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let stub = write_agy_stub(temp.path());
    // Test-only override, serialized by AGY_ENV_LOCK.
    unsafe { std::env::set_var("ND_AGY_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(antigravity_input("agy", &["stub-model"]))
        .expect("provider");
    state
        .save_account(cli_account("agy", "account-1"))
        .expect("account");
    state
        .save_combo(combo_input(
            "free-agy",
            "priority",
            vec![combo_entry("agy", "stub-model")],
        ))
        .expect("combo");
    enable_agy(&state);
    let approval = agy_approval(&state);

    let response = state
        .chat_with_request(
            json!({"model": "free-agy", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
            None,
            Some(&approval),
        )
        .await
        .expect("chat");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let value: Value = serde_json::from_slice(&bytes).expect("json");
    assert_eq!(value["model"], "stub-model");
    assert_eq!(value["choices"][0]["message"]["content"], "acct:account-1");
    assert_eq!(value["usage"]["prompt_tokens"], 11);
    assert_eq!(value["usage"]["total_tokens"], 14);

    let usage = state.usage_summary();
    assert_eq!(usage["ok"], 1);
    let agy = state.agy_usage_summary();
    assert_eq!(agy["summary"]["ok"], 1);
    assert_eq!(agy["summary"]["byCategory"]["coding"], 1);

    unsafe { std::env::remove_var("ND_AGY_BIN") };
}

#[tokio::test]
async fn antigravity_lane_streams_sse() {
    let _env = AGY_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let stub = write_agy_stub(temp.path());
    unsafe { std::env::set_var("ND_AGY_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(antigravity_input("agy", &["stub-model"]))
        .expect("provider");
    state
        .save_combo(combo_input(
            "stream-agy",
            "priority",
            vec![combo_entry("agy", "stub-model")],
        ))
        .expect("combo");
    enable_agy(&state);
    let approval = agy_approval(&state);

    let response = state
        .chat_with_request(
            json!({"model": "stream-agy", "messages": [{"role": "user", "content": "hi"}], "stream": true}),
            None,
            "/v1/chat/completions",
            None,
            Some(&approval),
        )
        .await
        .expect("chat");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("text/event-stream")
    );
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let text = String::from_utf8(bytes.to_vec()).expect("utf8");
    assert!(text.contains("acct:"));
    assert!(text.contains("data: [DONE]"));

    unsafe { std::env::remove_var("ND_AGY_BIN") };
}

#[tokio::test]
async fn antigravity_test_provider_runs_the_cli() {
    let _env = AGY_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let stub = write_agy_stub(temp.path());
    unsafe { std::env::set_var("ND_AGY_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(antigravity_input("agy", &["stub-model"]))
        .expect("provider");
    enable_agy(&state);
    let result = state.test_provider("agy").await.expect("test");
    assert_eq!(result["ok"], true);
    assert_eq!(result["statusCode"], 200);

    unsafe { std::env::remove_var("ND_AGY_BIN") };
}

#[test]
fn agy_failure_classification_separates_quota_auth_and_policy_errors() {
    use crate::agy_policy::{AgyCategory, AgyFailureClass, classify_agy_failure};

    assert_eq!(
        classify_agy_failure("Quota exceeded for this week"),
        AgyFailureClass::Quota
    );
    assert_eq!(
        classify_agy_failure("HTTP 429 too many requests"),
        AgyFailureClass::Quota
    );
    assert_eq!(
        classify_agy_failure("Authentication failed: signed out"),
        AgyFailureClass::Auth
    );
    assert_eq!(
        classify_agy_failure("403 Forbidden: terms of service"),
        AgyFailureClass::Policy
    );
    assert_eq!(
        classify_agy_failure("network is unreachable"),
        AgyFailureClass::Other
    );

    assert_eq!(AgyCategory::parse("dev"), Some(AgyCategory::Coding));
    assert_eq!(
        AgyCategory::parse("translation"),
        Some(AgyCategory::Translation)
    );
    assert_eq!(AgyCategory::parse("test"), Some(AgyCategory::Test));
    assert_eq!(AgyCategory::parse("unclassified"), None);
}

#[tokio::test]
async fn antigravity_lane_is_disabled_by_default() {
    let _env = AGY_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let stub = write_agy_stub(temp.path());
    unsafe { std::env::set_var("ND_AGY_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(antigravity_input("agy", &["stub-model"]))
        .expect("provider");
    state
        .save_combo(combo_input(
            "agy-only",
            "priority",
            vec![combo_entry("agy", "stub-model")],
        ))
        .expect("combo");

    let error = state
        .chat(
            json!({"model": "agy-only", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
        )
        .await
        .expect_err("disabled lane must not run");
    assert_eq!(error.status, StatusCode::FORBIDDEN);
    assert!(error.message.contains("disabled"), "{}", error.message);

    let agy = state.agy_usage_summary();
    assert_eq!(agy["summary"]["failed"], 1);
    assert_eq!(agy["recent"][0]["blockCode"], "agy_disabled");

    let snapshot = state.snapshot();
    let agy_provider = snapshot["providers"]
        .as_array()
        .and_then(|p| p.iter().find(|item| item["id"] == "agy"))
        .expect("agy provider in snapshot");
    assert_eq!(agy_provider["isActive"], false);

    state
        .set_agy_policy(crate::types::SetAgyPolicyInput {
            enabled: Some(true),
            manual_approval_required: None,
            max_concurrent_jobs: None,
            max_jobs_per_hour: None,
            max_jobs_per_day: None,
            max_tokens_per_day: None,
            approval_ttl_secs: None,
        })
        .expect("set agy policy");
    let enabled_snapshot = state.snapshot();
    let agy_enabled = enabled_snapshot["providers"]
        .as_array()
        .and_then(|p| p.iter().find(|item| item["id"] == "agy"))
        .expect("agy provider in snapshot");
    assert_eq!(agy_enabled["isActive"], true);

    unsafe { std::env::remove_var("ND_AGY_BIN") };
}

#[tokio::test]
async fn antigravity_lane_requires_a_manual_approval() {
    let _env = AGY_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let stub = write_agy_stub(temp.path());
    unsafe { std::env::set_var("ND_AGY_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(antigravity_input("agy", &["stub-model"]))
        .expect("provider");
    state
        .save_combo(combo_input(
            "agy-only",
            "priority",
            vec![combo_entry("agy", "stub-model")],
        ))
        .expect("combo");
    enable_agy(&state);

    let error = state
        .chat(
            json!({"model": "agy-only", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
        )
        .await
        .expect_err("unapproved request must not run");
    assert_eq!(error.status, StatusCode::FORBIDDEN);
    assert!(error.message.contains("approval"), "{}", error.message);

    let bogus = state
        .chat_with_request(
            json!({"model": "agy-only", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
            None,
            Some("agy_ap_not-a-real-token"),
        )
        .await
        .expect_err("invalid approval must not run");
    assert_eq!(bogus.status, StatusCode::FORBIDDEN);
    assert!(
        bogus.message.contains("invalid or expired"),
        "{}",
        bogus.message
    );

    unsafe { std::env::remove_var("ND_AGY_BIN") };
}

#[tokio::test]
async fn antigravity_approval_is_single_use() {
    let _env = AGY_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let stub = write_agy_stub(temp.path());
    unsafe { std::env::set_var("ND_AGY_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(antigravity_input("agy", &["stub-model"]))
        .expect("provider");
    state
        .save_combo(combo_input(
            "agy-only",
            "priority",
            vec![combo_entry("agy", "stub-model")],
        ))
        .expect("combo");
    enable_agy(&state);
    let approval = agy_approval(&state);

    let first = state
        .chat_with_request(
            json!({"model": "agy-only", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
            None,
            Some(&approval),
        )
        .await
        .expect("first use");
    assert_eq!(first.status(), StatusCode::OK);

    let replay = state
        .chat_with_request(
            json!({"model": "agy-only", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
            None,
            Some(&approval),
        )
        .await
        .expect_err("token must be single-use");
    assert_eq!(replay.status, StatusCode::FORBIDDEN);

    unsafe { std::env::remove_var("ND_AGY_BIN") };
}

#[tokio::test]
async fn antigravity_hourly_limit_stops_jobs() {
    let _env = AGY_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let stub = write_agy_stub(temp.path());
    unsafe { std::env::set_var("ND_AGY_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(antigravity_input("agy", &["stub-model"]))
        .expect("provider");
    state
        .save_combo(combo_input(
            "agy-only",
            "priority",
            vec![combo_entry("agy", "stub-model")],
        ))
        .expect("combo");
    state
        .set_agy_policy(SetAgyPolicyInput {
            enabled: Some(true),
            manual_approval_required: None,
            max_concurrent_jobs: None,
            max_jobs_per_hour: Some(1),
            max_jobs_per_day: None,
            max_tokens_per_day: None,
            approval_ttl_secs: None,
        })
        .expect("policy");

    let first = state
        .chat_with_request(
            json!({"model": "agy-only", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
            None,
            Some(&agy_approval(&state)),
        )
        .await
        .expect("first job");
    assert_eq!(first.status(), StatusCode::OK);

    let second = state
        .chat_with_request(
            json!({"model": "agy-only", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
            None,
            Some(&agy_approval(&state)),
        )
        .await
        .expect_err("hourly limit");
    assert_eq!(second.status, StatusCode::FORBIDDEN);
    assert!(
        second.message.contains("hourly limit"),
        "{}",
        second.message
    );

    unsafe { std::env::remove_var("ND_AGY_BIN") };
}

#[tokio::test]
async fn antigravity_kill_switch_locks_and_rearms_the_lane() {
    let _env = AGY_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let stub = write_agy_stub(temp.path());
    unsafe { std::env::set_var("ND_AGY_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(antigravity_input("agy", &["stub-model"]))
        .expect("provider");
    state
        .save_combo(combo_input(
            "agy-only",
            "priority",
            vec![combo_entry("agy", "stub-model")],
        ))
        .expect("combo");
    enable_agy(&state);
    let approval = agy_approval(&state);

    state
        .set_agy_enabled(SetAgyEnabledInput { enabled: false })
        .expect("kill switch");
    let blocked = state
        .chat_with_request(
            json!({"model": "agy-only", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
            None,
            Some(&approval),
        )
        .await
        .expect_err("kill switch must block");
    assert_eq!(blocked.status, StatusCode::FORBIDDEN);
    assert!(blocked.message.contains("locked"), "{}", blocked.message);
    let view = state.agy_view();
    assert_eq!(view["locked"], true);

    state
        .set_agy_enabled(SetAgyEnabledInput { enabled: true })
        .expect("re-arm");
    assert_eq!(state.agy_view()["locked"], false);
    let ok = state
        .chat_with_request(
            json!({"model": "agy-only", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
            None,
            Some(&agy_approval(&state)),
        )
        .await
        .expect("runs after re-arm");
    assert_eq!(ok.status(), StatusCode::OK);

    unsafe { std::env::remove_var("ND_AGY_BIN") };
}

#[tokio::test]
async fn antigravity_quota_error_trips_the_circuit_breaker() {
    let _env = AGY_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let stub = write_agy_failure_stub(temp.path(), "QUOTA_EXCEEDED");
    unsafe { std::env::set_var("ND_AGY_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(antigravity_input("agy", &["stub-model"]))
        .expect("provider");
    state
        .save_combo(combo_input(
            "agy-only",
            "priority",
            vec![combo_entry("agy", "stub-model")],
        ))
        .expect("combo");
    enable_agy(&state);

    let failure = state
        .chat_with_request(
            json!({"model": "agy-only", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
            None,
            Some(&agy_approval(&state)),
        )
        .await
        .expect_err("quota status fails the run");
    assert_eq!(failure.status, StatusCode::BAD_GATEWAY);

    let view = state.agy_view();
    assert_eq!(view["locked"], true);
    assert!(
        view["lockReason"]
            .as_str()
            .unwrap_or_default()
            .contains("quota")
    );

    // The lock is persisted: a fresh state over the same data dir stays locked.
    let reloaded = RouterState::new(temp.path().to_path_buf()).expect("reload");
    assert_eq!(reloaded.agy_view()["locked"], true);

    unsafe { std::env::remove_var("ND_AGY_BIN") };
}

#[tokio::test]
async fn antigravity_block_skips_to_the_next_lane() {
    let _env = AGY_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let (base_url, calls) = mock_upstream().await;
    let stub = write_agy_stub(temp.path());
    unsafe { std::env::set_var("ND_AGY_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(antigravity_input("agy", &["stub-model"]))
        .expect("provider");
    state
        .save_provider(provider_input("backup", &base_url, &["ok"]))
        .expect("backup");
    state
        .save_combo(combo_input(
            "mixed",
            "priority",
            vec![
                combo_entry("agy", "stub-model"),
                combo_entry("backup", "ok"),
            ],
        ))
        .expect("combo");
    // agy stays disabled: the combo must route around it without an approval.

    let response = state
        .chat(
            json!({"model": "mixed", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
        )
        .await
        .expect("chat");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(calls.lock().unwrap().as_slice(), ["ok"]);

    let agy = state.agy_usage_summary();
    assert_eq!(agy["summary"]["failed"], 1);
    assert_eq!(agy["recent"][0]["blockCode"], "agy_disabled");

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
    assert_eq!(
        prompt,
        "System: Be terse.\n\nUser: hello\n\nAssistant: hi\n\nUser: bye"
    );
    let single =
        crate::cli::prompt_from_messages(&[json!({"role": "user", "content": "just this"})]);
    assert_eq!(single, "just this");
}

/// ND_QODER_BIN is process-global like ND_AGY_BIN; qoder-lane tests serialize
/// on this lock while it is set.
static QODER_ENV_LOCK: Mutex<()> = Mutex::new(());

fn qoder_input(id: &str, models: &[&str]) -> SaveProviderInput {
    SaveProviderInput {
        id: Some(id.to_owned()),
        kind: Some("qoder".to_owned()),
        name: Some("Qoder CLI".to_owned()),
        base_url: None,
        models: Some(models.iter().map(|model| (*model).to_owned()).collect()),
        is_active: Some(true),
        priority: Some(0),
        api_key: None,
        clear_secret: false,
    }
}

fn qoder_account(provider_id: &str, pat: &str) -> SaveAccountInput {
    SaveAccountInput {
        provider_id: provider_id.to_owned(),
        id: None,
        label: "qoder-account".to_owned(),
        kind: Some("api-key".to_owned()),
        api_key: Some(pat.to_owned()),
        env_dir: None,
        selector: None,
        is_active: Some(true),
        priority: Some(0),
        clear_secret: false,
    }
}

fn qoder_cli_account(provider_id: &str, env_dir: &str) -> SaveAccountInput {
    SaveAccountInput {
        provider_id: provider_id.to_owned(),
        id: None,
        label: "qoder-profile".to_owned(),
        kind: Some("cli".to_owned()),
        api_key: None,
        env_dir: Some(env_dir.to_owned()),
        selector: None,
        is_active: Some(true),
        priority: Some(0),
        clear_secret: false,
    }
}

fn write_qoder_stub(dir: &std::path::Path, payload: &str) -> std::path::PathBuf {
    let stub = dir.join("qoder-stub.cmd");
    std::fs::write(&stub, format!("@echo off\r\necho {payload}\r\n")).expect("write stub");
    stub
}

#[tokio::test]
async fn qoder_lane_runs_the_cli_with_the_account_pat() {
    let _env = QODER_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let stub = write_qoder_stub(
        temp.path(),
        r#"{"type":"result","subtype":"success","is_error":false,"result":"pat:%QODER_PERSONAL_ACCESS_TOKEN%","usage":{"input_tokens":9,"output_tokens":5}}"#,
    );
    unsafe { std::env::set_var("ND_QODER_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(qoder_input("qoder", &["auto"]))
        .expect("provider");
    state
        .save_account(qoder_account("qoder", "qoder-test-pat"))
        .expect("account");
    state
        .save_combo(combo_input(
            "free-qoder",
            "priority",
            vec![combo_entry("qoder", "auto")],
        ))
        .expect("combo");

    let response = state
        .chat(
            json!({"model": "free-qoder", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
        )
        .await
        .expect("chat");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let value: Value = serde_json::from_slice(&bytes).expect("json");
    assert_eq!(value["model"], "auto");
    assert_eq!(
        value["choices"][0]["message"]["content"],
        "pat:qoder-test-pat"
    );
    assert_eq!(value["usage"]["prompt_tokens"], 9);
    assert_eq!(value["usage"]["total_tokens"], 14);

    unsafe { std::env::remove_var("ND_QODER_BIN") };
}

#[tokio::test]
async fn qoder_lane_runs_the_cli_with_the_account_config_dir() {
    let _env = QODER_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let stub = write_qoder_stub(
        temp.path(),
        r#"{"type":"result","subtype":"success","result":"dir:%QODER_CONFIG_DIR%"}"#,
    );
    unsafe { std::env::set_var("ND_QODER_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(qoder_input("qoder", &["auto"]))
        .expect("provider");
    state
        .save_account(qoder_cli_account("qoder", "qoder-profile-test"))
        .expect("account");
    state
        .save_combo(combo_input(
            "profile-qoder",
            "priority",
            vec![combo_entry("qoder", "auto")],
        ))
        .expect("combo");

    let response = state
        .chat(
            json!({"model": "profile-qoder", "messages": [{"role": "user", "content": "hi"}]}),
            None,
            "/v1/chat/completions",
        )
        .await
        .expect("chat");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let value: Value = serde_json::from_slice(&bytes).expect("json");
    assert_eq!(
        value["choices"][0]["message"]["content"],
        "dir:qoder-profile-test"
    );

    unsafe { std::env::remove_var("ND_QODER_BIN") };
}

#[tokio::test]
async fn qoder_lane_streams_nested_result_payloads() {
    let _env = QODER_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let stub = write_qoder_stub(
        temp.path(),
        r#"{"type":"result","subtype":"success","result":{"status":"success","content":"nested:ok"}}"#,
    );
    unsafe { std::env::set_var("ND_QODER_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(qoder_input("qoder", &["auto"]))
        .expect("provider");
    state
        .save_combo(combo_input(
            "stream-qoder",
            "priority",
            vec![combo_entry("qoder", "auto")],
        ))
        .expect("combo");

    let response = state
        .chat(
            json!({"model": "stream-qoder", "messages": [{"role": "user", "content": "hi"}], "stream": true}),
            None,
            "/v1/chat/completions",
        )
        .await
        .expect("chat");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let text = String::from_utf8(bytes.to_vec()).expect("utf8");
    assert!(text.contains("nested:ok"));
    assert!(text.contains("data: [DONE]"));

    unsafe { std::env::remove_var("ND_QODER_BIN") };
}

#[tokio::test]
async fn qoder_test_provider_runs_the_cli_with_the_pat_account() {
    let _env = QODER_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let temp = tempfile::tempdir().expect("tempdir");
    let stub = write_qoder_stub(
        temp.path(),
        r#"{"type":"result","subtype":"success","is_error":false,"result":"pat:%QODER_PERSONAL_ACCESS_TOKEN%","usage":{"input_tokens":9,"output_tokens":5}}"#,
    );
    unsafe { std::env::set_var("ND_QODER_BIN", &stub) };

    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(qoder_input("qoder", &["auto"]))
        .expect("provider");
    state
        .save_account(qoder_account("qoder", "qoder-test-pat"))
        .expect("account");
    let result = state.test_provider("qoder").await.expect("test");
    assert_eq!(result["ok"], true);
    assert_eq!(result["statusCode"], 200);
    assert_eq!(result["preview"], "pat:qoder-test-pat");

    unsafe { std::env::remove_var("ND_QODER_BIN") };
}

#[test]
fn categorizes_and_seeds_free_api_providers() {
    use crate::catalog;
    let temp = tempfile::tempdir().expect("tempdir");
    let state = RouterState::new(temp.path().to_path_buf()).expect("state");

    for (alias, expected_kind, expected_model) in [
        ("pollinations", catalog::KIND_POLLINATIONS, "openai-fast"),
        ("ovh", catalog::KIND_OVH_KEPLER, "gpt-oss-120b"),
        ("free-ai", catalog::KIND_FREE_AI, "qwen3-coder"),
        ("kilo", catalog::KIND_KILO, "openrouter/free"),
    ] {
        let normalized = catalog::normalize_kind(alias).expect("normalize");
        assert_eq!(normalized, expected_kind);
        assert_eq!(catalog::provider_category(&normalized), "api");
        assert_eq!(catalog::provider_auth_mode(&normalized), "none");
        assert!(catalog::is_http_kind(&normalized));
        assert!(catalog::is_free_api_kind(&normalized));

        let saved = state
            .save_provider(SaveProviderInput {
                id: Some(format!("provider-{alias}")),
                kind: Some(alias.to_owned()),
                name: None,
                base_url: None,
                models: None,
                is_active: Some(true),
                priority: Some(0),
                api_key: None,
                clear_secret: false,
            })
            .expect("save_provider");
        assert!(!saved["baseUrl"].as_str().unwrap_or("").is_empty());
        assert_eq!(saved["models"][0], expected_model);
    }

    assert_eq!(catalog::provider_category(catalog::KIND_ANTIGRAVITY), "cli");
    assert_eq!(
        catalog::provider_auth_mode(catalog::KIND_ANTIGRAVITY),
        "cli"
    );
    assert_eq!(catalog::provider_category(catalog::KIND_CHATGPT_WEB), "web");
    assert_eq!(
        catalog::provider_auth_mode(catalog::KIND_CHATGPT_WEB),
        "browser"
    );
    assert_eq!(
        catalog::provider_category(catalog::KIND_AI_STUDIO_WEB),
        "web"
    );
    assert_eq!(
        catalog::provider_auth_mode(catalog::KIND_AI_STUDIO_WEB),
        "browser"
    );
    assert_eq!(catalog::provider_category(catalog::KIND_OPENAI), "api");
    assert_eq!(catalog::provider_auth_mode(catalog::KIND_OPENAI), "api-key");
    assert_eq!(catalog::provider_category(catalog::KIND_AI_STUDIO), "api");
    assert_eq!(
        catalog::provider_auth_mode(catalog::KIND_AI_STUDIO),
        "api-key"
    );
    assert_eq!(
        catalog::normalize_kind("ai-studio").expect("ai-studio"),
        catalog::KIND_AI_STUDIO
    );
    assert_eq!(
        catalog::normalize_kind("aistudio-web").expect("aistudio-web"),
        catalog::KIND_AI_STUDIO_WEB
    );
}

#[tokio::test]
async fn test_candidate_validates_and_pings_without_persisting() {
    let temp = tempfile::tempdir().expect("tempdir");
    let state = RouterState::new(temp.path().to_path_buf()).expect("state");

    // Invalid kind returns ok: false, statusCode: 400
    let invalid_kind = state
        .test_candidate(SaveProviderInput {
            id: None,
            kind: Some("non-existent-kind".to_owned()),
            name: None,
            base_url: None,
            models: None,
            api_key: None,
            clear_secret: false,
            is_active: Some(true),
            priority: Some(0),
        })
        .await
        .expect("test_candidate");
    assert_eq!(invalid_kind["ok"], false);
    assert_eq!(invalid_kind["statusCode"], 400);

    // Missing baseUrl for custom openai-compatible returns ok: false, statusCode: 400
    let missing_url = state
        .test_candidate(SaveProviderInput {
            id: None,
            kind: Some("openai-compatible".to_owned()),
            name: Some("Custom API".to_owned()),
            base_url: Some("".to_owned()),
            models: None,
            api_key: None,
            clear_secret: false,
            is_active: Some(true),
            priority: Some(0),
        })
        .await
        .expect("test_candidate");
    assert_eq!(missing_url["ok"], false);
    assert_eq!(missing_url["statusCode"], 400);

    // Ensure store is completely empty (candidate was not saved)
    assert_eq!(
        state.snapshot()["providers"].as_array().map(Vec::len),
        Some(0)
    );
}

#[tokio::test]
async fn categorizes_and_seeds_trae_cli_provider() {
    let temp = tempfile::tempdir().expect("tempdir");
    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    let saved = state
        .save_provider(SaveProviderInput {
            id: Some("trae".to_owned()),
            kind: Some("trae-cli".to_owned()),
            name: None,
            base_url: None,
            models: None,
            api_key: None,
            clear_secret: false,
            is_active: Some(true),
            priority: Some(0),
        })
        .expect("save_provider");
    assert_eq!(saved["name"], "Trae CLI");
    assert_eq!(saved["kind"], "trae-cli");
    assert_eq!(crate::catalog::provider_category("trae-cli"), "cli");
    assert_eq!(crate::catalog::provider_auth_mode("trae-cli"), "cli");
    let models = saved["models"].as_array().expect("models");
    assert!(models.iter().any(|m| m == "default"));
    assert!(models.iter().any(|m| m == "agent"));
    assert!(models.iter().any(|m| m == "ask"));
    assert!(models.iter().any(|m| m == "edit"));
}

#[tokio::test]
async fn test_trae_cli_binary_detection() {
    let result = crate::cli::test_cli_binary("trae-cli").await;
    match result {
        Ok(output) => assert!(!output.is_empty()),
        Err(err) => {
            assert!(err.message.contains("not installed") || err.message.contains("timed out"))
        }
    }
}

#[test]
fn save_account_rejects_invalid_env_dir_and_selector() {
    let temp = tempfile::tempdir().expect("tempdir");
    let state = RouterState::new(temp.path().to_path_buf()).expect("state");
    state
        .save_provider(qoder_input("qoder-test", &["auto"]))
        .expect("provider");

    let bad_dir = state.save_account(SaveAccountInput {
        provider_id: "qoder-test".to_owned(),
        id: None,
        label: "bad-dir".to_owned(),
        kind: Some("cli".to_owned()),
        api_key: None,
        env_dir: Some("path/with/\0null".to_owned()),
        selector: None,
        is_active: Some(true),
        priority: Some(0),
        clear_secret: false,
    });
    assert!(bad_dir.is_err());
    assert!(bad_dir.unwrap_err().message.contains("env_dir"));

    let bad_selector = state.save_account(SaveAccountInput {
        provider_id: "qoder-test".to_owned(),
        id: None,
        label: "bad-sel".to_owned(),
        kind: Some("cli".to_owned()),
        api_key: None,
        env_dir: None,
        selector: Some("selector\nnewline".to_owned()),
        is_active: Some(true),
        priority: Some(0),
        clear_secret: false,
    });
    assert!(bad_selector.is_err());
    assert!(bad_selector.unwrap_err().message.contains("selector"));
}

#[tokio::test]
async fn generic_cli_rejects_overbudget_prompt() {
    let long_prompt = "a".repeat(crate::cli::GENERIC_CLI_MAX_PROMPT_CHARS + 1);
    let result = crate::cli::run_generic_cli("codex-cli", "default", &long_prompt).await;
    assert!(result.is_err());
    assert!(result.unwrap_err().message.contains("budget"));
}

#[cfg(windows)]
#[tokio::test]
async fn generic_cli_windows_cmd_rejects_shell_metacharacters() {
    let injected = "hello & calc.exe";
    let result = crate::cli::run_generic_cli("trae-cli", "agent", injected).await;
    assert!(result.is_err());
    assert!(result.unwrap_err().message.contains("shell metacharacters"));
}

async fn mock_edge_tts_ws_server() -> (String, Arc<Mutex<Vec<String>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind mock edge tts ws");
    let address = listener.local_addr().expect("mock ws addr");
    let seen_frames: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let frames_clone = Arc::clone(&seen_frames);

    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let frames_inner = Arc::clone(&frames_clone);
            tokio::spawn(async move {
                let mut req_buf = Vec::new();
                let mut tmp = [0u8; 1024];
                loop {
                    let Ok(n) = stream.read(&mut tmp).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    req_buf.extend_from_slice(&tmp[..n]);
                    if req_buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let req_str = String::from_utf8_lossy(&req_buf).to_string();
                frames_inner.lock().unwrap().push(req_str);

                let upgrade_resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n";
                if stream.write_all(upgrade_resp.as_bytes()).await.is_err() {
                    return;
                }

                // Read 2 masked client frames: speech.config and ssml
                for _ in 0..2 {
                    let mut head = [0u8; 2];
                    if stream.read_exact(&mut head).await.is_err() {
                        return;
                    }
                    let masked = (head[1] & 0x80) != 0;
                    let mut len = (head[1] & 0x7F) as usize;
                    if len == 126 {
                        let mut ext = [0u8; 2];
                        if stream.read_exact(&mut ext).await.is_err() {
                            return;
                        }
                        len = u16::from_be_bytes(ext) as usize;
                    } else if len == 127 {
                        let mut ext = [0u8; 8];
                        if stream.read_exact(&mut ext).await.is_err() {
                            return;
                        }
                        len = u64::from_be_bytes(ext) as usize;
                    }
                    let mut mask = [0u8; 4];
                    if masked && stream.read_exact(&mut mask).await.is_err() {
                        return;
                    }
                    let mut payload = vec![0u8; len];
                    if stream.read_exact(&mut payload).await.is_err() {
                        return;
                    }
                    if masked {
                        for (i, b) in payload.iter_mut().enumerate() {
                            *b ^= mask[i & 3];
                        }
                    }
                    frames_inner
                        .lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&payload).to_string());
                }

                // Send binary audio frame (unmasked server frame, opcode 0x2)
                let header = b"X-RequestId:mock\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n";
                let fake_mp3 = b"ID3\x04\x00\x00\x00\x00\x00\x00FAKE_MP3_AUDIO_BYTES";
                let mut bin_payload = Vec::new();
                bin_payload.extend_from_slice(&(header.len() as u16).to_be_bytes());
                bin_payload.extend_from_slice(header);
                bin_payload.extend_from_slice(fake_mp3);

                let mut bin_frame = vec![0x82, bin_payload.len() as u8];
                bin_frame.extend_from_slice(&bin_payload);
                let _ = stream.write_all(&bin_frame).await;

                // Send Path:turn.end text frame (opcode 0x1)
                let turn_end = b"X-RequestId:mock\r\nContent-Type:application/json; charset=utf-8\r\nPath:turn.end\r\n\r\n{}";
                let mut end_frame = vec![0x81, turn_end.len() as u8];
                end_frame.extend_from_slice(turn_end);
                let _ = stream.write_all(&end_frame).await;
                let _ = stream.flush().await;
            });
        }
    });

    (
        format!("ws://{address}/consumer/speech/synthesize/readaloud/edge/v1"),
        seen_frames,
    )
}

#[test]
fn seeds_edge_tts_as_first_default_provider_and_respects_subsequent_edits() {
    let temp = tempfile::tempdir().expect("tempdir");
    let state = RouterState::with_options(
        temp.path().to_path_buf(),
        RouterOptions {
            seed_defaults: true,
            ..Default::default()
        },
    )
    .expect("state");

    let snapshot = state.snapshot();
    let providers = snapshot["providers"].as_array().expect("providers array");
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0]["id"], "edge-tts");
    assert_eq!(providers[0]["kind"], "edge-tts");
    assert_eq!(providers[0]["name"], "Edge TTS (Free)");
    assert_eq!(providers[0]["isActive"], true);
    assert_eq!(crate::catalog::provider_category("edge-tts"), "tts");
    assert_eq!(crate::catalog::provider_auth_mode("edge-tts"), "none");

    // Deleting the default edge-tts provider persists `default_tts_seeded = true`,
    // so reloading with `seed_defaults: true` does not resurrect a removed provider.
    state.delete_provider("edge-tts").expect("delete edge-tts");
    let reloaded = RouterState::with_options(
        temp.path().to_path_buf(),
        RouterOptions {
            seed_defaults: true,
            ..Default::default()
        },
    )
    .expect("reload");
    assert_eq!(
        reloaded.snapshot()["providers"].as_array().map(Vec::len),
        Some(0)
    );
}

#[test]
fn generates_deterministic_sec_ms_gec_token_and_voice_mappings() {
    let token_a = crate::tts::generate_sec_ms_gec(1_730_000_010);
    let token_b = crate::tts::generate_sec_ms_gec(1_730_000_099);
    // Same 5-minute window produces identical v2 "<16 hex>-<64 hex>" uppercase token
    assert_eq!(token_a.len(), 81);
    assert_eq!(token_a.as_bytes()[16], b'-');
    assert_eq!(token_a, token_b);
    assert!(
        token_a
            .chars()
            .all(|c| c == '-' || (c.is_ascii_hexdigit() && !c.is_ascii_lowercase()))
    );

    assert_eq!(
        crate::tts::resolve_voice(Some("alloy"), None),
        "en-US-AriaNeural"
    );
    assert_eq!(
        crate::tts::resolve_voice(Some("nova"), None),
        "en-US-AvaMultilingualNeural"
    );
    assert_eq!(
        crate::tts::resolve_voice(None, Some("edge-tts/km-KH-SreymomNeural")),
        "km-KH-SreymomNeural"
    );
    assert_eq!(crate::tts::speed_to_rate(Some(1.25)), "+25%");
    assert_eq!(crate::tts::speed_to_rate(Some(0.8)), "-20%");
}

#[tokio::test]
async fn synthesizes_audio_via_edge_tts_and_lists_voices() {
    let temp = tempfile::tempdir().expect("tempdir");
    let (ws_url, seen_frames) = mock_edge_tts_ws_server().await;
    let state = RouterState::with_options(
        temp.path().to_path_buf(),
        RouterOptions {
            seed_defaults: true,
            ..Default::default()
        },
    )
    .expect("state");

    // Point the seeded edge-tts provider at our local mock WebSocket server
    state
        .save_provider(SaveProviderInput {
            id: Some("edge-tts".to_owned()),
            kind: Some("edge-tts".to_owned()),
            name: Some("Edge TTS (Free)".to_owned()),
            base_url: Some(ws_url),
            models: None,
            is_active: Some(true),
            priority: Some(100),
            api_key: None,
            clear_secret: false,
        })
        .expect("update edge-tts base_url");

    // 1. Verify voice catalog
    let voices = state.voice_catalog();
    let voice_list = voices["data"].as_array().expect("voices array");
    assert!(voice_list.iter().any(|v| v["id"] == "en-US-AriaNeural"));
    assert!(voice_list.iter().any(|v| v["id"] == "km-KH-SreymomNeural"));

    // 2. Verify /v1/audio/speech synthesis with OpenAI alias "alloy"
    let response = state
        .speech_with_request(
            json!({
                "model": "edge-tts",
                "input": "Hello & welcome to ND Router!",
                "voice": "alloy",
                "speed": 1.15
            }),
            None,
            "/v1/audio/speech",
        )
        .await
        .expect("speech response");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("audio/mpeg")
    );
    assert_eq!(
        response
            .headers()
            .get("x-nd-router-provider")
            .and_then(|v| v.to_str().ok()),
        Some("edge-tts")
    );
    assert_eq!(
        response
            .headers()
            .get("x-nd-router-voice")
            .and_then(|v| v.to_str().ok()),
        Some("en-US-AriaNeural")
    );
    let audio_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("audio body");
    assert!(audio_bytes.ends_with(b"FAKE_MP3_AUDIO_BYTES"));

    {
        let frames = seen_frames.lock().unwrap();
        assert!(frames.len() >= 3);
        assert!(frames[0].contains("Sec-MS-GEC="));
        assert!(frames[1].contains("Path:speech.config"));
        assert!(frames[2].contains("Path:ssml"));
        assert!(frames[2].contains("en-US-AriaNeural"));
        assert!(frames[2].contains("rate='+15%'"));
        assert!(frames[2].contains("Hello &amp; welcome to ND Router!"));
    }

    // 3. Verify provider test (`test_provider("edge-tts")`)
    let test_res = state
        .test_provider("edge-tts")
        .await
        .expect("test edge-tts");
    assert_eq!(test_res["ok"], true);
    assert_eq!(test_res["statusCode"], 200);
    assert!(
        test_res["preview"]
            .as_str()
            .unwrap_or_default()
            .contains("Audio OK")
    );

    // 4. Verify Playground chat completion with `edge-tts/en-US-JennyNeural`
    let chat_res = state
        .chat_with_request(
            json!({
                "model": "edge-tts/en-US-JennyNeural",
                "messages": [{"role": "user", "content": "Testing playground voice."}]
            }),
            None,
            "/v1/chat/completions",
            Some("req-tts-chat"),
            None,
        )
        .await
        .expect("tts chat completion");
    assert_eq!(chat_res.status(), StatusCode::OK);
    let chat_bytes = axum::body::to_bytes(chat_res.into_body(), usize::MAX)
        .await
        .expect("chat body");
    let chat_json: Value = serde_json::from_slice(&chat_bytes).expect("chat json");
    let content = chat_json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default();
    assert!(content.contains("data:audio/mpeg;base64,"));
    assert!(content.contains("en-US-JennyNeural"));
}
