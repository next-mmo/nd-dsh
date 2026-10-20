use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

pub const MAX_APPS: usize = 200;
pub const MAX_WINDOWS_PER_APP: usize = 24;
pub const MAX_TREE_NODES: usize = 1_500;
pub const MAX_TREE_DEPTH: usize = 24;
pub const MAX_TEXT_CHARS: usize = 48_000;
pub const MAX_SCREENSHOT_BYTES: usize = 128 * 1024;
pub const MAX_SCREENSHOT_WIDTH: u32 = 1_280;
pub const MAX_SESSION_ID_CHARS: usize = 128;
pub const MAX_APP_ID_CHARS: usize = 256;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppsListResult {
    pub apps: Vec<AppEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub id: String,
    pub display_name: String,
    pub windows: Vec<WindowEntry>,
    pub is_running: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowEntry {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub width: i32,
    pub height: i32,
    pub focused: bool,
    pub minimized: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppStateParams {
    pub app: String,
    #[serde(default)]
    pub window_id: Option<String>,
    pub session_id: String,
    #[serde(default)]
    pub include_screenshot: Option<bool>,
    #[serde(default)]
    pub include_text: Option<bool>,
    #[serde(default)]
    pub disable_diff: Option<bool>,
}

impl AppStateParams {
    pub fn validate(&self) -> Result<()> {
        if self.app.trim().is_empty() || self.app.chars().count() > MAX_APP_ID_CHARS {
            bail!("app must be a non-empty identifier under {MAX_APP_ID_CHARS} characters");
        }
        if self.session_id.trim().is_empty()
            || self.session_id.chars().count() > MAX_SESSION_ID_CHARS
        {
            bail!(
                "sessionId must be a non-empty identifier under {MAX_SESSION_ID_CHARS} characters"
            );
        }
        if let Some(window_id) = &self.window_id
            && (window_id.is_empty() || window_id.chars().count() > 128)
        {
            bail!("windowId must be an opaque identifier under 128 characters");
        }
        Ok(())
    }

    pub fn want_screenshot(&self) -> bool {
        self.include_screenshot.unwrap_or(true)
    }

    pub fn want_text(&self) -> bool {
        self.include_text.unwrap_or(false)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRef {
    pub id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRef {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    pub id: String,
    pub z_index: i32,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_x: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_y: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityState {
    pub tree: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused_element: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_elements: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_text: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TextMode {
    Full,
    Diff,
    None,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateStats {
    pub nodes: usize,
    pub truncated: bool,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateLimits {
    pub max_nodes: usize,
    pub max_depth: usize,
    pub max_text_chars: usize,
    pub max_screenshot_bytes: usize,
}

impl Default for StateLimits {
    fn default() -> Self {
        Self {
            max_nodes: MAX_TREE_NODES,
            max_depth: MAX_TREE_DEPTH,
            max_text_chars: MAX_TEXT_CHARS,
            max_screenshot_bytes: MAX_SCREENSHOT_BYTES,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateResult {
    pub app: AppRef,
    pub window: WindowRef,
    pub screenshots: Vec<Screenshot>,
    pub accessibility: Option<AccessibilityState>,
    pub text_mode: TextMode,
    pub state_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot_unavailable: Option<String>,
    pub stats: StateStats,
    pub limits: StateLimits,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetResult {
    pub reset: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionResetParams {
    pub session_id: String,
}

impl SessionResetParams {
    pub fn validate(&self) -> Result<()> {
        if self.session_id.trim().is_empty()
            || self.session_id.chars().count() > MAX_SESSION_ID_CHARS
        {
            bail!(
                "sessionId must be a non-empty identifier under {MAX_SESSION_ID_CHARS} characters"
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone)]
pub struct Selection {
    pub app_id: String,
    pub display_name: String,
    pub window: WindowEntry,
    pub hwnd: isize,
    pub rect: Rect,
}

#[derive(Debug)]
pub struct CapturedImage {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub origin_x: i32,
    pub origin_y: i32,
}

#[derive(Debug)]
pub enum CaptureFailure {
    Unavailable(&'static str),
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiNode {
    pub parent: Option<usize>,
    pub depth: usize,
    pub ordinal: usize,
    pub role: String,
    pub name: String,
    pub automation_id: Option<String>,
    pub class_name: Option<String>,
    pub value: Option<String>,
    pub toggle: Option<String>,
    pub enabled: bool,
    pub offscreen: bool,
    pub focused: bool,
    pub password: bool,
    pub bounds: Option<Rect>,
}
