//! Native media primitives: image thumbnails and the desktop wallpaper.
//!
//! Thumbnails exist because decoding them in the desktop main process blocked
//! every window in the app — a library of 4K photos cost seconds of frozen UI
//! per view open. Here they are decoded in parallel, off that process, and
//! returned already downscaled and re-encoded, so the payload is a screenful of
//! small JPEGs rather than a stack of full-resolution bitmaps.
//!
//! Thumbnail reads are root-confined exactly like [`crate::workspace`]: the
//! caller supplies a directory ND already handed to the sidecar plus paths
//! relative to it, and anything escaping that root is rejected before any file
//! is opened.
//!
//! [`set_wallpaper`] is the one exception, and says why.

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ExtendedColorType, ImageReader};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::deadline::Interrupt;
use crate::workspace::{canonical_root, resolve_existing_from_root};

const THUMBNAILS_METHOD: &str = "media.thumbnails";

/// One batch is a screenful of rows, not a whole library. Bounding it keeps the
/// response inside a single protocol frame and keeps one slow batch from holding
/// a dispatcher worker for long.
const MAX_THUMBNAIL_REQUESTS: usize = 64;
/// Decoding is embarrassingly parallel, but saturating every core for a
/// background UI request would starve the agent work the sidecar exists for.
const MAX_THUMBNAIL_PARALLELISM: usize = 8;
const DEFAULT_THUMBNAIL_WIDTH: u32 = 240;
const MIN_THUMBNAIL_WIDTH: u32 = 16;
/// Wide enough for a full-screen wallpaper preview, so the desktop main process
/// never has to decode an image itself for any surface.
const MAX_THUMBNAIL_WIDTH: u32 = 1920;
const DEFAULT_JPEG_QUALITY: u8 = 72;
const MIN_JPEG_QUALITY: u8 = 30;
const MAX_JPEG_QUALITY: u8 = 95;

/// A wallpaper source is a photograph, not an archive. Both bounds matter: the
/// byte bound stops a large file from being read at all, and the pixel bound
/// stops a small but highly compressed file from expanding into a bitmap that
/// exhausts memory inside the decoder.
const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SOURCE_PIXELS: u64 = 100_000_000;

/// Encoded output budget for one batch. Base64 inflates by 4/3 and the protocol
/// frame bound is 8 MiB, so this keeps a full batch inside one frame instead of
/// failing after all the decode work was already done.
const MAX_TOTAL_ENCODED_BYTES: usize = 4 * 1024 * 1024;
const MAX_PATH_LENGTH: usize = 4096;

/// Matches the extensions the product's wallpaper picker already offers.
const SUPPORTED_IMAGE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "bmp", "webp"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailsParams {
    pub root: String,
    pub paths: Vec<String>,
    pub width: Option<u32>,
    pub quality: Option<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thumbnail {
    /// The requested root-relative path, so the caller can match results to
    /// requests without depending on ordering.
    pub path: String,
    /// Base64 JPEG. A string rather than bytes because dispatch round-trips
    /// through `serde_json::Value`, where a byte array would expand to one JSON
    /// number per byte.
    pub data: String,
    pub format: &'static str,
    pub width: u32,
    pub height: u32,
    pub source_width: u32,
    pub source_height: u32,
    pub byte_size: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailFailure {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailsResult {
    pub thumbnails: Vec<Thumbnail>,
    pub failures: Vec<ThumbnailFailure>,
    /// The request named more paths than one batch allows, or the encoded output
    /// budget ran out. A partial batch is never presented as a complete one.
    pub truncated: bool,
    pub max_requests: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperSetParams {
    /// Absolute path to an image the user selected through an ND-owned dialog.
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperSetResult {
    pub changed: bool,
    pub path: String,
    pub platform: &'static str,
}

pub fn thumbnails(params: ThumbnailsParams, interrupt: &Interrupt) -> Result<ThumbnailsResult> {
    let root = canonical_root(&params.root)?;
    let width = params
        .width
        .unwrap_or(DEFAULT_THUMBNAIL_WIDTH)
        .clamp(MIN_THUMBNAIL_WIDTH, MAX_THUMBNAIL_WIDTH);
    let quality = params
        .quality
        .unwrap_or(DEFAULT_JPEG_QUALITY)
        .clamp(MIN_JPEG_QUALITY, MAX_JPEG_QUALITY);

    let truncated_by_bound = params.paths.len() > MAX_THUMBNAIL_REQUESTS;
    let requested: Vec<String> = params
        .paths
        .into_iter()
        .take(MAX_THUMBNAIL_REQUESTS)
        .collect();
    if requested.is_empty() {
        return Ok(ThumbnailsResult {
            thumbnails: Vec::new(),
            failures: Vec::new(),
            truncated: truncated_by_bound,
            max_requests: MAX_THUMBNAIL_REQUESTS,
        });
    }

    // Resolve every path up front so a traversal attempt fails the request
    // instead of quietly dropping one entry from an otherwise valid batch.
    let mut resolved: Vec<(String, PathBuf)> = Vec::with_capacity(requested.len());
    for relative in &requested {
        let target = resolve_existing_from_root(&root, relative)?;
        resolved.push((relative.clone(), target));
    }

    let next = AtomicUsize::new(0);
    let worker_count = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
        .clamp(1, MAX_THUMBNAIL_PARALLELISM)
        .min(resolved.len());

    let mut slots: Vec<Option<ThumbnailOutcome>> = (0..resolved.len()).map(|_| None).collect();
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..worker_count)
            .map(|_| {
                scope.spawn(|| {
                    let mut local = Vec::new();
                    loop {
                        interrupt.check(THUMBNAILS_METHOD)?;
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        let Some((relative, target)) = resolved.get(index) else {
                            break;
                        };
                        local.push((index, render_thumbnail(target, relative, width, quality)));
                    }
                    Ok::<_, anyhow::Error>(local)
                })
            })
            .collect();
        for worker in workers {
            let local = worker
                .join()
                .map_err(|_| anyhow!("thumbnail worker panicked"))??;
            for (index, outcome) in local {
                slots[index] = Some(outcome);
            }
        }
        Ok::<_, anyhow::Error>(())
    })?;

    let mut thumbnails = Vec::new();
    let mut failures = Vec::new();
    let mut encoded_total = 0usize;
    let mut truncated_by_budget = false;
    for slot in slots.into_iter().flatten() {
        match slot {
            ThumbnailOutcome::Ready(thumbnail) => {
                if encoded_total.saturating_add(thumbnail.byte_size) > MAX_TOTAL_ENCODED_BYTES {
                    truncated_by_budget = true;
                    failures.push(ThumbnailFailure {
                        path: thumbnail.path,
                        reason: "thumbnail batch output budget exhausted".to_owned(),
                    });
                    continue;
                }
                encoded_total = encoded_total.saturating_add(thumbnail.byte_size);
                thumbnails.push(thumbnail);
            }
            ThumbnailOutcome::Failed { path, reason } => {
                failures.push(ThumbnailFailure { path, reason });
            }
        }
    }

    Ok(ThumbnailsResult {
        thumbnails,
        failures,
        truncated: truncated_by_bound || truncated_by_budget,
        max_requests: MAX_THUMBNAIL_REQUESTS,
    })
}

enum ThumbnailOutcome {
    Ready(Thumbnail),
    Failed { path: String, reason: String },
}

/// One thumbnail. Never fails the batch: an unreadable, oversized, or corrupt
/// image is reported against its own path so the remaining rows still render.
fn render_thumbnail(target: &Path, relative: &str, width: u32, quality: u8) -> ThumbnailOutcome {
    let fail = |reason: String| ThumbnailOutcome::Failed {
        path: relative.to_owned(),
        reason,
    };

    let metadata = match fs::metadata(target) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return fail("not a file".to_owned()),
        Err(error) => return fail(error.to_string()),
    };
    if metadata.len() > MAX_SOURCE_BYTES {
        return fail(format!("source image exceeds {MAX_SOURCE_BYTES} bytes"));
    }

    // Read the header first: dimensions are cheap, and committing to a decode
    // before knowing the pixel count is how a small file blows up memory.
    let (source_width, source_height) = match read_dimensions(target) {
        Ok(dimensions) => dimensions,
        Err(error) => return fail(format!("unreadable image: {error:#}")),
    };
    if u64::from(source_width) * u64::from(source_height) > MAX_SOURCE_PIXELS {
        return fail(format!("source image exceeds {MAX_SOURCE_PIXELS} pixels"));
    }

    let source = match decode_image(target) {
        Ok(source) => source,
        Err(error) => return fail(format!("undecodable image: {error:#}")),
    };

    // Match the source aspect ratio exactly so `thumbnail` lands on the requested
    // width instead of letterboxing inside a square box. Never upscale: a small
    // source blown up to the requested width costs bytes and looks no better, and
    // the caller sizes the element with CSS regardless.
    let target_width = width.min(source_width.max(1));
    let target_height = (f64::from(target_width) * f64::from(source_height)
        / f64::from(source_width.max(1)))
    .round()
    .max(1.0) as u32;
    let rgb = source.thumbnail(target_width, target_height).to_rgb8();
    let (scaled_width, scaled_height) = (rgb.width(), rgb.height());

    let mut encoded: Vec<u8> = Vec::new();
    let encode_result = {
        let mut encoder = JpegEncoder::new_with_quality(&mut encoded, quality);
        encoder.encode(
            rgb.as_raw(),
            scaled_width,
            scaled_height,
            ExtendedColorType::Rgb8,
        )
    };
    if let Err(error) = encode_result {
        return fail(format!("thumbnail encode failed: {error}"));
    }
    let byte_size = encoded.len();

    ThumbnailOutcome::Ready(Thumbnail {
        path: relative.to_owned(),
        data: base64::engine::general_purpose::STANDARD.encode(&encoded),
        format: "jpeg",
        width: scaled_width,
        height: scaled_height,
        source_width,
        source_height,
        byte_size,
    })
}

/// Header-only read, so oversized sources are rejected before any decode.
fn read_dimensions(target: &Path) -> Result<(u32, u32)> {
    let reader = ImageReader::open(target)?.with_guessed_format()?;
    Ok(reader.into_dimensions()?)
}

fn decode_image(target: &Path) -> Result<DynamicImage> {
    let reader = ImageReader::open(target)?.with_guessed_format()?;
    Ok(reader.decode()?)
}

/// Set the host desktop wallpaper.
///
/// Unlike [`thumbnails`], this takes an absolute path rather than a
/// root-confined one, because the image comes from ND's own native file dialog
/// and may live anywhere the user can read. The effect is bounded to the desktop
/// picture: the sidecar never reads, copies, or returns the file's contents, and
/// the caller is the trusted main process acting on an explicit user gesture
/// that the invocation broker has already permission- and grant-checked.
pub fn set_wallpaper(params: WallpaperSetParams) -> Result<WallpaperSetResult> {
    let trimmed = params.path.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_PATH_LENGTH {
        bail!("invalid wallpaper path");
    }
    let target = PathBuf::from(trimmed);
    if !target.is_absolute() {
        bail!("wallpaper path must be absolute");
    }
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if !SUPPORTED_IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        bail!("wallpaper path is not a supported image");
    }
    let metadata = fs::metadata(&target).context("wallpaper image is unavailable")?;
    if !metadata.is_file() {
        bail!("wallpaper path is not a file");
    }
    if metadata.len() > MAX_SOURCE_BYTES {
        bail!("wallpaper image is too large");
    }

    apply_wallpaper(&target)?;
    Ok(WallpaperSetResult {
        changed: true,
        path: target.to_string_lossy().into_owned(),
        platform: std::env::consts::OS,
    })
}

/// In-process `SystemParametersInfoW`, replacing a `powershell.exe` spawn that
/// recompiled an inline C# type on every single wallpaper change.
#[cfg(windows)]
fn apply_wallpaper(target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SPI_SETDESKWALLPAPER, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SystemParametersInfoW,
    };

    let wide: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SPI_SETDESKWALLPAPER only reads `pvparam`, but the binding types that
    // parameter generically as `*mut c_void` across every action.
    let succeeded = unsafe {
        SystemParametersInfoW(
            SPI_SETDESKWALLPAPER,
            0,
            wide.as_ptr().cast_mut().cast(),
            SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
        )
    };
    if succeeded == 0 {
        let error = std::io::Error::last_os_error();
        bail!("SystemParametersInfoW rejected the wallpaper: {error}");
    }
    Ok(())
}

/// macOS and Linux already have fast native binaries for this (`osascript`,
/// `gsettings`), and neither pays the process-startup plus JIT-compile cost that
/// made the Windows path worth moving into the sidecar. The desktop keeps using
/// them directly, so this is a hard error rather than a silent no-op.
#[cfg(not(windows))]
fn apply_wallpaper(_target: &Path) -> Result<()> {
    bail!("media.set-wallpaper is implemented for Windows only; use the platform adapter")
}

/// One OS media transport key: `play-pause`, `next`, or `previous`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaKeyParams {
    pub key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaKeyResult {
    pub sent: bool,
}

/// Synthesize one OS media transport key.
///
/// ND's quick launcher transport row presses the page's own buttons first;
/// this is the fallback for pages with nothing to press and for media playing
/// outside ND, which is exactly the session the OS media keys already target.
pub fn send_media_key(params: MediaKeyParams) -> Result<MediaKeyResult> {
    let vk = match params.key.as_str() {
        "play-pause" => 0xB3u32,
        "next" => 0xB0u32,
        "previous" => 0xB1u32,
        other => bail!("unknown media key: {other}"),
    };
    press_media_key(vk)?;
    Ok(MediaKeyResult { sent: true })
}

#[cfg(windows)]
fn press_media_key(vk: u32) -> Result<()> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, keybd_event,
    };
    // Media keys are extended keys; receivers ignore the press without the flag.
    unsafe {
        keybd_event(vk as u8, 0, KEYEVENTF_EXTENDEDKEY, 0);
        keybd_event(vk as u8, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0);
    }
    Ok(())
}

#[cfg(not(windows))]
fn press_media_key(_vk: u32) -> Result<()> {
    bail!("media.key is implemented for Windows only")
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, ImageFormat, Rgb};
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use uuid::Uuid;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("nd-media-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn never() -> Interrupt {
        Interrupt::new(Arc::new(AtomicBool::new(false)), None)
    }

    /// A real encoded image, so these tests exercise the decoder rather than a
    /// stub standing in for it.
    fn write_png(path: &Path, width: u32, height: u32) {
        let image = ImageBuffer::from_fn(width, height, |x, y| {
            Rgb([(x % 256) as u8, (y % 256) as u8, 128u8])
        });
        image.save(path).unwrap();
    }

    fn params(root: &Path, paths: Vec<String>, width: Option<u32>) -> ThumbnailsParams {
        ThumbnailsParams {
            root: root.to_string_lossy().into_owned(),
            paths,
            width,
            quality: None,
        }
    }

    #[test]
    fn thumbnails_downscale_and_report_source_dimensions() {
        let root = temp_root("basic");
        write_png(&root.join("a.png"), 800, 400);
        write_png(&root.join("b.png"), 300, 300);

        let result = thumbnails(
            params(&root, vec!["a.png".into(), "b.png".into()], Some(200)),
            &never(),
        )
        .unwrap();

        assert!(result.failures.is_empty(), "{:?}", result.failures);
        assert!(!result.truncated);
        assert_eq!(result.thumbnails.len(), 2);

        let first = &result.thumbnails[0];
        assert_eq!(first.path, "a.png");
        assert_eq!(first.format, "jpeg");
        assert_eq!((first.source_width, first.source_height), (800, 400));
        // Aspect ratio preserved: 800x400 at width 200 is 200x100.
        assert_eq!((first.width, first.height), (200, 100));
        assert!(first.byte_size > 0);

        // The payload really is decodable JPEG, not an opaque blob.
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&first.data)
            .unwrap();
        let roundtrip = image::load_from_memory_with_format(&decoded, ImageFormat::Jpeg).unwrap();
        assert_eq!(roundtrip.width(), 200);

        assert_eq!(result.thumbnails[1].path, "b.png");
    }

    #[test]
    fn thumbnails_are_root_confined() {
        let root = temp_root("confined");
        write_png(&root.join("inside.png"), 64, 64);
        let outside = temp_root("outside");
        write_png(&outside.join("secret.png"), 64, 64);

        assert!(
            thumbnails(params(&root, vec!["../secret.png".into()], None), &never()).is_err(),
            "parent traversal must be rejected"
        );
        assert!(
            thumbnails(
                params(
                    &root,
                    vec![outside.join("secret.png").to_string_lossy().into_owned()],
                    None
                ),
                &never()
            )
            .is_err(),
            "an absolute path must be rejected even when the file exists"
        );

        // A path inside the root still works, proving the rejections above are
        // about confinement and not a broken reader.
        let allowed = thumbnails(params(&root, vec!["inside.png".into()], None), &never()).unwrap();
        assert_eq!(allowed.thumbnails.len(), 1);
    }

    #[test]
    fn a_bad_entry_fails_alone_and_the_batch_survives() {
        let root = temp_root("partial");
        write_png(&root.join("good.png"), 64, 64);
        fs::write(root.join("corrupt.png"), b"this is not an image").unwrap();

        let result = thumbnails(
            params(&root, vec!["good.png".into(), "corrupt.png".into()], None),
            &never(),
        )
        .unwrap();

        assert_eq!(result.thumbnails.len(), 1);
        assert_eq!(result.thumbnails[0].path, "good.png");
        assert_eq!(result.failures.len(), 1);
        assert_eq!(result.failures[0].path, "corrupt.png");
        assert!(!result.truncated);
    }

    #[test]
    fn an_oversized_batch_is_clamped_and_flagged() {
        let root = temp_root("clamp");
        let mut paths = Vec::new();
        for index in 0..(MAX_THUMBNAIL_REQUESTS + 10) {
            let name = format!("tiny-{index}.png");
            write_png(&root.join(&name), 8, 8);
            paths.push(name);
        }

        let result = thumbnails(params(&root, paths, Some(16)), &never()).unwrap();
        assert!(result.truncated, "an over-bound batch must be flagged");
        assert_eq!(result.thumbnails.len(), MAX_THUMBNAIL_REQUESTS);
        assert_eq!(result.max_requests, MAX_THUMBNAIL_REQUESTS);
    }

    #[test]
    fn an_empty_batch_is_not_an_error() {
        let root = temp_root("empty");
        let result = thumbnails(params(&root, Vec::new(), None), &never()).unwrap();
        assert!(result.thumbnails.is_empty());
        assert!(result.failures.is_empty());
        assert!(!result.truncated);
    }

    #[test]
    fn nested_paths_inside_the_root_are_allowed() {
        let root = temp_root("nested");
        let nested = root.join("library");
        fs::create_dir_all(&nested).unwrap();
        write_png(&nested.join("deep.png"), 120, 80);

        let result = thumbnails(
            params(&root, vec!["library/deep.png".into()], Some(60)),
            &never(),
        )
        .unwrap();
        assert_eq!(result.thumbnails.len(), 1);
        assert_eq!(result.thumbnails[0].path, "library/deep.png");
        assert_eq!(result.thumbnails[0].width, 60);
    }

    #[test]
    fn width_and_quality_are_clamped_to_supported_ranges() {
        let root = temp_root("clamp-bounds");
        write_png(&root.join("a.png"), 400, 200);

        let absurd =
            thumbnails(params(&root, vec!["a.png".into()], Some(100_000)), &never()).unwrap();
        assert!(absurd.thumbnails[0].width <= MAX_THUMBNAIL_WIDTH);

        let tiny = thumbnails(params(&root, vec!["a.png".into()], Some(0)), &never()).unwrap();
        assert!(tiny.thumbnails[0].width >= MIN_THUMBNAIL_WIDTH);
    }

    #[test]
    fn wallpaper_rejects_paths_it_must_not_touch() {
        let root = temp_root("wallpaper");
        write_png(&root.join("ok.png"), 32, 32);
        fs::write(root.join("notes.txt"), b"not an image").unwrap();

        assert!(
            set_wallpaper(WallpaperSetParams {
                path: "ok.png".into()
            })
            .is_err()
        );
        assert!(set_wallpaper(WallpaperSetParams { path: "   ".into() }).is_err());
        // Unsupported extension, even though the file exists.
        assert!(
            set_wallpaper(WallpaperSetParams {
                path: root.join("notes.txt").to_string_lossy().into_owned(),
            })
            .is_err()
        );
        // Missing file with a supported extension.
        assert!(
            set_wallpaper(WallpaperSetParams {
                path: root.join("absent.png").to_string_lossy().into_owned(),
            })
            .is_err()
        );
        // A directory is not a wallpaper.
        assert!(
            set_wallpaper(WallpaperSetParams {
                path: root.to_string_lossy().into_owned(),
            })
            .is_err()
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn wallpaper_set_is_unsupported_off_windows() {
        let root = temp_root("wallpaper-unix");
        write_png(&root.join("ok.png"), 32, 32);
        assert!(
            set_wallpaper(WallpaperSetParams {
                path: root.join("ok.png").to_string_lossy().into_owned(),
            })
            .is_err()
        );
    }
}
