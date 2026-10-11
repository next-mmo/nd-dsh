//! Bounded verification-artifact fingerprints.
//!
//! A verified task can declare file or directory artifacts as its evidence, and
//! the reviewer binds the run to their content: each artifact records the bytes
//! that were hashed and a SHA-256 over a fixed layout. Directory artifacts hash
//! every entry's workspace-relative path (NUL-terminated) interleaved with file
//! content, so renaming a file changes the digest as reliably as editing it.
//!
//! The layout follows the earlier TypeScript capture, with one deliberate
//! difference: entry names are ordered by UTF-16 code units (JavaScript's
//! default sort) instead of the host-dependent `localeCompare` collation, so the
//! digest is reproducible on every machine. Artifact digests are recorded
//! evidence and are not compared across desktop versions, so determinism was
//! chosen over replicating ICU collation.

use crate::deadline::Interrupt;
use crate::errors::{CODE_INVALID_PARAMS, coded};
use crate::evidence::utf16_order;
use crate::workspace;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::Path;

const MAX_ARTIFACT_COUNT: usize = 1_000;
const MAX_ARTIFACT_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ARTIFACT_ENTRIES: u64 = 100_000;
const MAX_ARTIFACT_DEPTH: usize = 128;
const METHOD: &str = "workspace.fingerprint-artifacts";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFingerprintParams {
    pub root: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFingerprint {
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFingerprintResult {
    pub artifacts: Vec<ArtifactFingerprint>,
}

pub fn fingerprint(
    params: ArtifactFingerprintParams,
    interrupt: &Interrupt,
) -> Result<ArtifactFingerprintResult> {
    if params.paths.is_empty() {
        return Err(coded(
            CODE_INVALID_PARAMS,
            "artifact fingerprint requires at least one path",
        ));
    }
    if params.paths.len() > MAX_ARTIFACT_COUNT {
        return Err(coded(
            CODE_INVALID_PARAMS,
            format!("artifact fingerprint accepts at most {MAX_ARTIFACT_COUNT} paths"),
        ));
    }
    let root = workspace::canonical_root(&params.root)?;
    let mut remaining = MAX_ARTIFACT_TOTAL_BYTES;
    let mut artifacts = Vec::with_capacity(params.paths.len());
    for path in &params.paths {
        interrupt.check(METHOD)?;
        let artifact = fingerprint_one(&root, path, remaining, interrupt)?;
        remaining = remaining.saturating_sub(artifact.size);
        artifacts.push(artifact);
    }
    Ok(ArtifactFingerprintResult { artifacts })
}

fn fingerprint_one(
    root: &Path,
    requested: &str,
    remaining_total: u64,
    interrupt: &Interrupt,
) -> Result<ArtifactFingerprint> {
    let relative = workspace::validate_relative(requested)?;
    let target = root.join(&relative);
    let metadata = fs::symlink_metadata(&target)
        .with_context(|| format!("artifact path is unavailable: {requested}"))?;
    if metadata.file_type().is_symlink() {
        bail!("Artifact path may not be a symbolic link: {requested}");
    }
    let canonical = fs::canonicalize(&target)
        .with_context(|| format!("artifact path is unavailable: {requested}"))?;
    if !canonical.starts_with(root) {
        bail!("Artifact path resolves outside the task workspace: {requested}");
    }

    if metadata.is_file() {
        if metadata.len() > MAX_ARTIFACT_FILE_BYTES {
            bail!(
                "Artifact file exceeds the {MAX_ARTIFACT_FILE_BYTES}-byte evidence bound: {requested}"
            );
        }
        if metadata.len() > remaining_total {
            bail!(
                "Artifact evidence exceeds the {MAX_ARTIFACT_TOTAL_BYTES}-byte total evidence bound"
            );
        }
        let mut hasher = Sha256::new();
        let size = stream_hash(
            &mut hasher,
            &target,
            MAX_ARTIFACT_FILE_BYTES.min(remaining_total),
            interrupt,
        )?;
        return Ok(ArtifactFingerprint {
            path: requested.to_owned(),
            kind: "file".to_owned(),
            size,
            sha256: hex(&hasher.finalize()),
        });
    }
    if !metadata.is_dir() {
        bail!("Artifact path is not a regular file or directory: {requested}");
    }

    let mut state = WalkState {
        hasher: Sha256::new(),
        size: 0,
        entries: 0,
        max_total: remaining_total.min(MAX_ARTIFACT_TOTAL_BYTES),
        interrupt,
    };
    walk(root, &target, 0, &mut state)?;
    Ok(ArtifactFingerprint {
        path: requested.to_owned(),
        kind: "directory".to_owned(),
        size: state.size,
        sha256: hex(&state.hasher.finalize()),
    })
}

struct WalkState<'a> {
    hasher: Sha256,
    size: u64,
    entries: u64,
    max_total: u64,
    interrupt: &'a Interrupt,
}

fn walk(root: &Path, directory: &Path, depth: usize, state: &mut WalkState<'_>) -> Result<()> {
    if depth > MAX_ARTIFACT_DEPTH {
        bail!("Artifact directory exceeds the {MAX_ARTIFACT_DEPTH}-level depth bound");
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(directory)
        .with_context(|| format!("artifact directory is unavailable: {}", directory.display()))?
    {
        names.push(entry?.file_name());
    }
    names.sort_by(|left, right| utf16_order(&left.to_string_lossy(), &right.to_string_lossy()));

    for name in names {
        state.interrupt.check(METHOD)?;
        state.entries += 1;
        if state.entries > MAX_ARTIFACT_ENTRIES {
            bail!("Artifact directory exceeds the {MAX_ARTIFACT_ENTRIES}-entry evidence bound");
        }
        let candidate = directory.join(&name);
        let relative = relative_to_root(root, &candidate);
        let metadata = fs::symlink_metadata(&candidate)?;
        if metadata.file_type().is_symlink() {
            bail!("Artifact directory contains a symbolic link: {relative}");
        }
        state.hasher.update(relative.as_bytes());
        state.hasher.update(b"\0");
        if metadata.is_dir() {
            walk(root, &candidate, depth + 1, state)?;
            continue;
        }
        if !metadata.is_file() {
            bail!("Artifact directory contains an unsupported entry: {relative}");
        }
        if metadata.len() > MAX_ARTIFACT_FILE_BYTES {
            bail!(
                "Artifact file exceeds the {MAX_ARTIFACT_FILE_BYTES}-byte evidence bound: {relative}"
            );
        }
        let remaining = state.max_total.saturating_sub(state.size);
        if metadata.len() > remaining {
            bail!(
                "Artifact directory exceeds the {MAX_ARTIFACT_TOTAL_BYTES}-byte total evidence bound"
            );
        }
        state.size += stream_hash(
            &mut state.hasher,
            &candidate,
            MAX_ARTIFACT_FILE_BYTES.min(remaining),
            state.interrupt,
        )?;
    }
    Ok(())
}

fn stream_hash(
    hasher: &mut Sha256,
    path: &Path,
    max_bytes: u64,
    interrupt: &Interrupt,
) -> Result<u64> {
    let mut file = fs::File::open(path)
        .with_context(|| format!("artifact file is unavailable: {}", path.display()))?;
    let mut buffer = [0u8; 64 * 1024];
    let mut read_total = 0u64;
    loop {
        interrupt.check(METHOD)?;
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        read_total += read as u64;
        if read_total > max_bytes {
            bail!(
                "Artifact grew beyond its {max_bytes}-byte evidence bound while hashing: {}",
                path.display()
            );
        }
        hasher.update(&buffer[..read]);
    }
    Ok(read_total)
}

fn relative_to_root(root: &Path, target: &Path) -> String {
    target
        .strip_prefix(root)
        .unwrap_or(target)
        .to_string_lossy()
        .replace('\\', "/")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_root(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("nd-artifacts-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn interrupt() -> Interrupt {
        Interrupt::never()
    }

    #[test]
    fn file_artifacts_hash_exactly_their_bytes() {
        let root = temp_root("file");
        fs::write(root.join("research.md"), "hello").unwrap();

        let result = fingerprint(
            ArtifactFingerprintParams {
                root: root.to_string_lossy().into_owned(),
                paths: vec!["research.md".to_owned()],
            },
            &interrupt(),
        )
        .unwrap();

        assert_eq!(result.artifacts.len(), 1);
        let artifact = &result.artifacts[0];
        assert_eq!(artifact.path, "research.md");
        assert_eq!(artifact.kind, "file");
        assert_eq!(artifact.size, 5);
        assert_eq!(
            artifact.sha256,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn directory_artifacts_pin_the_recorded_layout() {
        let root = temp_root("dir");
        fs::create_dir_all(root.join("design").join("sub")).unwrap();
        fs::write(root.join("design").join("a.txt"), "A").unwrap();
        fs::write(root.join("design").join("sub").join("b.txt"), "B").unwrap();

        let result = fingerprint(
            ArtifactFingerprintParams {
                root: root.to_string_lossy().into_owned(),
                paths: vec!["design".to_owned()],
            },
            &interrupt(),
        )
        .unwrap();

        // Layout: every entry contributes "<root-relative path>\0", files add their
        // bytes, names ordered by UTF-16 code units (a.txt before sub).
        let mut expected = Sha256::new();
        expected.update(b"design/a.txt\0");
        expected.update(b"A");
        expected.update(b"design/sub\0");
        expected.update(b"design/sub/b.txt\0");
        expected.update(b"B");
        let expected_digest = hex(&expected.finalize());

        let artifact = &result.artifacts[0];
        assert_eq!(artifact.kind, "directory");
        assert_eq!(artifact.size, 2);
        assert_eq!(artifact.sha256, expected_digest);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_directories_hash_the_empty_input() {
        let root = temp_root("empty");
        fs::create_dir_all(root.join("design")).unwrap();

        let result = fingerprint(
            ArtifactFingerprintParams {
                root: root.to_string_lossy().into_owned(),
                paths: vec!["design".to_owned()],
            },
            &interrupt(),
        )
        .unwrap();

        assert_eq!(result.artifacts[0].size, 0);
        assert_eq!(
            result.artifacts[0].sha256,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn escapes_and_missing_paths_are_refused() {
        let root = temp_root("refuse");
        let error = fingerprint(
            ArtifactFingerprintParams {
                root: root.to_string_lossy().into_owned(),
                paths: vec!["../outside.txt".to_owned()],
            },
            &interrupt(),
        )
        .expect_err("parent traversal must be refused");
        assert!(error.to_string().contains("escapes the root"));

        let error = fingerprint(
            ArtifactFingerprintParams {
                root: root.to_string_lossy().into_owned(),
                paths: Vec::new(),
            },
            &interrupt(),
        )
        .expect_err("an empty artifact list must be refused");
        assert_eq!(crate::errors::code_of(&error), CODE_INVALID_PARAMS);
        let _ = fs::remove_dir_all(&root);
    }
}
