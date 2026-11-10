//! Realtime Gemini Live API (`BidiGenerateContent`) lane for ND Router.
//!
//! Keeps Google AI Studio credentials strictly inside the Rust router: callers
//! obtain a single-use, short-lived loopback ticket via `router.createLiveTicket`
//! and connect over `ws://127.0.0.1:<port>/v1/live?ticket=...`. The router
//! authors the upstream `setup` message itself, enforces an allowlist on
//! client-to-upstream frames, caps session duration and concurrency, and closes
//! immediately if Safe Mode is enabled.

use crate::RouterState;
use crate::catalog;
use crate::store;
use crate::types::{CreateLiveTicketInput, LiveToolSpec, RoutedEntry, RouterError};
use axum::extract::ws::{CloseFrame, Message as AxumMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as UpstreamMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

pub const LIVE_MODELS: &[&str] = &["gemini-3.8-live", "gemini-3.8-live-extended-thinking"];
pub const DEFAULT_LIVE_MODEL: &str = "gemini-3.8-live";
pub const DEFAULT_LIVE_UPSTREAM: &str = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const LIVE_TICKET_TTL: Duration = Duration::from_secs(60);
const MAX_PENDING_TICKETS: usize = 4;
const MAX_CONCURRENT_LIVE: usize = 1;
const MAX_SYSTEM_BYTES: usize = 16 * 1024;
const MAX_TOOLS: usize = 8;
const MAX_TOOL_DESC_CHARS: usize = 512;
const MAX_TOOL_PARAMS_BYTES: usize = 2048;
const MAX_CLIENT_FRAME_BYTES: usize = 256 * 1024;
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_SESSION_DURATION: Duration = Duration::from_secs(15 * 60);
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(12);

const ALLOWED_CLIENT_KEYS: &[&str] = &["realtimeInput", "clientContent", "toolResponse"];

#[derive(Clone, Debug)]
pub struct PendingLiveTicket {
    pub expires_at: Instant,
    pub model: String,
    pub setup_payload: String,
    pub api_key: String,
    pub entry: RoutedEntry,
}

#[derive(Default)]
pub struct LiveTicketStore {
    tickets: Mutex<HashMap<String, PendingLiveTicket>>,
}

impl LiveTicketStore {
    pub fn issue(&self, pending: PendingLiveTicket) -> Result<(String, u64), RouterError> {
        let now = Instant::now();
        let mut guard = self
            .tickets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.retain(|_, ticket| ticket.expires_at > now);
        if guard.len() >= MAX_PENDING_TICKETS {
            return Err(RouterError::conflict(
                "too many pending live session tickets; wait a moment and try again",
            ));
        }
        let token = format!("ndlive_{}", uuid::Uuid::new_v4().simple());
        let expires_at_ms = store::now_ms() + LIVE_TICKET_TTL.as_millis() as u64;
        guard.insert(token.clone(), pending);
        Ok((token, expires_at_ms))
    }

    pub fn consume(&self, candidate: &str) -> Option<PendingLiveTicket> {
        let trimmed = candidate.trim();
        if trimmed.is_empty() {
            return None;
        }
        let now = Instant::now();
        let mut guard = self
            .tickets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.retain(|_, ticket| ticket.expires_at > now);
        let matched_key = guard
            .keys()
            .find(|key| crate::state::constant_time_eq(key.as_bytes(), trimmed.as_bytes()))
            .cloned()?;
        guard.remove(&matched_key)
    }
}

#[derive(Deserialize)]
pub struct LiveUpgradeQuery {
    #[serde(default)]
    ticket: String,
}

pub fn is_live_model(model: &str) -> bool {
    let trimmed = model.trim();
    let stripped = trimmed.strip_prefix("models/").unwrap_or(trimmed);
    LIVE_MODELS.contains(&stripped)
}

pub fn normalize_live_model(model: Option<&str>) -> Result<String, RouterError> {
    let raw = model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_LIVE_MODEL);
    let stripped = raw.strip_prefix("models/").unwrap_or(raw);
    if !LIVE_MODELS.contains(&stripped) {
        return Err(RouterError::bad_request(format!(
            "unsupported live model '{raw}'; expected one of: {}",
            LIVE_MODELS.join(", ")
        )));
    }
    Ok(stripped.to_owned())
}

fn validate_voice(voice: Option<&str>) -> Result<Option<String>, RouterError> {
    let Some(raw) = voice.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if raw.len() > 32
        || !raw
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(RouterError::bad_request("invalid live voice identifier"));
    }
    Ok(Some(raw.to_owned()))
}

fn validate_tools(tools: &[LiveToolSpec]) -> Result<Vec<Value>, RouterError> {
    if tools.len() > MAX_TOOLS {
        return Err(RouterError::bad_request(format!(
            "at most {MAX_TOOLS} live tools are permitted"
        )));
    }
    let mut declarations = Vec::with_capacity(tools.len());
    for tool in tools {
        let name = tool.name.trim();
        if name.is_empty()
            || name.len() > 48
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        {
            return Err(RouterError::bad_request(format!(
                "invalid live tool name '{name}'"
            )));
        }
        let desc = tool.description.trim();
        if desc.is_empty() || desc.chars().count() > MAX_TOOL_DESC_CHARS {
            return Err(RouterError::bad_request(format!(
                "invalid description for live tool '{name}'"
            )));
        }
        let params = if tool.parameters.is_null() {
            json!({ "type": "object", "properties": {} })
        } else if tool.parameters.is_object() {
            let serialized = serde_json::to_string(&tool.parameters)
                .map_err(|error| RouterError::bad_request(error.to_string()))?;
            if serialized.len() > MAX_TOOL_PARAMS_BYTES {
                return Err(RouterError::bad_request(format!(
                    "parameters schema for live tool '{name}' exceeds limit"
                )));
            }
            tool.parameters.clone()
        } else {
            return Err(RouterError::bad_request(format!(
                "parameters for live tool '{name}' must be an object"
            )));
        };
        declarations.push(json!({
            "name": name,
            "description": desc,
            "parameters": params,
        }));
    }
    Ok(declarations)
}

pub fn build_setup_payload(
    model: &str,
    system_instruction: Option<&str>,
    voice: Option<&str>,
    tools: &[Value],
) -> String {
    let mut generation_config = serde_json::Map::new();
    generation_config.insert("responseModalities".to_owned(), json!(["AUDIO"]));
    if let Some(voice_name) = voice {
        generation_config.insert(
            "speechConfig".to_owned(),
            json!({
                "voiceConfig": {
                    "prebuiltVoiceConfig": {
                        "voiceName": voice_name
                    }
                }
            }),
        );
    }

    let mut setup = serde_json::Map::new();
    setup.insert("model".to_owned(), Value::String(format!("models/{model}")));
    setup.insert(
        "generationConfig".to_owned(),
        Value::Object(generation_config),
    );
    setup.insert("inputAudioTranscription".to_owned(), json!({}));
    setup.insert("outputAudioTranscription".to_owned(), json!({}));

    if let Some(instruction) = system_instruction
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        setup.insert(
            "systemInstruction".to_owned(),
            json!({ "parts": [{ "text": instruction }] }),
        );
    }
    if !tools.is_empty() {
        setup.insert(
            "tools".to_owned(),
            json!([{ "functionDeclarations": tools }]),
        );
    }

    json!({ "setup": Value::Object(setup) }).to_string()
}

pub fn create_ticket(
    state: &RouterState,
    input: CreateLiveTicketInput,
) -> Result<Value, RouterError> {
    if state.safe_mode_enabled() {
        return Err(RouterError::forbidden(
            "ND Router Safe Mode is on: live voice sessions are disabled",
        ));
    }
    let model = normalize_live_model(input.model.as_deref())?;
    let voice = validate_voice(input.voice.as_deref())?;
    let system_instruction = input
        .system_instruction
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(text) = system_instruction
        && text.len() > MAX_SYSTEM_BYTES
    {
        return Err(RouterError::bad_request(
            "systemInstruction exceeds maximum allowed size",
        ));
    }
    let tools = validate_tools(&input.tools)?;

    let (entry, api_key) = resolve_live_entry(state, input.provider_id.as_deref(), &model)?;
    let setup_payload = build_setup_payload(&model, system_instruction, voice.as_deref(), &tools);
    let expires_at = Instant::now() + LIVE_TICKET_TTL;

    let (ticket, expires_at_ms) = state.live.issue(PendingLiveTicket {
        expires_at,
        model: model.clone(),
        setup_payload,
        api_key,
        entry: entry.clone(),
    })?;

    Ok(json!({
        "ticket": ticket,
        "model": model,
        "expiresAtMs": expires_at_ms,
        "providerId": entry.provider.id,
        "providerName": entry.provider.name,
    }))
}

fn resolve_live_entry(
    state: &RouterState,
    provider_id_hint: Option<&str>,
    model: &str,
) -> Result<(RoutedEntry, String), RouterError> {
    let candidates = {
        let guard = state
            .store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut providers: Vec<_> = guard
            .providers
            .iter()
            .filter(|provider| provider.is_active && catalog::supports_live(&provider.kind))
            .filter(|provider| {
                provider_id_hint
                    .map(str::trim)
                    .filter(|hint| !hint.is_empty())
                    .map(|hint| provider.id == hint)
                    .unwrap_or(true)
            })
            .cloned()
            .collect();
        providers.sort_by_key(|provider| std::cmp::Reverse(provider.priority));

        let mut list = Vec::new();
        for provider in providers {
            let mut accounts: Vec<_> = provider
                .accounts
                .iter()
                .filter(|account| account.is_active)
                .cloned()
                .collect();
            accounts.sort_by_key(|account| std::cmp::Reverse(account.priority));
            if accounts.is_empty() {
                list.push(RoutedEntry {
                    provider,
                    account: None,
                    model: model.to_owned(),
                });
            } else {
                for account in accounts {
                    list.push(RoutedEntry {
                        provider: provider.clone(),
                        account: Some(account),
                        model: model.to_owned(),
                    });
                }
            }
        }
        list
    };

    if candidates.is_empty() {
        return Err(RouterError::bad_request(
            "No active Google AI Studio provider is configured in ND Router. Add a Google AI Studio provider with an API key first.",
        ));
    }

    for entry in candidates {
        if let Some(secret) = state.entry_secret_for_live(&entry) {
            return Ok((entry, secret));
        }
    }

    Err(RouterError::bad_request(
        "The active Google AI Studio provider in ND Router does not have an API key configured.",
    ))
}

struct LiveSessionGuard {
    state: Arc<RouterState>,
    entry: RoutedEntry,
    started: Instant,
    ok: bool,
    status: u16,
    error: Option<String>,
    prompt_tokens: u64,
    completion_tokens: u64,
}

impl LiveSessionGuard {
    fn new(state: Arc<RouterState>, entry: RoutedEntry) -> Self {
        Self {
            state,
            entry,
            started: Instant::now(),
            ok: true,
            status: 200,
            error: None,
            prompt_tokens: 0,
            completion_tokens: 0,
        }
    }

    fn set_failure(&mut self, status: u16, message: impl Into<String>) {
        self.ok = false;
        self.status = status;
        self.error = Some(catalog::truncate(&message.into(), 300));
    }

    fn observe_usage(&mut self, value: &Value) {
        let Some(meta) = value.get("usageMetadata") else {
            return;
        };
        if let Some(prompt) = meta.get("promptTokenCount").and_then(Value::as_u64) {
            self.prompt_tokens = self.prompt_tokens.max(prompt);
        }
        if let Some(response) = meta.get("responseTokenCount").and_then(Value::as_u64) {
            self.completion_tokens = self.completion_tokens.max(response);
        }
    }
}

impl Drop for LiveSessionGuard {
    fn drop(&mut self) {
        self.state.live_active.fetch_sub(1, Ordering::AcqRel);
        self.state.record_usage(
            &self.entry,
            "live",
            "/v1/live",
            self.status,
            self.ok,
            self.started.elapsed(),
            self.error.clone(),
            &Value::Null,
            self.completion_tokens.max(self.prompt_tokens),
        );
    }
}

fn try_claim_live_slot(counter: &AtomicUsize) -> bool {
    counter
        .compare_exchange(0, MAX_CONCURRENT_LIVE, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

pub async fn upgrade(
    State(state): State<Arc<RouterState>>,
    Query(query): Query<LiveUpgradeQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, RouterError> {
    if state.safe_mode_enabled() {
        return Err(RouterError::forbidden(
            "ND Router Safe Mode is on: live voice sessions are disabled",
        ));
    }
    let Some(ticket) = state.live.consume(&query.ticket) else {
        return Err(RouterError::unauthorized(
            "invalid or expired live session ticket",
        ));
    };
    if !try_claim_live_slot(&state.live_active) {
        return Err(RouterError::conflict(
            "another live voice session is already active",
        ));
    }
    let guard = LiveSessionGuard::new(Arc::clone(&state), ticket.entry.clone());
    Ok(ws
        .max_message_size(MAX_CLIENT_FRAME_BYTES)
        .max_frame_size(MAX_CLIENT_FRAME_BYTES)
        .on_upgrade(move |socket| async move {
            relay_session(socket, state, ticket, guard).await;
        }))
}

async fn connect_upstream(
    upstream_url: &str,
    api_key: &str,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    (u16, String),
> {
    let mut request = upstream_url
        .into_client_request()
        .map_err(|error| (400, format!("invalid live upstream URL: {error}")))?;
    let header = HeaderValue::from_str(api_key)
        .map_err(|_| (400, "invalid Google AI Studio API key format".to_owned()))?;
    request.headers_mut().insert("x-goog-api-key", header);

    let (stream, _) = tokio::time::timeout(UPSTREAM_CONNECT_TIMEOUT, connect_async(request))
        .await
        .map_err(|_| {
            (
                504,
                "timed out connecting to Gemini Live upstream".to_owned(),
            )
        })?
        .map_err(|error| (502, format!("Gemini Live connection failed: {error}")))?;
    Ok(stream)
}

async fn relay_session(
    mut client: WebSocket,
    state: Arc<RouterState>,
    ticket: PendingLiveTicket,
    mut guard: LiveSessionGuard,
) {
    let upstream_url = state.live_upstream_url();
    let mut upstream = match connect_upstream(&upstream_url, &ticket.api_key).await {
        Ok(stream) => stream,
        Err((status, message)) => {
            guard.set_failure(status, &message);
            let _ = client
                .send(AxumMessage::Close(Some(CloseFrame {
                    code: 1011,
                    reason: catalog::truncate(&message, 120).into(),
                })))
                .await;
            return;
        }
    };

    if let Err(error) = upstream
        .send(UpstreamMessage::Text(ticket.setup_payload.clone()))
        .await
    {
        let message = format!("failed to send Gemini Live setup: {error}");
        guard.set_failure(502, &message);
        let _ = client
            .send(AxumMessage::Close(Some(CloseFrame {
                code: 1011,
                reason: catalog::truncate(&message, 120).into(),
            })))
            .await;
        return;
    }

    let safe_notify: Arc<Notify> = Arc::clone(&state.live_safe_notify);
    let max_deadline = tokio::time::Instant::now() + MAX_SESSION_DURATION;
    let max_sleep = tokio::time::sleep_until(max_deadline);
    tokio::pin!(max_sleep);

    let idle_sleep = tokio::time::sleep(IDLE_TIMEOUT);
    tokio::pin!(idle_sleep);

    loop {
        if state.safe_mode_enabled() {
            guard.set_failure(403, "ND Router Safe Mode enabled");
            let _ = close_both(
                &mut client,
                &mut upstream,
                1008,
                "ND Router Safe Mode enabled",
            )
            .await;
            return;
        }

        tokio::select! {
            _ = safe_notify.notified() => {
                if state.safe_mode_enabled() {
                    guard.set_failure(403, "ND Router Safe Mode enabled");
                    let _ = close_both(&mut client, &mut upstream, 1008, "ND Router Safe Mode enabled").await;
                    return;
                }
            }
            _ = &mut max_sleep => {
                let _ = close_both(&mut client, &mut upstream, 1000, "Live session reached 15 minute limit").await;
                return;
            }
            _ = &mut idle_sleep => {
                let _ = close_both(&mut client, &mut upstream, 1000, "Live session closed due to inactivity").await;
                return;
            }
            client_frame = client.next() => {
                match client_frame {
                    Some(Ok(AxumMessage::Text(text))) => {
                        idle_sleep.as_mut().reset(tokio::time::Instant::now() + IDLE_TIMEOUT);
                        if text.len() > MAX_CLIENT_FRAME_BYTES {
                            guard.set_failure(400, "client live frame exceeded size cap");
                            let _ = close_both(&mut client, &mut upstream, 1009, "Frame too large").await;
                            return;
                        }
                        if let Some(sanitized) = sanitize_client_frame(&text)
                            && let Err(error) = upstream.send(UpstreamMessage::Text(sanitized)).await
                        {
                            guard.set_failure(502, format!("upstream send failed: {error}"));
                            let _ = client.send(AxumMessage::Close(Some(CloseFrame {
                                code: 1011,
                                reason: "Upstream disconnected".into(),
                            }))).await;
                            return;
                        }
                    }
                    Some(Ok(AxumMessage::Binary(_))) => {
                        // Browser clients speak JSON frames; ignore raw binary.
                    }
                    Some(Ok(AxumMessage::Ping(payload))) => {
                        let _ = client.send(AxumMessage::Pong(payload)).await;
                    }
                    Some(Ok(AxumMessage::Pong(_))) => {}
                    Some(Ok(AxumMessage::Close(_))) | None => {
                        let _ = upstream.close(None).await;
                        return;
                    }
                    Some(Err(error)) => {
                        guard.set_failure(400, format!("client websocket error: {error}"));
                        let _ = upstream.close(None).await;
                        return;
                    }
                }
            }
            upstream_frame = upstream.next() => {
                match upstream_frame {
                    Some(Ok(UpstreamMessage::Text(text))) => {
                        idle_sleep.as_mut().reset(tokio::time::Instant::now() + IDLE_TIMEOUT);
                        if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
                            guard.observe_usage(&parsed);
                        }
                        if client.send(AxumMessage::Text(text)).await.is_err() {
                            let _ = upstream.close(None).await;
                            return;
                        }
                    }
                    Some(Ok(UpstreamMessage::Binary(bytes))) => {
                        idle_sleep.as_mut().reset(tokio::time::Instant::now() + IDLE_TIMEOUT);
                        if let Ok(text) = String::from_utf8(bytes) {
                            if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
                                guard.observe_usage(&parsed);
                            }
                            if client.send(AxumMessage::Text(text)).await.is_err() {
                                let _ = upstream.close(None).await;
                                return;
                            }
                        }
                    }
                    Some(Ok(UpstreamMessage::Ping(payload))) => {
                        let _ = upstream.send(UpstreamMessage::Pong(payload)).await;
                    }
                    Some(Ok(UpstreamMessage::Pong(_))) => {}
                    Some(Ok(UpstreamMessage::Frame(_))) => {}
                    Some(Ok(UpstreamMessage::Close(frame))) => {
                        let (code, reason) = frame
                            .as_ref()
                            .map(|f| (u16::from(f.code), f.reason.to_string()))
                            .unwrap_or((1000, "Upstream closed".to_owned()));
                        if code != 1000 && code != 1001 {
                            guard.set_failure(502, format!("upstream closed ({code}): {reason}"));
                        }
                        let _ = client
                            .send(AxumMessage::Close(Some(CloseFrame {
                                code,
                                reason: catalog::truncate(&reason, 120).into(),
                            })))
                            .await;
                        return;
                    }
                    None => {
                        let _ = client.send(AxumMessage::Close(None)).await;
                        return;
                    }
                    Some(Err(error)) => {
                        let msg = format!("upstream websocket error: {error}");
                        guard.set_failure(502, &msg);
                        let _ = client
                            .send(AxumMessage::Close(Some(CloseFrame {
                                code: 1011,
                                reason: catalog::truncate(&msg, 120).into(),
                            })))
                            .await;
                        return;
                    }
                }
            }
        }
    }
}

/// Allow only `realtimeInput`, `clientContent`, or `toolResponse` single-key
/// payloads from the client so a caller can never re-send `setup`.
pub fn sanitize_client_frame(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    let key = object.keys().next()?.as_str();
    if !ALLOWED_CLIENT_KEYS.contains(&key) {
        return None;
    }
    Some(value.to_string())
}

async fn close_both(
    client: &mut WebSocket,
    upstream: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    code: u16,
    reason: &str,
) {
    let _ = client
        .send(AxumMessage::Close(Some(CloseFrame {
            code,
            reason: catalog::truncate(reason, 120).into(),
        })))
        .await;
    let _ = upstream.close(None).await;
}

/// Connectivity test for `ai-studio` providers configured with a Live model.
pub async fn probe_live_connection(
    upstream_url: &str,
    api_key: &str,
    model: &str,
) -> Result<(u64, String), (u16, String)> {
    let normalized = normalize_live_model(Some(model)).map_err(|err| (400, err.message))?;
    let started = Instant::now();
    let mut stream = connect_upstream(upstream_url, api_key).await?;
    let setup = build_setup_payload(&normalized, None, None, &[]);
    stream
        .send(UpstreamMessage::Text(setup))
        .await
        .map_err(|error| (502, format!("failed to send Live setup: {error}")))?;

    let reply = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(frame) = stream.next().await {
            match frame {
                Ok(UpstreamMessage::Text(text)) => return Ok(text),
                Ok(UpstreamMessage::Binary(bytes)) => {
                    if let Ok(text) = String::from_utf8(bytes) {
                        return Ok(text);
                    }
                }
                Ok(UpstreamMessage::Close(close)) => {
                    let msg = close
                        .map(|f| format!("Live API closed ({}): {}", f.code, f.reason))
                        .unwrap_or_else(|| "Live API closed during setup".to_owned());
                    return Err((502, msg));
                }
                Ok(_) => {}
                Err(error) => return Err((502, format!("Live API probe error: {error}"))),
            }
        }
        Err((502, "Live API closed without setupComplete".to_owned()))
    })
    .await
    .map_err(|_| (504, "Live API setup probe timed out".to_owned()))??;

    let _ = stream.close(None).await;
    let parsed: Value = serde_json::from_str(&reply).unwrap_or(Value::Null);
    if parsed.get("setupComplete").is_some() {
        return Ok((
            started.elapsed().as_millis() as u64,
            format!("Live API OK ({normalized})"),
        ));
    }
    if let Some(error_msg) = parsed
        .get("error")
        .and_then(|err| err.get("message"))
        .and_then(Value::as_str)
    {
        return Err((400, error_msg.to_owned()));
    }
    Ok((
        started.elapsed().as_millis() as u64,
        catalog::truncate(reply.trim(), 80),
    ))
}
