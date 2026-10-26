use crate::catalog;
use crate::store;
use crate::types::{
    AccountRecord, AccountView, ComboRecord, ProviderView, RoutedEntry,
    RouterError, SaveAccountInput, SaveComboInput, SaveProviderInput, UsageEntry, MAX_USAGE_LINES,
    REQUEST_TIMEOUT_SECS, STORE_SCHEMA_VERSION, USAGE_FILE,
};
use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header::CONTENT_TYPE};
use axum::response::Response;
use futures_util::TryStreamExt;
use nd_runtime::vault::{
    VaultEntryInput, VaultIdParams, VaultRegistry, VaultUpdateParams, VaultWriteParams,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct RouterState {
    store: Mutex<crate::types::PersistedStore>,
    store_path: PathBuf,
    data_dir: PathBuf,
    vault: VaultRegistry,
    vault_path: PathBuf,
    client: reqwest::Client,
    key: String,
    counters: Mutex<Counters>,
}

#[derive(Default, Clone)]
struct Counters {
    requests: u64,
    ok: u64,
    failed: u64,
    last_error: Option<String>,
}

impl RouterState {
    pub fn new(data_dir: PathBuf) -> anyhow::Result<Arc<Self>> {
        std::fs::create_dir_all(&data_dir)?;
        let store_path = data_dir.join(crate::types::STORE_FILE);
        let vault_path = data_dir.join("secrets.ndv");
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .connect_timeout(Duration::from_secs(10))
            // Match ND's Node fetch behavior: no ambient proxy. Loopback plugin
            // gateways must never be sent through a corporate proxy.
            .no_proxy()
            .build()?;
        let key = format!("ndr_{}", uuid::Uuid::new_v4().simple());
        Ok(Arc::new(Self {
            store: Mutex::new(store::load(&store_path)),
            store_path,
            data_dir,
            vault: VaultRegistry::new_platform(),
            vault_path,
            client,
            key,
            counters: Mutex::new(Counters::default()),
        }))
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn data_dir(&self) -> &PathBuf {
        &self.data_dir
    }

    pub fn snapshot(&self) -> Value {
        let store = self.store.lock().unwrap_or_else(|error| error.into_inner());
        let counters = self.counters.lock().unwrap_or_else(|error| error.into_inner()).clone();
        json!({
            "providers": store.providers.iter().map(ProviderView::of).collect::<Vec<_>>(),
            "combos": store.combos,
            "counters": {
                "requests": counters.requests,
                "ok": counters.ok,
                "failed": counters.failed,
                "lastError": counters.last_error,
            },
        })
    }

    pub fn save_provider(&self, input: SaveProviderInput) -> Result<Value, RouterError> {
        let mut guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
        let existing = input
            .id
            .as_ref()
            .and_then(|id| guard.providers.iter().find(|provider| provider.id == *id).cloned());
        let mut record = store::sanitize_provider(&input, existing.as_ref())
            .map_err(RouterError::bad_request)?;
        if input.clear_secret {
            if let Some(entry_id) = record.secret_ref.take() {
                self.delete_secret(&entry_id);
            }
        }
        if let Some(secret) = input.api_key.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            record.secret_ref = Some(self.write_secret(
                record.secret_ref.as_deref(),
                &format!("ND Router · {}", record.name),
                &record.id,
                secret,
            )?);
        }
        if let Some(index) = guard.providers.iter().position(|provider| provider.id == record.id) {
            guard.providers[index] = record.clone();
        } else {
            guard.providers.push(record.clone());
        }
        store::save(&self.store_path, &guard).map_err(|error| RouterError::internal(error.to_string()))?;
        Ok(serde_json::to_value(ProviderView::of(&record)).unwrap_or(Value::Null))
    }

    pub fn delete_provider(&self, provider_id: &str) -> Result<Value, RouterError> {
        let mut guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
        let Some(index) = guard.providers.iter().position(|provider| provider.id == provider_id) else {
            return Err(RouterError::not_found("provider_not_found"));
        };
        let removed = guard.providers.remove(index);
        if let Some(entry_id) = removed.secret_ref.as_deref() {
            self.delete_secret(entry_id);
        }
        for account in &removed.accounts {
            if let Some(entry_id) = account.secret_ref.as_deref() {
                self.delete_secret(entry_id);
            }
        }
        for combo in &mut guard.combos {
            combo.models.retain(|entry| entry.provider_id != provider_id);
        }
        guard.combos.retain(|combo| !combo.models.is_empty());
        store::save(&self.store_path, &guard).map_err(|error| RouterError::internal(error.to_string()))?;
        Ok(json!({"deleted": true}))
    }

    pub fn save_account(&self, input: SaveAccountInput) -> Result<Value, RouterError> {
        let mut guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
        let Some(provider_index) = guard.providers.iter().position(|provider| provider.id == input.provider_id) else {
            return Err(RouterError::not_found("provider_not_found"));
        };
        let label = input.label.trim();
        if label.is_empty() || label.chars().count() > 80 {
            return Err(RouterError::bad_request("account label must be 1-80 characters"));
        }
        let kind = input.kind.as_deref().unwrap_or("api-key").trim().to_ascii_lowercase();
        if kind != "api-key" && kind != "cli" {
            return Err(RouterError::bad_request("account kind must be api-key or cli"));
        }
        let existing = input
            .id
            .as_ref()
            .and_then(|id| guard.providers[provider_index].accounts.iter().find(|account| account.id == *id).cloned());
        let mut record = AccountRecord {
            id: input
                .id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .or_else(|| existing.as_ref().map(|account| account.id.clone()))
                .unwrap_or_else(|| store::new_id("account")),
            label: label.to_owned(),
            kind,
            secret_ref: existing.as_ref().and_then(|account| account.secret_ref.clone()),
            env_dir: input.env_dir.clone().or_else(|| existing.as_ref().and_then(|account| account.env_dir.clone())),
            selector: input
                .selector
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .or_else(|| existing.as_ref().and_then(|account| account.selector.clone())),
            is_active: input.is_active.or_else(|| existing.as_ref().map(|account| account.is_active)).unwrap_or(true),
            priority: input.priority.or_else(|| existing.as_ref().map(|account| account.priority)).unwrap_or(0),
            cooldown_until_ms: existing.as_ref().and_then(|account| account.cooldown_until_ms),
            last_status: existing.as_ref().and_then(|account| account.last_status.clone()),
        };
        if input.clear_secret {
            if let Some(entry_id) = record.secret_ref.take() {
                self.delete_secret(&entry_id);
            }
        }
        if let Some(secret) = input.api_key.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            record.secret_ref = Some(self.write_secret(
                record.secret_ref.as_deref(),
                &format!("ND Router · {} · {}", guard.providers[provider_index].name, record.label),
                &record.id,
                secret,
            )?);
        }
        let accounts = &mut guard.providers[provider_index].accounts;
        if let Some(index) = accounts.iter().position(|account| account.id == record.id) {
            accounts[index] = record.clone();
        } else {
            accounts.push(record.clone());
        }
        store::save(&self.store_path, &guard).map_err(|error| RouterError::internal(error.to_string()))?;
        Ok(serde_json::to_value(AccountView::of(&record)).unwrap_or(Value::Null))
    }

    pub fn delete_account(&self, provider_id: &str, account_id: &str) -> Result<Value, RouterError> {
        let mut guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
        let Some(provider) = guard.providers.iter_mut().find(|provider| provider.id == provider_id) else {
            return Err(RouterError::not_found("provider_not_found"));
        };
        let Some(index) = provider.accounts.iter().position(|account| account.id == account_id) else {
            return Err(RouterError::not_found("account_not_found"));
        };
        let removed = provider.accounts.remove(index);
        if let Some(entry_id) = removed.secret_ref.as_deref() {
            self.delete_secret(entry_id);
        }
        store::save(&self.store_path, &guard).map_err(|error| RouterError::internal(error.to_string()))?;
        Ok(json!({"deleted": true}))
    }

    pub fn save_combo(&self, input: SaveComboInput) -> Result<Value, RouterError> {
        let mut guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
        if guard.combos.iter().any(|combo| combo.name == input.name.trim() && Some(&combo.id) != input.id.as_ref()) {
            return Err(RouterError::bad_request("a combo with that name already exists"));
        }
        let existing = input
            .id
            .as_ref()
            .and_then(|id| guard.combos.iter().find(|combo| combo.id == *id).cloned());
        let provider_ids: Vec<String> = guard.providers.iter().map(|provider| provider.id.clone()).collect();
        let record = store::sanitize_combo(&input, existing.as_ref(), &provider_ids)
            .map_err(RouterError::bad_request)?;
        if let Some(index) = guard.combos.iter().position(|combo| combo.id == record.id) {
            guard.combos[index] = record.clone();
        } else {
            guard.combos.push(record.clone());
        }
        store::save(&self.store_path, &guard).map_err(|error| RouterError::internal(error.to_string()))?;
        Ok(serde_json::to_value(&record).unwrap_or(Value::Null))
    }

    pub fn delete_combo(&self, combo_id: &str) -> Result<Value, RouterError> {
        let mut guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
        let Some(index) = guard.combos.iter().position(|combo| combo.id == combo_id) else {
            return Err(RouterError::not_found("combo_not_found"));
        };
        guard.combos.remove(index);
        store::save(&self.store_path, &guard).map_err(|error| RouterError::internal(error.to_string()))?;
        Ok(json!({"deleted": true}))
    }

    pub fn model_catalog(&self) -> Value {
        let guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
        let mut data = Vec::new();
        for combo in &guard.combos {
            data.push(json!({
                "id": combo.name,
                "object": "model",
                "owned_by": "nd-router",
                "nd_router_kind": "combo",
            }));
        }
        for provider in guard.providers.iter().filter(|provider| provider.is_active) {
            for model in &provider.models {
                data.push(json!({
                    "id": format!("{}/{}", provider.id, model),
                    "object": "model",
                    "owned_by": "nd-router",
                    "nd_router_kind": "provider",
                }));
            }
        }
        json!({"object": "list", "data": data})
    }

    pub fn resolve(&self, combo_hint: Option<&str>, model_hint: Option<&str>) -> Result<(String, Vec<RoutedEntry>), RouterError> {
        let mut guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
        let combo = combo_hint
            .and_then(|hint| find_combo(&guard.combos, hint))
            .or_else(|| model_hint.and_then(|hint| find_combo(&guard.combos, hint)))
            .or_else(|| guard.combos.first())
            .cloned();
        let mut entries = combo.as_ref().map(|combo| combo.models.clone()).unwrap_or_default();
        let strategy = combo.as_ref().map(|combo| combo.strategy.as_str()).unwrap_or(catalog::STRATEGY_PRIORITY);
        let combo_name = combo.as_ref().map(|combo| combo.name.clone()).unwrap_or_else(|| "default".to_owned());

        if entries.is_empty() {
            entries = guard
                .providers
                .iter()
                .filter(|provider| provider.is_active)
                .flat_map(|provider| {
                    provider.models.first().map(|model| crate::types::ComboEntry {
                        provider_id: provider.id.clone(),
                        model: model.clone(),
                        weight: None,
                        account_id: None,
                    })
                })
                .collect();
        }

        if let Some((provider_id, model)) = model_hint.and_then(|hint| hint.split_once('/')) {
            if guard.providers.iter().any(|provider| provider.id == provider_id) {
                entries = vec![crate::types::ComboEntry {
                    provider_id: provider_id.to_owned(),
                    model: model.to_owned(),
                    weight: None,
                    account_id: None,
                }];
            }
        }

        if strategy == catalog::STRATEGY_ROUND_ROBIN && entries.len() > 1 {
            let key = combo.as_ref().map(|combo| combo.id.clone()).unwrap_or_else(|| "default".to_owned());
            let index = guard.round_robin.entry(key).or_insert(0);
            let start = *index % entries.len();
            entries.rotate_left(start);
            *index = (*index + 1) % entries.len();
        }

        let now = store::now_ms();
        let mut routed = Vec::new();
        for entry in entries {
            let Some(provider) = guard.providers.iter().find(|provider| provider.id == entry.provider_id && provider.is_active).cloned() else {
                continue;
            };
            let mut accounts: Vec<AccountRecord> = provider
                .accounts
                .iter()
                .filter(|account| account.is_active)
                .filter(|account| account.cooldown_until_ms.map(|until| until <= now).unwrap_or(true))
                .filter(|account| entry.account_id.as_ref().map(|id| id == &account.id).unwrap_or(true))
                .cloned()
                .collect();
            accounts.sort_by(|left, right| right.priority.cmp(&left.priority));
            if strategy == catalog::STRATEGY_ROUND_ROBIN && accounts.len() > 1 {
                let key = format!("account:{}", provider.id);
                let index = guard.round_robin.entry(key).or_insert(0);
                let start = *index % accounts.len();
                accounts.rotate_left(start);
                *index = (*index + 1) % accounts.len();
            }
            if accounts.is_empty() {
                routed.push(RoutedEntry { provider, account: None, model: entry.model });
            } else {
                for account in accounts {
                    routed.push(RoutedEntry { provider: provider.clone(), account: Some(account), model: entry.model.clone() });
                }
            }
        }
        if routed.is_empty() {
            return Err(RouterError::bad_request("no active provider configured"));
        }
        Ok((combo_name, routed))
    }

    pub async fn chat(&self, mut body: Value, combo_hint: Option<&str>, path: &str) -> Result<Response, RouterError> {
        let model_hint = body.get("model").and_then(Value::as_str).map(ToOwned::to_owned);
        let streaming = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
        if let Some(object) = body.as_object_mut() {
            object.remove("combo");
        }
        let (combo_name, entries) = self.resolve(combo_hint, model_hint.as_deref())?;
        let mut last: Option<(u16, String)> = None;

        for entry in entries {
            if entry.provider.kind == catalog::KIND_ANTIGRAVITY {
                let messages = body.get("messages").and_then(Value::as_array);
                let prompt = crate::cli::prompt_from_messages(messages.map(Vec::as_slice).unwrap_or(&[]));
                if prompt.trim().is_empty() {
                    last = Some((400, "the antigravity lane needs messages".to_owned()));
                    continue;
                }
                let started = Instant::now();
                match crate::cli::run_antigravity(&entry.model, &prompt, entry.account.as_ref()).await {
                    Ok(completion) => {
                        self.record_usage(
                            &entry,
                            &combo_name,
                            path,
                            200,
                            true,
                            started.elapsed(),
                            None,
                            &json!({"messages": [{"role": "user", "content": prompt}]}),
                            completion.text.chars().count() as u64,
                        );
                        return if streaming {
                            Ok(cli_response(
                                StatusCode::OK,
                                crate::cli::sse_body(&entry.model, &completion),
                                "text/event-stream",
                            ))
                        } else {
                            Ok(cli_response(
                                StatusCode::OK,
                                crate::cli::completion_body(&entry.model, &completion).to_string(),
                                "application/json",
                            ))
                        };
                    }
                    Err(error) => {
                        let status = error.status.as_u16();
                        let message = error.message.clone();
                        self.record_usage(
                            &entry,
                            &combo_name,
                            path,
                            status,
                            false,
                            started.elapsed(),
                            Some(message.clone()),
                            &json!({"messages": [{"role": "user", "content": prompt}]}),
                            0,
                        );
                        self.mark_account_failure(&entry, status);
                        last = Some((status, message));
                        if !catalog::is_retryable_status(status) {
                            break;
                        }
                    }
                }
                continue;
            }
            if entry.provider.kind != catalog::KIND_OPENAI {
                last = Some((501, format!("{} lane is not implemented yet", entry.provider.kind)));
                continue;
            }
            let secret = self.entry_secret(&entry);
            let url = match catalog::join_provider_url(&entry.provider.base_url, path) {
                Ok(url) => url,
                Err(error) => {
                    last = Some((400, error));
                    continue;
                }
            };
            let mut payload = body.clone();
            if let Some(object) = payload.as_object_mut() {
                object.insert("model".to_owned(), Value::String(entry.model.clone()));
            }
            let started = Instant::now();
            let mut request = self.client.post(&url).header(CONTENT_TYPE, "application/json").json(&payload);
            if let Some(secret) = secret.as_deref().filter(|value| !value.is_empty()) {
                request = request.bearer_auth(secret);
            }
            match request.send().await {
                Ok(upstream) if upstream.status().is_success() => {
                    self.record_usage(&entry, &combo_name, path, upstream.status().as_u16(), true, started.elapsed(), None, &payload, 0);
                    return forward(upstream, streaming).await;
                }
                Ok(upstream) => {
                    let status = upstream.status().as_u16();
                    let text = upstream.text().await.unwrap_or_default();
                    let error = catalog::truncate(text.trim(), 300);
                    self.record_usage(&entry, &combo_name, path, status, false, started.elapsed(), Some(error.clone()), &payload, 0);
                    self.mark_account_failure(&entry, status);
                    last = Some((status, error));
                    if !catalog::is_retryable_status(status) {
                        break;
                    }
                }
                Err(error) => {
                    let message = format!("provider could not be reached: {error}");
                    self.record_usage(&entry, &combo_name, path, 502, false, started.elapsed(), Some(message.clone()), &payload, 0);
                    self.mark_account_failure(&entry, 502);
                    last = Some((502, message));
                }
            }
        }
        let (status, message) = last.unwrap_or((502, "no provider accepted the request".to_owned()));
        Err(RouterError {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            code: "upstream_failed",
            message: if message.is_empty() { "upstream rejected the request".to_owned() } else { message },
        })
    }

    pub async fn test_provider(&self, provider_id: &str) -> Result<Value, RouterError> {
        let (provider, model) = {
            let guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
            let provider = guard
                .providers
                .iter()
                .find(|provider| provider.id == provider_id)
                .cloned()
                .ok_or_else(|| RouterError::not_found("provider_not_found"))?;
            let model = provider.models.first().cloned().unwrap_or_else(|| "default".to_owned());
            (provider, model)
        };
        if provider.kind == catalog::KIND_ANTIGRAVITY {
            let started = Instant::now();
            return match crate::cli::run_antigravity(&model, "Reply with exactly: OK", None).await {
                Ok(completion) => Ok(json!({
                    "id": provider_id,
                    "ok": true,
                    "statusCode": 200,
                    "latencyMs": started.elapsed().as_millis() as u64,
                    "model": model,
                    "error": Value::Null,
                    "preview": catalog::truncate(completion.text.trim(), 80),
                })),
                Err(error) => Ok(json!({
                    "id": provider_id,
                    "ok": false,
                    "statusCode": error.status.as_u16(),
                    "latencyMs": started.elapsed().as_millis() as u64,
                    "model": model,
                    "error": error.message,
                })),
            };
        }
        if provider.kind != catalog::KIND_OPENAI {
            return Ok(json!({
                "id": provider_id,
                "ok": false,
                "statusCode": 501,
                "latencyMs": 0,
                "model": model,
                "error": format!("{} lane is not implemented yet", provider.kind),
            }));
        }
        let entry = RoutedEntry { provider: provider.clone(), account: None, model: model.clone() };
        let body = json!({
            "model": model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 5,
            "stream": false,
        });
        let url = match catalog::join_provider_url(&provider.base_url, "/v1/chat/completions") {
            Ok(url) => url,
            Err(error) => {
                return Ok(json!({"id": provider_id, "ok": false, "statusCode": 400, "latencyMs": 0, "model": model, "error": error}));
            }
        };
        let started = Instant::now();
        let mut request = self.client.post(&url).header(CONTENT_TYPE, "application/json").json(&body);
        if let Some(secret) = self.entry_secret(&entry).filter(|value| !value.is_empty()) {
            request = request.bearer_auth(secret);
        }
        match request.send().await {
            Ok(upstream) => {
                let status = upstream.status().as_u16();
                let ok = upstream.status().is_success();
                let error = if ok { None } else { Some(catalog::truncate(&upstream.text().await.unwrap_or_default(), 300)) };
                Ok(json!({
                    "id": provider_id,
                    "ok": ok,
                    "statusCode": status,
                    "latencyMs": started.elapsed().as_millis() as u64,
                    "model": model,
                    "error": error,
                }))
            }
            Err(error) => Ok(json!({
                "id": provider_id,
                "ok": false,
                "statusCode": 502,
                "latencyMs": started.elapsed().as_millis() as u64,
                "model": model,
                "error": format!("provider could not be reached: {error}"),
            })),
        }
    }

    pub fn usage_summary(&self) -> Value {
        let counters = self.counters.lock().unwrap_or_else(|error| error.into_inner()).clone();
        let mut total = 0u64;
        let mut ok = 0u64;
        let mut failed = 0u64;
        let mut latency_total = 0u64;
        let mut by_provider: HashMap<String, u64> = HashMap::new();
        if let Ok(file) = std::fs::File::open(self.data_dir.join(USAGE_FILE)) {
            for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
                let Ok(entry) = serde_json::from_str::<UsageEntry>(&line) else { continue };
                total += 1;
                if entry.ok { ok += 1 } else { failed += 1 }
                latency_total += entry.latency_ms;
                *by_provider.entry(entry.provider).or_insert(0) += 1;
            }
        }
        json!({
            "requests": total,
            "ok": ok,
            "failed": failed,
            "avgLatencyMs": if total == 0 { 0 } else { latency_total / total },
            "byProvider": by_provider,
            "session": {
                "requests": counters.requests,
                "ok": counters.ok,
                "failed": counters.failed,
                "lastError": counters.last_error,
            },
        })
    }

    pub fn reset_usage(&self) -> Result<Value, RouterError> {
        let path = self.data_dir.join(USAGE_FILE);
        std::fs::write(&path, "").map_err(|error| RouterError::internal(error.to_string()))?;
        *self.counters.lock().unwrap_or_else(|error| error.into_inner()) = Counters::default();
        Ok(json!({"reset": true}))
    }

    fn entry_secret(&self, entry: &RoutedEntry) -> Option<String> {
        let entry_id = entry
            .account
            .as_ref()
            .and_then(|account| account.secret_ref.clone())
            .or_else(|| entry.provider.secret_ref.clone())?;
        self.read_secret(&entry_id)
    }

    fn read_secret(&self, entry_id: &str) -> Option<String> {
        self.vault
            .get(VaultIdParams { vault_path: self.vault_path.to_string_lossy().to_string(), id: entry_id.to_owned() })
            .ok()
            .map(|result| result.entry.secret)
            .filter(|secret| !secret.is_empty())
    }

    fn write_secret(&self, existing: Option<&str>, title: &str, username: &str, secret: &str) -> Result<String, RouterError> {
        let vault_path = self.vault_path.to_string_lossy().to_string();
        if let Some(entry_id) = existing {
            let entry = VaultEntryInput {
                title: title.to_owned(),
                username: username.to_owned(),
                url: String::new(),
                notes: "Managed by ND Router".to_owned(),
                secret: secret.to_owned(),
            };
            if let Ok(updated) = self.vault.update(VaultUpdateParams { vault_path: vault_path.clone(), id: entry_id.to_owned(), entry }) {
                return Ok(updated.entry.id);
            }
        }
        let created = self
            .vault
            .create(VaultWriteParams {
                vault_path,
                entry: VaultEntryInput {
                    title: title.to_owned(),
                    username: username.to_owned(),
                    url: String::new(),
                    notes: "Managed by ND Router".to_owned(),
                    secret: secret.to_owned(),
                },
            })
            .map_err(|error| RouterError::internal(format!("secret store: {error:#}")))?;
        Ok(created.entry.id)
    }

    fn delete_secret(&self, entry_id: &str) {
        let _ = self.vault.delete(VaultIdParams {
            vault_path: self.vault_path.to_string_lossy().to_string(),
            id: entry_id.to_owned(),
        });
    }

    fn mark_account_failure(&self, entry: &RoutedEntry, status: u16) {
        if !catalog::is_retryable_status(status) {
            return;
        }
        let Some(account) = entry.account.as_ref() else { return };
        let mut guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
        let Some(provider) = guard.providers.iter_mut().find(|provider| provider.id == entry.provider.id) else { return };
        let Some(record) = provider.accounts.iter_mut().find(|candidate| candidate.id == account.id) else { return };
        record.cooldown_until_ms = Some(store::now_ms() + catalog::cooldown_ms_for_status(status));
        record.last_status = Some(format!("HTTP {status}"));
        let _ = store::save(&self.store_path, &guard);
    }

    fn record_usage(
        &self,
        entry: &RoutedEntry,
        combo: &str,
        endpoint: &str,
        status: u16,
        ok: bool,
        latency: Duration,
        error: Option<String>,
        payload: &Value,
        completion_chars: u64,
    ) {
        {
            let mut counters = self.counters.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            counters.requests += 1;
            if ok { counters.ok += 1 } else {
                counters.failed += 1;
                counters.last_error = error.clone();
            }
        }
        let usage = UsageEntry {
            ts_ms: store::now_ms(),
            combo: combo.to_owned(),
            provider: entry.provider.name.clone(),
            account: entry.account.as_ref().map(|account| account.label.clone()),
            model: entry.model.clone(),
            endpoint: endpoint.to_owned(),
            status,
            ok,
            latency_ms: latency.as_millis() as u64,
            error,
            prompt_chars: text_chars(payload),
            completion_chars,
        };
        let path = self.data_dir.join(USAGE_FILE);
        let Ok(line) = serde_json::to_string(&usage) else { return };
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(file, "{line}");
        }
        if std::fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0) > 4 * 1024 * 1024 {
            prune_usage(&path);
        }
    }
}

fn find_combo<'a>(combos: &'a [ComboRecord], hint: &str) -> Option<&'a ComboRecord> {
    let trimmed = hint.trim();
    let normalized = trimmed.strip_prefix("combo:").unwrap_or(trimmed);
    combos.iter().find(|combo| combo.id == normalized || combo.name == normalized)
}

fn cli_response(status: StatusCode, body: String, content_type: &str) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    if let Ok(value) = HeaderValue::from_str(content_type) {
        response.headers_mut().insert(CONTENT_TYPE, value);
    }
    response
}

async fn forward(upstream: reqwest::Response, wants_stream: bool) -> Result<Response, RouterError> {
    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream.headers().get(CONTENT_TYPE).and_then(|value| value.to_str().ok()).map(ToOwned::to_owned);
    let is_sse = content_type.as_deref().is_some_and(|value| value.starts_with("text/event-stream"));
    if wants_stream && is_sse {
        let stream = upstream.bytes_stream().map_err(std::io::Error::other);
        let mut response = Response::new(Body::from_stream(stream));
        *response.status_mut() = status;
        response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
        return Ok(response);
    }
    let bytes = upstream.bytes().await.map_err(|error| RouterError::bad_gateway(error.to_string()))?;
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    if let Some(content_type) = content_type.and_then(|value| HeaderValue::from_str(&value).ok()) {
        response.headers_mut().insert(CONTENT_TYPE, content_type);
    }
    Ok(response)
}

fn text_chars(value: &Value) -> u64 {
    match value {
        Value::String(text) => text.chars().count() as u64,
        Value::Array(items) => items.iter().map(text_chars).sum(),
        Value::Object(map) => map.values().map(text_chars).sum(),
        _ => 0,
    }
}

fn prune_usage(path: &std::path::Path) {
    let Ok(file) = std::fs::File::open(path) else { return };
    let lines: Vec<String> = std::io::BufReader::new(file).lines().map_while(Result::ok).collect();
    let keep = lines.len().saturating_sub(MAX_USAGE_LINES);
    if keep == 0 {
        return;
    }
    let _ = std::fs::write(path, lines[keep..].join("\n") + "\n");
}

pub fn store_version() -> u32 {
    STORE_SCHEMA_VERSION
}
