pub const KIND_OPENAI: &str = "openai-compatible";
pub const KIND_ANTIGRAVITY: &str = "antigravity";
pub const KIND_GEMINI_CLI: &str = "gemini-cli";

pub const STRATEGY_PRIORITY: &str = "priority";
pub const STRATEGY_ROUND_ROBIN: &str = "round-robin";

pub fn normalize_kind(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "" | "custom" | "openai" | "openai-compatible" => Ok(KIND_OPENAI.to_owned()),
        "antigravity" | "agy" => Ok(KIND_ANTIGRAVITY.to_owned()),
        "gemini-cli" | "gemini" => Ok(KIND_GEMINI_CLI.to_owned()),
        other => Err(format!("provider kind is not supported: {other}")),
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
