//! Workspace-relative filesystem primitives.
//!
//! This module is the single filesystem layer the product uses for reading a linked
//! workspace. Every entry point resolves through [`resolve_existing_from_root`], so a
//! path that escapes the active workspace root — by `..`, by an absolute path, or by
//! a symlink whose target leaves the root — is rejected before any filesystem access.
//!
//! Reads and listings are bounded and say so: a caller always learns whether it saw
//! everything, instead of silently receiving a truncated view.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

/// Default bound for a single file read. Matches the product's existing workspace
/// file-view limit.
const DEFAULT_MAX_READ: usize = 1024 * 1024;
/// Hard bound for a single file read. Derived from the protocol frame bound: a larger
/// payload could not be framed, and failing after the read would be a worse error
/// than refusing the bound up front.
const HARD_MAX_READ: usize = crate::protocol::MAX_FRAME_BYTES / 2;
/// Writes stay comfortably below the protocol frame bound and are committed
/// through a temporary sibling so a crash never leaves a partially written file.
const HARD_MAX_WRITE: usize = crate::protocol::MAX_FRAME_BYTES / 2;
/// Default directory-listing bound, matching the product's workspace browser.
const DEFAULT_MAX_LIST_ENTRIES: usize = 500;
const HARD_MAX_LIST_ENTRIES: usize = 4096;
const MAX_PATH_LENGTH: usize = 4096;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListParams {
    pub root: String,
    #[serde(default = "default_relative")]
    pub path: String,
    pub max_entries: Option<usize>,
}

fn default_relative() -> String {
    ".".to_owned()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadParams {
    pub root: String,
    pub path: String,
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteParams {
    pub root: String,
    pub path: String,
    pub data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    pub name: String,
    /// Workspace-relative path with `/` separators, so the shape is identical on
    /// every platform.
    pub path: String,
    pub is_file: bool,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub root: String,
    pub path: String,
    pub entries: Vec<ListEntry>,
    /// The bound stopped the listing. A truncated listing is never presented as a
    /// complete one.
    pub truncated: bool,
    pub max_entries: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub root: String,
    pub path: String,
    pub data: String,
    pub size: usize,
    /// The file is larger than the requested bound; `data` holds the leading bytes.
    pub truncated: bool,
    pub max_bytes: usize,
    pub byte_size: u64,
}

/// Binary document input uses the same workspace authorization and read bounds.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryReadResult {
    pub data: Vec<u8>,
    pub truncated: bool,
}

pub fn read_binary(params: ReadParams) -> Result<BinaryReadResult> {
    let root = canonical_root(&params.root)?;
    let target = resolve_existing_from_root(&root, &params.path)?;
    let mut file = fs::File::open(target)?;
    if !file.metadata()?.is_file() {
        bail!("workspace read target is not a file");
    }
    // JSON-shaped byte arrays can expand to two MessagePack bytes per byte.
    let max_bytes = params
        .max_bytes
        .unwrap_or(DEFAULT_MAX_READ)
        .clamp(1, HARD_MAX_READ / 2);
    let mut data = Vec::new();
    Read::by_ref(&mut file)
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut data)?;
    let truncated = data.len() > max_bytes;
    data.truncate(max_bytes);
    Ok(BinaryReadResult { data, truncated })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub root: String,
    pub path: String,
    pub bytes_written: usize,
    pub replaced: bool,
}

pub fn list(params: ListParams) -> Result<ListResult> {
    let root = canonical_root(&params.root)?;
    let target = resolve_existing_from_root(&root, &params.path)?;
    let metadata = fs::metadata(&target)?;
    if !metadata.is_dir() {
        bail!("workspace list target is not a directory");
    }
    let max_entries = params
        .max_entries
        .unwrap_or(DEFAULT_MAX_LIST_ENTRIES)
        .clamp(1, HARD_MAX_LIST_ENTRIES);

    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(&target)? {
        let entry = entry?;
        if entries.len() >= max_entries {
            truncated = true;
            break;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        let relative = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(ListEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: relative,
            is_file: metadata.is_file(),
            is_directory: metadata.is_dir(),
            is_symlink: metadata.file_type().is_symlink(),
            size: metadata.len(),
        });
    }
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(ListResult {
        root: root.to_string_lossy().into_owned(),
        path: relative_to_root(&root, &target),
        entries,
        truncated,
        max_entries,
    })
}

const DEFAULT_MAX_INDEX_ENTRIES: usize = 10_000;
/// Keeps the response comfortably inside one protocol frame.
const HARD_MAX_INDEX_ENTRIES: usize = 20_000;
const MAX_INDEX_SKIP_NAMES: usize = 256;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexParams {
    pub root: String,
    pub max_entries: Option<usize>,
    /// Directory or file names never descended into or returned, chosen by the
    /// product (dependency and generated trees).
    #[serde(default)]
    pub skip_names: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    /// Workspace-relative path with `/` separators.
    pub path: String,
    pub is_directory: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexResult {
    pub root: String,
    pub entries: Vec<IndexEntry>,
    pub truncated: bool,
    pub max_entries: usize,
    pub duration_ms: u64,
}

/// Bounded breadth-first path index of the workspace, for mention suggestions.
/// Symlinks are never followed or returned, unreadable directories are skipped,
/// and hitting the bound is reported rather than presented as a complete tree.
pub fn index(params: IndexParams, interrupt: &crate::deadline::Interrupt) -> Result<IndexResult> {
    let started_at = crate::scheduler::now_ms();
    let root = canonical_root(&params.root)?;
    if params.skip_names.len() > MAX_INDEX_SKIP_NAMES {
        bail!("too many workspace index skip names");
    }
    let skip = params
        .skip_names
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let max_entries = params
        .max_entries
        .unwrap_or(DEFAULT_MAX_INDEX_ENTRIES)
        .clamp(1, HARD_MAX_INDEX_ENTRIES);

    let mut entries = Vec::new();
    let mut truncated = false;
    let mut queue = std::collections::VecDeque::from([String::new()]);
    'walk: while let Some(directory) = queue.pop_front() {
        interrupt.check("workspace.index")?;
        let Ok(children) = fs::read_dir(root.join(&directory)) else {
            continue;
        };
        for child in children {
            let Ok(child) = child else { continue };
            let Ok(file_type) = child.file_type() else {
                continue;
            };
            let name = child.file_name().to_string_lossy().into_owned();
            if skip.contains(name.as_str()) || file_type.is_symlink() {
                continue;
            }
            if !file_type.is_file() && !file_type.is_dir() {
                continue;
            }
            if entries.len() >= max_entries {
                truncated = true;
                break 'walk;
            }
            let path = if directory.is_empty() {
                name
            } else {
                format!("{directory}/{name}")
            };
            if file_type.is_dir() {
                queue.push_back(path.clone());
            }
            entries.push(IndexEntry {
                path,
                is_directory: file_type.is_dir(),
            });
        }
    }
    Ok(IndexResult {
        root: root.to_string_lossy().into_owned(),
        entries,
        truncated,
        max_entries,
        duration_ms: crate::scheduler::now_ms().saturating_sub(started_at),
    })
}

/// Bounded read: the returned payload never exceeds the resolved bound, and
/// `truncated` distinguishes a whole file from its leading bytes.
pub fn read(params: ReadParams) -> Result<ReadResult> {
    let root = canonical_root(&params.root)?;
    let target = resolve_existing_from_root(&root, &params.path)?;
    let metadata = fs::metadata(&target)?;
    if !metadata.is_file() {
        bail!("workspace read target is not a file");
    }
    let max_bytes = params
        .max_bytes
        .unwrap_or(DEFAULT_MAX_READ)
        .clamp(1, HARD_MAX_READ);
    let byte_size = metadata.len();
    let truncated = byte_size > max_bytes as u64;

    let bytes = if truncated {
        fs::read(&target)?
            .into_iter()
            .take(max_bytes)
            .collect::<Vec<u8>>()
    } else {
        fs::read(&target)?
    };
    let data = String::from_utf8(bytes).context("workspace file is not valid UTF-8")?;
    let size = data.len();
    Ok(ReadResult {
        root: root.to_string_lossy().into_owned(),
        path: relative_to_root(&root, &target),
        data,
        size,
        truncated,
        max_bytes,
        byte_size,
    })
}

/// Atomic UTF-8 write inside an existing workspace directory.
///
/// The parent directory must already exist. This intentionally refuses recursive
/// directory creation: a model cannot manufacture a path chain whose intermediate
/// entries have not each been observed under the workspace boundary first.
pub fn write(params: WriteParams) -> Result<WriteResult> {
    if params.data.len() > HARD_MAX_WRITE {
        bail!("workspace write exceeds the configured bound");
    }
    let root = canonical_root(&params.root)?;
    let relative = validate_relative(&params.path)?;
    if relative.as_os_str().is_empty() || relative == Path::new(".") {
        bail!("workspace write path must name a file");
    }
    let file_name = relative
        .file_name()
        .context("workspace write path must name a file")?;
    let parent_relative = relative.parent().unwrap_or_else(|| Path::new("."));
    let parent = fs::canonicalize(root.join(parent_relative))
        .context("workspace write parent is unavailable")?;
    ensure_inside(&root, &parent)?;
    if !fs::metadata(&parent)?.is_dir() {
        bail!("workspace write parent is not a directory");
    }

    let requested_target = parent.join(file_name);
    let (target, replaced, permissions) = match fs::symlink_metadata(&requested_target) {
        Ok(_) => {
            let canonical = fs::canonicalize(&requested_target)
                .context("workspace write target is unavailable")?;
            ensure_inside(&root, &canonical)?;
            let target_metadata = fs::metadata(&canonical)?;
            if !target_metadata.is_file() {
                bail!("workspace write target is not a file");
            }
            // If the requested path is a safe in-workspace symlink, preserve the
            // resolved file's permissions rather than the symlink's metadata.
            (canonical, true, Some(target_metadata.permissions()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            (requested_target, false, None)
        }
        Err(error) => return Err(error).context("inspect workspace write target"),
    };

    let temporary = parent.join(format!(".nd-write-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .context("create workspace write staging file")?;
        file.write_all(params.data.as_bytes())
            .context("write workspace staging file")?;
        file.sync_all().context("flush workspace staging file")?;
        drop(file);
        if let Some(permissions) = permissions {
            fs::set_permissions(&temporary, permissions)
                .context("preserve workspace file permissions")?;
        }
        atomic_replace(&temporary, &target)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;

    Ok(WriteResult {
        root: root.to_string_lossy().into_owned(),
        path: relative_to_root(&root, &target),
        bytes_written: params.data.len(),
        replaced,
    })
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, target: &Path) -> Result<()> {
    fs::rename(source, target).context("commit workspace write")
}

#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
    // SAFETY: both UTF-16 buffers are NUL terminated and remain alive for the call.
    let ok = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), flags) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error()).context("commit workspace write");
    }
    Ok(())
}

/// Resolve an existing workspace-relative path, rejecting escapes.
pub(crate) fn resolve_existing_from_root(root: &Path, relative: &str) -> Result<PathBuf> {
    let relative = validate_relative(relative)?;
    let target = fs::canonicalize(root.join(relative)).context("workspace path is unavailable")?;
    ensure_inside(root, &target)?;
    Ok(target)
}

pub(crate) fn canonical_root(root: &str) -> Result<PathBuf> {
    if root.trim().is_empty() || root.len() > MAX_PATH_LENGTH {
        bail!("invalid workspace root");
    }
    let root = fs::canonicalize(root).context("workspace root is unavailable")?;
    if !fs::metadata(&root)?.is_dir() {
        bail!("workspace root is not a directory");
    }
    Ok(root)
}

fn relative_to_root(root: &Path, target: &Path) -> String {
    let relative = target
        .strip_prefix(root)
        .unwrap_or(target)
        .to_string_lossy()
        .replace('\\', "/");
    if relative.is_empty() {
        ".".to_owned()
    } else {
        relative
    }
}

pub(crate) fn validate_relative(path: &str) -> Result<PathBuf> {
    if path.len() > MAX_PATH_LENGTH {
        bail!("workspace path is too long");
    }

    // The RPC path contract is platform-neutral. A Windows absolute path must
    // still be rejected when nd-core happens to run on Linux/macOS (and vice
    // versa), otherwise a value such as C:/Windows is treated as a relative
    // filename and fails later with the misleading "path is unavailable".
    let bytes = path.as_bytes();
    let windows_drive_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\');
    let windows_unc_absolute = path.starts_with("\\\\") || path.starts_with("//");
    if windows_drive_absolute || windows_unc_absolute {
        bail!("workspace path must be relative");
    }

    // Interpret either path separator when looking for a parent traversal so
    // the safety boundary is identical on every host OS.
    if path.split(['/', '\\']).any(|segment| segment == "..") {
        bail!("workspace path escapes the root");
    }

    let value = Path::new(path);
    if value.is_absolute() {
        bail!("workspace path must be relative");
    }
    for component in value.components() {
        match component {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!("workspace path escapes the root")
            }
            _ => {}
        }
    }
    Ok(value.to_path_buf())
}

fn ensure_inside(root: &Path, target: &Path) -> Result<()> {
    if target == root || target.starts_with(root) {
        Ok(())
    } else {
        bail!("workspace path escapes the root")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("nd-core-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn root_of(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn no_interrupt() -> crate::deadline::Interrupt {
        crate::deadline::Interrupt::new(
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            None,
        )
    }

    #[test]
    fn index_walks_breadth_first_and_skips_named_trees() {
        let root = temp_root("index");
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("src/deep/leaf.ts"), "x").unwrap();
        fs::write(root.join("src/app.ts"), "x").unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "x").unwrap();
        fs::write(root.join("README.md"), "x").unwrap();

        let result = index(
            IndexParams {
                root: root_of(&root),
                max_entries: None,
                skip_names: vec!["node_modules".into()],
            },
            &no_interrupt(),
        )
        .unwrap();
        let paths = result
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();
        assert!(!result.truncated);
        assert!(paths.iter().all(|path| !path.starts_with("node_modules")));
        let depth = |path: &str| path.matches('/').count();
        assert!(
            paths
                .windows(2)
                .all(|pair| depth(pair[0]) <= depth(pair[1]))
        );
        for expected in [
            "README.md",
            "src",
            "src/app.ts",
            "src/deep",
            "src/deep/leaf.ts",
        ] {
            assert!(paths.contains(&expected), "missing {expected}: {paths:?}");
        }
        assert!(
            result
                .entries
                .iter()
                .any(|entry| entry.path == "src" && entry.is_directory)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn index_reports_the_entry_bound() {
        let root = temp_root("index-bound");
        for index in 0..5 {
            fs::write(root.join(format!("file-{index}.txt")), "x").unwrap();
        }
        let result = index(
            IndexParams {
                root: root_of(&root),
                max_entries: Some(3),
                skip_names: Vec::new(),
            },
            &no_interrupt(),
        )
        .unwrap();
        assert_eq!(result.entries.len(), 3);
        assert!(result.truncated);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_parent_escape_before_filesystem_access() {
        let root = temp_root("workspace-parent");
        let outside = root.parent().unwrap().join("nd-core-outside.txt");
        fs::write(&outside, "outside").unwrap();
        let result = read(ReadParams {
            root: root_of(&root),
            path: "../nd-core-outside.txt".into(),
            max_bytes: None,
        });
        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&root);
        assert!(result.is_err());
        assert!(format!("{:#}", result.unwrap_err()).contains("escapes the root"));
    }

    #[test]
    fn binary_document_reads_preserve_bytes_and_enforce_bounds_and_scope() {
        let root = temp_root("binary-document");
        fs::write(root.join("document.docx"), [0, 255, 128, 65]).unwrap();
        let params = |path: &str, bound| ReadParams {
            root: root_of(&root),
            path: path.into(),
            max_bytes: Some(bound),
        };
        let whole = read_binary(params("document.docx", 10)).unwrap();
        assert_eq!(whole.data, [0, 255, 128, 65]);
        assert!(!whole.truncated);
        let capped = read_binary(params("document.docx", 2)).unwrap();
        assert_eq!(capped.data, [0, 255]);
        assert!(capped.truncated);
        assert!(read_binary(params("../document.docx", 10)).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_absolute_and_prefix_paths() {
        let root = temp_root("workspace-absolute");
        for candidate in [
            "/etc/passwd",
            "C:/Windows/win.ini",
            "C:\\Windows\\win.ini",
            "\\\\server\\share",
            "..\\secrets.txt",
        ] {
            let result = list(ListParams {
                root: root_of(&root),
                path: candidate.into(),
                max_entries: None,
            });
            assert!(result.is_err(), "{candidate} was accepted");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn atomic_write_replaces_and_creates_only_inside_existing_directories() {
        let root = temp_root("workspace-write");
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested/existing.txt"), "old").unwrap();

        let replaced = write(WriteParams {
            root: root_of(&root),
            path: "nested/existing.txt".into(),
            data: "new body".into(),
        })
        .unwrap();
        assert!(replaced.replaced);
        assert_eq!(replaced.bytes_written, 8);
        assert_eq!(
            fs::read_to_string(root.join("nested/existing.txt")).unwrap(),
            "new body"
        );

        let created = write(WriteParams {
            root: root_of(&root),
            path: "nested/new.txt".into(),
            data: "created".into(),
        })
        .unwrap();
        assert!(!created.replaced);
        assert_eq!(created.path, "nested/new.txt");
        assert_eq!(
            fs::read_to_string(root.join("nested/new.txt")).unwrap(),
            "created"
        );

        let missing_parent = write(WriteParams {
            root: root_of(&root),
            path: "not-created/file.txt".into(),
            data: "no".into(),
        });
        assert!(missing_parent.is_err());
        assert!(!root.join("not-created").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn write_rejects_parent_absolute_and_symlink_escapes() {
        let root = temp_root("workspace-write-root");
        let outside = temp_root("workspace-write-outside");
        fs::write(outside.join("secret.txt"), "outside").unwrap();

        for candidate in ["../outside.txt", "/outside.txt", "C:/Windows/win.ini"] {
            assert!(
                write(WriteParams {
                    root: root_of(&root),
                    path: candidate.into(),
                    data: "blocked".into(),
                })
                .is_err(),
                "{candidate} was accepted"
            );
        }

        if create_dir_symlink(&outside, &root.join("link")).is_ok() {
            assert!(
                write(WriteParams {
                    root: root_of(&root),
                    path: "link/secret.txt".into(),
                    data: "blocked".into(),
                })
                .is_err()
            );
            assert_eq!(
                fs::read_to_string(outside.join("secret.txt")).unwrap(),
                "outside"
            );
        }
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn write_rejects_payloads_over_the_protocol_safe_bound() {
        let root = temp_root("workspace-write-bound");
        let error = write(WriteParams {
            root: root_of(&root),
            path: "too-large.txt".into(),
            data: "x".repeat(HARD_MAX_WRITE + 1),
        })
        .unwrap_err();
        assert!(format!("{error:#}").contains("configured bound"));
        assert!(!root.join("too-large.txt").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bounded_read_reports_truncation_instead_of_failing() {
        let root = temp_root("workspace-bounded-read");
        let body = "0123456789".repeat(32);
        fs::write(root.join("large.txt"), &body).unwrap();

        let whole = read(ReadParams {
            root: root_of(&root),
            path: "large.txt".into(),
            max_bytes: Some(4096),
        })
        .unwrap();
        assert!(!whole.truncated);
        assert_eq!(whole.size, body.len());

        let capped = read(ReadParams {
            root: root_of(&root),
            path: "large.txt".into(),
            max_bytes: Some(10),
        })
        .unwrap();
        assert!(capped.truncated);
        assert_eq!(capped.data.len(), 10);
        assert_eq!(capped.byte_size, body.len() as u64);

        // The hard bound keeps a requested read frameable, so it is clamped rather
        // than honoured.
        let clamped = read(ReadParams {
            root: root_of(&root),
            path: "large.txt".into(),
            max_bytes: Some(usize::MAX),
        })
        .unwrap();
        assert_eq!(clamped.max_bytes, HARD_MAX_READ);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn listing_reports_truncation_and_workspace_relative_paths() {
        let root = temp_root("workspace-list");
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested").join("child.txt"), "child").unwrap();

        let listing = list(ListParams {
            root: root_of(&root),
            path: ".".into(),
            max_entries: None,
        })
        .unwrap();
        assert!(!listing.truncated);
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].path, "nested");
        assert!(listing.entries[0].is_directory);

        let inner = list(ListParams {
            root: root_of(&root),
            path: "nested".into(),
            max_entries: Some(1),
        })
        .unwrap();
        assert_eq!(inner.path, "nested");
        assert!(!inner.truncated);

        for index in 0..5 {
            fs::write(root.join(format!("file-{index}.txt")), "x").unwrap();
        }
        let capped = list(ListParams {
            root: root_of(&root),
            path: ".".into(),
            max_entries: Some(2),
        })
        .unwrap();
        assert!(capped.truncated);
        assert_eq!(capped.entries.len(), 2);
        assert_eq!(capped.max_entries, 2);
        let _ = fs::remove_dir_all(&root);
    }

    /// Symlink escape coverage runs wherever the platform lets a test create a
    /// symlink: always on unix runners, and on Windows when Developer Mode or an
    /// elevated token allows it. Where the platform refuses the fixture, the test
    /// reports that it did not run rather than passing silently on a false premise.
    #[test]
    fn rejects_symlink_escape_on_read_and_list() {
        let root = temp_root("workspace-symlink-root");
        let outside = temp_root("workspace-symlink-outside");
        fs::write(outside.join("secret.txt"), "outside").unwrap();
        if let Err(error) = create_dir_symlink(&outside, &root.join("link")) {
            eprintln!("skipping symlink escape coverage: {error}");
            let _ = fs::remove_dir_all(&root);
            let _ = fs::remove_dir_all(&outside);
            return;
        }

        let read_result = read(ReadParams {
            root: root_of(&root),
            path: "link/secret.txt".into(),
            max_bytes: None,
        });
        assert!(read_result.is_err());
        assert!(format!("{:#}", read_result.unwrap_err()).contains("escapes the root"));

        let list_result = list(ListParams {
            root: root_of(&root),
            path: "link".into(),
            max_entries: None,
        });
        assert!(list_result.is_err());
        assert!(format!("{:#}", list_result.unwrap_err()).contains("escapes the root"));

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }
}
