//! Bounded, cancellable package snapshots. ND validates manifests and authority;
//! this service owns filesystem traversal/copying and atomic directory replacement.
use crate::deadline::Interrupt;
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const MAX_FILES: usize = 5_000;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 24 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotParams {
    pub source: PathBuf,
    pub destination: PathBuf,
    pub expected_manifest: serde_json::Value,
}

pub fn snapshot(params: SnapshotParams, interrupt: &Interrupt) -> Result<serde_json::Value> {
    interrupt.check("extension package snapshot")?;
    let source = fs::canonicalize(&params.source).context("resolve package source")?;
    if !source.is_dir() || !params.destination.is_absolute() {
        bail!("Package source must be a directory and destination must be absolute");
    }
    let parent = params
        .destination
        .parent()
        .context("package destination parent")?;
    fs::create_dir_all(parent)?;
    let parent = fs::canonicalize(parent)?;
    if parent.starts_with(&source) || source.starts_with(&parent) {
        bail!("Package source and snapshot destination must not overlap");
    }
    let destination = parent.join(params.destination.file_name().context("destination name")?);
    let stage = parent.join(format!(".stage-{}", Uuid::new_v4()));
    let backup = parent.join(format!(".backup-{}", Uuid::new_v4()));
    let result = (|| {
        fs::create_dir(&stage)?;
        let mut budget = Budget::default();
        copy_tree(&source, &stage, &source, &mut budget, interrupt)?;
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(stage.join("nd-extension.json"))?)?;
        if manifest != params.expected_manifest {
            bail!("Package manifest changed during installation");
        }
        interrupt.check("extension package snapshot")?;
        let backed_up = match fs::rename(&destination, &backup) {
            Ok(()) => true,
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        if let Err(error) = fs::rename(&stage, &destination) {
            if backed_up {
                fs::rename(&backup, &destination).context("restore previous package snapshot")?;
            }
            return Err(error.into());
        }
        Ok(serde_json::json!({ "files": budget.files, "bytes": budget.bytes }))
    })();
    let _ = fs::remove_dir_all(&stage);
    // Keep the backup if restoring the original destination failed.
    if destination.exists() {
        let _ = fs::remove_dir_all(&backup);
    }
    result
}

#[derive(Default)]
struct Budget {
    files: usize,
    bytes: u64,
}

fn copy_tree(
    source: &Path,
    target: &Path,
    root: &Path,
    budget: &mut Budget,
    interrupt: &Interrupt,
) -> Result<()> {
    interrupt.check("extension package snapshot")?;
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() || !fs::canonicalize(source)?.starts_with(root) {
        bail!("Package contains a symbolic link or escaping path");
    }
    if !metadata.is_dir() {
        bail!("Package directory changed during installation");
    }
    for entry in fs::read_dir(source)? {
        interrupt.check("extension package snapshot")?;
        let entry = entry?;
        if entry.file_name() == ".git" {
            continue;
        }
        budget.files += 1;
        if budget.files > MAX_FILES {
            bail!("Package contains more than 5000 files");
        }
        let path = entry.path();
        let destination = target.join(entry.file_name());
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            bail!("Package contains a symbolic link");
        }
        if metadata.is_dir() {
            fs::create_dir(&destination)?;
            copy_tree(&path, &destination, root, budget, interrupt)?;
        } else if metadata.is_file() {
            if metadata.len() > MAX_FILE_BYTES {
                bail!("Package file exceeds the 8 MB per-file cap");
            }
            if !fs::canonicalize(&path)?.starts_with(root) {
                bail!("Package path escapes source");
            }
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            let mut input = options.open(&path)?;
            if !input.metadata()?.is_file() {
                bail!("Package contains a non-regular file");
            }
            let mut output = File::create(&destination)?;
            let mut bytes = 0;
            let mut chunk = [0u8; 64 * 1024];
            loop {
                interrupt.check("extension package snapshot")?;
                let read = input.read(&mut chunk)?;
                if read == 0 {
                    break;
                }
                bytes += read as u64;
                budget.bytes += read as u64;
                if bytes > MAX_FILE_BYTES {
                    bail!("Package file exceeds the 8 MB per-file cap");
                }
                if budget.bytes > MAX_TOTAL_BYTES {
                    bail!("Package exceeds the 24 MB total asset cap");
                }
                io::copy(&mut &chunk[..read], &mut output)?;
            }
            if fs::symlink_metadata(&path)?.file_type().is_symlink()
                || !fs::canonicalize(&path)?.starts_with(root)
            {
                bail!("Package changed during installation");
            }
            fs::set_permissions(&destination, metadata.permissions())?;
        } else {
            bail!("Package contains a non-regular file");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    fn interrupt() -> Interrupt {
        Interrupt::new(Arc::new(AtomicBool::new(false)), None)
    }

    #[test]
    fn oversized_dependencies_fail_and_preserve_previous_snapshot() {
        let root = std::env::temp_dir().join(format!("nd-package-test-{}", Uuid::new_v4()));
        let source = root.join("source");
        let destination = root.join("installed/1.0.0");
        fs::create_dir_all(source.join("node_modules")).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("old.txt"), "previous").unwrap();
        fs::write(source.join("nd-extension.json"), "{}").unwrap();
        File::create(source.join("node_modules/large.bin"))
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        let result = snapshot(
            SnapshotParams {
                source,
                destination: destination.clone(),
                expected_manifest: serde_json::json!({}),
            },
            &interrupt(),
        );
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(destination.join("old.txt")).unwrap(),
            "previous"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_includes_bounded_dependencies_and_replaces_atomically() {
        let root = std::env::temp_dir().join(format!("nd-package-test-{}", Uuid::new_v4()));
        let source = root.join("source");
        let destination = root.join("installed/1.0.0");
        fs::create_dir_all(source.join("node_modules/dependency")).unwrap();
        fs::write(source.join("nd-extension.json"), "{}").unwrap();
        fs::write(source.join("node_modules/dependency/index.js"), "fixture").unwrap();
        let result = snapshot(
            SnapshotParams {
                source,
                destination: destination.clone(),
                expected_manifest: serde_json::json!({}),
            },
            &interrupt(),
        )
        .unwrap();
        assert_eq!(result["files"], 4);
        assert_eq!(
            fs::read_to_string(destination.join("node_modules/dependency/index.js")).unwrap(),
            "fixture"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn total_dependency_bytes_are_bounded() {
        let root = std::env::temp_dir().join(format!("nd-package-test-{}", Uuid::new_v4()));
        let source = root.join("source");
        fs::create_dir_all(source.join("node_modules")).unwrap();
        fs::write(source.join("nd-extension.json"), "{}").unwrap();
        for index in 0..4 {
            File::create(source.join(format!("node_modules/{index}.bin")))
                .unwrap()
                .set_len(7 * 1024 * 1024)
                .unwrap();
        }
        assert!(
            snapshot(
                SnapshotParams {
                    source,
                    destination: root.join("installed/1"),
                    expected_manifest: serde_json::json!({})
                },
                &interrupt()
            )
            .is_err()
        );
        assert!(!root.join("installed/1").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancellation_and_changed_manifests_never_replace_the_previous_snapshot() {
        let root = std::env::temp_dir().join(format!("nd-package-test-{}", Uuid::new_v4()));
        let source = root.join("source");
        let destination = root.join("installed/1");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(source.join("nd-extension.json"), "{}").unwrap();
        fs::write(destination.join("previous.txt"), "previous").unwrap();
        let canceled = Interrupt::new(Arc::new(AtomicBool::new(true)), None);
        assert!(
            snapshot(
                SnapshotParams {
                    source: source.clone(),
                    destination: destination.clone(),
                    expected_manifest: serde_json::json!({})
                },
                &canceled
            )
            .is_err()
        );
        assert!(
            snapshot(
                SnapshotParams {
                    source,
                    destination: destination.clone(),
                    expected_manifest: serde_json::json!({"changed":true})
                },
                &interrupt()
            )
            .is_err()
        );
        assert_eq!(
            fs::read_to_string(destination.join("previous.txt")).unwrap(),
            "previous"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_links_in_dependency_tree() {
        let root = std::env::temp_dir().join(format!("nd-package-test-{}", Uuid::new_v4()));
        let source = root.join("source");
        fs::create_dir_all(source.join("node_modules")).unwrap();
        fs::write(source.join("nd-extension.json"), "{}").unwrap();
        std::os::unix::fs::symlink("/tmp", source.join("node_modules/link")).unwrap();
        assert!(
            snapshot(
                SnapshotParams {
                    source,
                    destination: root.join("installed/1"),
                    expected_manifest: serde_json::json!({})
                },
                &interrupt()
            )
            .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }
}
