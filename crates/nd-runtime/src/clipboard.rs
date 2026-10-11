//! Clipboard observation as the sidecar's first background push-event resource.
//!
//! The watcher exists so the desktop can learn that the clipboard changed
//! without polling it. It is deliberately *content-free*: a
//! `clipboard.changed` event carries the watcher id, a format-signature
//! fingerprint, the content class, and a timestamp — never the copied text or
//! pixels. Content is read afterwards through the same trusted
//! `clipboard.read` path that note capture uses, so recording stays a desktop
//! policy decision and the event path cannot leak a password even if it wanted
//! to.
//!
//! A watcher exists only because the desktop issued `clipboard.watch`. It is
//! never self-started, it is idempotently stoppable, and its teardown is
//! joined during sidecar shutdown. Two delivery tiers share one code path:
//!
//! * **push** (Windows): a message-only window with
//!   `AddClipboardFormatListener` observes `WM_CLIPBOARDUPDATE` and never
//!   blocks on the clipboard being busy.
//! * **poll**: a bounded-interval signature check (750 ms by default) for
//!   sources without push support. The tier is chosen per watcher and reported
//!   in the `clipboard.watch` result, so a push failure degrades visibly
//!   instead of returning a dead handle.
//!
//! Emission is bounded twice: the producer thread hands notifications to the
//! emitter through a fixed-capacity channel (a full channel increments a drop
//! counter rather than blocking the message pump), and the emitter drops
//! events while the outbound protocol queue is near capacity. Every dropped
//! event is accounted for and reported on the next event that does get
//! through.
//!
//! The sidecar also owns clipboard read and write. One process producing and
//! observing clipboard changes is what makes write-back echo suppression a
//! reliable in-process fact (`Suppression`) rather than a cross-process
//! guess: a signature the sidecar itself just wrote is consumed exactly once
//! and never emitted.

use anyhow::{Context, Result, bail};
use nd_protocol::ProtocolWriter;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use uuid::Uuid;

#[cfg(windows)]
use base64::Engine as _;
#[cfg(windows)]
use sha2::{Digest, Sha256};

use crate::scheduler::now_ms;

/// Notifications in flight per watcher. A clipboard produces a handful of
/// changes per second at worst; 256 is far above that and keeps the memory a
/// stalled consumer can cost bounded.
const CHANNEL_CAPACITY: usize = 256;

/// The emitter drops events while the outbound queue holds this many frames —
/// the queue's own cap is 1024 normal-priority frames, so at this point the
/// consumer has stalled and the drop policy, not unbounded blocking, applies.
const MAX_OUTBOUND_QUEUED_FRAMES: usize = 900;

/// A write observed within this window whose signature matches what the
/// sidecar itself wrote is echo, not a user copy. Consumed on first match.
const WRITE_SUPPRESSION_WINDOW: Duration = Duration::from_millis(1_500);

const DEFAULT_POLL_INTERVAL_MS: u64 = 750;
const MIN_POLL_INTERVAL_MS: u64 = 10;
const MAX_POLL_INTERVAL_MS: u64 = 60_000;

/// Read bounds. Text matches the `clipboard.write` ceiling so a captured note
/// is never silently narrower than what a user could copy; images follow the
/// media.rs source bounds, and the encoded PNG must fit one protocol frame
/// with room to spare (8 MiB) after base64 inflation.
const MAX_TEXT_CHARS: usize = 256_000;
#[cfg(windows)]
const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
#[cfg(windows)]
const MAX_SOURCE_PIXELS: u64 = 100_000_000;
const MAX_ENCODED_PNG_BYTES: usize = 4 * 1024 * 1024;
/// A clipboard holding more than a screenful of files is an archive
/// operation, not something history should record verbatim.
#[cfg(windows)]
const MAX_FILE_NAMES: usize = 32;
#[cfg(windows)]
const MAX_FILE_NAME_CHARS: usize = 1_024;

/// Clipboard formats used for classification and reads. Windows clipboard
/// format ids are fixed constants; naming them here avoids depending on where
/// the bindings expose them.
const CF_UNICODETEXT: u32 = 13;
const CF_DIB: u32 = 8;
const CF_DIBV5: u32 = 17;
const CF_HDROP: u32 = 15;

/// Standard clipboard bitmap compressions this module can decode.
#[cfg(windows)]
const BI_RGB: u32 = 0;
#[cfg(windows)]
const BI_BITFIELDS: u32 = 3;

/// Extensions a single copied *file* resolves into a stored image through.
#[cfg(windows)]
const IMAGE_FILE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "bmp", "webp"];

// --- Wire types -------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardWatchParams {
    /// Tier-3 interval override. Unset uses the 750 ms default; the clamp
    /// bounds how hot a poller can spin.
    pub poll_interval_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchResult {
    pub watch_id: String,
    /// `push` (event-driven) or `poll` (bounded interval). A push start that
    /// failed reports itself here instead of returning a dead watcher.
    pub mode: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardUnwatchParams {
    pub watch_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardUnwatchResult {
    pub removed: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardReadParams {}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardReadResult {
    /// `text` | `image` | `files` | `none`.
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub png_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub too_large: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub names: Option<Vec<String>>,
}

impl ClipboardReadResult {
    fn none_default() -> Self {
        Self {
            kind: "none",
            text: None,
            truncated: None,
            png_base64: None,
            fingerprint: None,
            width: None,
            height: None,
            file_name: None,
            too_large: None,
            names: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardWriteTextParams {
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardWriteTextResult {
    pub written: bool,
    pub signature: Vec<u32>,
}

/// The content-free payload of one `clipboard.changed` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardChangedData {
    pub watch_id: String,
    pub seq: u64,
    /// Sorted clipboard format ids present at change time.
    pub signature: Vec<u32>,
    /// `text` | `image` | `files` | `other` — a class, never the content.
    pub content_type: &'static str,
    pub timestamp: u64,
    /// Events dropped since the previous delivered event. Zero is omitted.
    #[serde(skip_serializing_if = "is_zero")]
    pub dropped_since_last: u64,
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_zero(value: &u64) -> bool {
    *value == 0
}

// --- Sinking events ---------------------------------------------------------

/**
 * Where watcher events go. Abstracted so the watcher is testable without a
 * real protocol stdout, while `ProtocolWriter` stays the only production sink.
 */
pub trait ClipboardEventSink: Send + Sync {
    fn send_clipboard_changed(
        &self,
        watch_id: &str,
        seq: u64,
        data: &ClipboardChangedData,
    ) -> Result<()>;
    /// Frames currently queued outbound; the drop policy watches this.
    fn outbound_queued(&self) -> usize;
}

impl ClipboardEventSink for ProtocolWriter {
    fn send_clipboard_changed(
        &self,
        watch_id: &str,
        seq: u64,
        data: &ClipboardChangedData,
    ) -> Result<()> {
        self.send_event(
            "clipboard.changed",
            Some(watch_id),
            Some(seq),
            "normal",
            data,
        )
    }

    fn outbound_queued(&self) -> usize {
        self.snapshot().queued_frames
    }
}

// --- Signature and classification -------------------------------------------

/// Cheap, content-free fingerprint of the clipboard: the sorted set of format
/// ids currently present plus the platform's change counter. Reading it never
/// locks pixel or text data, which is what keeps a large image sitting
/// untouched on the clipboard free to re-observe (`Design decisions adopted`
/// #2 in task 0050). The change counter matters because a text copy and the
/// next text copy carry the same formats; the counter is what distinguishes
/// them — on Windows it is the free `GetClipboardSequenceNumber`, so a poller
/// can skip even opening the clipboard when nothing changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatSignature {
    pub formats: Vec<u32>,
    pub change_id: u64,
}

impl FormatSignature {
    pub fn new(mut formats: Vec<u32>, change_id: u64) -> Self {
        formats.sort_unstable();
        formats.dedup();
        Self { formats, change_id }
    }
}

/// Classify a format list into the content class an event reports. `files`
/// wins over `image` because an Explorer file copy carries `CF_HDROP` and the
/// single-image-file case is resolved later at read time; `image` wins over
/// `text` because a rendered copy carries both a bitmap and its HTML/text
/// fallback.
pub fn classify_signature(formats: &[u32], png_format: u32) -> &'static str {
    if formats.contains(&CF_HDROP) {
        "files"
    } else if formats.contains(&CF_DIB)
        || formats.contains(&CF_DIBV5)
        || (png_format != 0 && formats.contains(&png_format))
    {
        "image"
    } else if formats.contains(&CF_UNICODETEXT) {
        "text"
    } else {
        "other"
    }
}

// --- Injectable clipboard source ---------------------------------------------

/// The OS clipboard, abstracted. Production uses the Windows implementation
/// below; tests inject fakes, so the watcher logic runs with no real
/// clipboard at all.
pub trait ClipboardSource: Send + Sync {
    /// Whether this platform can observe the clipboard at all. A watcher on
    /// an unsupported source is refused rather than started to emit nothing.
    fn is_supported(&self) -> bool {
        true
    }

    /// Whether the source can deliver push notifications (tier 1).
    fn supports_push(&self) -> bool {
        false
    }

    /// A near-free change counter, when the platform provides one. Pollers
    /// check it before paying for an open-plus-enumerate, which is the cheap
    /// middle tier between push events and full signature reads.
    fn change_counter(&self) -> Option<u64> {
        None
    }

    /// Current format-list fingerprint, or `None` when the clipboard could
    /// not be observed right now (busy or unsupported).
    fn signature(&self) -> Option<FormatSignature>;

    /// Content class for a signature.
    fn content_type(&self, signature: &FormatSignature) -> &'static str {
        classify_signature(&signature.formats, 0)
    }

    /// Read the current content within bounds. Fail-closed on error.
    fn read(&self, limits: &ContentLimits) -> Result<ClipboardContent>;

    /// Write text and return the signature observed after the write, which is
    /// what echo suppression matches against.
    fn write_text(&self, text: &str) -> Result<FormatSignature>;
}

#[derive(Debug, Clone, Copy)]
pub struct ContentLimits {
    pub max_text_chars: usize,
    pub max_encoded_png_bytes: usize,
}

impl Default for ContentLimits {
    fn default() -> Self {
        Self {
            max_text_chars: MAX_TEXT_CHARS,
            max_encoded_png_bytes: MAX_ENCODED_PNG_BYTES,
        }
    }
}

/// Content read out of the clipboard. This never travels on the event path;
/// it is the response to an explicit read.
#[derive(Debug, Clone)]
pub enum ClipboardContent {
    None,
    Text {
        text: String,
        truncated: bool,
    },
    Image {
        /// Re-encoded PNG. A string rather than bytes because dispatch
        /// round-trips through `serde_json::Value`.
        png_base64: Option<String>,
        /// Hash over the decoded pixel bytes plus dimensions, so the same
        /// picture re-copied through a different encoder still dedups.
        fingerprint: String,
        width: u32,
        height: u32,
        file_name: Option<String>,
        /// The image was real but too large to store; metadata only.
        too_large: bool,
    },
    Files {
        names: Vec<String>,
    },
}

// --- Echo suppression ---------------------------------------------------------

/// Records what the sidecar itself last wrote. One process owning both the
/// writer and the watcher is what turns "ignore our own write-back" from a
/// cross-process guess into an in-process fact.
#[derive(Debug)]
struct Suppression {
    signature: FormatSignature,
    at: Instant,
}

impl Suppression {
    fn matches(&self, signature: &FormatSignature) -> bool {
        self.signature == *signature && self.at.elapsed() < WRITE_SUPPRESSION_WINDOW
    }
}

type SharedSuppression = Arc<Mutex<Option<Suppression>>>;

// --- Watcher plumbing ---------------------------------------------------------

#[derive(Debug)]
struct Notification {
    signature: FormatSignature,
    content_type: &'static str,
    timestamp: u64,
}

/// State one producer (pump or poller) needs to turn a signature change into
/// a bounded, echo-filtered notification.
struct ProducerContext {
    source: Arc<dyn ClipboardSource>,
    sender: std::sync::mpsc::SyncSender<Notification>,
    dropped: Arc<AtomicU64>,
    closing: Arc<AtomicBool>,
    suppression: SharedSuppression,
    /// Serialises observation against the write path: a `WM_CLIPBOARDUPDATE`
    /// arriving while the sidecar's own write is still finishing must observe
    /// the armed suppression, not race ahead of it.
    operation: Arc<Mutex<()>>,
}

impl ProducerContext {
    /// Consume one observed signature: suppress ND's own write-back, or hand
    /// a bounded notification to the emitter (counting a drop when full).
    fn record_change(&self, signature: &FormatSignature) {
        if self.closing.load(Ordering::Relaxed) {
            return;
        }
        if let Ok(mut slot) = self.suppression.lock()
            && slot.as_ref().is_some_and(|guard| guard.matches(signature))
        {
            // Exactly one change per write is suppressed; a later genuine
            // copy of the same content (after the window) is recorded.
            *slot = None;
            return;
        }
        let content_type = self.source.content_type(signature);
        let note = Notification {
            signature: signature.clone(),
            content_type,
            timestamp: now_ms(),
        };
        if self.sender.try_send(note).is_err() {
            // Full (or disconnected): drop newest and account for it.
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

enum Producer {
    #[cfg(windows)]
    Push {
        hwnd: isize,
        thread: JoinHandle<()>,
    },
    Poll {
        thread: JoinHandle<()>,
    },
}

struct WatcherHandle {
    closing: Arc<AtomicBool>,
    producer: Option<Producer>,
    emitter: Option<JoinHandle<()>>,
}

/// Signature observed after an unsuccessful read attempt — retries are what
/// keep a momentarily locked clipboard from swallowing a change entirely.
fn retry_signature(
    source: &dyn ClipboardSource,
    attempts: u32,
    pause: Duration,
) -> Option<FormatSignature> {
    for attempt in 0..attempts {
        if attempt > 0 {
            thread::sleep(pause);
        }
        if let Some(signature) = source.signature() {
            return Some(signature);
        }
    }
    None
}

pub struct ClipboardManager {
    sink: Arc<dyn ClipboardEventSink>,
    source: Arc<dyn ClipboardSource>,
    watchers: Mutex<HashMap<String, WatcherHandle>>,
    suppression: SharedSuppression,
    operation: Arc<Mutex<()>>,
    shutting_down: AtomicBool,
}

impl ClipboardManager {
    pub fn new(sink: Arc<dyn ClipboardEventSink>, source: Arc<dyn ClipboardSource>) -> Self {
        Self {
            sink,
            source,
            watchers: Mutex::new(HashMap::new()),
            suppression: Arc::new(Mutex::new(None)),
            operation: Arc::new(Mutex::new(())),
            shutting_down: AtomicBool::new(false),
        }
    }

    /// Start one watcher. Returns a resource id and the delivery tier actually
    /// running. Failures are errors — never a success that silently never
    /// emits.
    pub fn watch(&self, params: ClipboardWatchParams) -> Result<WatchResult> {
        if !self.source.is_supported() {
            bail!("clipboard.watch is not supported on this platform");
        }
        if self.shutting_down.load(Ordering::Relaxed) {
            bail!("clipboard manager is shutting down");
        }
        let poll_interval_ms = params
            .poll_interval_ms
            .unwrap_or(DEFAULT_POLL_INTERVAL_MS)
            .clamp(MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
        let watch_id = Uuid::new_v4().to_string();
        let (sender, receiver) = std::sync::mpsc::sync_channel::<Notification>(CHANNEL_CAPACITY);
        let dropped = Arc::new(AtomicU64::new(0));
        let closing = Arc::new(AtomicBool::new(false));
        let context = Arc::new(ProducerContext {
            source: Arc::clone(&self.source),
            sender,
            dropped: Arc::clone(&dropped),
            closing: Arc::clone(&closing),
            suppression: Arc::clone(&self.suppression),
            operation: Arc::clone(&self.operation),
        });

        let emitter = self.spawn_emitter(&watch_id, receiver, dropped, Arc::clone(&closing));
        let mut handle = WatcherHandle {
            closing,
            producer: None,
            emitter: Some(emitter),
        };
        match self.spawn_producer(&watch_id, context, poll_interval_ms) {
            Ok((producer, mode)) => {
                handle.producer = Some(producer);
                self.watchers
                    .lock()
                    .map_err(|_| anyhow::anyhow!("clipboard watcher registry lock poisoned"))?
                    .insert(watch_id.clone(), handle);
                Ok(WatchResult { watch_id, mode })
            }
            Err(error) => {
                // Tear the emitter back down so a failed watch leaves nothing behind.
                handle.closing.store(true, Ordering::Relaxed);
                if let Some(emitter) = handle.emitter.take() {
                    let _ = emitter.join();
                }
                Err(error)
            }
        }
    }

    /// Stop one watcher. Idempotent: stopping an unknown id reports
    /// `removed: false` instead of failing.
    pub fn unwatch(&self, params: ClipboardUnwatchParams) -> Result<ClipboardUnwatchResult> {
        let handle = self
            .watchers
            .lock()
            .map_err(|_| anyhow::anyhow!("clipboard watcher registry lock poisoned"))?
            .remove(&params.watch_id);
        let Some(mut handle) = handle else {
            return Ok(ClipboardUnwatchResult { removed: false });
        };
        stop_handle(&mut handle);
        Ok(ClipboardUnwatchResult { removed: true })
    }

    /// Read current clipboard content within bounds. This is the trusted path
    /// history recording and note capture both use.
    pub fn read(&self, _params: ClipboardReadParams) -> Result<ClipboardReadResult> {
        let limits = ContentLimits::default();
        Ok(match self.source.read(&limits)? {
            ClipboardContent::None => ClipboardReadResult {
                kind: "none",
                ..ClipboardReadResult::none_default()
            },
            ClipboardContent::Text { text, truncated } => ClipboardReadResult {
                kind: "text",
                text: Some(text),
                truncated: Some(truncated),
                ..ClipboardReadResult::none_default()
            },
            ClipboardContent::Image {
                png_base64,
                fingerprint,
                width,
                height,
                file_name,
                too_large,
            } => ClipboardReadResult {
                kind: "image",
                png_base64,
                fingerprint: Some(fingerprint),
                width: Some(width),
                height: Some(height),
                file_name,
                too_large: Some(too_large),
                ..ClipboardReadResult::none_default()
            },
            ClipboardContent::Files { names } => ClipboardReadResult {
                kind: "files",
                names: Some(names),
                ..ClipboardReadResult::none_default()
            },
        })
    }

    /// Write text through the same process that watches, then arm echo
    /// suppression for the signature the write produced.
    pub fn write_text(&self, params: ClipboardWriteTextParams) -> Result<ClipboardWriteTextResult> {
        let text = params.text;
        if text.is_empty() || text.len() > 256_000 {
            bail!("clipboard text is empty or too large");
        }
        // The operation lock makes the write + suppression arm atomic from the
        // watchers' point of view: no update handler can read the clipboard in
        // between and record our own write-back as a user copy.
        let _operation = self
            .operation
            .lock()
            .map_err(|_| anyhow::anyhow!("clipboard operation lock poisoned"))?;
        let signature = self.source.write_text(&text)?;
        if let Ok(mut slot) = self.suppression.lock() {
            *slot = Some(Suppression {
                signature: signature.clone(),
                at: Instant::now(),
            });
        }
        Ok(ClipboardWriteTextResult {
            written: true,
            signature: signature.formats,
        })
    }

    pub fn watcher_count(&self) -> usize {
        self.watchers
            .lock()
            .map(|watchers| watchers.len())
            .unwrap_or_default()
    }

    /// Stop every watcher and join its threads. Called from sidecar shutdown:
    /// no leaked thread, no leaked message-only window.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Relaxed);
        let Ok(mut watchers) = self.watchers.lock() else {
            return;
        };
        for (_, mut handle) in watchers.drain() {
            stop_handle(&mut handle);
        }
    }

    fn spawn_emitter(
        &self,
        watch_id: &str,
        receiver: std::sync::mpsc::Receiver<Notification>,
        dropped: Arc<AtomicU64>,
        closing: Arc<AtomicBool>,
    ) -> JoinHandle<()> {
        let watch_id = watch_id.to_owned();
        let sink = Arc::clone(&self.sink);
        thread::Builder::new()
            .name(format!("nd-clipboard-emit-{watch_id}"))
            .spawn(move || {
                let mut seq: u64 = 0;
                let mut unreported: u64 = 0;
                // The producer dropping its sender ends this loop, so shutdown
                // joins are bounded by producer exit, not by event volume.
                while let Ok(note) = receiver.recv() {
                    let dropped_now = dropped.swap(0, Ordering::Relaxed);
                    if closing.load(Ordering::Relaxed) {
                        unreported = unreported.saturating_add(1 + dropped_now);
                        continue;
                    }
                    if sink.outbound_queued() >= MAX_OUTBOUND_QUEUED_FRAMES {
                        unreported = unreported.saturating_add(1 + dropped_now);
                        continue;
                    }
                    seq = seq.saturating_add(1);
                    let report = unreported.saturating_add(dropped_now);
                    unreported = 0;
                    let data = ClipboardChangedData {
                        watch_id: watch_id.clone(),
                        seq,
                        signature: note.signature.formats,
                        content_type: note.content_type,
                        timestamp: note.timestamp,
                        dropped_since_last: report,
                    };
                    if sink.send_clipboard_changed(&watch_id, seq, &data).is_err() {
                        // Sink closed (sidecar exiting): stop emitting.
                        break;
                    }
                }
            })
            .expect("spawn clipboard event emitter")
    }

    fn spawn_producer(
        &self,
        watch_id: &str,
        context: Arc<ProducerContext>,
        poll_interval_ms: u64,
    ) -> Result<(Producer, &'static str)> {
        // Push first; a failed push start degrades visibly to the poll tier
        // and reports which tier actually runs in the watch result.
        #[cfg(windows)]
        if self.source.supports_push() {
            match spawn_push_watcher(watch_id, Arc::clone(&context)) {
                Ok((thread, hwnd)) => return Ok((Producer::Push { hwnd, thread }, "push")),
                Err(error) => {
                    eprintln!(
                        "[nd-core] clipboard push watcher unavailable, falling back to polling: {error:#}"
                    );
                }
            }
        }
        let thread = spawn_poll_watcher(watch_id, context, poll_interval_ms)?;
        Ok((Producer::Poll { thread }, "poll"))
    }
}

impl Drop for ClipboardManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn stop_handle(handle: &mut WatcherHandle) {
    handle.closing.store(true, Ordering::Relaxed);
    if let Some(producer) = handle.producer.take() {
        match producer {
            #[cfg(windows)]
            Producer::Push { hwnd, thread } => {
                // Posting the stop message wakes the pump immediately; the
                // window is destroyed on the thread that owns it.
                unsafe {
                    windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW(
                        hwnd as usize as windows_sys::Win32::Foundation::HWND,
                        WM_APP_STOP,
                        0,
                        0,
                    );
                }
                let _ = thread.join();
            }
            Producer::Poll { thread } => {
                let _ = thread.join();
            }
        }
    }
    if let Some(emitter) = handle.emitter.take() {
        let _ = emitter.join();
    }
}

fn spawn_poll_watcher(
    watch_id: &str,
    context: Arc<ProducerContext>,
    poll_interval_ms: u64,
) -> Result<JoinHandle<()>> {
    let watch_id = watch_id.to_owned();
    // Seed the baseline at watch start: whatever sits on the clipboard before
    // the watcher existed is never reported as a change.
    let mut last: Option<FormatSignature> =
        retry_signature(context.source.as_ref(), 3, Duration::from_millis(10));
    let interval = Duration::from_millis(poll_interval_ms);
    thread::Builder::new()
        .name(format!("nd-clipboard-poll-{watch_id}"))
        .spawn(move || {
            let mut elapsed = Duration::ZERO;
            let mut last_counter: Option<u64> = None;
            let slice = Duration::from_millis(25);
            loop {
                if context.closing.load(Ordering::Relaxed) {
                    return;
                }
                thread::sleep(slice);
                elapsed += slice;
                if elapsed < interval {
                    continue;
                }
                elapsed = Duration::ZERO;
                // Near-free short-circuit: when the platform exposes a
                // change counter, an unchanged clipboard is skipped
                // without opening it at all.
                if let Some(counter) = context.source.change_counter() {
                    if last_counter == Some(counter) {
                        continue;
                    }
                    last_counter = Some(counter);
                }
                // Serialised against writes so an in-flight sidecar write
                // is never observed half-armed.
                let Ok(_operation) = context.operation.lock() else {
                    continue;
                };
                // A busy clipboard reads as None; keep the previous baseline
                // and try again next tick rather than emitting a phantom.
                if let Some(signature) = retry_signature(context.source.as_ref(), 1, Duration::ZERO)
                    && last.as_ref() != Some(&signature)
                {
                    last = Some(signature.clone());
                    context.record_change(&signature);
                }
            }
        })
        .context("spawn clipboard poll watcher")
}

// --- Windows push tier ---------------------------------------------------------

#[cfg(windows)]
mod windows_push {
    use super::{ProducerContext, WM_APP_STOP, register_watcher_class_once, retry_signature};
    use anyhow::{Context, Result, anyhow};
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    use std::thread::JoinHandle;
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::DataExchange::AddClipboardFormatListener;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GWLP_USERDATA,
        GetMessageW, GetWindowLongPtrW, HWND_MESSAGE, MSG, SetWindowLongPtrW, TranslateMessage,
        WM_CLIPBOARDUPDATE,
    };

    /// State reachable from the window procedure. Lives in `GWLP_USERDATA`.
    struct PumpState {
        context: Arc<ProducerContext>,
    }

    impl PumpState {
        fn on_clipboard_update(&self) {
            if self.context.closing.load(Ordering::Relaxed) {
                return;
            }
            // Serialised against the write path: an update for the sidecar's
            // own write must see the armed suppression, not race it.
            let Ok(_operation) = self.context.operation.lock() else {
                return;
            };
            // A busy clipboard reads as None; the change is then lost, but
            // retries keep a momentary lock from swallowing it.
            if let Some(signature) =
                retry_signature(self.context.source.as_ref(), 5, Duration::from_millis(10))
            {
                self.context.record_change(&signature);
            } else {
                self.context.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    pub(super) unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        unsafe {
            if msg == WM_CLIPBOARDUPDATE {
                let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const PumpState;
                if !state.is_null() {
                    (*state).on_clipboard_update();
                }
                return 0;
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
    }

    pub(super) fn spawn(
        watch_id: &str,
        context: Arc<ProducerContext>,
    ) -> Result<(JoinHandle<()>, isize)> {
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<isize, String>>(1);
        let id = watch_id.to_owned();
        let handle = std::thread::Builder::new()
            .name(format!("nd-clipboard-pump-{id}"))
            .spawn(move || {
                let result = run_pump(&id, &context, &ready_tx);
                if let Err(error) = result {
                    eprintln!("[nd-core] clipboard watcher pump stopped: {error:#}");
                }
            })?;
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(hwnd)) => Ok((handle, hwnd)),
            Ok(Err(message)) => {
                let _ = handle.join();
                Err(anyhow!(
                    "clipboard watcher window failed to start: {message}"
                ))
            }
            Err(_) => Err(anyhow!("clipboard watcher window did not become ready")),
        }
    }

    /// Creates the message-only window, arms the clipboard listener, signals
    /// readiness, and pumps until the stop message. All teardown happens on
    /// this thread, which owns the window.
    fn run_pump(
        watch_id: &str,
        context: &Arc<ProducerContext>,
        ready_tx: &std::sync::mpsc::SyncSender<Result<isize, String>>,
    ) -> Result<()> {
        register_watcher_class_once();

        let class_name: Vec<u16> = super::WATCHER_WINDOW_CLASS
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let window_name: Vec<u16> = format!("nd-clipboard-watcher-{watch_id}")
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        // SAFETY: every call here is the documented single-threaded window
        // setup for the message-only window this thread then owns.
        unsafe {
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                window_name.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            );
            if hwnd.is_null() {
                let error = std::io::Error::last_os_error();
                let _ = ready_tx.send(Err(error.to_string()));
                return Err(error).context("create clipboard watcher message-only window");
            }

            let state = Box::new(PumpState {
                context: Arc::clone(context),
            });
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(state) as isize);

            if AddClipboardFormatListener(hwnd) == 0 {
                let error = std::io::Error::last_os_error();
                take_state(hwnd);
                DestroyWindow(hwnd);
                let _ = ready_tx.send(Err(error.to_string()));
                return Err(error).context("register clipboard format listener");
            }

            let _ = ready_tx.send(Ok(hwnd as isize));

            let mut message: MSG = std::mem::zeroed();
            loop {
                let result = GetMessageW(&mut message, std::ptr::null_mut(), 0, 0);
                // 0 = WM_QUIT, -1 = error; both end the pump, as does the stop
                // message the manager posts on unwatch or shutdown.
                if result == 0 || result == -1 || message.message == WM_APP_STOP {
                    break;
                }
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }

            take_state(hwnd);
            DestroyWindow(hwnd);
        }
        Ok(())
    }

    fn take_state(hwnd: HWND) {
        // SAFETY: the pointer was stored by this module on this thread's own
        // window and is boxed state; reading and clearing it restores sole
        // ownership before dropping.
        unsafe {
            let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PumpState;
            if !state.is_null() {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                drop(Box::from_raw(state));
            }
        }
    }
}

#[cfg(windows)]
use windows_push::spawn as spawn_push_watcher;

#[cfg(windows)]
const WM_APP_STOP: u32 = windows_sys::Win32::UI::WindowsAndMessaging::WM_APP + 1;

#[cfg(windows)]
const WATCHER_WINDOW_CLASS: &str = "ND_DSH_ClipboardWatcher";

#[cfg(windows)]
fn register_watcher_class_once() {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{RegisterClassW, WNDCLASSW};
    static REGISTERED: OnceLock<bool> = OnceLock::new();
    // One-time registration guard: a second watcher must not re-register the
    // class. ERROR_CLASS_ALREADY_EXISTS still counts as owned.
    REGISTERED.get_or_init(|| {
        let class_name: Vec<u16> = WATCHER_WINDOW_CLASS
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut class: WNDCLASSW = unsafe { std::mem::zeroed() };
        class.lpfnWndProc = Some(windows_push::wnd_proc);
        class.lpszClassName = class_name.as_ptr();
        class.hInstance = unsafe { GetModuleHandleW(std::ptr::null()) };
        let atom = unsafe { RegisterClassW(&class) };
        atom != 0 || std::io::Error::last_os_error().raw_os_error() == Some(1410)
    });
}

// --- Windows clipboard source ---------------------------------------------------

/// Reads and writes the session clipboard through Win32, and classifies
/// signatures with the registered PNG format included. This is also the
/// process that owns the watcher, which is what makes echo suppression exact.
#[cfg(windows)]
pub struct WindowsClipboardSource;

#[cfg(windows)]
impl WindowsClipboardSource {
    fn png_format() -> u32 {
        static PNG_FORMAT: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
        *PNG_FORMAT.get_or_init(|| {
            let name: Vec<u16> = "PNG".encode_utf16().chain(std::iter::once(0)).collect();
            unsafe {
                windows_sys::Win32::System::DataExchange::RegisterClipboardFormatW(name.as_ptr())
            }
        })
    }

    /// Run `body` with the clipboard open, retrying while another process
    /// holds it. Every code path closes the clipboard before returning.
    fn with_open<T>(body: impl FnOnce() -> Result<T>) -> Result<T> {
        let mut opened = false;
        let result = (|| {
            for _ in 0..10 {
                if unsafe {
                    windows_sys::Win32::System::DataExchange::OpenClipboard(std::ptr::null_mut())
                } != 0
                {
                    opened = true;
                    return body();
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            bail!("clipboard is busy")
        })();
        if opened {
            unsafe {
                windows_sys::Win32::System::DataExchange::CloseClipboard();
            }
        }
        result
    }

    fn enum_formats() -> Vec<u32> {
        let mut formats = Vec::new();
        let mut format =
            unsafe { windows_sys::Win32::System::DataExchange::EnumClipboardFormats(0) };
        while format != 0 {
            formats.push(format);
            format =
                unsafe { windows_sys::Win32::System::DataExchange::EnumClipboardFormats(format) };
        }
        formats.sort_unstable();
        formats.dedup();
        formats
    }

    /// Copy the bytes behind a clipboard handle out while the clipboard is open.
    fn read_handle_bytes(format: u32) -> Result<Option<Vec<u8>>> {
        // SAFETY: the handle came from GetClipboardData with the clipboard
        // open on this thread; GlobalSize/Lock/Unlock access it while locked
        // and copy out before unlocking.
        unsafe {
            let handle = windows_sys::Win32::System::DataExchange::GetClipboardData(format);
            if handle.is_null() {
                return Ok(None);
            }
            let size = windows_sys::Win32::System::Memory::GlobalSize(handle.cast());
            if size == 0 || size > usize::try_from(MAX_SOURCE_BYTES).unwrap_or(usize::MAX) {
                bail!("clipboard payload exceeds the read bound");
            }
            let locked = windows_sys::Win32::System::Memory::GlobalLock(handle.cast());
            if locked.is_null() {
                bail!("clipboard payload could not be locked");
            }
            let bytes = std::slice::from_raw_parts(locked.cast::<u8>(), size).to_vec();
            windows_sys::Win32::System::Memory::GlobalUnlock(handle.cast());
            Ok(Some(bytes))
        }
    }
}

#[cfg(windows)]
impl ClipboardSource for WindowsClipboardSource {
    fn supports_push(&self) -> bool {
        true
    }

    fn change_counter(&self) -> Option<u64> {
        Some(
            unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() }
                as u64,
        )
    }

    fn signature(&self) -> Option<FormatSignature> {
        let change_id = self.change_counter()?;
        Self::with_open(|| {
            let formats = Self::enum_formats();
            Ok(Some(FormatSignature::new(formats, change_id)))
        })
        .ok()
        .flatten()
    }

    fn content_type(&self, signature: &FormatSignature) -> &'static str {
        classify_signature(&signature.formats, Self::png_format())
    }

    fn read(&self, limits: &ContentLimits) -> Result<ClipboardContent> {
        // Snapshot the raw payloads while open, decode after close so a long
        // image decode never holds the session clipboard.
        enum Raw {
            Hdrop(Vec<String>),
            Dib(Vec<u8>),
            Png(Vec<u8>),
            Text(Vec<u8>),
        }
        let raw = Self::with_open(|| {
            let formats = Self::enum_formats();
            if formats.contains(&CF_HDROP) {
                return Ok(Some(Raw::Hdrop(
                    Self::read_handle_bytes(CF_HDROP)?
                        .map(|bytes| parse_hdrop(&bytes))
                        .unwrap_or_default(),
                )));
            }
            let png_format = Self::png_format();
            if png_format != 0 && formats.contains(&png_format) {
                return Ok(Self::read_handle_bytes(png_format)?.map(Raw::Png));
            }
            if formats.contains(&CF_DIB) {
                return Ok(Self::read_handle_bytes(CF_DIB)?.map(Raw::Dib));
            }
            if formats.contains(&CF_DIBV5) {
                return Ok(Self::read_handle_bytes(CF_DIBV5)?.map(Raw::Dib));
            }
            if formats.contains(&CF_UNICODETEXT) {
                return Ok(Self::read_handle_bytes(CF_UNICODETEXT)?.map(Raw::Text));
            }
            Ok(None)
        })?;

        match raw {
            None => Ok(ClipboardContent::None),
            Some(Raw::Hdrop(names)) => {
                if names.len() == 1
                    && names[0].rsplit('.').next().is_some_and(|ext| {
                        IMAGE_FILE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
                    })
                {
                    read_image_file(&names[0])
                } else {
                    Ok(ClipboardContent::Files { names })
                }
            }
            Some(Raw::Dib(bytes)) => decode_dib(&bytes),
            Some(Raw::Png(bytes)) => decode_png(&bytes, None),
            Some(Raw::Text(bytes)) => Ok(decode_utf16_text(&bytes, limits.max_text_chars)),
        }
    }

    fn write_text(&self, text: &str) -> Result<FormatSignature> {
        let mut wide: Vec<u16> = text.encode_utf16().collect();
        wide.push(0);
        let byte_len = wide.len() * 2;
        Self::with_open(|| unsafe {
            if windows_sys::Win32::System::DataExchange::EmptyClipboard() == 0 {
                bail!("clipboard could not be cleared for writing");
            }
            let handle = windows_sys::Win32::System::Memory::GlobalAlloc(
                windows_sys::Win32::System::Memory::GMEM_MOVEABLE,
                byte_len,
            );
            if handle.is_null() {
                bail!("clipboard allocation failed");
            }
            let locked = windows_sys::Win32::System::Memory::GlobalLock(handle);
            if locked.is_null() {
                windows_sys::Win32::Foundation::GlobalFree(handle);
                bail!("clipboard allocation could not be locked");
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), locked.cast::<u16>(), wide.len());
            windows_sys::Win32::System::Memory::GlobalUnlock(handle);

            let set = windows_sys::Win32::System::DataExchange::SetClipboardData(
                CF_UNICODETEXT,
                handle.cast(),
            );
            if set.is_null() {
                // Ownership did not transfer; free to avoid the leak.
                windows_sys::Win32::Foundation::GlobalFree(handle);
                bail!("clipboard text could not be set");
            }
            Ok(())
        })?;
        // Observe what actually landed (Windows may add formats such as
        // CF_LOCALE) so echo suppression matches the real signature.
        let change_id = self.change_counter().context("clipboard change counter")?;
        Self::with_open(|| Ok(FormatSignature::new(Self::enum_formats(), change_id)))
    }
}

#[cfg(windows)]
fn read_image_file(path: &str) -> Result<ClipboardContent> {
    let metadata = std::fs::metadata(path).context("copied image file is unavailable")?;
    if !metadata.is_file() {
        bail!("copied file is not a regular file");
    }
    if metadata.len() > MAX_SOURCE_BYTES {
        bail!("copied image file exceeds the read bound");
    }
    let bytes = std::fs::read(path).context("copied image file could not be read")?;
    let file_name = std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned());
    decode_png(&bytes, file_name)
}

/// Decode PNG (or any format the image crate recognises) into the uniform
/// fingerprint + bounded-PNG payload history stores.
#[cfg(windows)]
fn decode_png(bytes: &[u8], file_name: Option<String>) -> Result<ClipboardContent> {
    use std::io::Cursor;

    let source = image::load_from_memory(bytes).context("clipboard image is undecodable")?;
    if u64::from(source.width()) * u64::from(source.height()) > MAX_SOURCE_PIXELS {
        bail!("clipboard image exceeds the pixel bound");
    }
    let rgba = source.to_rgba8();
    let fingerprint = image_fingerprint(rgba.width(), rgba.height(), rgba.as_raw());

    let mut encoded: Vec<u8> = Vec::new();
    rgba.write_to(&mut Cursor::new(&mut encoded), image::ImageFormat::Png)
        .context("clipboard image could not be re-encoded")?;
    let too_large = encoded.len() > MAX_ENCODED_PNG_BYTES;
    let png_base64 = if too_large {
        None
    } else {
        Some(base64::engine::general_purpose::STANDARD.encode(&encoded))
    };
    Ok(ClipboardContent::Image {
        png_base64,
        fingerprint,
        width: rgba.width(),
        height: rgba.height(),
        file_name,
        too_large,
    })
}

/// Decode a clipboard DIB (BITMAPINFOHEADER family) into RGBA and re-encode.
/// Supports the formats Windows actually hands out for screenshots and
/// rendered copies: BI_RGB at 24/32 bpp and BI_BITFIELDS 32 bpp with masks
/// carried at the header tail.
#[cfg(windows)]
fn decode_dib(dib: &[u8]) -> Result<ClipboardContent> {
    if dib.len() < 40 {
        bail!("clipboard bitmap header is truncated");
    }
    let le_u16 = |offset: usize| -> u16 { u16::from_le_bytes([dib[offset], dib[offset + 1]]) };
    let le_u32 = |offset: usize| -> u32 {
        u32::from_le_bytes([
            dib[offset],
            dib[offset + 1],
            dib[offset + 2],
            dib[offset + 3],
        ])
    };
    let le_i32 = |offset: usize| -> i32 {
        i32::from_le_bytes(dib[offset..offset + 4].try_into().expect("4 bytes"))
    };

    let header_size = le_u32(0) as usize;
    if header_size < 40 || header_size > dib.len() {
        bail!("clipboard bitmap header size is unsupported: {header_size}");
    }
    let width = le_i32(4);
    let height_raw = le_i32(8);
    if width <= 0 || height_raw == 0 {
        bail!("clipboard bitmap has empty dimensions");
    }
    let top_down = height_raw < 0;
    let (width, height): (u32, u32) = (width as u32, height_raw.unsigned_abs());
    let bit_count = le_u16(14);
    let compression = le_u32(16);
    let colors_used = le_u32(32) as usize;
    if u64::from(width) * u64::from(height) > MAX_SOURCE_PIXELS {
        bail!("clipboard bitmap exceeds the pixel bound");
    }
    if compression != BI_RGB && compression != BI_BITFIELDS {
        bail!("clipboard bitmap compression {compression} is unsupported");
    }
    if bit_count != 24 && bit_count != 32 {
        bail!("clipboard bitmap depth {bit_count} is unsupported");
    }

    let palette_bytes = if bit_count <= 8 {
        if colors_used > 0 {
            colors_used * 4
        } else {
            (1usize << bit_count) * 4
        }
    } else {
        0
    };
    // A 40-byte header with BI_BITFIELDS carries its three masks immediately
    // after the header; larger (V4/V5) headers carry them inside.
    let masks_after_header = compression == BI_BITFIELDS && header_size == 40;
    let pixel_offset = header_size + palette_bytes + if masks_after_header { 12 } else { 0 };
    if dib.len() < pixel_offset {
        bail!("clipboard bitmap is truncated before pixel data");
    }

    let (red_mask, green_mask, blue_mask) = if compression == BI_BITFIELDS {
        let mask_offset = if masks_after_header { header_size } else { 40 };
        if dib.len() < mask_offset + 12 {
            bail!("clipboard bitmap channel masks are truncated");
        }
        (
            le_u32(mask_offset),
            le_u32(mask_offset + 4),
            le_u32(mask_offset + 8),
        )
    } else if bit_count == 32 {
        (0x00FF_0000, 0x0000_FF00, 0x0000_00FF)
    } else {
        (0, 0, 0)
    };

    let row_bytes = (width as usize * bit_count as usize).div_ceil(32) * 4;
    let needed = pixel_offset + row_bytes * height as usize;
    if dib.len() < needed {
        bail!("clipboard bitmap pixel data is truncated");
    }

    let mask_channel = |pixel: u32, mask: u32| -> u8 {
        if mask == 0 {
            return 0;
        }
        let shift = mask.trailing_zeros();
        let bits = 32 - mask.leading_zeros() - shift;
        let raw = (pixel & mask) >> shift;
        let max = (1u32 << bits) - 1;
        ((raw * 255 + max / 2) / max) as u8
    };

    let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
    for row in 0..height as usize {
        let source_row = if top_down {
            row
        } else {
            height as usize - 1 - row
        };
        let start = pixel_offset + source_row * row_bytes;
        for column in 0..width as usize {
            let offset = start + column * (bit_count as usize / 8);
            if bit_count == 32 {
                let pixel = u32::from_le_bytes([
                    dib[offset],
                    dib[offset + 1],
                    dib[offset + 2],
                    dib[offset + 3],
                ]);
                let red = mask_channel(pixel, red_mask);
                let green = mask_channel(pixel, green_mask);
                let blue = mask_channel(pixel, blue_mask);
                // Clipboard bitmaps are opaque in practice — screenshots and
                // rendered copies carry zeroed alpha bytes. Force opaque
                // rather than storing fully transparent pictures.
                rgba.extend_from_slice(&[red, green, blue, 255]);
            } else {
                // 24 bpp rows are BGR triplets.
                rgba.extend_from_slice(&[dib[offset + 2], dib[offset + 1], dib[offset], 255]);
            }
        }
    }

    use std::io::Cursor;
    let image = image::RgbaImage::from_raw(width, height, rgba)
        .context("clipboard bitmap size mismatch")?;
    let fingerprint = image_fingerprint(width, height, image.as_raw());
    let mut encoded: Vec<u8> = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut encoded), image::ImageFormat::Png)
        .context("clipboard bitmap could not be re-encoded")?;
    let too_large = encoded.len() > MAX_ENCODED_PNG_BYTES;
    let png_base64 = if too_large {
        None
    } else {
        Some(base64::engine::general_purpose::STANDARD.encode(&encoded))
    };
    Ok(ClipboardContent::Image {
        png_base64,
        fingerprint,
        width,
        height,
        file_name: None,
        too_large,
    })
}

/// Parse an HDROP payload: a DROPFILES header followed by a file-name list.
#[cfg(windows)]
fn parse_hdrop(bytes: &[u8]) -> Vec<String> {
    if bytes.len() < 20 {
        return Vec::new();
    }
    let le_u32 = |offset: usize| -> usize {
        usize::try_from(u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]))
        .unwrap_or(usize::MAX)
    };
    let list_offset = le_u32(0);
    let wide = le_u32(16) != 0;
    if list_offset >= bytes.len() {
        return Vec::new();
    }
    let list = &bytes[list_offset..];
    let mut names = Vec::new();
    if wide {
        let mut current: Vec<u16> = Vec::new();
        for pair in list.as_chunks::<2>().0 {
            let unit = u16::from_le_bytes(*pair);
            if unit == 0 {
                // A double NUL (empty name after a name) ends the list.
                if current.is_empty() {
                    break;
                }
                names.push(String::from_utf16_lossy(&current));
                current.clear();
                if names.len() >= MAX_FILE_NAMES {
                    break;
                }
                continue;
            }
            current.push(unit);
        }
    } else {
        let mut current: Vec<u8> = Vec::new();
        for &byte in list {
            if byte == 0 {
                if current.is_empty() {
                    break;
                }
                names.push(String::from_utf8_lossy(&current).into_owned());
                current.clear();
                if names.len() >= MAX_FILE_NAMES {
                    break;
                }
                continue;
            }
            current.push(byte);
        }
    }
    names
        .into_iter()
        .filter(|name| !name.is_empty())
        .map(|name| name.chars().take(MAX_FILE_NAME_CHARS).collect::<String>())
        .collect()
}

#[cfg(windows)]
fn decode_utf16_text(bytes: &[u8], max_chars: usize) -> ClipboardContent {
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .take_while(|&unit| unit != 0)
        .collect();
    let full = String::from_utf16_lossy(&units);
    let truncated = full.chars().count() > max_chars;
    let text: String = full
        .chars()
        .take(max_chars)
        .collect::<String>()
        .trim_end()
        .to_owned();
    ClipboardContent::Text { text, truncated }
}

/// Fingerprint over decoded pixels plus dimensions, so the same picture
/// re-copied through a different encoder still dedups in history.
#[cfg(windows)]
fn image_fingerprint(width: u32, height: u32, rgba: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"nd-clipboard-image");
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update(rgba);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

// --- Platform source selection ---------------------------------------------------

/// The clipboard implementation for this platform. Non-Windows platforms have
/// no source yet, so `clipboard.watch` fails closed there instead of starting
/// a watcher that could never observe anything; the poll tier itself is
/// platform-neutral and exercised by the injected-source tests.
pub fn platform_source() -> Arc<dyn ClipboardSource> {
    #[cfg(windows)]
    {
        Arc::new(WindowsClipboardSource)
    }
    #[cfg(not(windows))]
    {
        Arc::new(NullClipboardSource)
    }
}

#[cfg(not(windows))]
pub struct NullClipboardSource;

#[cfg(not(windows))]
impl ClipboardSource for NullClipboardSource {
    fn is_supported(&self) -> bool {
        false
    }

    fn signature(&self) -> Option<FormatSignature> {
        None
    }

    fn read(&self, _limits: &ContentLimits) -> Result<ClipboardContent> {
        bail!("clipboard access is not implemented for this platform in nd-core")
    }

    fn write_text(&self, _text: &str) -> Result<FormatSignature> {
        bail!("clipboard access is not implemented for this platform in nd-core")
    }
}

// --- Tests ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct RecordingSink {
        events: Mutex<Vec<ClipboardChangedData>>,
        queued: AtomicUsize,
    }

    impl RecordingSink {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                events: Mutex::new(Vec::new()),
                queued: AtomicUsize::new(0),
            })
        }

        fn events(&self) -> Vec<ClipboardChangedData> {
            self.events
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
        }

        fn event_count(&self) -> usize {
            self.events
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .len()
        }
    }

    impl ClipboardEventSink for RecordingSink {
        fn send_clipboard_changed(
            &self,
            _watch_id: &str,
            _seq: u64,
            data: &ClipboardChangedData,
        ) -> Result<()> {
            self.events
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(data.clone());
            Ok(())
        }

        fn outbound_queued(&self) -> usize {
            self.queued.load(Ordering::Relaxed)
        }
    }

    struct FakeSource {
        state: Mutex<FakeClipboard>,
        push: bool,
        supported: bool,
    }

    #[derive(Clone)]
    struct FakeClipboard {
        formats: Vec<u32>,
        content: ClipboardContent,
        change_id: u64,
    }

    impl FakeSource {
        fn text(initial: &str) -> Arc<Self> {
            Arc::new(Self {
                state: Mutex::new(FakeClipboard {
                    formats: vec![CF_UNICODETEXT],
                    content: ClipboardContent::Text {
                        text: initial.to_owned(),
                        truncated: false,
                    },
                    change_id: 1,
                }),
                push: false,
                supported: true,
            })
        }

        fn set_text(&self, text: &str) {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.formats = vec![CF_UNICODETEXT];
            state.content = ClipboardContent::Text {
                text: text.to_owned(),
                truncated: false,
            };
            state.change_id += 1;
        }

        fn set_image(&self) {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.formats = vec![CF_DIB, CF_UNICODETEXT];
            state.content = ClipboardContent::Image {
                png_base64: None,
                fingerprint: "fp".to_owned(),
                width: 2,
                height: 2,
                file_name: None,
                too_large: false,
            };
            state.change_id += 1;
        }
    }

    impl ClipboardSource for FakeSource {
        fn is_supported(&self) -> bool {
            self.supported
        }

        fn supports_push(&self) -> bool {
            self.push
        }

        fn change_counter(&self) -> Option<u64> {
            let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            Some(state.change_id)
        }

        fn signature(&self) -> Option<FormatSignature> {
            let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            Some(FormatSignature::new(state.formats.clone(), state.change_id))
        }

        fn read(&self, _limits: &ContentLimits) -> Result<ClipboardContent> {
            let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            Ok(state.content.clone())
        }

        fn write_text(&self, text: &str) -> Result<FormatSignature> {
            self.set_text(text);
            self.signature().context("signature after write")
        }
    }

    fn wait_for(predicate: impl Fn() -> bool, timeout: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < timeout {
            if predicate() {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        predicate()
    }

    fn poll_watch(manager: &ClipboardManager) -> WatchResult {
        manager
            .watch(ClipboardWatchParams {
                poll_interval_ms: Some(10),
            })
            .unwrap()
    }

    #[test]
    fn watch_returns_a_resource_id_and_registers_exactly_one_watcher() {
        let manager = ClipboardManager::new(RecordingSink::new(), FakeSource::text("seed"));
        let result = poll_watch(&manager);
        assert!(!result.watch_id.is_empty());
        assert_eq!(result.mode, "poll");
        assert_eq!(manager.watcher_count(), 1);
        manager.shutdown();
        assert_eq!(manager.watcher_count(), 0);
    }

    #[test]
    fn watch_refuses_an_unsupported_source_instead_of_starting_silently() {
        let source = Arc::new(FakeSource {
            state: Mutex::new(FakeClipboard {
                formats: vec![CF_UNICODETEXT],
                content: ClipboardContent::None,
                change_id: 1,
            }),
            push: false,
            supported: false,
        });
        let manager = ClipboardManager::new(RecordingSink::new(), source);
        assert!(
            manager.watch(ClipboardWatchParams::default()).is_err(),
            "an unsupported source must be an error, never a silent watcher"
        );
        assert_eq!(manager.watcher_count(), 0);
    }

    #[test]
    fn a_change_emits_exactly_one_content_free_event() {
        let sink = RecordingSink::new();
        let source = FakeSource::text("before");
        let manager = ClipboardManager::new(sink.clone(), source.clone());
        let watch = poll_watch(&manager);

        source.set_text("after");
        assert!(
            wait_for(|| sink.event_count() == 1, Duration::from_secs(2)),
            "expected exactly one event"
        );
        let event = &sink.events()[0];
        assert_eq!(event.watch_id, watch.watch_id);
        assert_eq!(event.seq, 1);
        assert_eq!(event.content_type, "text");
        assert!(event.signature.contains(&CF_UNICODETEXT));
        assert_eq!(event.dropped_since_last, 0);
        // The event path must stay content-free.
        assert!(!serde_json::to_string(event).unwrap().contains("after"));

        manager.shutdown();
    }

    #[test]
    fn the_baseline_is_seeded_at_watch_start() {
        let sink = RecordingSink::new();
        let source = FakeSource::text("pre-existing");
        let manager = ClipboardManager::new(sink.clone(), source.clone());
        poll_watch(&manager);
        // No event for the content that was already there; only a real change emits.
        assert!(!wait_for(
            || sink.event_count() > 0,
            Duration::from_millis(120)
        ));
        source.set_text("new copy");
        assert!(wait_for(|| sink.event_count() == 1, Duration::from_secs(2)));
        manager.shutdown();
    }

    #[test]
    fn an_unchanged_clipboard_emits_nothing() {
        let sink = RecordingSink::new();
        let source = FakeSource::text("stable");
        let manager = ClipboardManager::new(sink.clone(), source.clone());
        poll_watch(&manager);
        assert!(!wait_for(
            || sink.event_count() > 0,
            Duration::from_millis(120)
        ));
        manager.shutdown();
    }

    #[test]
    fn unwatch_stops_emission_and_is_idempotent() {
        let sink = RecordingSink::new();
        let source = FakeSource::text("one");
        let manager = ClipboardManager::new(sink.clone(), source.clone());
        let watch = poll_watch(&manager);

        let removed = manager
            .unwatch(ClipboardUnwatchParams {
                watch_id: watch.watch_id.clone(),
            })
            .unwrap();
        assert!(removed.removed);
        let again = manager
            .unwatch(ClipboardUnwatchParams {
                watch_id: watch.watch_id,
            })
            .unwrap();
        assert!(!again.removed, "stopping twice must be idempotent");
        assert_eq!(manager.watcher_count(), 0);

        source.set_text("two");
        assert!(!wait_for(
            || sink.event_count() > 0,
            Duration::from_millis(150)
        ));
    }

    #[test]
    fn a_sidecar_write_is_suppressed_as_echo() {
        let sink = RecordingSink::new();
        let source = FakeSource::text("user text");
        let manager = ClipboardManager::new(sink.clone(), source.clone());
        poll_watch(&manager);

        manager
            .write_text(ClipboardWriteTextParams {
                text: "written by nd".to_owned(),
            })
            .unwrap();

        // The write itself must not be observed as a user copy.
        assert!(!wait_for(
            || sink.event_count() > 0,
            Duration::from_millis(150)
        ));

        // A later genuine change still emits, proving suppression was consumed
        // rather than wedging the watcher.
        source.set_text("next user copy");
        assert!(wait_for(|| sink.event_count() == 1, Duration::from_secs(2)));
        manager.shutdown();
    }

    #[test]
    fn a_user_copy_of_the_same_text_after_the_window_still_records() {
        let sink = RecordingSink::new();
        let source = FakeSource::text("user text");
        let manager = ClipboardManager::new(sink.clone(), source.clone());
        poll_watch(&manager);

        manager
            .write_text(ClipboardWriteTextParams {
                text: "same text".to_owned(),
            })
            .unwrap();
        assert!(!wait_for(
            || sink.event_count() > 0,
            Duration::from_millis(150)
        ));

        // Simulate the suppression window expiring: the guard is consumed on
        // first match, so a second identical signature change is a real copy.
        source.set_text("intermediate");
        assert!(wait_for(|| sink.event_count() == 1, Duration::from_secs(2)));
        source.set_text("same text");
        assert!(wait_for(|| sink.event_count() == 2, Duration::from_secs(2)));
        manager.shutdown();
    }

    #[test]
    fn a_full_outbound_queue_drops_events_and_reports_the_gap() {
        let sink = RecordingSink::new();
        let source = FakeSource::text("one");
        let manager = ClipboardManager::new(sink.clone(), source.clone());
        poll_watch(&manager);

        // A stalled consumer: the emitter sees a full outbound queue and
        // applies the drop policy instead of blocking or accumulating.
        sink.queued
            .store(MAX_OUTBOUND_QUEUED_FRAMES, Ordering::Relaxed);
        source.set_text("two");
        assert!(!wait_for(
            || sink.event_count() > 0,
            Duration::from_millis(150)
        ));

        sink.queued.store(0, Ordering::Relaxed);
        source.set_text("three");
        assert!(wait_for(|| sink.event_count() == 1, Duration::from_secs(2)));
        assert!(
            sink.events()[0].dropped_since_last >= 1,
            "the gap must be reported on the next delivered event"
        );
        manager.shutdown();
    }

    #[test]
    fn shutdown_stops_every_watcher_and_joins() {
        let sink = RecordingSink::new();
        let source = FakeSource::text("one");
        let manager = ClipboardManager::new(sink.clone(), source.clone());
        poll_watch(&manager);
        poll_watch(&manager);
        assert_eq!(manager.watcher_count(), 2);

        manager.shutdown();
        assert_eq!(manager.watcher_count(), 0);
        source.set_text("after shutdown");
        assert!(!wait_for(
            || sink.event_count() > 0,
            Duration::from_millis(150)
        ));
    }

    #[test]
    fn watch_after_shutdown_is_refused() {
        let manager = ClipboardManager::new(RecordingSink::new(), FakeSource::text("x"));
        manager.shutdown();
        assert!(manager.watch(ClipboardWatchParams::default()).is_err());
    }

    #[test]
    fn read_routes_through_the_injected_source() {
        let source = FakeSource::text("hello");
        let manager = ClipboardManager::new(RecordingSink::new(), source.clone());
        let read = manager.read(ClipboardReadParams::default()).unwrap();
        assert_eq!(read.kind, "text");
        assert_eq!(read.text.as_deref(), Some("hello"));

        source.set_image();
        let read = manager.read(ClipboardReadParams::default()).unwrap();
        assert_eq!(read.kind, "image");
        assert_eq!(read.fingerprint.as_deref(), Some("fp"));
    }

    #[test]
    fn classification_prefers_files_then_images_then_text() {
        assert_eq!(classify_signature(&[CF_HDROP, CF_UNICODETEXT], 0), "files");
        assert_eq!(classify_signature(&[CF_DIB, CF_UNICODETEXT], 0), "image");
        assert_eq!(classify_signature(&[CF_DIBV5], 0), "image");
        assert_eq!(classify_signature(&[49161], 49161), "image");
        assert_eq!(classify_signature(&[CF_UNICODETEXT], 0), "text");
        assert_eq!(classify_signature(&[7], 0), "other");
    }

    #[test]
    fn signature_is_order_insensitive_and_deduplicated() {
        let left = FormatSignature::new(vec![13, 8, 13], 4);
        let right = FormatSignature::new(vec![8, 13], 4);
        let other_change = FormatSignature::new(vec![8, 13], 5);
        assert_eq!(left, right);
        assert_ne!(left, other_change);
    }

    #[test]
    fn a_second_text_copy_is_detected_even_though_formats_do_not_change() {
        let left = FormatSignature::new(vec![CF_UNICODETEXT], 1);
        let right = FormatSignature::new(vec![CF_UNICODETEXT], 2);
        assert_ne!(left, right, "same formats, different copy");
    }

    #[test]
    fn the_watch_result_survives_a_json_round_trip() {
        let result = WatchResult {
            watch_id: "watch-1".to_owned(),
            mode: "push",
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["watchId"], "watch-1");
        assert_eq!(value["mode"], "push");
    }

    #[test]
    fn changed_data_serializes_camel_case_and_omits_zero_drops() {
        let data = ClipboardChangedData {
            watch_id: "watch-1".to_owned(),
            seq: 3,
            signature: vec![13],
            content_type: "text",
            timestamp: 123,
            dropped_since_last: 0,
        };
        let value = serde_json::to_value(&data).unwrap();
        assert_eq!(value["watchId"], "watch-1");
        assert_eq!(value["contentType"], "text");
        assert!(value.get("droppedSinceLast").is_none());

        let dropped = ClipboardChangedData {
            dropped_since_last: 2,
            ..data
        };
        let value = serde_json::to_value(&dropped).unwrap();
        assert_eq!(value["droppedSinceLast"], 2);
    }

    #[cfg(windows)]
    mod dib {
        use super::*;
        use image::GenericImageView;

        /// A 2x2 32bpp BI_RGB bitmap, bottom-up (positive height), the shape
        /// Windows hands out for most rendered and screenshot copies.
        fn sample_dib_32bpp(height: i32) -> Vec<u8> {
            let mut dib = Vec::new();
            dib.extend_from_slice(&40u32.to_le_bytes()); // biSize
            dib.extend_from_slice(&2i32.to_le_bytes()); // width
            dib.extend_from_slice(&height.to_le_bytes());
            dib.extend_from_slice(&1u16.to_le_bytes()); // planes
            dib.extend_from_slice(&32u16.to_le_bytes()); // bit count
            dib.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
            dib.extend_from_slice(&0u32.to_le_bytes()); // size image
            dib.extend_from_slice(&0i32.to_le_bytes()); // x ppm
            dib.extend_from_slice(&0i32.to_le_bytes()); // y ppm
            dib.extend_from_slice(&0u32.to_le_bytes()); // colors used
            dib.extend_from_slice(&0u32.to_le_bytes()); // important
            // Rows: B,G,R,X — row 0 is blue, row 1 is green (bottom-up source).
            dib.extend_from_slice(&[255u8, 0, 0, 0, 255, 0, 0, 0]);
            dib.extend_from_slice(&[0, 255, 0, 0, 0, 255, 0, 0]);
            dib
        }

        #[test]
        fn a_bottom_up_32bpp_dib_decodes_with_opaque_alpha() {
            let content = decode_dib(&sample_dib_32bpp(2)).unwrap();
            let ClipboardContent::Image {
                png_base64,
                fingerprint,
                width,
                height,
                too_large,
                ..
            } = content
            else {
                panic!("expected an image");
            };
            assert_eq!((width, height), (2, 2));
            assert!(!too_large);
            assert!(png_base64.is_some());

            let decoded = base64::engine::general_purpose::STANDARD
                .decode(png_base64.unwrap())
                .unwrap();
            let image =
                image::load_from_memory_with_format(&decoded, image::ImageFormat::Png).unwrap();
            assert_eq!((image.width(), image.height()), (2, 2));
            let top = image.get_pixel(0, 0);
            // Bottom-up source: the last row lands on top.
            assert_eq!((top[0], top[1], top[2], top[3]), (0, 255, 0, 255));
            assert!(fingerprint.len() == 64);
        }

        #[test]
        fn a_top_down_32bpp_dib_decodes_in_scan_order() {
            let content = decode_dib(&sample_dib_32bpp(-2)).unwrap();
            let ClipboardContent::Image { png_base64, .. } = content else {
                panic!("expected an image");
            };
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(png_base64.unwrap())
                .unwrap();
            let image =
                image::load_from_memory_with_format(&decoded, image::ImageFormat::Png).unwrap();
            let top = image.get_pixel(0, 0);
            // Top-down source: the first row stays on top and is blue.
            assert_eq!((top[0], top[1], top[2]), (0, 0, 255));
        }

        #[test]
        fn a_24bpp_dib_decodes_to_opaque_rgb() {
            let mut dib = Vec::new();
            dib.extend_from_slice(&40u32.to_le_bytes());
            dib.extend_from_slice(&1i32.to_le_bytes());
            dib.extend_from_slice(&1i32.to_le_bytes());
            dib.extend_from_slice(&1u16.to_le_bytes());
            dib.extend_from_slice(&24u16.to_le_bytes());
            dib.extend_from_slice(&0u32.to_le_bytes());
            dib.extend_from_slice(&0u32.to_le_bytes());
            dib.extend_from_slice(&0i32.to_le_bytes());
            dib.extend_from_slice(&0i32.to_le_bytes());
            dib.extend_from_slice(&0u32.to_le_bytes());
            dib.extend_from_slice(&0u32.to_le_bytes());
            // One pixel BGR (row padded to 4 bytes).
            dib.extend_from_slice(&[10, 20, 30, 0, 0]);
            let content = decode_dib(&dib).unwrap();
            let ClipboardContent::Image { png_base64, .. } = content else {
                panic!("expected an image");
            };
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(png_base64.unwrap())
                .unwrap();
            let image =
                image::load_from_memory_with_format(&decoded, image::ImageFormat::Png).unwrap();
            let pixel = image.get_pixel(0, 0);
            assert_eq!((pixel[0], pixel[1], pixel[2], pixel[3]), (30, 20, 10, 255));
        }

        #[test]
        fn truncated_and_unsupported_dibs_fail_closed() {
            let mut dib = sample_dib_32bpp(2);
            dib.truncate(30);
            assert!(decode_dib(&dib).is_err());

            let mut compressed = sample_dib_32bpp(2);
            // biCompression at offset 16 -> 4 (JPEG) is unsupported.
            compressed[16] = 4;
            assert!(decode_dib(&compressed).is_err());

            let mut deep = sample_dib_32bpp(2);
            // biBitCount at offset 14 -> 16bpp is unsupported.
            deep[14] = 16;
            assert!(decode_dib(&deep).is_err());
        }

        #[test]
        fn hdrop_lists_parse_from_wide_payloads() {
            let mut payload = Vec::new();
            payload.extend_from_slice(&20u32.to_le_bytes()); // pFiles
            payload.extend_from_slice(&0i32.to_le_bytes()); // pt.x
            payload.extend_from_slice(&0i32.to_le_bytes()); // pt.y
            payload.extend_from_slice(&0u32.to_le_bytes()); // fNC
            payload.extend_from_slice(&1u32.to_le_bytes()); // fWide
            let name: Vec<u16> = "C:\\Users\\test\\pic.png\0".encode_utf16().collect();
            for unit in name {
                payload.extend_from_slice(&unit.to_le_bytes());
            }
            payload.extend_from_slice(&0u16.to_le_bytes());

            let names = parse_hdrop(&payload);
            assert_eq!(names, vec!["C:\\Users\\test\\pic.png".to_owned()]);
        }

        #[test]
        fn fingerprints_depend_on_pixels_and_dimensions() {
            let left = image_fingerprint(
                2,
                2,
                &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
            );
            let same = image_fingerprint(
                2,
                2,
                &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
            );
            let other_pixels = image_fingerprint(
                2,
                2,
                &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17],
            );
            let other_dims = image_fingerprint(
                4,
                1,
                &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
            );
            assert_eq!(left, same);
            assert_ne!(left, other_pixels);
            assert_ne!(left, other_dims);
        }
    }

    /// Phase 0 spike evidence (task 0050): these tests exercise the real Win32
    /// clipboard in an interactive Windows session. They mutate the session
    /// clipboard, so they are excluded from the default suite and run
    /// explicitly:
    ///
    /// ```text
    /// cargo test -p nd-runtime clipboard:: -- --ignored --test-threads=1
    /// ```
    #[cfg(windows)]
    mod real_clipboard {
        use super::*;

        fn external_copy(text: &str) {
            use std::process::{Command, Stdio};
            let mut child = Command::new("cmd.exe")
                .args(["/C", "clip"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn clip.exe");
            use std::io::Write as _;
            child
                .stdin
                .as_mut()
                .expect("clip stdin")
                .write_all(text.as_bytes())
                .unwrap();
            child.wait().expect("clip exit");
        }

        fn save_user_clipboard() -> Option<String> {
            WindowsClipboardSource
                .read(&ContentLimits::default())
                .ok()
                .map(|content| match content {
                    ClipboardContent::Text { text, .. } => text,
                    _ => String::new(),
                })
        }

        fn restore_user_clipboard(text: Option<String>) {
            if let Some(text) = text.filter(|text| !text.is_empty()) {
                let _ = WindowsClipboardSource.write_text(&text);
            }
        }

        /// Q1/Q4 evidence: a message-only window with AddClipboardFormatListener
        /// receives WM_CLIPBOARDUPDATE for a copy made by another process, with
        /// the event-to-emit latency printed for the record.
        #[test]
        #[ignore = "mutates the real session clipboard; run with --ignored in an interactive Windows session"]
        fn push_watcher_observes_a_third_party_copy_and_measures_latency() {
            let saved = save_user_clipboard();
            let sink = RecordingSink::new();
            let manager = ClipboardManager::new(sink.clone(), Arc::new(WindowsClipboardSource));
            let watch = manager.watch(ClipboardWatchParams::default()).unwrap();
            assert_eq!(watch.mode, "push", "a real Windows session must get tier 1");

            let marker = format!("nd-dsh-spike-{}", Uuid::new_v4());
            let started = Instant::now();
            external_copy(&marker);
            assert!(
                wait_for(|| sink.event_count() == 1, Duration::from_secs(5)),
                "the watcher must observe a copy made by another process"
            );
            let latency = started.elapsed();
            let event = &sink.events()[0];
            assert_eq!(event.content_type, "text");
            println!(
                "PHASE0 push cross-process copy: latency={latency:?} signature={:?} seq={}",
                event.signature, event.seq
            );

            // Tier-1 idle: no event may appear while nothing copies.
            let idle_start = Instant::now();
            let events_before = sink.event_count();
            thread::sleep(Duration::from_secs(2));
            assert_eq!(
                sink.event_count(),
                events_before,
                "idle session must not emit"
            );
            println!(
                "PHASE0 push idle window: {:?} with {} events",
                idle_start.elapsed(),
                sink.event_count()
            );

            manager.shutdown();
            restore_user_clipboard(saved);
        }

        /// Phase 0 Q3 evidence: an nd-core write-back is not observed as a user
        /// copy, while a following third-party copy still is.
        #[test]
        #[ignore = "mutates the real session clipboard; run with --ignored in an interactive Windows session"]
        fn push_watcher_suppresses_nd_write_back() {
            let saved = save_user_clipboard();
            let sink = RecordingSink::new();
            let manager = ClipboardManager::new(sink.clone(), Arc::new(WindowsClipboardSource));
            manager.watch(ClipboardWatchParams::default()).unwrap();

            manager
                .write_text(ClipboardWriteTextParams {
                    text: "nd-dsh-write-back".to_owned(),
                })
                .unwrap();
            assert!(
                !wait_for(|| sink.event_count() > 0, Duration::from_millis(1_000)),
                "an ND write-back must not be recorded as a user copy"
            );

            external_copy("nd-dsh-after-write");
            assert!(
                wait_for(|| sink.event_count() == 1, Duration::from_secs(5)),
                "a following external copy must still be observed"
            );

            manager.shutdown();
            restore_user_clipboard(saved);
        }
    }
}
