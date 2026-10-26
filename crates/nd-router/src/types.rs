use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;

pub const STORE_SCHEMA_VERSION: u32 = 1;
pub const STORE_FILE: &str = "router-state.json";
pub const USAGE_FILE: &str = "usage.jsonl";
pub const MAX_USAGE_LINES: usize = 5_000;
pub const REQUEST_TIMEOUT_SECS: u64 = 120;
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
        Self { status: StatusCode::BAD_REQUEST, code: "invalid_request", message: message.into() }
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self { status: StatusCode::UNAUTHORIZED, code: "unauthorized", message: message.into() }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self { status: StatusCode::NOT_FOUND, code: "not_found", message: message.into() }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, code: "router_error", message: message.into() }
    }

    pub fn bad_gateway(message: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_GATEWAY, code: "upstream_unavailable", message: message.into() }
    }

    pub fn not_implemented(message: impl Into<String>) -> Self {
        Self { status: StatusCode::NOT_IMPLEMENTED, code: "lane_not_implemented", message: message.into() }
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
        (self.status, Json(json!({"error": {"message": self.message, "code": self.code}})))
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
            has_secret: record.secret_ref.is_some() || record.accounts.iter().any(|account| account.secret_ref.is_some()),
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
