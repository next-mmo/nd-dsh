//! Read-only desktop observation for ND Computer Use.
//!
//! The sidecar owns window enumeration, UI Automation extraction, window
//! capture, and the per-session tree cache. The desktop main process and the
//! extension broker only see bounded snapshots; no COM interface or native
//! handle crosses the RPC boundary.

mod cache;
#[cfg(windows)]
mod capture;
mod tree;
mod types;
#[cfg(windows)]
mod windows_backend;

#[cfg(test)]
mod tests;

use std::sync::Mutex;
use std::time::Instant;

use anyhow::{Result, anyhow};
use base64::Engine as _;

pub use types::{
    AccessibilityState, AppEntry, AppRef, AppStateParams, AppStateResult, AppsListResult,
    CaptureFailure, CapturedImage, Rect, ResetResult, Screenshot, Selection, SessionResetParams,
    StateLimits, StateStats, TextMode, UiNode, WindowEntry, WindowRef,
};

use crate::deadline::Interrupt;
use cache::{CachedState, DiffCache};

pub struct ComputerUse {
    cache: Mutex<DiffCache>,
}

impl Default for ComputerUse {
    fn default() -> Self {
        Self::new()
    }
}

impl ComputerUse {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(DiffCache::new()),
        }
    }

    pub fn list_apps(&self) -> Result<AppsListResult> {
        platform::list_apps()
    }

    pub fn app_state(
        &self,
        params: AppStateParams,
        interrupt: &Interrupt,
    ) -> Result<AppStateResult> {
        params.validate()?;
        let started = Instant::now();
        let selection = platform::select_window(&params.app, params.window_id.as_deref())?;

        let mut screenshots = Vec::new();
        let mut screenshot_unavailable = None;
        if params.want_screenshot() {
            match platform::capture_window(selection.hwnd, &selection.rect) {
                Ok(image) => {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(&image.jpeg);
                    screenshots.push(Screenshot {
                        id: format!("shot-{:x}", selection.hwnd),
                        z_index: 0,
                        url: format!("data:image/jpeg;base64,{encoded}"),
                        origin_x: Some(image.origin_x),
                        origin_y: Some(image.origin_y),
                        width: Some(image.width),
                        height: Some(image.height),
                    });
                }
                Err(CaptureFailure::Unavailable(reason)) => {
                    screenshot_unavailable = Some(reason.to_string());
                }
                Err(CaptureFailure::Failed) => {
                    screenshot_unavailable = Some("capture-failed".to_string());
                }
            }
        }

        let mut node_count = 0;
        let mut truncated = false;
        let mut accessibility = None;
        let mut text_mode = TextMode::None;
        let mut state_id = String::new();
        let mut diff_counts: Option<(usize, usize, usize)> = None;

        if params.want_text() {
            let (nodes, tree_truncated) =
                platform::read_tree(selection.hwnd, selection.rect, interrupt)?;
            node_count = nodes.len();
            truncated |= tree_truncated;
            let snapshot = tree::snapshot(&nodes, types::MAX_TEXT_CHARS);
            truncated |= snapshot.truncated_by_text;
            state_id = tree::state_id(&snapshot.tree_text);

            let mut cache = self
                .cache
                .lock()
                .map_err(|_| anyhow!("computer use cache lock was poisoned"))?;
            let previous = if params.disable_diff.unwrap_or(false) {
                None
            } else {
                cache
                    .get(&params.session_id, &selection.app_id, &selection.window.id)
                    .filter(|state| state.truncated == snapshot.truncated_by_text)
            };

            let (text, mode) = if let Some(previous) = previous {
                let generation = previous.generation.saturating_add(1);
                let diff = tree::diff(&previous.lines, &snapshot.lines, generation);
                diff_counts = Some((diff.changed, diff.added, diff.removed));
                cache.put(
                    &params.session_id,
                    &selection.app_id,
                    &selection.window.id,
                    CachedState {
                        lines: snapshot.lines.clone(),
                        generation,
                        truncated: snapshot.truncated_by_text,
                    },
                );
                (diff.text, TextMode::Diff)
            } else {
                cache.put(
                    &params.session_id,
                    &selection.app_id,
                    &selection.window.id,
                    CachedState {
                        lines: snapshot.lines.clone(),
                        generation: 1,
                        truncated: snapshot.truncated_by_text,
                    },
                );
                (snapshot.tree_text.clone(), TextMode::Full)
            };

            accessibility = Some(AccessibilityState {
                tree: text,
                focused_element: snapshot.focused_element,
                selected_text: None,
                selected_elements: None,
                document_text: None,
            });
            text_mode = mode;
        }

        Ok(AppStateResult {
            app: AppRef {
                id: selection.app_id,
                display_name: selection.display_name,
            },
            window: WindowRef {
                id: selection.window.id,
                title: selection.window.title,
            },
            screenshots,
            accessibility,
            text_mode,
            state_id,
            screenshot_unavailable,
            stats: StateStats {
                nodes: node_count,
                truncated,
                elapsed_ms: started.elapsed().as_millis() as u64,
                changed: diff_counts.map(|counts| counts.0),
                added: diff_counts.map(|counts| counts.1),
                removed: diff_counts.map(|counts| counts.2),
            },
            limits: StateLimits::default(),
        })
    }

    pub fn reset_session(&self, session_id: &str) -> ResetResult {
        let reset = self
            .cache
            .lock()
            .map(|mut cache| cache.reset_session(session_id))
            .unwrap_or(false);
        ResetResult { reset }
    }
}

#[cfg(windows)]
pub fn init_process_dpi() {
    use windows::Win32::UI::HiDpi::{
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
    };
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

#[cfg(not(windows))]
pub fn init_process_dpi() {}

#[cfg(windows)]
mod platform {
    pub use super::capture::capture_window;
    pub use super::windows_backend::{list_apps, read_tree, select_window};
}

#[cfg(not(windows))]
mod platform {
    use anyhow::{Result, bail};

    use super::types::{AppsListResult, CaptureFailure, CapturedImage, Rect, Selection, UiNode};
    use crate::deadline::Interrupt;

    pub fn list_apps() -> Result<AppsListResult> {
        bail!("desktop computer use is only supported on Windows")
    }

    pub fn select_window(_app: &str, _window_id: Option<&str>) -> Result<Selection> {
        bail!("desktop computer use is only supported on Windows")
    }

    pub fn read_tree(
        _hwnd: isize,
        _rect: Rect,
        _interrupt: &Interrupt,
    ) -> Result<(Vec<UiNode>, bool)> {
        bail!("desktop computer use is only supported on Windows")
    }

    pub fn capture_window(
        _hwnd: isize,
        _rect: &Rect,
    ) -> std::result::Result<CapturedImage, CaptureFailure> {
        Err(CaptureFailure::Unavailable("unsupported"))
    }
}
