//! Antigravity (agy CLI) execution lane.
//!
//! The user's installed agy CLI owns the Google sign-in and its tokens (OS
//! keychain); ND never handles them. A request becomes one
//! `agy --print --output-format json` invocation, with `AGY_ACCOUNT`
//! selecting the signed-in account when the routed entry carries one.

use crate::catalog;
use crate::types::{AccountRecord, RouterError};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::process::Command;

pub const AGY_PRINT_TIMEOUT_SECS: u64 = 120;
const MAX_PROMPT_CHARS: usize = 400_000;

pub struct CliCompletion {
    pub text: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

pub fn agy_binary() -> String {
    // Test override; production uses whatever `agy` resolves to on PATH.
    std::env::var("ND_AGY_BIN").unwrap_or_else(|_| "agy".to_owned())
}

/// Flatten OpenAI chat messages into one print-mode prompt. A single message
/// passes through verbatim; a conversation keeps role labels so the CLI's
/// single user turn still sees who said what.
pub fn prompt_from_messages(messages: &[Value]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("user");
        let content = stringify_content(message.get("content").unwrap_or(&Value::Null));
        if content.trim().is_empty() {
            continue;
        }
        let label = match role {
            "system" => "System",
            "assistant" => "Assistant",
            _ => "User",
        };
        parts.push(format!("{label}: {content}"));
    }
    if parts.len() == 1 {
        let only = parts.remove(0);
        return only.split_once(": ").map(|(_, rest)| rest.to_owned()).unwrap_or(only);
    }
    parts.join("\n\n")
}

fn stringify_content(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                item.get("text").and_then(Value::as_str).or_else(|| item.as_str())
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

pub async fn run_antigravity(
    model: &str,
    prompt: &str,
    account: Option<&AccountRecord>,
) -> Result<CliCompletion, RouterError> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(RouterError::bad_request("the antigravity lane needs a non-empty prompt"));
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(RouterError::bad_request("prompt exceeds the antigravity lane budget"));
    }
    let mut command = Command::new(agy_binary());
    command.arg(format!("--print={prompt}"));
    let model = model.trim();
    if !model.is_empty() && model != "default" {
        command.arg(format!("--model={model}"));
    }
    command.arg("--output-format=json");
    command.arg(format!("--print-timeout={AGY_PRINT_TIMEOUT_SECS}s"));
    if let Some(account) = account {
        if let Some(selector) = account.selector.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            command.env("AGY_ACCOUNT", selector);
        }
        // Application Default Credentials sign-in: the account record points at
        // an authorized_user credentials file; the CLI reads and refreshes it.
        if let Some(adc) = account.env_dir.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            command.env("AGY_ADC_AUTH", adc);
        }
    }
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    command.kill_on_drop(true);

    let output = tokio::time::timeout(
        Duration::from_secs(AGY_PRINT_TIMEOUT_SECS + 15),
        command.output(),
    )
    .await
    .map_err(|_| RouterError::bad_gateway("agy CLI did not finish in time"))?
    .map_err(|error| RouterError::bad_gateway(format!("agy CLI could not be started: {error}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        let detail = if stdout.trim().is_empty() { stderr.trim() } else { stdout.trim() };
        return Err(RouterError::bad_gateway(format!(
            "agy CLI failed: {}",
            catalog::truncate(detail, 300)
        )));
    }
    let parsed = parse_output(&stdout)
        .ok_or_else(|| RouterError::bad_gateway("agy CLI returned no parseable result"))?;
    let status = parsed.get("status").and_then(Value::as_str).unwrap_or("");
    if !status.eq_ignore_ascii_case("success") {
        return Err(RouterError::bad_gateway(format!("agy CLI reported status {status}")));
    }
    let text = parsed
        .get("response")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if text.trim().is_empty() {
        return Err(RouterError::bad_gateway("agy CLI returned an empty response"));
    }
    let usage = parsed.get("usage").cloned().unwrap_or(Value::Null);
    Ok(CliCompletion {
        text,
        prompt_tokens: usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0),
        completion_tokens: usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
        total_tokens: usage.get("total_tokens").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// agy prints progress text on some paths; scan lines bottom-up for the last
/// JSON object and require the shape we expect.
fn parse_output(stdout: &str) -> Option<Value> {
    for line in stdout.lines().rev() {
        let trimmed = line.trim();
        if !trimmed.starts_with('{') {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            if value.get("status").is_some() && value.get("response").is_some() {
                return Some(value);
            }
        }
    }
    None
}

pub fn completion_body(model: &str, completion: &CliCompletion) -> Value {
    json!({
        "id": format!("chatcmpl-agy-{}", uuid::Uuid::new_v4().simple()),
        "object": "chat.completion",
        "created": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default(),
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": completion.text},
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": completion.prompt_tokens,
            "completion_tokens": completion.completion_tokens,
            "total_tokens": completion.total_tokens,
        },
    })
}

pub fn sse_body(model: &str, completion: &CliCompletion) -> String {
    let id = format!("chatcmpl-agy-{}", uuid::Uuid::new_v4().simple());
    let first = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{"index": 0, "delta": {"role": "assistant", "content": completion.text}, "finish_reason": Value::Null}],
    });
    let last = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        "usage": {
            "prompt_tokens": completion.prompt_tokens,
            "completion_tokens": completion.completion_tokens,
            "total_tokens": completion.total_tokens,
        },
    });
    format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n")
}
