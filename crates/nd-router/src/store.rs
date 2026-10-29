use crate::catalog;
use crate::types::{
    ComboEntry, ComboRecord, PersistedStore, ProviderRecord, SaveComboInput, SaveProviderInput,
    STORE_SCHEMA_VERSION,
};
use std::path::Path;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
}

pub fn load(path: &Path) -> PersistedStore {
    let Ok(bytes) = std::fs::read(path) else {
        return PersistedStore { schema_version: STORE_SCHEMA_VERSION, ..Default::default() };
    };
    let Ok(mut store) = serde_json::from_slice::<PersistedStore>(&bytes) else {
        return PersistedStore { schema_version: STORE_SCHEMA_VERSION, ..Default::default() };
    };
    if store.schema_version != STORE_SCHEMA_VERSION {
        return PersistedStore { schema_version: STORE_SCHEMA_VERSION, ..Default::default() };
    }
    for provider in &mut store.providers {
        provider.id = provider.id.trim().to_owned();
        provider.name = provider.name.trim().to_owned();
        provider.base_url = provider.base_url.trim().to_owned();
        provider.models = sanitize_models(std::mem::take(&mut provider.models));
    }
    store.providers.retain(|provider| !provider.id.is_empty());
    store.combos.retain(|combo| !combo.id.is_empty() && !combo.name.is_empty());
    store
}

pub fn save(path: &Path, store: &PersistedStore) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&temp, format!("{}\n", serde_json::to_string_pretty(store)?))?;
    std::fs::rename(&temp, path)?;
    Ok(())
}

pub fn sanitize_provider(
    input: &SaveProviderInput,
    existing: Option<&ProviderRecord>,
) -> Result<ProviderRecord, String> {
    let kind = catalog::normalize_kind(input.kind.as_deref().unwrap_or_else(|| {
        existing.map(|record| record.kind.as_str()).unwrap_or(catalog::KIND_OPENAI)
    }))?;
    let id = input
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| existing.map(|record| record.id.clone()))
        .unwrap_or_else(|| new_id("provider"));
    if id.len() > 64 || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_')) {
        return Err("provider id may only contain letters, digits, - and _".to_owned());
    }
    let base_url = input
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| existing.map(|record| record.base_url.clone()))
        .unwrap_or_default();
    if catalog::requires_base_url(&kind) && base_url.is_empty() {
        return Err("baseUrl is required for an OpenAI-compatible provider".to_owned());
    }
    if !base_url.is_empty() {
        catalog::join_provider_url(&base_url, "/v1/chat/completions")?;
    }
    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| existing.map(|record| record.name.clone()))
        .unwrap_or_else(|| default_name(&kind));
    if name.chars().count() > 80 {
        return Err("provider name is too long".to_owned());
    }
    let models = match &input.models {
        Some(models) => sanitize_models(models.clone()),
        None => existing.map(|record| record.models.clone()).unwrap_or_default(),
    };
    let models = if models.is_empty() { default_models(&kind) } else { models };
    Ok(ProviderRecord {
        id,
        kind,
        name,
        base_url,
        models,
        is_active: input.is_active.or_else(|| existing.map(|record| record.is_active)).unwrap_or(true),
        priority: input.priority.or_else(|| existing.map(|record| record.priority)).unwrap_or(0),
        secret_ref: existing.and_then(|record| record.secret_ref.clone()),
        accounts: existing.map(|record| record.accounts.clone()).unwrap_or_default(),
        metadata: existing.map(|record| record.metadata.clone()).unwrap_or_else(|| serde_json::json!({})),
    })
}

pub fn sanitize_combo(
    input: &SaveComboInput,
    existing: Option<&ComboRecord>,
    providers: &[ProviderRecord],
) -> Result<ComboRecord, String> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err("combo name must be 1-64 characters".to_owned());
    }
    let id = input
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| existing.map(|record| record.id.clone()))
        .unwrap_or_else(|| new_id("combo"));
    let mut models: Vec<ComboEntry> = Vec::new();
    for entry in &input.models {
        let provider_id = entry.provider_id.trim();
        if provider_id.is_empty() || !providers.iter().any(|provider| provider.id == provider_id) {
            return Err(format!("combo entry references an unknown provider: {provider_id}"));
        }
        let model = entry.model.trim();
        if model.is_empty() || model.chars().count() > 200 {
            return Err("combo entry model must be 1-200 characters".to_owned());
        }
        if models.len() >= 20 {
            return Err("a combo supports at most 20 entries".to_owned());
        }
        models.push(ComboEntry {
            provider_id: provider_id.to_owned(),
            model: model.to_owned(),
            weight: entry.weight,
            account_id: entry.account_id.as_ref().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty()),
        });
    }
    if models.is_empty() {
        return Err("a combo needs at least one provider/model entry".to_owned());
    }
    // Web-lane combos are private unless the caller explicitly says otherwise.
    // They still resolve by name through /v1; only the personal picker skips them.
    let includes_web_lane = models.iter().any(|entry| {
        providers
            .iter()
            .any(|provider| provider.id == entry.provider_id && catalog::is_web_kind(&provider.kind))
    });
    let hidden_from_chat = input
        .hidden_from_chat
        .or_else(|| existing.map(|record| record.hidden_from_chat))
        .unwrap_or(includes_web_lane);
    Ok(ComboRecord {
        id,
        name: name.to_owned(),
        strategy: catalog::normalize_strategy(input.strategy.as_deref()),
        models,
        config: existing.map(|record| record.config.clone()).unwrap_or_else(|| serde_json::json!({})),
        hidden_from_chat,
    })
}

fn sanitize_models(models: Vec<String>) -> Vec<String> {
    let mut sanitized = Vec::new();
    for model in models {
        let trimmed = model.trim();
        if trimmed.is_empty() || trimmed.chars().count() > 200 || sanitized.len() >= 60 {
            continue;
        }
        if !sanitized.iter().any(|existing: &String| existing == trimmed) {
            sanitized.push(trimmed.to_owned());
        }
    }
    sanitized
}

fn default_name(kind: &str) -> String {
    match kind {
        catalog::KIND_ANTIGRAVITY => "Antigravity".to_owned(),
        catalog::KIND_GEMINI_CLI => "Gemini CLI".to_owned(),
        catalog::KIND_QODER => "Qoder CLI".to_owned(),
        catalog::KIND_CHATGPT_WEB => "ChatGPT Web".to_owned(),
        catalog::KIND_GEMINI_WEB => "Gemini Web".to_owned(),
        _ => "OpenAI-compatible".to_owned(),
    }
}

fn default_models(kind: &str) -> Vec<String> {
    match kind {
        catalog::KIND_CHATGPT_WEB => vec!["default".to_owned()],
        catalog::KIND_GEMINI_WEB => vec![
            "3.5 Flash-Lite".to_owned(),
            "3.8 Flash".to_owned(),
            "3.1 Pro".to_owned(),
            "4 Argon".to_owned(),
        ],
        _ => Vec::new(),
    }
}
