//! Exact worktree fingerprints for review evidence.
//!
//! A receipt binds independent review to the precise state of a task worktree:
//! HEAD, the binary tracked diff, and the content of every untracked file. The
//! diff can be far larger than an RPC frame, so it is streamed into the hash
//! rather than returned. The byte layout of the fingerprint is a stored contract
//! (receipts recorded earlier are compared against fresh captures), so any change
//! to what is hashed, or in which order, invalidates every pending receipt.

use crate::deadline::Interrupt;
use crate::git::{self, GitExecParams};
use crate::scheduler::now_ms;
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fs;
use std::io::Read;
use std::path::Path;

const MAX_GIT_METADATA_BYTES: usize = 16 * 1024 * 1024;
const MAX_GIT_DIFF_BYTES: usize = 512 * 1024 * 1024;
const MAX_UNTRACKED_FILES: usize = 50_000;
const MAX_UNTRACKED_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
const FINGERPRINT_DOMAIN: &str = "nd-dsh-evidence-v1\0";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceParams {
    pub root: String,
    pub git_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceResult {
    pub fingerprint: String,
    pub git_head: String,
    pub changed_files: Vec<String>,
    pub untracked_bytes: u64,
    pub diff_bytes: usize,
    pub duration_ms: u64,
}

pub fn capture(params: EvidenceParams, interrupt: &Interrupt) -> Result<EvidenceResult> {
    let started_at = now_ms();
    let root = params.root.trim();
    if root.is_empty() {
        bail!("evidence root is empty");
    }
    let run = |args: &[&str]| -> Result<String> {
        let result = git::exec(git_params(root, args, params.git_path.clone()), interrupt)?;
        if result.truncated {
            bail!("git {} output exceeded the evidence bound", args.join(" "));
        }
        if result.exit_code != 0 {
            bail!(
                "git {} exited {}: {}",
                args.join(" "),
                result.exit_code,
                result.stderr.trim()
            );
        }
        Ok(result.stdout)
    };

    let git_head = run(&["rev-parse", "HEAD"])?.trim().to_owned();
    let tracked_names = run(&["diff", "--name-only", "HEAD", "--", "."])?;
    let untracked_raw = run(&["ls-files", "--others", "--exclude-standard", "-z"])?;

    let mut untracked = untracked_raw
        .split('\0')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    untracked.sort_by(|left, right| utf16_order(left, right));
    if untracked.len() > MAX_UNTRACKED_FILES {
        bail!("untracked file count exceeds the workspace evidence bound");
    }

    let root_path = Path::new(root);
    let mut untracked_items = Vec::with_capacity(untracked.len());
    let mut untracked_bytes = 0u64;
    for relative in &untracked {
        interrupt.check("workspace.evidence")?;
        let file = root_path.join(relative);
        let metadata = fs::symlink_metadata(&file)?;
        if metadata.file_type().is_symlink() {
            let target = fs::read_link(&file)?;
            untracked_items.push(format!("{relative}\0symlink\0{}", target.to_string_lossy()));
            continue;
        }
        if !metadata.is_file() {
            bail!("unsupported untracked workspace entry: {relative}");
        }
        if metadata.len() > MAX_UNTRACKED_FILE_BYTES {
            bail!(
                "untracked file exceeds the {MAX_UNTRACKED_FILE_BYTES}-byte evidence bound: {relative}"
            );
        }
        let remaining = MAX_UNTRACKED_TOTAL_BYTES - untracked_bytes;
        if metadata.len() > remaining {
            bail!("untracked workspace content exceeds the aggregate evidence bound");
        }
        let (digest, read) = hash_file(&file, MAX_UNTRACKED_FILE_BYTES.min(remaining))?;
        untracked_bytes += read;
        untracked_items.push(format!("{relative}\0{digest}"));
    }

    let mut changed_files = tracked_names
        .split('\n')
        .map(|line| line.trim_end_matches('\r').trim())
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .chain(untracked.iter().cloned())
        .collect::<Vec<_>>();
    changed_files.sort_by(|left, right| utf16_order(left, right));
    changed_files.dedup();

    let mut hasher = Sha256::new();
    hasher.update(FINGERPRINT_DOMAIN.as_bytes());
    hasher.update(git_head.as_bytes());
    hasher.update(b"\0");
    let diff = git::hash_stdout(
        git_params(
            root,
            &["diff", "--binary", "HEAD", "--", "."],
            params.git_path.clone(),
        ),
        interrupt,
        hasher,
        MAX_GIT_DIFF_BYTES,
    )?;
    let mut hasher = diff.hasher;
    hasher.update(b"\0");
    for item in &untracked_items {
        hasher.update(item.as_bytes());
        hasher.update(b"\0");
    }

    Ok(EvidenceResult {
        fingerprint: hex(&hasher.finalize()),
        git_head,
        changed_files,
        untracked_bytes,
        diff_bytes: diff.bytes,
        duration_ms: now_ms().saturating_sub(started_at),
    })
}

fn git_params(root: &str, args: &[&str], git_path: Option<String>) -> GitExecParams {
    GitExecParams {
        cwd: root.to_owned(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        input: None,
        env: Default::default(),
        max_output_bytes: Some(MAX_GIT_METADATA_BYTES),
        git_path,
    }
}

fn hash_file(path: &Path, max_bytes: u64) -> Result<(String, u64)> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut read_total = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        read_total += read as u64;
        if read_total > max_bytes {
            bail!(
                "workspace file exceeded the {max_bytes}-byte streaming hash bound: {}",
                path.display()
            );
        }
        hasher.update(&buffer[..read]);
    }
    Ok((hex(&hasher.finalize()), read_total))
}

/// JavaScript's default sort compares UTF-16 code units; receipts recorded by the
/// earlier TypeScript capture used that order, so the fingerprint must too.
pub(crate) fn utf16_order(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_paths_by_utf16_code_units_like_javascript() {
        // U+FF5E (one UTF-16 unit, 0xFF5E) sorts after U+1F600 (surrogate 0xD83D) in
        // JavaScript, while UTF-8 byte order would put it first.
        let mut names = vec!["\u{FF5E}.txt".to_owned(), "\u{1F600}.txt".to_owned()];
        names.sort_by(|left, right| utf16_order(left, right));
        assert_eq!(names, vec!["\u{1F600}.txt", "\u{FF5E}.txt"]);
    }

    #[test]
    fn formats_lowercase_hex() {
        assert_eq!(hex(&[0x00, 0xab, 0xff]), "00abff");
    }
}
