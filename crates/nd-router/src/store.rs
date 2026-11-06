use crate::catalog;
use crate::types::{
    ComboEntry, ComboRecord, PersistedStore, ProviderRecord, STORE_SCHEMA_VERSION, SaveComboInput,
    SaveProviderInput,
};
use std::path::Path;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

pub fn new_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    )
}

pub fn load(path: &Path) -> PersistedStore {
    let Ok(bytes) = std::fs::read(path) else {
        return PersistedStore {
            schema_version: STORE_SCHEMA_VERSION,
            ..Default::default()
        };
    };
    let Ok(mut store) = serde_json::from_slice::<PersistedStore>(&bytes) else {
        return PersistedStore {
            schema_version: STORE_SCHEMA_VERSION,
            ..Default::default()
        };
    };
    if store.schema_version != STORE_SCHEMA_VERSION {
        return PersistedStore {
            schema_version: STORE_SCHEMA_VERSION,
            ..Default::default()
        };
    }
    for provider in &mut store.providers {
        provider.id = provider.id.trim().to_owned();
        provider.name = provider.name.trim().to_owned();
        provider.base_url = provider.base_url.trim().to_owned();
        provider.models = sanitize_models(std::mem::take(&mut provider.models));
    }
    store.providers.retain(|provider| !provider.id.is_empty());
    store
        .combos
        .retain(|combo| !combo.id.is_empty() && !combo.name.is_empty());
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
        existing
            .map(|record| record.kind.as_str())
            .unwrap_or(catalog::KIND_OPENAI)
    }))?;
    let id = input
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| existing.map(|record| record.id.clone()))
        .unwrap_or_else(|| new_id("provider"));
    if id.len() > 64
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err("provider id may only contain letters, digits, - and _".to_owned());
    }
    let base_url = input
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| existing.map(|record| record.base_url.clone()))
        .unwrap_or_else(|| default_base_url(&kind));
    if catalog::requires_base_url(&kind) && base_url.is_empty() {
        return Err("baseUrl is required for an OpenAI-compatible provider".to_owned());
    }
    if !base_url.is_empty() {
        if catalog::is_tts_kind(&kind) {
            let parsed =
                url::Url::parse(&base_url).map_err(|_| "baseUrl is not a valid URL".to_owned())?;
            if !matches!(parsed.scheme(), "ws" | "wss" | "http" | "https") {
                return Err("TTS baseUrl must use ws, wss, http, or https".to_owned());
            }
        } else {
            catalog::join_provider_url(&base_url, "/v1/chat/completions")?;
        }
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
        None => existing
            .map(|record| record.models.clone())
            .unwrap_or_default(),
    };
    let models = if models.is_empty() {
        default_models(&kind)
    } else {
        models
    };
    Ok(ProviderRecord {
        id,
        kind,
        name,
        base_url,
        models,
        is_active: input
            .is_active
            .or_else(|| existing.map(|record| record.is_active))
            .unwrap_or(true),
        priority: input
            .priority
            .or_else(|| existing.map(|record| record.priority))
            .unwrap_or(0),
        secret_ref: existing.and_then(|record| record.secret_ref.clone()),
        accounts: existing
            .map(|record| record.accounts.clone())
            .unwrap_or_default(),
        metadata: existing
            .map(|record| record.metadata.clone())
            .unwrap_or_else(|| serde_json::json!({})),
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
            return Err(format!(
                "combo entry references an unknown provider: {provider_id}"
            ));
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
            account_id: entry
                .account_id
                .as_ref()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty()),
        });
    }
    if models.is_empty() {
        return Err("a combo needs at least one provider/model entry".to_owned());
    }
    // Web-lane combos are private unless the caller explicitly says otherwise.
    // They still resolve by name through /v1; only the personal picker skips them.
    let includes_web_lane = models.iter().any(|entry| {
        providers.iter().any(|provider| {
            provider.id == entry.provider_id && catalog::is_web_kind(&provider.kind)
        })
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
        config: existing
            .map(|record| record.config.clone())
            .unwrap_or_else(|| serde_json::json!({})),
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
        if !sanitized
            .iter()
            .any(|existing: &String| existing == trimmed)
        {
            sanitized.push(trimmed.to_owned());
        }
    }
    sanitized
}

fn default_name(kind: &str) -> String {
    match kind {
        catalog::KIND_AI_STUDIO => "Google AI Studio".to_owned(),
        catalog::KIND_AI_STUDIO_WEB => "Google AI Studio Web".to_owned(),
        catalog::KIND_POLLINATIONS => "Pollinations AI (Free)".to_owned(),
        catalog::KIND_OVH_KEPLER => "OVH Kepler Cloud (Free)".to_owned(),
        catalog::KIND_FREE_AI => "Free.ai (Free)".to_owned(),
        catalog::KIND_KILO => "Kilo Gateway (Free)".to_owned(),
        catalog::KIND_ANTIGRAVITY => "Antigravity".to_owned(),
        catalog::KIND_GEMINI_CLI => "Gemini CLI".to_owned(),
        catalog::KIND_QODER => "Qoder CLI".to_owned(),
        catalog::KIND_CODEX_CLI => "Codex CLI".to_owned(),
        catalog::KIND_CLAUDE_CLI => "Claude Code CLI".to_owned(),
        catalog::KIND_PI_CLI => "Pi CLI".to_owned(),
        catalog::KIND_ZCODE_CLI => "ZCode CLI".to_owned(),
        catalog::KIND_CURSOR_CLI => "Cursor CLI".to_owned(),
        catalog::KIND_OPENCODE_CLI => "OpenCode CLI".to_owned(),
        catalog::KIND_GOOSE_CLI => "Goose CLI".to_owned(),
        catalog::KIND_HERMES_CLI => "Hermes CLI".to_owned(),
        catalog::KIND_JCODE_CLI => "JCode CLI".to_owned(),
        catalog::KIND_MINIMAX_CLI => "MiniMax CLI".to_owned(),
        catalog::KIND_TRAE_CLI => "Trae CLI".to_owned(),
        catalog::KIND_CHATGPT_WEB => "ChatGPT Web".to_owned(),
        catalog::KIND_GEMINI_WEB => "Gemini Web".to_owned(),
        catalog::KIND_DEEPSEEK_WEB => "DeepSeek Web".to_owned(),
        catalog::KIND_GROK_WEB => "Grok Web".to_owned(),
        catalog::KIND_QWEN_WEB => "Qwen Web".to_owned(),
        catalog::KIND_ZAI_WEB => "Z.ai Web".to_owned(),
        catalog::KIND_MISTRAL_WEB => "Mistral Web".to_owned(),
        catalog::KIND_PERPLEXITY_WEB => "Perplexity Web".to_owned(),
        catalog::KIND_POE_WEB => "Poe Web".to_owned(),
        catalog::KIND_ARENA_WEB => "Arena AI Web".to_owned(),
        catalog::KIND_META_WEB => "Meta AI Web".to_owned(),
        catalog::KIND_DUCK_WEB => "Duck.ai Web".to_owned(),
        catalog::KIND_EDGE_TTS => "Edge TTS (Free)".to_owned(),
        _ => "OpenAI-compatible".to_owned(),
    }
}

fn default_models(kind: &str) -> Vec<String> {
    match kind {
        catalog::KIND_AI_STUDIO => vec![
            "gemini-2.5-flash".to_owned(),
            "gemini-2.5-pro".to_owned(),
            "gemini-2.0-flash".to_owned(),
            "gemini-2.0-pro".to_owned(),
            "gemini-1.5-flash".to_owned(),
            "gemini-1.5-pro".to_owned(),
        ],
        catalog::KIND_AI_STUDIO_WEB => vec![
            "default".to_owned(),
            "gemini-2.5-flash".to_owned(),
            "gemini-2.5-pro".to_owned(),
        ],
        catalog::KIND_POLLINATIONS => vec!["openai-fast".to_owned()],
        catalog::KIND_OVH_KEPLER => vec![
            "gpt-oss-120b".to_owned(),
            "Qwen3.6-27B".to_owned(),
            "Qwen2.5-VL-72B-Instruct".to_owned(),
            "Mistral-Small-3.2-24B-Instruct-2506".to_owned(),
            "Meta-Llama-3_3-70B-Instruct".to_owned(),
        ],
        catalog::KIND_FREE_AI => vec![
            "qwen3-coder".to_owned(),
            "qwen25-vl".to_owned(),
            "deepseek-r1-7b".to_owned(),
            "deepseek-r1".to_owned(),
            "mistral".to_owned(),
        ],
        catalog::KIND_KILO => vec![
            "openrouter/free".to_owned(),
            "cohere/north-mini-code:free".to_owned(),
            "kilo-auto/small".to_owned(),
            "nvidia/nemotron-3.5-lightning:free".to_owned(),
        ],
        catalog::KIND_CODEX_CLI => {
            vec!["default".to_owned(), "o3-mini".to_owned(), "o1".to_owned()]
        }
        catalog::KIND_CLAUDE_CLI => vec![
            "default".to_owned(),
            "claude-3-7-sonnet".to_owned(),
            "claude-3-5-sonnet".to_owned(),
        ],
        catalog::KIND_PI_CLI => vec!["default".to_owned()],
        catalog::KIND_ZCODE_CLI => vec!["default".to_owned(), "deepseek-r1".to_owned()],
        catalog::KIND_CURSOR_CLI => vec!["default".to_owned(), "claude-3-7-sonnet".to_owned()],
        catalog::KIND_OPENCODE_CLI => vec!["default".to_owned()],
        catalog::KIND_GOOSE_CLI => vec!["default".to_owned()],
        catalog::KIND_HERMES_CLI => vec!["default".to_owned()],
        catalog::KIND_JCODE_CLI => vec!["default".to_owned()],
        catalog::KIND_MINIMAX_CLI => vec!["default".to_owned(), "MiniMax-Text-01".to_owned()],
        catalog::KIND_TRAE_CLI => vec![
            "default".to_owned(),
            "agent".to_owned(),
            "ask".to_owned(),
            "edit".to_owned(),
        ],
        catalog::KIND_CHATGPT_WEB => vec!["default".to_owned()],
        catalog::KIND_GEMINI_WEB => vec![
            "3.5 Flash-Lite".to_owned(),
            "3.8 Flash".to_owned(),
            "3.1 Pro".to_owned(),
            "4 Argon".to_owned(),
        ],
        catalog::KIND_DEEPSEEK_WEB => vec!["default".to_owned(), "deep-think".to_owned()],
        catalog::KIND_GROK_WEB => vec![
            "default".to_owned(),
            "grok-3".to_owned(),
            "grok-2".to_owned(),
            "deepsearch".to_owned(),
            "think".to_owned(),
        ],
        catalog::KIND_QWEN_WEB => vec![
            "default".to_owned(),
            "qwen-max".to_owned(),
            "qwen-plus".to_owned(),
            "qwen-turbo".to_owned(),
            "qwen-coder".to_owned(),
        ],
        catalog::KIND_ZAI_WEB => vec![
            "default".to_owned(),
            "glm-4-plus".to_owned(),
            "glm-4-air".to_owned(),
            "glm-4-flash".to_owned(),
        ],
        catalog::KIND_MISTRAL_WEB => vec![
            "default".to_owned(),
            "mistral-large".to_owned(),
            "mistral-small".to_owned(),
            "codestral".to_owned(),
        ],
        catalog::KIND_PERPLEXITY_WEB => vec![
            "default".to_owned(),
            "sonar".to_owned(),
            "sonar-pro".to_owned(),
            "sonar-reasoning".to_owned(),
        ],
        catalog::KIND_POE_WEB => vec![
            "default".to_owned(),
            "assistant".to_owned(),
            "web-search".to_owned(),
        ],
        catalog::KIND_ARENA_WEB => vec![
            "default".to_owned(),
            "battle".to_owned(),
            "side-by-side".to_owned(),
            "direct-chat".to_owned(),
        ],
        catalog::KIND_META_WEB => vec![
            "default".to_owned(),
            "llama-3.3".to_owned(),
            "imagine".to_owned(),
        ],
        catalog::KIND_DUCK_WEB => vec![
            "default".to_owned(),
            "gpt-4o-mini".to_owned(),
            "claude-3-haiku".to_owned(),
            "llama-3.3-70b".to_owned(),
        ],
        catalog::KIND_EDGE_TTS => vec![
            "en-US-AriaNeural".to_owned(),
            "en-US-AvaMultilingualNeural".to_owned(),
            "en-US-GuyNeural".to_owned(),
            "en-US-JennyNeural".to_owned(),
            "en-GB-SoniaNeural".to_owned(),
            "zh-CN-XiaoxiaoNeural".to_owned(),
            "ja-JP-NanamiNeural".to_owned(),
            "km-KH-SreymomNeural".to_owned(),
            "km-KH-PisethNeural".to_owned(),
        ],
        _ => Vec::new(),
    }
}

fn default_base_url(kind: &str) -> String {
    match kind {
        catalog::KIND_AI_STUDIO => {
            "https://generativelanguage.googleapis.com/v1beta/openai/".to_owned()
        }
        catalog::KIND_POLLINATIONS => "https://text.pollinations.ai/v1".to_owned(),
        catalog::KIND_OVH_KEPLER => "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1".to_owned(),
        catalog::KIND_FREE_AI => "https://api.free.ai/v1".to_owned(),
        catalog::KIND_KILO => "https://api.kilo.ai/api/gateway/v1".to_owned(),
        _ => String::new(),
    }
}

pub const DEFAULT_EDGE_TTS_PROVIDER_ID: &str = "edge-tts";

pub fn default_edge_tts_provider() -> ProviderRecord {
    ProviderRecord {
        id: DEFAULT_EDGE_TTS_PROVIDER_ID.to_owned(),
        kind: catalog::KIND_EDGE_TTS.to_owned(),
        name: default_name(catalog::KIND_EDGE_TTS),
        base_url: String::new(),
        models: default_models(catalog::KIND_EDGE_TTS),
        is_active: true,
        priority: 100,
        secret_ref: None,
        accounts: Vec::new(),
        metadata: serde_json::json!({}),
    }
}

/// Seed `edge-tts` as the first default TTS provider when a store is initialized
/// for the first time (or upgraded from a pre-TTS store). If the user later
/// removes or disables it, `default_tts_seeded` remains true so their choice sticks.
pub fn ensure_default_tts_provider(store: &mut PersistedStore) -> bool {
    if store.default_tts_seeded {
        return false;
    }
    store.default_tts_seeded = true;
    let already_has_edge = store.providers.iter().any(|provider| {
        provider.kind == catalog::KIND_EDGE_TTS || provider.id == DEFAULT_EDGE_TTS_PROVIDER_ID
    });
    if !already_has_edge {
        store.providers.insert(0, default_edge_tts_provider());
    }
    true
}
