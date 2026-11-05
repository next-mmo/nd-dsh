//! CLI execution lanes.
//!
//! Antigravity: the user's installed agy CLI owns the Google sign-in and its
//! tokens (OS keychain); ND never handles them. A request becomes one
//! `agy --print --output-format json` invocation, with `AGY_ACCOUNT`
//! selecting the signed-in account when the routed entry carries one.
//!
//! Qoder: the installed qoder CLI owns its sign-in (or receives a personal
//! access token from the ND vault). A request becomes one `qoder --print`
//! invocation with tools disabled, so the CLI answers instead of acting on
//! the ND workspace.

use crate::catalog;
use crate::types::{AccountRecord, RouterError};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::process::Command;

pub const AGY_PRINT_TIMEOUT_SECS: u64 = 120;
const MAX_PROMPT_CHARS: usize = 400_000;

pub const QODER_PRINT_TIMEOUT_SECS: u64 = 120;
// The prompt travels as a command-line argument and Windows caps a process
// command line at ~32k characters, so the qoder budget stays well below it.
const QODER_MAX_PROMPT_CHARS: usize = 24_000;
pub const GENERIC_CLI_MAX_PROMPT_CHARS: usize = 30_000;

#[derive(Clone, Debug)]
pub struct CliCompletion {
    pub text: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

/// Web lanes return finished text only; usage is estimated at four characters
/// per token so ND's existing completion/SSE builders stay uniform.
pub fn completion_from_text(prompt: &str, text: &str) -> CliCompletion {
    let prompt_tokens = (prompt.chars().count() / 4) as u64;
    let completion_tokens = (text.chars().count() / 4) as u64;
    CliCompletion {
        text: text.to_owned(),
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
    }
}

pub fn agy_binary() -> String {
    // Test override; production uses whatever `agy` resolves to on PATH.
    std::env::var("ND_AGY_BIN").unwrap_or_else(|_| "agy".to_owned())
}

pub fn qoder_binary() -> String {
    // Test override; production uses whatever `qoder` resolves to on PATH.
    std::env::var("ND_QODER_BIN").unwrap_or_else(|_| "qoder".to_owned())
}

pub fn cli_binary_for_kind(kind: &str) -> String {
    match kind {
        catalog::KIND_ANTIGRAVITY => agy_binary(),
        catalog::KIND_QODER => qoder_binary(),
        catalog::KIND_GEMINI_CLI => std::env::var("ND_DSH_GEMINI_BINARY").unwrap_or_else(|_| "gemini".to_owned()),
        catalog::KIND_CODEX_CLI => std::env::var("ND_DSH_CODEX_BINARY").unwrap_or_else(|_| "codex".to_owned()),
        catalog::KIND_CLAUDE_CLI => std::env::var("ND_DSH_CLAUDE_BINARY").unwrap_or_else(|_| "claude".to_owned()),
        catalog::KIND_PI_CLI => std::env::var("ND_DSH_PI_BINARY").unwrap_or_else(|_| "pi".to_owned()),
        catalog::KIND_ZCODE_CLI => std::env::var("ND_DSH_ZCODE_BINARY").unwrap_or_else(|_| "zcode".to_owned()),
        catalog::KIND_CURSOR_CLI => std::env::var("ND_DSH_CURSOR_BINARY").unwrap_or_else(|_| "cursor-agent".to_owned()),
        catalog::KIND_OPENCODE_CLI => std::env::var("ND_DSH_OPENCODE_BINARY").unwrap_or_else(|_| "opencode".to_owned()),
        catalog::KIND_GOOSE_CLI => std::env::var("ND_DSH_GOOSE_BINARY").unwrap_or_else(|_| "goose".to_owned()),
        catalog::KIND_HERMES_CLI => std::env::var("ND_DSH_HERMES_BINARY").unwrap_or_else(|_| "hermes".to_owned()),
        catalog::KIND_JCODE_CLI => std::env::var("ND_DSH_JCODE_BINARY").unwrap_or_else(|_| "jcode".to_owned()),
        catalog::KIND_MINIMAX_CLI => std::env::var("ND_DSH_MINIMAX_BINARY").unwrap_or_else(|_| "minimax".to_owned()),
        catalog::KIND_TRAE_CLI => std::env::var("ND_DSH_TRAE_BINARY").unwrap_or_else(|_| {
            if cfg!(windows) {
                if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
                    let default_path = std::path::PathBuf::from(local_app_data)
                        .join("Programs")
                        .join("Trae")
                        .join("bin")
                        .join("trae.cmd");
                    if default_path.exists() {
                        return default_path.to_string_lossy().to_string();
                    }
                }
                "trae.cmd".to_owned()
            } else {
                "trae".to_owned()
            }
        }),
        other => other.to_owned(),
    }
}

fn create_command(bin: &str) -> Command {
    #[cfg(windows)]
    {
        if bin.ends_with(".cmd") || bin.ends_with(".bat") || bin.eq_ignore_ascii_case("trae") {
            let mut cmd = Command::new("cmd.exe");
            cmd.arg("/c").arg(bin);
            return cmd;
        }
    }
    Command::new(bin)
}

pub async fn test_cli_binary(kind: &str) -> Result<String, RouterError> {
    let bin = cli_binary_for_kind(kind);
    let mut command = create_command(&bin);
    command.arg("--version");
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    command.kill_on_drop(true);

    let output = match tokio::time::timeout(Duration::from_secs(5), command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return Err(RouterError::bad_request(format!(
                "CLI binary '{bin}' is not installed or not found on PATH: {error}"
            )));
        }
        Err(_) => {
            return Err(RouterError::bad_gateway(format!("'{bin} --version' timed out")));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let preview = if !stdout.is_empty() { stdout } else { stderr };
    if preview.is_empty() {
        Ok(format!("{bin} CLI available"))
    } else {
        Ok(catalog::truncate(&preview, 80))
    }
}

pub async fn run_generic_cli(
    kind: &str,
    model: &str,
    prompt: &str,
) -> Result<CliCompletion, RouterError> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(RouterError::bad_request("the CLI lane needs a non-empty prompt"));
    }
    if prompt.chars().count() > GENERIC_CLI_MAX_PROMPT_CHARS {
        return Err(RouterError::bad_request("prompt exceeds the generic CLI lane budget"));
    }
    let bin = cli_binary_for_kind(kind);
    #[cfg(windows)]
    {
        if bin.ends_with(".cmd") || bin.ends_with(".bat") || bin.eq_ignore_ascii_case("trae") {
            if prompt.contains('\n')
                || prompt.contains('\r')
                || prompt.contains('&')
                || prompt.contains('|')
                || prompt.contains('^')
                || prompt.contains('%')
                || prompt.contains('<')
                || prompt.contains('>')
            {
                return Err(RouterError::bad_request(
                    "prompts sent to Windows batch/cmd CLI shims must not contain newlines or shell metacharacters (&, |, ^, %, <, >)",
                ));
            }
            if prompt.len() > 8000 {
                return Err(RouterError::bad_request("prompt exceeds Windows command shell length limit"));
            }
        }
    }
    let safe_prompt = if prompt.starts_with('-') {
        format!(" {prompt}")
    } else {
        prompt.to_owned()
    };
    let mut command = create_command(&bin);
    match kind {
        catalog::KIND_CLAUDE_CLI => {
            command.arg("-p").arg(&safe_prompt);
            if !model.is_empty() && model != "default" {
                command.arg("--model").arg(model);
            }
        }
        catalog::KIND_CODEX_CLI => {
            command.arg("exec").arg(&safe_prompt);
        }
        catalog::KIND_OPENCODE_CLI => {
            command.arg("run").arg(&safe_prompt);
            if !model.is_empty() && model != "default" {
                command.arg("--model").arg(model);
            }
        }
        catalog::KIND_TRAE_CLI => {
            command.arg("chat");
            let mode = match model {
                "ask" | "edit" | "agent" => model,
                _ => "agent",
            };
            command.arg("-m").arg(mode);
            command.arg(&safe_prompt);
        }
        catalog::KIND_GOOSE_CLI
        | catalog::KIND_HERMES_CLI
        | catalog::KIND_ZCODE_CLI
        | catalog::KIND_JCODE_CLI
        | catalog::KIND_MINIMAX_CLI => {
            command.arg("run").arg(&safe_prompt);
        }
        _ => {
            command.arg(&safe_prompt);
        }
    }
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    command.kill_on_drop(true);

    let output = tokio::time::timeout(Duration::from_secs(120), command.output())
        .await
        .map_err(|_| RouterError::bad_gateway(format!("{bin} CLI did not finish in time")))?
        .map_err(|error| RouterError::bad_gateway(format!("{bin} CLI could not be started: {error}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if !output.status.success() && stdout.is_empty() {
        return Err(RouterError::bad_gateway(format!("{bin} CLI failed: {stderr}")));
    }
    let text = if !stdout.is_empty() {
        stdout
    } else if !stderr.is_empty() {
        stderr
    } else if kind == catalog::KIND_TRAE_CLI {
        format!("Dispatched prompt to Trae IDE (mode: {model}, {} characters). Trae window is active.", prompt.len())
    } else {
        String::new()
    };
    Ok(completion_from_text(prompt, &text))
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

pub async fn run_qoder(
    model: &str,
    prompt: &str,
    account: Option<&AccountRecord>,
    secret: Option<&str>,
) -> Result<CliCompletion, RouterError> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(RouterError::bad_request("the qoder lane needs a non-empty prompt"));
    }
    if prompt.chars().count() > QODER_MAX_PROMPT_CHARS {
        return Err(RouterError::bad_request("prompt exceeds the qoder lane budget"));
    }
    let mut command = Command::new(qoder_binary());
    command.arg("--print").arg(prompt);
    let model = model.trim();
    if !model.is_empty() && model != "default" {
        command.arg(format!("--model={model}"));
    }
    command.arg("--output-format=json");
    // One turn with every tool disabled keeps this a completion route: the
    // CLI answers from the prompt and never acts on the ND workspace.
    command.arg("--max-turns=1");
    command.arg("--tools").arg("");
    command.arg("--no-session-persistence");
    if let Some(secret) = secret.map(str::trim).filter(|value| !value.is_empty()) {
        command.env("QODER_PERSONAL_ACCESS_TOKEN", secret);
    }
    if let Some(config_dir) = account
        .and_then(|account| account.env_dir.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        command.env("QODER_CONFIG_DIR", config_dir);
    }
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    command.kill_on_drop(true);

    let output = tokio::time::timeout(
        Duration::from_secs(QODER_PRINT_TIMEOUT_SECS + 15),
        command.output(),
    )
    .await
    .map_err(|_| RouterError::bad_gateway("qoder CLI did not finish in time"))?
    .map_err(|error| RouterError::bad_gateway(format!("qoder CLI could not be started: {error}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        let detail = if stdout.trim().is_empty() { stderr.trim() } else { stdout.trim() };
        return Err(RouterError::bad_gateway(format!(
            "qoder CLI failed: {}",
            catalog::truncate(detail, 300)
        )));
    }
    let parsed = parse_qoder_output(&stdout)
        .ok_or_else(|| RouterError::bad_gateway("qoder CLI returned no parseable result"))?;
    let text = qoder_text(&parsed);
    let subtype = parsed.get("subtype").and_then(Value::as_str).unwrap_or("");
    let status = parsed.get("status").and_then(Value::as_str).unwrap_or("");
    let is_error = parsed.get("is_error").and_then(Value::as_bool).unwrap_or(false);
    if is_error
        || subtype.to_ascii_lowercase().contains("error")
        || status.to_ascii_lowercase().contains("error")
        || status.eq_ignore_ascii_case("failed")
    {
        let detail = if text.trim().is_empty() { subtype } else { text.trim() };
        return Err(RouterError::bad_gateway(format!(
            "qoder CLI reported an error: {}",
            catalog::truncate(detail, 300)
        )));
    }
    if text.trim().is_empty() {
        return Err(RouterError::bad_gateway("qoder CLI returned an empty response"));
    }
    let usage = parsed
        .get("usage")
        .or_else(|| parsed.get("result").and_then(|result| result.get("usage")))
        .cloned()
        .unwrap_or(Value::Null);
    let prompt_tokens = usage_number(&usage, &["input_tokens", "prompt_tokens", "tokens_input"]);
    let completion_tokens = usage_number(&usage, &["output_tokens", "completion_tokens", "tokens_output"]);
    let total_tokens = usage_number(&usage, &["total_tokens", "tokens_total"]);
    Ok(CliCompletion {
        text,
        prompt_tokens,
        completion_tokens,
        total_tokens: if total_tokens == 0 { prompt_tokens + completion_tokens } else { total_tokens },
    })
}

fn usage_number(usage: &Value, keys: &[&str]) -> u64 {
    keys.iter().find_map(|key| usage.get(*key).and_then(Value::as_u64)).unwrap_or(0)
}

/// Accept both the Claude-style `result` string and the nested
/// `result.content` shape Qoder documents, plus assistant message blocks.
fn qoder_text(parsed: &Value) -> String {
    if let Some(result) = parsed.get("result") {
        match result {
            Value::String(text) => return text.clone(),
            Value::Object(object) => {
                if let Some(text) = object.get("content").and_then(Value::as_str) {
                    return text.to_owned();
                }
            }
            _ => {}
        }
    }
    if let Some(text) = parsed.get("content").and_then(Value::as_str) {
        return text.to_owned();
    }
    parsed
        .get("message")
        .and_then(|message| message.get("content"))
        .map(stringify_content)
        .unwrap_or_default()
}

/// qoder may print progress text around the payload; prefer a `result`
/// object, otherwise fall back to the last JSON object on stdout.
fn parse_qoder_output(stdout: &str) -> Option<Value> {
    let trimmed = stdout.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if value.is_object() {
            return Some(value);
        }
    }
    let mut fallback = None;
    for line in trimmed.lines().rev() {
        let trimmed_line = line.trim();
        if !trimmed_line.starts_with('{') {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed_line) {
            if value.get("type").and_then(Value::as_str) == Some("result") {
                return Some(value);
            }
            fallback.get_or_insert(value);
        }
    }
    fallback
}

pub fn completion_body(lane: &str, model: &str, completion: &CliCompletion) -> Value {
    json!({
        "id": format!("chatcmpl-{lane}-{}", uuid::Uuid::new_v4().simple()),
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

pub fn sse_body(lane: &str, model: &str, completion: &CliCompletion) -> String {
    let id = format!("chatcmpl-{lane}-{}", uuid::Uuid::new_v4().simple());
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
