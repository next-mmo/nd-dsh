use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;

pub const STORE_SCHEMA_VERSION: u32 = 1;
pub const STORE_FILE: &str = "router-state.json";
pub const USAGE_FILE: &str = "usage.jsonl";
/// Antigravity lane accounting lives in its own file so the safety dashboard
/// can show blocks, approvals, categories and token usage without disturbing
/// the generic provider usage feed.
pub const AGY_USAGE_FILE: &str = "agy-usage.jsonl";
pub const AGY_HOUR_MS: u64 = 3_600_000;
pub const AGY_DAY_MS: u64 = 86_400_000;
pub const MAX_PENDING_AGY_APPROVALS: usize = 8;
pub const MAX_USAGE_LINES: usize = 5_000;
pub const REQUEST_TIMEOUT_SECS: u64 = 120;
/// Web lanes own a real browser turn, which can take the engine's full 10 minutes.
pub const WEB_REQUEST_TIMEOUT_SECS: u64 = 620;
pub const WEB_TEST_TIMEOUT_SECS: u64 = 300;
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistedStore {
    pub schema_version: u32,
    #[serde(default)]
    pub providers: Vec<ProviderRecord>,
    #[serde(default)]
    pub combos: Vec<ComboRecord>,
    #[serde(default)]
    pub round_robin: HashMap<String, usize>,
    #[serde(default)]
    pub agy: AgyStateRecord,
    #[serde(default)]
    pub default_tts_seeded: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRecord {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub models: Vec<String>,
    pub is_active: bool,
    pub priority: i32,
    #[serde(default)]
    pub secret_ref: Option<String>,
    #[serde(default)]
    pub accounts: Vec<AccountRecord>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRecord {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(default)]
    pub secret_ref: Option<String>,
    #[serde(default)]
    pub env_dir: Option<String>,
    /// CLI lane account selector (for example the agy `AGY_ACCOUNT` name).
    /// Not a secret: it names an account the external CLI already signed in.
    #[serde(default)]
    pub selector: Option<String>,
    pub is_active: bool,
    pub priority: i32,
    #[serde(default)]
    pub cooldown_until_ms: Option<u64>,
    #[serde(default)]
    pub last_status: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComboRecord {
    pub id: String,
    pub name: String,
    pub strategy: String,
    #[serde(default)]
    pub models: Vec<ComboEntry>,
    #[serde(default)]
    pub config: Value,
    /// Private combos keep resolving through `/v1` but stay out of personal chat.
    #[serde(default)]
    pub hidden_from_chat: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComboEntry {
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub weight: Option<f64>,
    #[serde(default)]
    pub account_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    pub ts_ms: u64,
    pub combo: String,
    pub provider: String,
    #[serde(default)]
    pub account: Option<String>,
    pub model: String,
    pub endpoint: String,
    pub status: u16,
    pub ok: bool,
    pub latency_ms: u64,
    #[serde(default)]
    pub error: Option<String>,
    pub prompt_chars: u64,
    pub completion_chars: u64,
}

#[derive(Clone, Debug)]
pub struct RoutedEntry {
    pub provider: ProviderRecord,
    pub account: Option<AccountRecord>,
    pub model: String,
}

#[derive(Debug)]
pub struct RouterError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl RouterError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_request",
            message: message.into(),
        }
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: message.into(),
        }
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: message.into(),
        }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "conflict",
            message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "router_error",
            message: message.into(),
        }
    }

    pub fn bad_gateway(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "upstream_unavailable",
            message: message.into(),
        }
    }

    pub fn not_implemented(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_IMPLEMENTED,
            code: "lane_not_implemented",
            message: message.into(),
        }
    }
}

impl std::fmt::Display for RouterError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for RouterError {}

impl IntoResponse for RouterError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error": {"message": self.message, "code": self.code}})),
        )
            .into_response()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub is_active: bool,
    pub priority: i32,
    pub has_secret: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cooldown_until_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_status: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub base_url: String,
    pub models: Vec<String>,
    pub is_active: bool,
    pub priority: i32,
    pub has_secret: bool,
    pub live_capable: bool,
    pub accounts: Vec<AccountView>,
}

impl AccountView {
    pub fn of(record: &AccountRecord) -> Self {
        Self {
            id: record.id.clone(),
            label: record.label.clone(),
            kind: record.kind.clone(),
            is_active: record.is_active,
            priority: record.priority,
            has_secret: record.secret_ref.is_some(),
            env_dir: record.env_dir.clone(),
            selector: record.selector.clone(),
            cooldown_until_ms: record.cooldown_until_ms,
            last_status: record.last_status.clone(),
        }
    }
}

impl ProviderView {
    pub fn of(record: &ProviderRecord) -> Self {
        Self {
            id: record.id.clone(),
            kind: record.kind.clone(),
            name: record.name.clone(),
            base_url: record.base_url.clone(),
            models: record.models.clone(),
            is_active: record.is_active,
            priority: record.priority,
            has_secret: record.secret_ref.is_some()
                || record
                    .accounts
                    .iter()
                    .any(|account| account.secret_ref.is_some()),
            live_capable: crate::catalog::supports_live(&record.kind),
            accounts: record.accounts.iter().map(AccountView::of).collect(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProviderInput {
    pub id: Option<String>,
    pub kind: Option<String>,
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub models: Option<Vec<String>>,
    pub is_active: Option<bool>,
    pub priority: Option<i32>,
    pub api_key: Option<String>,
    #[serde(default)]
    pub clear_secret: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAccountInput {
    pub provider_id: String,
    pub id: Option<String>,
    pub label: String,
    pub kind: Option<String>,
    pub api_key: Option<String>,
    pub env_dir: Option<String>,
    pub selector: Option<String>,
    pub is_active: Option<bool>,
    pub priority: Option<i32>,
    #[serde(default)]
    pub clear_secret: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveComboInput {
    pub id: Option<String>,
    pub name: String,
    pub strategy: Option<String>,
    pub models: Vec<ComboEntry>,
    pub hidden_from_chat: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderIdInput {
    pub provider_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdInput {
    pub provider_id: String,
    pub account_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComboIdInput {
    pub combo_id: String,
}

/// Loopback bridge hosted by trusted Electron main that drives the visible
/// ChatGPT Web / Gemini Web / DeepSeek Web tabs for the router's web lanes.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebBridgeConfig {
    pub url: String,
    pub token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetExternalKeyInput {
    pub external_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSafeModeInput {
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SpeechRequestInput {
    #[serde(default)]
    pub model: Option<String>,
    pub input: String,
    #[serde(default)]
    pub voice: Option<String>,
    #[serde(default, alias = "responseFormat")]
    pub response_format: Option<String>,
    #[serde(default)]
    pub speed: Option<f64>,
}

/// Conservative operating budget for the Antigravity CLI lane. These are
/// internal limits, not Google-validated safe thresholds: the lane runs a
/// consumer Google account through the user's own `agy` CLI, so ND defaults
/// to disabled plus manual approval and never retries quota failures.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgyPolicyRecord {
    /// Master switch. Off by default; the lane stays out of automatic routing
    /// until the user opts in from Router Settings.
    #[serde(default)]
    pub enabled: bool,
    /// Every router request must carry a one-shot approval token created by
    /// the user. Provider "Test" clicks count as the user's approval.
    #[serde(default = "agy_default_true")]
    pub manual_approval_required: bool,
    #[serde(default = "agy_default_one")]
    pub max_concurrent_jobs: u32,
    #[serde(default = "agy_default_two")]
    pub max_jobs_per_hour: u32,
    #[serde(default = "agy_default_ten")]
    pub max_jobs_per_day: u32,
    /// Hard daily token budget using the usage the CLI itself reports.
    /// Zero disables the token budget (job limits still apply).
    #[serde(default = "agy_default_token_budget")]
    pub max_tokens_per_day: u64,
    #[serde(default = "agy_default_ttl")]
    pub approval_ttl_secs: u64,
    /// Fixed at zero: ND never re-invokes the CLI after a failure. Moving to
    /// the next combo entry is provider failover, not a retry.
    #[serde(default)]
    pub max_retries: u32,
    #[serde(default = "agy_default_timeout")]
    pub max_timeout_secs: u64,
}

fn agy_default_true() -> bool {
    true
}
fn agy_default_one() -> u32 {
    1
}
fn agy_default_two() -> u32 {
    2
}
fn agy_default_ten() -> u32 {
    10
}
fn agy_default_token_budget() -> u64 {
    200_000
}
fn agy_default_ttl() -> u64 {
    600
}
fn agy_default_timeout() -> u64 {
    300
}

impl Default for AgyPolicyRecord {
    fn default() -> Self {
        Self {
            enabled: false,
            manual_approval_required: true,
            max_concurrent_jobs: 1,
            max_jobs_per_hour: 2,
            max_jobs_per_day: 10,
            max_tokens_per_day: 200_000,
            approval_ttl_secs: 600,
            max_retries: 0,
            max_timeout_secs: 300,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgyStateRecord {
    #[serde(default)]
    pub policy: AgyPolicyRecord,
    /// Kill switch / circuit breaker. Trip it manually or let a quota, auth
    /// or policy failure trip it; only a manual re-enable clears it.
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub lock_reason: Option<String>,
    #[serde(default)]
    pub window_start_ms: u64,
    #[serde(default)]
    pub window_jobs: u32,
    #[serde(default)]
    pub day_start_ms: u64,
    #[serde(default)]
    pub day_jobs: u32,
    #[serde(default)]
    pub day_tokens: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAgyPolicyInput {
    pub enabled: Option<bool>,
    pub manual_approval_required: Option<bool>,
    pub max_concurrent_jobs: Option<u32>,
    pub max_jobs_per_hour: Option<u32>,
    pub max_jobs_per_day: Option<u32>,
    pub max_tokens_per_day: Option<u64>,
    pub approval_ttl_secs: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAgyEnabledInput {
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgyApprovalInput {
    pub category: String,
}

/// Result of one gated antigravity job, fed back into the guard for token
/// accounting and circuit-breaker classification.
#[derive(Clone, Debug)]
pub struct AgyOutcome {
    pub status: u16,
    pub ok: bool,
    pub message: Option<String>,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveToolSpec {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub parameters: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLiveTicketInput {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub system_instruction: Option<String>,
    #[serde(default)]
    pub voice: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub tools: Vec<LiveToolSpec>,
}
