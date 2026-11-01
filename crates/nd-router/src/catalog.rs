pub const KIND_OPENAI: &str = "openai-compatible";
pub const KIND_POLLINATIONS: &str = "pollinations";
pub const KIND_OVH_KEPLER: &str = "ovh-kepler";
pub const KIND_FREE_AI: &str = "free-ai";
pub const KIND_KILO: &str = "kilo-gateway";
pub const KIND_ANTIGRAVITY: &str = "antigravity";
pub const KIND_GEMINI_CLI: &str = "gemini-cli";
pub const KIND_QODER: &str = "qoder";
pub const KIND_CODEX_CLI: &str = "codex-cli";
pub const KIND_CLAUDE_CLI: &str = "claude-code-cli";
pub const KIND_PI_CLI: &str = "pi-coding";
pub const KIND_ZCODE_CLI: &str = "zcode-cli";
pub const KIND_CURSOR_CLI: &str = "cursor-cli";
pub const KIND_OPENCODE_CLI: &str = "opencode-cli";
pub const KIND_GOOSE_CLI: &str = "goose-cli";
pub const KIND_HERMES_CLI: &str = "hermes-cli";
pub const KIND_JCODE_CLI: &str = "jcode-cli";
pub const KIND_MINIMAX_CLI: &str = "minimax-cli";
pub const KIND_CHATGPT_WEB: &str = "chatgpt-web";
pub const KIND_GEMINI_WEB: &str = "gemini-web";
pub const KIND_DEEPSEEK_WEB: &str = "deepseek-web";
pub const KIND_GROK_WEB: &str = "grok-web";
pub const KIND_QWEN_WEB: &str = "qwen-web";
pub const KIND_ZAI_WEB: &str = "zai-web";
pub const KIND_MISTRAL_WEB: &str = "mistral-web";
pub const KIND_PERPLEXITY_WEB: &str = "perplexity-web";
pub const KIND_POE_WEB: &str = "poe-web";
pub const KIND_ARENA_WEB: &str = "arena-web";
pub const KIND_META_WEB: &str = "meta-web";
pub const KIND_DUCK_WEB: &str = "duck-web";

pub const STRATEGY_PRIORITY: &str = "priority";
pub const STRATEGY_ROUND_ROBIN: &str = "round-robin";

pub fn normalize_kind(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "" | "custom" | "openai" | "openai-compatible" => Ok(KIND_OPENAI.to_owned()),
        "pollinations" | "pollinations-ai" | "pollinations-free" => Ok(KIND_POLLINATIONS.to_owned()),
        "ovh" | "ovh-kepler" | "ovh-cloud" | "ovh-anonymous" => Ok(KIND_OVH_KEPLER.to_owned()),
        "free-ai" | "freeai" => Ok(KIND_FREE_AI.to_owned()),
        "kilo" | "kilo-gateway" | "kilo-ai" => Ok(KIND_KILO.to_owned()),
        "antigravity" | "agy" => Ok(KIND_ANTIGRAVITY.to_owned()),
        "gemini-cli" | "gemini" => Ok(KIND_GEMINI_CLI.to_owned()),
        "qoder" | "qoder-cli" => Ok(KIND_QODER.to_owned()),
        "codex-cli" | "codex" => Ok(KIND_CODEX_CLI.to_owned()),
        "claude-code-cli" | "claude-code" | "claude-cli" | "claude" => Ok(KIND_CLAUDE_CLI.to_owned()),
        "pi-coding" | "pi" | "pi-cli" => Ok(KIND_PI_CLI.to_owned()),
        "zcode-cli" | "zcode" => Ok(KIND_ZCODE_CLI.to_owned()),
        "cursor-cli" | "cursor" | "cursor-agent" => Ok(KIND_CURSOR_CLI.to_owned()),
        "opencode-cli" | "opencode" => Ok(KIND_OPENCODE_CLI.to_owned()),
        "goose-cli" | "goose" => Ok(KIND_GOOSE_CLI.to_owned()),
        "hermes-cli" | "hermes" => Ok(KIND_HERMES_CLI.to_owned()),
        "jcode-cli" | "jcode" => Ok(KIND_JCODE_CLI.to_owned()),
        "minimax-cli" | "minimax" => Ok(KIND_MINIMAX_CLI.to_owned()),
        "chatgpt-web" | "chatgpt" | "gpt-web" => Ok(KIND_CHATGPT_WEB.to_owned()),
        "gemini-web" => Ok(KIND_GEMINI_WEB.to_owned()),
        "deepseek-web" | "deepseek" | "deepseek-chat-web" => Ok(KIND_DEEPSEEK_WEB.to_owned()),
        "grok-web" | "grok" => Ok(KIND_GROK_WEB.to_owned()),
        "qwen-web" | "qwen" => Ok(KIND_QWEN_WEB.to_owned()),
        "zai-web" | "zai" | "glm-web" | "glm" => Ok(KIND_ZAI_WEB.to_owned()),
        "mistral-web" | "mistral" => Ok(KIND_MISTRAL_WEB.to_owned()),
        "perplexity-web" | "perplexity" => Ok(KIND_PERPLEXITY_WEB.to_owned()),
        "poe-web" | "poe" => Ok(KIND_POE_WEB.to_owned()),
        "arena-web" | "arena" | "lmsys" => Ok(KIND_ARENA_WEB.to_owned()),
        "meta-web" | "meta" => Ok(KIND_META_WEB.to_owned()),
        "duck-web" | "duck" | "duck-ai" => Ok(KIND_DUCK_WEB.to_owned()),
        other => Err(format!("provider kind is not supported: {other}")),
    }
}

pub fn is_web_kind(kind: &str) -> bool {
    matches!(
        kind,
        KIND_CHATGPT_WEB
            | KIND_GEMINI_WEB
            | KIND_DEEPSEEK_WEB
            | KIND_GROK_WEB
            | KIND_QWEN_WEB
            | KIND_ZAI_WEB
            | KIND_MISTRAL_WEB
            | KIND_PERPLEXITY_WEB
            | KIND_POE_WEB
            | KIND_ARENA_WEB
            | KIND_META_WEB
            | KIND_DUCK_WEB
    )
}

pub fn is_http_kind(kind: &str) -> bool {
    matches!(
        kind,
        KIND_OPENAI
            | KIND_POLLINATIONS
            | KIND_OVH_KEPLER
            | KIND_FREE_AI
            | KIND_KILO
    )
}

pub fn is_free_api_kind(kind: &str) -> bool {
    matches!(
        kind,
        KIND_POLLINATIONS
            | KIND_OVH_KEPLER
            | KIND_FREE_AI
            | KIND_KILO
    )
}

pub fn is_cli_kind(kind: &str) -> bool {
    matches!(
        kind,
        KIND_ANTIGRAVITY
            | KIND_GEMINI_CLI
            | KIND_QODER
            | KIND_CODEX_CLI
            | KIND_CLAUDE_CLI
            | KIND_PI_CLI
            | KIND_ZCODE_CLI
            | KIND_CURSOR_CLI
            | KIND_OPENCODE_CLI
            | KIND_GOOSE_CLI
            | KIND_HERMES_CLI
            | KIND_JCODE_CLI
            | KIND_MINIMAX_CLI
    )
}

pub fn provider_category(kind: &str) -> &'static str {
    if is_web_kind(kind) {
        "web"
    } else if is_cli_kind(kind) {
        "cli"
    } else {
        "api"
    }
}

pub fn provider_auth_mode(kind: &str) -> &'static str {
    if is_free_api_kind(kind) {
        "none"
    } else if is_web_kind(kind) {
        "browser"
    } else if is_cli_kind(kind) {
        "cli"
    } else {
        "api-key"
    }
}

pub fn normalize_strategy(value: Option<&str>) -> String {
    match value.map(str::trim) {
        Some(STRATEGY_ROUND_ROBIN) => STRATEGY_ROUND_ROBIN.to_owned(),
        _ => STRATEGY_PRIORITY.to_owned(),
    }
}

pub fn requires_base_url(kind: &str) -> bool {
    kind == KIND_OPENAI
}

/// Join a provider base URL with an API path. Accepts bases with or without
/// the `/v1` suffix so plugin gateways pasted from their docs just work.
pub fn join_provider_url(base: &str, path: &str) -> Result<String, String> {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("baseUrl is required for this provider".to_owned());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "baseUrl is not a valid URL".to_owned())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("baseUrl must use http or https".to_owned());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("baseUrl must not embed credentials".to_owned());
    }
    if !path.starts_with("/v1/") {
        return Err("router paths must live under /v1".to_owned());
    }
    if trimmed.ends_with("/v1") {
        Ok(format!("{trimmed}{}", &path[3..]))
    } else {
        Ok(format!("{trimmed}{path}"))
    }
}

/// Only transport-ish failures move to the next lane. 4xx configuration and
/// auth failures stay put so a bad key does not silently burn every free lane.
pub fn is_retryable_status(status: u16) -> bool {
    matches!(status, 408 | 425 | 429 | 500..=599)
}

pub fn cooldown_ms_for_status(status: u16) -> u64 {
    if status == 429 { 30_000 } else { 10_000 }
}

pub fn truncate(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}
