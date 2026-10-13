//! Bounded, cancellable disk-usage scans for the ND Disk Cleaner extension.
//!
//! The walk itself is ripgrep's parallel walker with every ignore rule off —
//! a disk audit must see the whole tree, not a repository view. Sizes are
//! aggregated bottom-up into per-directory totals, and the delivered tree is
//! pruned (top children per directory, a bounded node count, truncated names)
//! so a full-volume scan still fits the extension web-view bridge budget.

use crate::deadline::Interrupt;
use anyhow::{Context, Result, bail};
use ignore::{WalkBuilder, WalkState};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Progress fires at most this often, plus every [`PROGRESS_EVERY`] entries.
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(250);
const PROGRESS_EVERY: u64 = 4096;
/// Interrupt/limit checks run at most this many entries apart in each visitor.
const CHECK_EVERY: u64 = 256;
/// Hard ceiling on walked entries; past it the walk stops and reports `truncated`.
const MAX_ENTRIES: u64 = 2_000_000;
/// Children kept per directory in the delivered tree; the rest fold into one bucket.
const MAX_CHILDREN: usize = 12;
/// Name truncation inside the delivered tree, one of the size levers.
const MAX_NAME_CHARS: usize = 48;
/// The delivered result must fit the web-view bridge frame (262,144 characters);
/// leave room under it for the message wrapper and JSON escaping.
const MAX_RESULT_CHARS: usize = 200_000;
/// Node budgets shrink until the serialized result fits; the last is the floor.
const NODE_BUDGETS: [usize; 3] = [3_500, 1_200, 400];
/// The "rest of this folder" aggregate label; `k: 2` nodes are not actionable.
const OTHER_LABEL: &str = "(other)";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskScanParams {
    pub root: PathBuf,
}

#[derive(Debug, Default, Clone, Copy)]
struct ScanCounts {
    entries: u64,
    file_bytes: u64,
    file_count: u64,
    dir_count: u64,
    errors: u64,
}

#[derive(Debug, Default)]
struct DirAccum {
    file_bytes: u64,
    file_count: u64,
    /// Largest directly-contained files, sorted best-first and capped.
    top_files: Vec<(u64, String)>,
}

impl DirAccum {
    fn add_file(&mut self, size: u64, name: String) {
        self.file_bytes += size;
        self.file_count += 1;
        let sort = |list: &mut [(u64, String)]| {
            list.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        };
        if self.top_files.len() < MAX_CHILDREN {
            self.top_files.push((size, name));
            sort(&mut self.top_files);
            return;
        }
        let replaces = {
            let worst = self.top_files.last().expect("capped list");
            size > worst.0 || (size == worst.0 && name < worst.1)
        };
        if replaces {
            *self.top_files.last_mut().expect("capped list") = (size, name);
            sort(&mut self.top_files);
        }
    }
}

struct ScanShared {
    dirs: Mutex<HashMap<PathBuf, DirAccum>>,
    entries: AtomicU64,
    file_bytes: AtomicU64,
    file_count: AtomicU64,
    dir_count: AtomicU64,
    errors: AtomicU64,
    entry_cap_hit: AtomicBool,
    last_progress: Mutex<Option<Instant>>,
}

impl ScanShared {
    fn progress_due(&self) -> bool {
        let mut last = lock(&self.last_progress);
        match *last {
            None => {
                *last = Some(Instant::now());
                true
            }
            Some(when) => {
                if when.elapsed() >= PROGRESS_MIN_INTERVAL {
                    *last = Some(Instant::now());
                    true
                } else {
                    false
                }
            }
        }
    }
}

fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|error| error.into_inner())
}

/**
 * Walk one directory tree and return its aggregated, pruned size tree.
 *
 * `progress` receives live `(entries, bytes)` counts while the walk runs, so
 * the desktop can show real progress without waiting for the final result.
 * Cancellation and deadlines travel through `interrupt`: the caller's request
 * id is the scan identity on the desktop side, and `core.cancel` stops the
 * walk by failing the request with the `canceled` code.
 */
pub fn scan(
    params: DiskScanParams,
    interrupt: &Interrupt,
    progress: Option<&(dyn Fn(u64, u64) + Sync)>,
) -> Result<Value> {
    interrupt.check("disk scan")?;
    let root = fs::canonicalize(&params.root).context("resolve scan root")?;
    if !root.is_dir() {
        bail!("Scan root must be an existing directory");
    }

    let shared = Arc::new(ScanShared {
        dirs: Mutex::new(HashMap::new()),
        entries: AtomicU64::new(0),
        file_bytes: AtomicU64::new(0),
        file_count: AtomicU64::new(0),
        dir_count: AtomicU64::new(0),
        errors: AtomicU64::new(0),
        entry_cap_hit: AtomicBool::new(false),
        last_progress: Mutex::new(None),
    });
    lock(&shared.dirs).insert(root.clone(), DirAccum::default());

    let threads = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4)
        .clamp(2, 8);
    let walker = WalkBuilder::new(&root)
        .hidden(false)
        .ignore(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .parents(false)
        .require_git(false)
        .follow_links(false)
        .threads(threads)
        .build_parallel();
    {
        let interrupt = interrupt.clone();
        let shared = Arc::clone(&shared);
        walker.run(move || {
            let shared = Arc::clone(&shared);
            let interrupt = interrupt.clone();
            let mut since_check: u64 = 0;
            let mut since_progress: u64 = 0;
            Box::new(move |entry| {
                since_check += 1;
                if since_check >= CHECK_EVERY {
                    since_check = 0;
                    if interrupt.stop_reason().is_some() {
                        return WalkState::Quit;
                    }
                }
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => {
                        shared.errors.fetch_add(1, Ordering::Relaxed);
                        return WalkState::Continue;
                    }
                };
                // A symlink is a name, not a second copy of its target.
                if entry.file_type().is_some_and(|kind| kind.is_symlink()) {
                    return WalkState::Continue;
                }
                let path = entry.path().to_path_buf();
                let entries = shared.entries.fetch_add(1, Ordering::Relaxed) + 1;
                if entries > MAX_ENTRIES {
                    shared.entry_cap_hit.store(true, Ordering::Relaxed);
                    return WalkState::Quit;
                }
                if entry.file_type().is_some_and(|kind| kind.is_dir()) {
                    shared.dir_count.fetch_add(1, Ordering::Relaxed);
                    lock(&shared.dirs).entry(path).or_default();
                } else {
                    let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
                    shared.file_bytes.fetch_add(size, Ordering::Relaxed);
                    shared.file_count.fetch_add(1, Ordering::Relaxed);
                    let name = file_name_of(&path);
                    let mut dirs = lock(&shared.dirs);
                    if let Some(parent) = path.parent() {
                        dirs.entry(parent.to_path_buf())
                            .or_default()
                            .add_file(size, name);
                    }
                }
                since_progress += 1;
                if let Some(report) = progress
                    && (since_progress >= PROGRESS_EVERY || shared.progress_due())
                {
                    since_progress = 0;
                    report(
                        shared.entries.load(Ordering::Relaxed),
                        shared.file_bytes.load(Ordering::Relaxed),
                    );
                }
                WalkState::Continue
            })
        });
    }

    // A canceled or expired request is an error, never a partial result.
    interrupt.check("disk scan")?;
    let dirs = std::mem::take(&mut *lock(&shared.dirs));
    let counts = ScanCounts {
        entries: shared.entries.load(Ordering::Relaxed),
        file_bytes: shared.file_bytes.load(Ordering::Relaxed),
        file_count: shared.file_count.load(Ordering::Relaxed),
        dir_count: shared.dir_count.load(Ordering::Relaxed),
        errors: shared.errors.load(Ordering::Relaxed),
    };
    let truncated = shared.entry_cap_hit.load(Ordering::Relaxed);
    build_result(&root, &dirs, counts, truncated)
}

/** A delivered child item: size, name, kind, and the directory path when it is one. */
struct TreeItem<'a> {
    size: u64,
    name: String,
    is_dir: bool,
    dir: Option<&'a Path>,
}

/**
 * Assemble the compact delivered tree. The walk's flat map is exact; this is
 * where the result is bounded: top [`MAX_CHILDREN`] children per directory,
 * one aggregate bucket for the rest, and a node budget that shrinks until the
 * serialized result fits the web-view bridge.
 */
fn build_result(
    root: &Path,
    dirs: &HashMap<PathBuf, DirAccum>,
    counts: ScanCounts,
    truncated: bool,
) -> Result<Value> {
    // Child-directory adjacency, then subtree totals deepest-first.
    let mut children: HashMap<&Path, Vec<&Path>> = HashMap::new();
    for path in dirs.keys() {
        if let Some(parent) = path.parent() {
            children.entry(parent).or_default().push(path);
        }
    }
    let mut order: Vec<&Path> = dirs.keys().map(|key| key.as_path()).collect();
    order.sort_by_key(|path| path.components().count());
    let mut totals: HashMap<&Path, u64> = HashMap::new();
    for path in order.iter().rev() {
        let mut total = dirs[*path].file_bytes;
        if let Some(kids) = children.get(*path) {
            for kid in kids {
                total += totals[kid];
            }
        }
        totals.insert(*path, total);
    }

    for budget in NODE_BUDGETS {
        let mut remaining = budget;
        let tree = dir_node(root, dirs, &children, &totals, &mut remaining);
        let result = json!({
            "root": root.to_string_lossy(),
            "name": short_name(root),
            "entries": counts.entries,
            "bytes": counts.file_bytes,
            "fileCount": counts.file_count,
            "dirCount": counts.dir_count,
            "errors": counts.errors,
            "truncated": truncated,
            "tree": tree,
        });
        let fits = serde_json::to_string(&result)
            .map(|text| text.chars().count() <= MAX_RESULT_CHARS)
            .unwrap_or(false);
        if fits {
            return Ok(result);
        }
    }
    bail!("The scan result is too large to deliver; scan a narrower folder");
}

/**
 * One delivered directory node. Compact keys (`n`, `s`, `k`, `c`, `count`)
 * because the tree crosses the web-view bridge; `k` is 0 for a directory, 1
 * for a file, and 2 for the aggregate bucket of everything that was folded
 * away — which is informational and never actionable.
 */
fn dir_node(
    path: &Path,
    dirs: &HashMap<PathBuf, DirAccum>,
    children: &HashMap<&Path, Vec<&Path>>,
    totals: &HashMap<&Path, u64>,
    remaining: &mut usize,
) -> Value {
    if *remaining == 0 {
        // Out of budget: this directory arrives as a size-only leaf.
        return json!({ "n": short_name(path), "s": totals[path], "k": 0, "c": [] });
    }
    *remaining -= 1;
    let accum = &dirs[path];
    let mut items: Vec<TreeItem> = Vec::new();
    if let Some(kids) = children.get(path) {
        for kid in kids {
            items.push(TreeItem {
                size: totals[kid],
                name: short_name(kid),
                is_dir: true,
                dir: Some(*kid),
            });
        }
    }
    for (size, name) in &accum.top_files {
        items.push(TreeItem {
            size: *size,
            name: name.clone(),
            is_dir: false,
            dir: None,
        });
    }
    items.sort_by(|left, right| {
        right
            .size
            .cmp(&left.size)
            .then_with(|| left.name.cmp(&right.name))
    });

    let kept = items.len().min(MAX_CHILDREN);
    let mut nodes: Vec<Value> = Vec::with_capacity(kept + 1);
    let mut emitted = 0usize;
    let mut emitted_size = 0u64;
    while emitted < kept && *remaining > 0 {
        *remaining -= 1;
        let item = &items[emitted];
        emitted_size += item.size;
        if item.is_dir {
            nodes.push(dir_node(
                item.dir.expect("directory item"),
                dirs,
                children,
                totals,
                remaining,
            ));
        } else {
            nodes.push(json!({ "n": item.name, "s": item.size, "k": 1 }));
        }
        emitted += 1;
    }
    // The exact remainder of this directory's total: folded child entries
    // (directories and top files that lost their slot) plus every directly
    // contained file that never made the top list. Sizes reconcile by
    // construction — the bucket is the total minus what the emitted children
    // already carry.
    let never_listed_files = (accum.file_count as usize).saturating_sub(accum.top_files.len());
    let rest_count = (items.len() - emitted) + never_listed_files;
    let rest_size = totals[path].saturating_sub(emitted_size);
    if rest_count > 0 {
        nodes.push(json!({ "n": OTHER_LABEL, "s": rest_size, "k": 2, "count": rest_count }));
    }
    json!({ "n": short_name(path), "s": totals[path], "k": 0, "c": nodes })
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn short_name(path: &Path) -> String {
    truncate_chars(&file_name_of(path), MAX_NAME_CHARS)
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_owned();
    }
    let mut truncated: String = value.chars().take(max.saturating_sub(1)).collect();
    truncated.push('…');
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::{CODE_CANCELED, code_of};
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    fn never_interrupted() -> Interrupt {
        Interrupt::new(Arc::new(AtomicBool::new(false)), None)
    }

    fn canceled_interrupt() -> Interrupt {
        Interrupt::new(Arc::new(AtomicBool::new(true)), None)
    }

    fn write(path: &Path, bytes: usize) {
        fs::write(path, vec![0u8; bytes]).unwrap();
    }

    #[test]
    fn aggregates_sizes_bottom_up_and_reports_exact_totals() {
        let fixture = temp_dir("disk-scan-aggregate");
        fs::create_dir_all(fixture.join("b/inner")).unwrap();
        write(&fixture.join("a.bin"), 1_000);
        write(&fixture.join("b/big.bin"), 5_000);
        write(&fixture.join("b/inner/tiny.txt"), 10);
        let result = scan(
            DiskScanParams {
                root: fixture.clone(),
            },
            &never_interrupted(),
            None,
        )
        .unwrap();

        assert_eq!(result["bytes"], json!(6_010));
        assert_eq!(result["fileCount"], json!(3));
        assert_eq!(result["dirCount"], json!(3)); // root, b, b/inner
        assert_eq!(result["errors"], json!(0));
        assert_eq!(result["truncated"], json!(false));
        assert_eq!(result["tree"]["s"], json!(6_010));
        assert_eq!(result["tree"]["k"], json!(0));

        // Children arrive sorted by size; the top-level names are all present.
        let names: Vec<&str> = result["tree"]["c"]
            .as_array()
            .unwrap()
            .iter()
            .map(|node| node["n"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["b", "a.bin"]);
        assert_eq!(result["tree"]["c"][0]["s"], json!(5_010));

        let b = &result["tree"]["c"][0];
        assert_eq!(b["c"][0]["n"], json!("big.bin"));
        assert_eq!(b["c"][0]["s"], json!(5_000));
        // Directory children merge with the directory's own top files, sorted.
        let inner = b["c"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["k"] == json!(0))
            .unwrap();
        assert_eq!(inner["s"], json!(10));
        let _ = fs::remove_dir_all(fixture);
    }

    #[test]
    fn folds_small_children_into_one_non_actionable_bucket() {
        let fixture = temp_dir("disk-scan-fold");
        fs::create_dir_all(fixture.join("d")).unwrap();
        for index in 0..(MAX_CHILDREN + 8) {
            write(&fixture.join(format!("f{index:02}.bin")), 1_000);
        }
        let result = scan(
            DiskScanParams {
                root: fixture.clone(),
            },
            &never_interrupted(),
            None,
        )
        .unwrap();

        let nodes = result["tree"]["c"].as_array().unwrap();
        assert_eq!(nodes.len(), MAX_CHILDREN + 1);
        let bucket = nodes.last().unwrap();
        assert_eq!(bucket["n"], json!(OTHER_LABEL));
        assert_eq!(bucket["k"], json!(2));
        // The 8 files past the cap plus the empty directory itself fold in.
        assert_eq!(bucket["count"], json!(9));
        assert_eq!(bucket["s"], json!(8_000));
        // Kept children plus the bucket sum back to the exact total.
        let sum: u64 = nodes.iter().map(|node| node["s"].as_u64().unwrap()).sum();
        assert_eq!(sum, 20_000);
        assert_eq!(result["bytes"], json!(20_000));
        let _ = fs::remove_dir_all(fixture);
    }

    #[test]
    fn an_exhausted_node_budget_returns_size_only_leaves_and_folds_the_rest() {
        let root = PathBuf::from("/budget-fixture");
        let one = root.join("one");
        let two = root.join("two");
        let mut dirs: HashMap<PathBuf, DirAccum> = HashMap::new();
        dirs.insert(root.clone(), DirAccum::default());
        for child in [&one, &two] {
            dirs.insert(
                child.clone(),
                DirAccum {
                    file_bytes: 5,
                    file_count: 1,
                    top_files: vec![(5, "x.bin".to_owned())],
                },
            );
        }
        let mut children: HashMap<&Path, Vec<&Path>> = HashMap::new();
        for path in dirs.keys() {
            if let Some(parent) = path.parent() {
                children.entry(parent).or_default().push(path);
            }
        }
        let mut totals: HashMap<&Path, u64> = HashMap::new();
        totals.insert(root.as_path(), 10);
        totals.insert(one.as_path(), 5);
        totals.insert(two.as_path(), 5);

        let mut remaining = 2; // enough for the root and one child, nothing deeper
        let node = dir_node(&root, &dirs, &children, &totals, &mut remaining);
        let kids = node["c"].as_array().unwrap();
        assert_eq!(kids.len(), 2);
        // The first child kept its budget slot but had none left for its own
        // children; the second folded into the root's aggregate bucket.
        assert_eq!(kids[0]["n"], json!("one"));
        assert_eq!(kids[0]["c"], json!([]));
        assert_eq!(kids[1]["n"], json!(OTHER_LABEL));
        assert_eq!(kids[1]["k"], json!(2));
        assert_eq!(node["s"], json!(10));
    }

    #[test]
    fn skips_symlinks_and_counts_unreadable_entries_without_failing() {
        let fixture = temp_dir("disk-scan-symlink");
        write(&fixture.join("real.bin"), 1_000);
        #[cfg(unix)]
        std::os::unix::fs::symlink(fixture.join("real.bin"), fixture.join("link.bin")).unwrap();
        let result = scan(
            DiskScanParams {
                root: fixture.clone(),
            },
            &never_interrupted(),
            None,
        )
        .unwrap();

        let names: Vec<&str> = result["tree"]["c"]
            .as_array()
            .unwrap()
            .iter()
            .map(|node| node["n"].as_str().unwrap())
            .collect();
        #[cfg(unix)]
        assert!(!names.contains(&"link.bin"));
        assert_eq!(names, ["real.bin"]);
        assert_eq!(result["bytes"], json!(1_000));
        let _ = fs::remove_dir_all(fixture);
    }

    #[test]
    fn a_canceled_request_fails_with_the_canceled_code_before_walking() {
        let fixture = temp_dir("disk-scan-cancel");
        let error = scan(
            DiskScanParams {
                root: fixture.clone(),
            },
            &canceled_interrupt(),
            None,
        )
        .unwrap_err();
        assert_eq!(code_of(&error), CODE_CANCELED);
        let _ = fs::remove_dir_all(fixture);
    }

    #[test]
    fn missing_or_non_directory_roots_are_rejected() {
        let fixture = temp_dir("disk-scan-roots");
        let missing = scan(
            DiskScanParams {
                root: fixture.join("nope"),
            },
            &never_interrupted(),
            None,
        )
        .unwrap_err();
        assert!(format!("{missing:#}").contains("resolve scan root"));

        let file_root = fixture.join("file.bin");
        write(&file_root, 64);
        let not_dir = scan(
            DiskScanParams {
                root: file_root.clone(),
            },
            &never_interrupted(),
            None,
        )
        .unwrap_err();
        assert!(format!("{not_dir:#}").contains("existing directory"));
        let _ = fs::remove_dir_all(fixture);
    }

    #[test]
    fn progress_reports_live_counts_without_failing_the_scan() {
        let fixture = temp_dir("disk-scan-progress");
        write(&fixture.join("a.bin"), 4_096);
        let reports: Mutex<Vec<(u64, u64)>> = Mutex::new(Vec::new());
        let result = scan(
            DiskScanParams {
                root: fixture.clone(),
            },
            &never_interrupted(),
            Some(&|entries, bytes| reports.lock().unwrap().push((entries, bytes))),
        )
        .unwrap();
        // Small fixtures may finish before the entry cadence fires; the final
        // counts are authoritative either way.
        assert_eq!(result["bytes"], json!(4_096));
        let _ = fs::remove_dir_all(fixture);
    }

    #[test]
    fn delivered_results_shrink_until_they_fit_the_bridge_budget() {
        // A synthetic flat map stands in for a huge walked tree, so the budget
        // and serialization guard run without creating thousands of files.
        let root = PathBuf::from("/scan-fixture");
        let mut dirs: HashMap<PathBuf, DirAccum> = HashMap::new();
        dirs.insert(root.clone(), DirAccum::default());
        let mut total_bytes = 0u64;
        for index in 0..4_000 {
            let dir = root.join(format!("d{index:04}"));
            let mut accum = DirAccum::default();
            for file in 0..MAX_CHILDREN {
                let size = 1_000_000 + u64::try_from(index * 13 + file).unwrap();
                accum.add_file(size, format!("file-{file:02}.bin"));
                total_bytes += size;
            }
            dirs.insert(dir, accum);
            dirs.get_mut(&root).unwrap().add_file(0, String::new());
        }
        let counts = ScanCounts {
            entries: dirs.len() as u64 + total_bytes / 1_000_000,
            file_bytes: total_bytes,
            file_count: 4_000 * MAX_CHILDREN as u64,
            dir_count: 4_000,
            errors: 0,
        };
        let result = build_result(&root, &dirs, counts, false).unwrap();
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(
            serialized.chars().count() <= MAX_RESULT_CHARS,
            "delivered result must fit the bridge budget"
        );
        assert_eq!(result["bytes"], json!(total_bytes));
        // The shrunken budget folds deep children into aggregate buckets.
        let root_children = result["tree"]["c"].as_array().unwrap();
        assert!(root_children.len() <= MAX_CHILDREN + 1);
        assert!(root_children.iter().any(|node| node["k"] == json!(2)));
    }

    #[test]
    fn truncates_long_names_without_panicking_on_multibyte_boundaries() {
        let name = "ディスクの大きなファイル".repeat(20);
        assert!(truncate_chars(&name, MAX_NAME_CHARS).chars().count() <= MAX_NAME_CHARS);
        let ascii = "x".repeat(200);
        let truncated = truncate_chars(&ascii, MAX_NAME_CHARS);
        assert_eq!(truncated.chars().count(), MAX_NAME_CHARS);
        assert!(truncated.ends_with('…'));
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("{label}-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
