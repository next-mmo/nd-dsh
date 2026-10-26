use crate::state::RouterState;
use crate::types::{MAX_BODY_BYTES, RouterError};
use axum::Json;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, header::AUTHORIZATION};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Router, http::StatusCode};
use serde_json::{Value, json};
use std::sync::Arc;

pub fn app(state: Arc<RouterState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(chat))
        .route("/v1/responses", post(responses))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({"ok": true, "engine": "nd-router"}))
}

async fn models(
    State(state): State<Arc<RouterState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, RouterError> {
    authorize(&state, &headers)?;
    Ok(Json(state.model_catalog()))
}

async fn chat(
    State(state): State<Arc<RouterState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, RouterError> {
    authorize(&state, &headers)?;
    if !body.is_object() {
        return Err(RouterError::bad_request("request body must be a JSON object"));
    }
    let combo = combo_header(&headers);
    state.chat(body, combo.as_deref(), "/v1/chat/completions").await
}

async fn responses(
    State(state): State<Arc<RouterState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, RouterError> {
    authorize(&state, &headers)?;
    if !body.is_object() {
        return Err(RouterError::bad_request("request body must be a JSON object"));
    }
    let combo = combo_header(&headers);
    state.chat(body, combo.as_deref(), "/v1/responses").await
}

fn combo_header(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-nd-route-combo")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn authorize(state: &RouterState, headers: &HeaderMap) -> Result<(), RouterError> {
    let value = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let token = value.strip_prefix("Bearer ").unwrap_or_default();
    if !token.is_empty() && token == state.key() {
        Ok(())
    } else {
        Err(RouterError {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: "invalid ND Router credential".to_owned(),
        })
    }
}
