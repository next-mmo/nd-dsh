//! Protocol-level contract tests for the nd-core sidecar contract task.
//!
//! These drive a real `nd-core` process over the real MessagePack protocol, because
//! the guarantees under test are the ones a caller can only observe from outside:
//! a deadline that stops work, a cancel that leaves its peers alone, a stopped
//! request that leaves no process behind, a restart that keeps terminal identity,
//! and a cache that never serves a stale result.

use base64::Engine as _;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const PROTOCOL_VERSION: u16 = 1;

// ---------------------------------------------------------------------------------
// Test client
// ---------------------------------------------------------------------------------

#[derive(Debug)]
struct CoreError {
    code: String,
    message: String,
}

type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug, Deserialize)]
struct WireError {
    code: String,
    message: String,
}

/// Decoded separately from the result so a response carrying `bin` data (the
/// retained terminal tail) can still be read: unknown fields are skipped rather than
/// forced through a JSON value model that has no bytes.
#[derive(Debug, Deserialize)]
struct ResponseEnvelope {
    /// Absent on event frames, which arrive interleaved on the same stream.
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    error: Option<WireError>,
}

#[derive(Debug, Deserialize)]
struct ResponseResult<T> {
    result: Option<T>,
}

struct Core {
    child: Child,
    stdin: ChildStdin,
    incoming: Receiver<Result<Vec<u8>, String>>,
    /// Responses that arrived while a different request was being awaited. Requests
    /// run concurrently in nd-core, so a response can land before the one being
    /// awaited; dropping it would hide a real answer.
    buffered: HashMap<String, Vec<u8>>,
}

impl Core {
    fn launch() -> Self {
        let binary = env!("CARGO_BIN_EXE_nd-core");
        let mut child = Command::new(binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn nd-core");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let (sender, incoming) = channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut header = [0u8; 4];
                if let Err(error) = reader.read_exact(&mut header) {
                    let _ = sender.send(Err(error.to_string()));
                    return;
                }
                let length = u32::from_be_bytes(header) as usize;
                let mut payload = vec![0u8; length];
                if let Err(error) = reader.read_exact(&mut payload) {
                    let _ = sender.send(Err(error.to_string()));
                    return;
                }
                if sender.send(Ok(payload)).is_err() {
                    return;
                }
            }
        });
        Self {
            child,
            stdin,
            incoming,
            buffered: HashMap::new(),
        }
    }

    fn send_raw(
        &mut self,
        id: &str,
        method: &str,
        params: Value,
        deadline_ms: Option<u64>,
    ) -> String {
        let mut frame = serde_json::Map::new();
        frame.insert("version".into(), json!(PROTOCOL_VERSION));
        frame.insert("kind".into(), json!("request"));
        frame.insert("id".into(), json!(id));
        frame.insert("method".into(), json!(method));
        frame.insert("params".into(), params);
        if let Some(deadline_ms) = deadline_ms {
            frame.insert("deadlineMs".into(), json!(deadline_ms));
        }
        let payload = rmp_serde::to_vec_named(&Value::Object(frame)).expect("encode request");
        let mut header = (payload.len() as u32).to_be_bytes().to_vec();
        header.extend_from_slice(&payload);
        self.stdin.write_all(&header).expect("write request");
        self.stdin.flush().expect("flush request");
        id.to_owned()
    }

    fn send(&mut self, method: &str, params: Value) -> String {
        let id = Uuid::new_v4().to_string();
        self.send_raw(&id, method, params, None)
    }

    fn send_with_deadline(&mut self, method: &str, params: Value, deadline_ms: u64) -> String {
        let id = Uuid::new_v4().to_string();
        self.send_raw(&id, method, params, Some(deadline_ms))
    }

    fn next_payload(&mut self, timeout: Duration) -> Vec<u8> {
        self.incoming
            .recv_timeout(timeout)
            .unwrap_or_else(|error| panic!("timed out waiting for a frame: {error}"))
            .unwrap_or_else(|error| panic!("nd-core stream ended: {error}"))
    }

    /// Read until the response for `id` arrives. Responses for other in-flight
    /// requests are buffered rather than dropped, and event frames (which carry no
    /// id) are passed over.
    fn await_response<T: DeserializeOwned>(
        &mut self,
        id: &str,
        timeout: Duration,
    ) -> CoreResult<T> {
        if let Some(payload) = self.buffered.remove(id) {
            return decode_response::<T>(&payload);
        }
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                panic!("no response for request {id} within {timeout:?}");
            }
            let payload = self.next_payload(remaining);
            let envelope: ResponseEnvelope =
                rmp_serde::from_slice(&payload).expect("decode response envelope");
            match envelope.id {
                Some(ref responded) if responded == id => return decode_response::<T>(&payload),
                Some(responded) => {
                    self.buffered.insert(responded, payload);
                }
                None => {}
            }
        }
    }

    fn call<T: DeserializeOwned>(&mut self, method: &str, params: Value) -> CoreResult<T> {
        let id = self.send(method, params);
        self.await_response(&id, Duration::from_secs(60))
    }

    fn health(&mut self) -> Value {
        self.call::<Value>("core.health", json!({}))
            .expect("core.health")
    }
}

fn decode_response<T: DeserializeOwned>(payload: &[u8]) -> CoreResult<T> {
    let envelope: ResponseEnvelope =
        rmp_serde::from_slice(payload).expect("decode response envelope");
    if let Some(error) = envelope.error {
        return Err(CoreError {
            code: error.code,
            message: error.message,
        });
    }
    let with_result: ResponseResult<T> =
        rmp_serde::from_slice(payload).expect("decode response result");
    Ok(with_result.result.expect("response has a result"))
}

impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("nd-core-it-{label}-{}", Uuid::new_v4()));
    fs::create_dir_all(&path).expect("create temp dir");
    path
}

/// A stand-in for the Git executable that stays alive and proves it was alive.
///
/// It appends to a heartbeat file, so a test can tell both that the process really
/// started and that it stopped: a killed child stops appending.
fn heartbeat_executable(heartbeat: &Path) -> (String, Vec<String>) {
    let beat = heartbeat.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        let script = format!(
            "$path = '{beat}'; $i = 0; while ($i -lt 1200) {{ Add-Content -LiteralPath $path -Value $i; $i++; Start-Sleep -Milliseconds 100 }}"
        );
        (
            "powershell".to_owned(),
            vec![
                "-NoProfile".to_owned(),
                "-NonInteractive".to_owned(),
                "-Command".to_owned(),
                script,
            ],
        )
    }
    #[cfg(unix)]
    {
        let script = format!(
            "i=0; while [ $i -lt 1200 ]; do echo $i >> '{beat}'; i=$((i+1)); sleep 0.1; done"
        );
        ("sh".to_owned(), vec!["-c".to_owned(), script])
    }
}

fn heartbeat_lines(path: &Path) -> usize {
    fs::read_to_string(path)
        .map(|text| text.lines().count())
        .unwrap_or(0)
}

fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init_repository(root: &Path) {
    fs::create_dir_all(root).expect("create repository");
    git(root, &["init", "--quiet", "--initial-branch=main"]);
    git(
        root,
        &["config", "user.email", "nd-core-tests@example.test"],
    );
    git(root, &["config", "user.name", "ND Core Tests"]);
    git(root, &["config", "commit.gpgsign", "false"]);
    fs::write(root.join("tracked.txt"), "first\n").expect("write tracked file");
    git(root, &["add", "tracked.txt"]);
    git(root, &["commit", "--quiet", "-m", "initial commit"]);
}

// ---------------------------------------------------------------------------------
// Section 2: core-side deadlines and per-request cancellation
// ---------------------------------------------------------------------------------

/// Read the core's accounting once it has stopped moving.
///
/// A response is written from inside the dispatch job, and that job's registry entry and
/// dispatcher slot are released only when the closure returns — after the response is
/// already on the wire. A client that has just received a response can therefore still
/// see its own request counted as in flight. That is an ordering fact, not a leak, and
/// sampling it once turns the assertion below into a flake on a slow runner. Polling
/// keeps the assertion honest: a slot that really leaked never settles, so it still
/// fails the bound.
fn settled_metrics(core: &mut Core, within: Duration) -> Value {
    let started = Instant::now();
    loop {
        let metrics: Value = core.call("metrics.snapshot", json!({})).expect("metrics");
        let alone = metrics["inFlightRequestCount"] == json!(1)
            && metrics["dispatcher"]["active"] == json!(1);
        if alone || started.elapsed() >= within {
            return metrics;
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn deadline_expiry_stops_git_work_reports_its_code_and_leaves_no_orphan() {
    let fixture = temp_dir("deadline");
    let heartbeat = fixture.join("heartbeat.txt");
    let (program, args) = heartbeat_executable(&heartbeat);
    let mut core = Core::launch();

    // The child needs time to start and prove it is alive before the deadline lands,
    // so the assertion below is about killing a running process, not a late start.
    // That child is PowerShell, and its cold start on a Windows CI runner (image load,
    // AMSI/Defender scan, JIT, plus parallel test load) does not fit in 4 s: a warm
    // start measures ~0.5 s here, and run 35773266896 killed the child before its first
    // heartbeat and failed the precondition below, on the same tree that passed in run
    // 35768282861. The orphan check is what this test is about, and it does not weaken
    // as the deadline grows.
    let deadline_ms = 15_000;
    let id = core.send_with_deadline(
        "git.exec",
        json!({
            "cwd": fixture.to_string_lossy(),
            "args": args.clone(),
            "gitPath": program.clone(),
        }),
        deadline_ms,
    );
    let started = Instant::now();
    let result = core.await_response::<Value>(&id, Duration::from_secs(45));
    let elapsed = started.elapsed();

    let error = result.expect_err("an expired deadline must not report success");
    assert_eq!(
        error.code, "deadline_exceeded",
        "unexpected error: {error:?}"
    );
    assert!(
        elapsed < Duration::from_millis(deadline_ms + 3_000),
        "deadline took {elapsed:?} to stop work"
    );

    // Positive evidence the child ran, then evidence it stopped: a live child appends
    // to this file every 100 ms, so a frozen count means nothing survived the stop.
    let after_stop = heartbeat_lines(&heartbeat);
    assert!(
        after_stop > 0,
        "the interrupted child never started, so this run proves nothing"
    );
    thread::sleep(Duration::from_millis(1_200));
    let still_frozen = heartbeat_lines(&heartbeat);
    assert_eq!(
        after_stop, still_frozen,
        "an interrupted git.exec left an orphaned child appending to {heartbeat:?}"
    );

    // The metrics request is itself in flight while it is counted, so one active
    // slot is this observer; anything above that is a leaked slot.
    let metrics = settled_metrics(&mut core, Duration::from_secs(5));
    assert_eq!(
        metrics["inFlightRequestCount"],
        json!(1),
        "the stopped request kept its slot: {metrics}"
    );
    assert_eq!(
        metrics["dispatcher"]["active"],
        json!(1),
        "the stopped request kept its dispatcher worker: {metrics}"
    );
    let _ = fs::remove_dir_all(&fixture);
}

#[test]
fn cancelling_one_request_leaves_its_peer_running_and_releases_only_its_own_slot() {
    let fixture = temp_dir("cancel");
    let long_heartbeat = fixture.join("long.txt");
    let (program, args) = heartbeat_executable(&long_heartbeat);
    let mut core = Core::launch();

    let doomed = core.send_with_deadline(
        "git.exec",
        json!({ "cwd": fixture.to_string_lossy(), "args": args.clone(), "gitPath": program.clone() }),
        20_000,
    );
    // A peer with a generous deadline that finishes on its own.
    let peer = core.send_with_deadline(
        "git.exec",
        json!({
            "cwd": fixture.to_string_lossy(),
            "args": ["--version"],
        }),
        20_000,
    );
    thread::sleep(Duration::from_millis(500));

    let canceled: Value = core
        .call("core.cancel", json!({ "requestId": doomed }))
        .expect("core.cancel");
    assert_eq!(canceled["canceled"], json!(true));

    let started = Instant::now();
    let error = core
        .await_response::<Value>(&doomed, Duration::from_secs(20))
        .expect_err("a canceled request must not report success");
    assert_eq!(error.code, "canceled", "unexpected error: {error:?}");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "cancellation took {:?}",
        started.elapsed()
    );

    let peer_result: Value = core
        .await_response(&peer, Duration::from_secs(30))
        .expect("cancelling one request must not disturb an unrelated one");
    assert_eq!(peer_result["exitCode"], json!(0));

    // Only this observer is in flight by the time it is counted.
    let metrics = settled_metrics(&mut core, Duration::from_secs(5));
    assert_eq!(metrics["inFlightRequestCount"], json!(1), "{metrics}");
    assert_eq!(metrics["dispatcher"]["active"], json!(1), "{metrics}");
    let _ = fs::remove_dir_all(&fixture);
}

#[test]
fn absurd_deadlines_are_rejected_before_any_work_starts() {
    let fixture = temp_dir("deadline-bounds");
    let heartbeat = fixture.join("heartbeat.txt");
    let (program, args) = heartbeat_executable(&heartbeat);
    let mut core = Core::launch();

    for absurd in [json!(0), json!(10), json!(86_400_000), json!(u64::MAX)] {
        let id = core.send_raw(
            &Uuid::new_v4().to_string(),
            "git.exec",
            json!({
                "cwd": fixture.to_string_lossy(),
                "args": args.clone(),
                "gitPath": program.clone(),
            }),
            absurd.as_u64(),
        );
        let error = core
            .await_response::<Value>(&id, Duration::from_secs(10))
            .expect_err("an absurd deadline must not be accepted");
        assert_eq!(
            error.code, "invalid_params",
            "deadline {absurd} produced {error:?}"
        );
    }
    assert!(
        !heartbeat.exists(),
        "a rejected deadline still started work: {heartbeat:?}"
    );
    let _ = fs::remove_dir_all(&fixture);
}

#[test]
fn a_request_without_a_deadline_still_completes_normally() {
    let fixture = temp_dir("no-deadline");
    init_repository(&fixture);
    let mut core = Core::launch();
    let result: Value = core
        .call(
            "git.exec",
            json!({ "cwd": fixture.to_string_lossy(), "args": ["rev-parse", "--is-inside-work-tree"] }),
        )
        .expect("git.exec without a deadline");
    assert_eq!(result["exitCode"], json!(0));
    assert!(
        result["stdout"]
            .as_str()
            .unwrap_or_default()
            .contains("true")
    );
    let _ = fs::remove_dir_all(&fixture);
}

// ---------------------------------------------------------------------------------
// Section 3: protocol completeness
// ---------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct TerminalState {
    terminal_id: String,
    session_id: String,
    shell: String,
    cwd: String,
    pid: Option<u32>,
    running: bool,
    generation: u64,
    restart_count: u64,
    exit_code: Option<u32>,
    cols: u16,
    rows: u16,
    seq: u64,
    first_retained_seq: u64,
    dropped_through_seq: u64,
    retained_bytes: usize,
    tail_truncated: bool,
    #[serde(with = "serde_bytes")]
    bytes: serde_bytes::ByteBuf,
}

fn shell_for_terminal() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        ("cmd.exe".to_owned(), vec!["/Q".to_owned()])
    }
    #[cfg(unix)]
    {
        ("/bin/sh".to_owned(), Vec::new())
    }
}

#[test]
fn terminal_restart_preserves_identity_and_never_reports_the_previous_shell_running() {
    let fixture = temp_dir("terminal-restart");
    let mut core = Core::launch();
    let (shell, args) = shell_for_terminal();
    let session = Uuid::new_v4().to_string();
    let terminal_id = Uuid::new_v4().to_string();

    let created: Value = core
        .call(
            "terminal.create",
            json!({
                "terminalId": terminal_id,
                "sessionId": session,
                "shell": shell,
                "args": args,
                "cwd": fixture.to_string_lossy(),
                "cols": 80,
                "rows": 24,
            }),
        )
        .expect("terminal.create");
    assert_eq!(created["terminalId"], json!(terminal_id));
    assert_eq!(created["generation"], json!(0));
    let first_pid = created["pid"].as_u64();

    let before: TerminalState = core
        .call("terminal.state", json!({ "terminalId": terminal_id }))
        .expect("terminal.state");
    assert!(before.running);
    assert_eq!(before.generation, 0);
    assert_eq!(before.restart_count, 0);
    assert_eq!(before.terminal_id, terminal_id);
    assert_eq!(before.pid.map(u64::from), first_pid);

    let restarted: Value = core
        .call(
            "terminal.restart",
            json!({ "terminalId": terminal_id, "cols": 100, "rows": 30 }),
        )
        .expect("terminal.restart");
    assert_eq!(
        restarted["terminalId"],
        json!(terminal_id),
        "a restart must preserve terminal identity"
    );
    assert_eq!(restarted["generation"], json!(1));
    assert_eq!(restarted["restarted"], json!(true));

    let after: TerminalState = core
        .call("terminal.state", json!({ "terminalId": terminal_id }))
        .expect("terminal.state after restart");
    assert_eq!(after.terminal_id, terminal_id);
    assert_eq!(after.generation, 1);
    assert_eq!(after.restart_count, 1);
    assert!(after.running, "the restarted shell must be running");
    assert_eq!(after.pid.map(u64::from), restarted["pid"].as_u64());
    assert_eq!(after.cols, 100);
    assert_eq!(after.rows, 30);
    assert_eq!(
        after.exit_code, None,
        "a running shell must not report an exit code"
    );
    if first_pid.is_some() {
        assert_ne!(
            after.pid.map(u64::from),
            first_pid,
            "the state still describes the replaced shell"
        );
    }

    let closed: Value = core
        .call("terminal.close", json!({ "terminalId": terminal_id }))
        .expect("terminal.close");
    assert_eq!(closed["closed"], json!(true));

    let missing = core
        .call::<Value>("terminal.state", json!({ "terminalId": terminal_id }))
        .expect_err("a closed terminal must not report state");
    assert_eq!(missing.code, "not_found");
    let _ = fs::remove_dir_all(&fixture);
}

#[test]
fn terminal_state_carries_the_sequence_a_client_needs_to_recover_from_missed_events() {
    let fixture = temp_dir("terminal-state");
    let mut core = Core::launch();
    let (shell, args) = shell_for_terminal();
    let terminal_id = Uuid::new_v4().to_string();
    core.call::<Value>(
        "terminal.create",
        json!({
            "terminalId": terminal_id,
            "sessionId": Uuid::new_v4().to_string(),
            "shell": shell,
            "args": args,
            "cwd": fixture.to_string_lossy(),
            "cols": 80,
            "rows": 24,
        }),
    )
    .expect("terminal.create");

    let state: TerminalState = core
        .call("terminal.state", json!({ "terminalId": terminal_id }))
        .expect("terminal.state");
    assert!(state.running);
    assert_eq!(state.dropped_through_seq, 0);
    assert!(!state.tail_truncated);
    assert!(state.seq == 0 || state.first_retained_seq > 0);
    assert_eq!(state.retained_bytes, state.bytes.len());
    assert!(state.bytes.len() <= 256 * 1024);
    let _ = core.call::<Value>("terminal.close", json!({ "terminalId": terminal_id }));
    let _ = fs::remove_dir_all(&fixture);
}

#[test]
fn process_cancel_stops_a_managed_process_and_reports_nothing_afterward() {
    let fixture = temp_dir("process-cancel");
    let mut core = Core::launch();
    let (program, args) = heartbeat_executable(&fixture.join("process.txt"));
    let spawned: Value = core
        .call(
            "process.spawn",
            json!({
                "id": "managed-1",
                "command": program,
                "args": args,
                "cwd": fixture.to_string_lossy(),
            }),
        )
        .expect("process.spawn");

    let canceled: Value = core
        .call("process.cancel", json!({ "processId": "managed-1" }))
        .expect("process.cancel");
    assert_eq!(canceled["canceled"], json!(true));

    // The registry entry is removed by the wait thread once it observes the exit, so
    // this polls instead of assuming the removal already happened.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot: Value = core
            .call("process.snapshot", json!({}))
            .expect("process.snapshot");
        let listed = snapshot
            .as_array()
            .expect("snapshot is a list")
            .iter()
            .any(|item| item["processId"] == json!("managed-1"));
        if !listed {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "a canceled process is still in the registry: {snapshot}"
        );
        thread::sleep(Duration::from_millis(50));
    }
    // The heartbeat file proves the child existed; it must now be frozen.
    let after_stop = heartbeat_lines(&fixture.join("process.txt"));
    thread::sleep(Duration::from_millis(600));
    assert_eq!(after_stop, heartbeat_lines(&fixture.join("process.txt")));
    assert!(
        spawned["pid"].as_u64().is_some(),
        "process.spawn returned no pid"
    );
    let _ = fs::remove_dir_all(&fixture);
}

// ---------------------------------------------------------------------------------
// Section 1: the workspace primitive decision
// ---------------------------------------------------------------------------------

#[test]
fn workspace_primitives_are_bounded_reject_escapes_and_are_the_only_ones_exposed() {
    let fixture = temp_dir("workspace-primitives");
    for index in 0..5 {
        fs::write(fixture.join(format!("file-{index}.txt")), "0123456789").expect("write file");
    }
    fs::create_dir_all(fixture.join("nested")).expect("create nested dir");
    fs::write(fixture.join("nested").join("large.txt"), "x".repeat(4096)).expect("write large");
    let mut core = Core::launch();
    let root = fixture.to_string_lossy().to_string();

    let listing: Value = core
        .call(
            "workspace.list",
            json!({ "root": root, "path": ".", "maxEntries": 2 }),
        )
        .expect("workspace.list");
    assert_eq!(listing["truncated"], json!(true));
    assert_eq!(listing["maxEntries"], json!(2));
    assert_eq!(listing["entries"].as_array().map(Vec::len), Some(2));
    assert_eq!(listing["path"], json!("."));

    let complete: Value = core
        .call("workspace.list", json!({ "root": root, "path": "." }))
        .expect("workspace.list complete");
    assert_eq!(complete["truncated"], json!(false));
    let paths = complete["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .map(|entry| entry["path"].as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    assert!(paths.contains(&"nested".to_owned()));
    assert!(paths.contains(&"file-0.txt".to_owned()));

    let capped: Value = core
        .call(
            "workspace.read",
            json!({ "root": root, "path": "nested/large.txt", "maxBytes": 16 }),
        )
        .expect("workspace.read");
    assert_eq!(capped["truncated"], json!(true));
    assert_eq!(capped["size"], json!(16));
    assert_eq!(capped["maxBytes"], json!(16));
    assert_eq!(capped["byteSize"], json!(4096));

    let escape = core
        .call::<Value>(
            "workspace.read",
            json!({ "root": root, "path": "../outside.txt" }),
        )
        .expect_err("a parent-escape read must be rejected");
    assert!(escape.message.contains("escapes the root"), "{escape:?}");
    let absolute = core
        .call::<Value>(
            "workspace.list",
            json!({ "root": root, "path": "C:/Windows" }),
        )
        .expect_err("an absolute path must be rejected");
    assert!(absolute.message.contains("relative"), "{absolute:?}");

    // The decision: `list` and `read` are the product's workspace layer. The other
    // three single-operation RPCs are gone from the protocol rather than kept alive
    // with a caller that exists only to justify them.
    for removed in [
        "workspace.realpath",
        "workspace.stat",
        "workspace.atomicWrite",
    ] {
        let error = core
            .call::<Value>(removed, json!({ "root": root, "path": "." }))
            .expect_err("a removed method must not answer");
        assert_eq!(
            error.code, "method_failed",
            "{removed} still exists: {error:?}"
        );
        assert!(
            error.message.contains("unknown nd-core method"),
            "{error:?}"
        );
    }
    let _ = fs::remove_dir_all(&fixture);
}

// ---------------------------------------------------------------------------------
// Section 4: revision markers and the revision-keyed cache
// ---------------------------------------------------------------------------------

#[test]
fn git_status_and_log_are_cached_against_a_revision_and_never_serve_stale_state() {
    if !git_available() {
        eprintln!("skipping: git is not available in this environment");
        return;
    }
    let fixture = temp_dir("git-cache");
    init_repository(&fixture);
    fs::write(fixture.join("untracked.txt"), "new\n").expect("write untracked");
    let mut core = Core::launch();
    let cwd = fixture.to_string_lossy().to_string();

    let first: Value = core
        .call("git.status", json!({ "cwd": cwd }))
        .expect("git.status");
    assert_eq!(first["cached"], json!(false));
    let revision_one = first["revision"].as_str().expect("revision").to_owned();
    assert!(!revision_one.is_empty());

    let second: Value = core
        .call("git.status", json!({ "cwd": cwd }))
        .expect("git.status again");
    assert_eq!(
        second["cached"],
        json!(true),
        "an unchanged repository must be served from the cache"
    );
    assert_eq!(second["revision"], json!(revision_one));

    // Mutate from outside nd-core, exactly as a user's editor or another tool would.
    fs::write(fixture.join("brand-new-file.txt"), "external\n").expect("external write");
    let third: Value = core
        .call("git.status", json!({ "cwd": cwd }))
        .expect("git.status after external mutation");
    assert_eq!(
        third["cached"],
        json!(false),
        "an external mutation must not serve the previous result"
    );
    assert_ne!(third["revision"], json!(revision_one));
    let paths = third["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .map(|entry| entry["path"].as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    assert!(
        paths.contains(&"brand-new-file.txt".to_owned()),
        "the cached read missed an externally created file: {paths:?}"
    );

    let log_first: Value = core
        .call("git.log", json!({ "cwd": cwd, "limit": 8 }))
        .expect("git.log");
    assert_eq!(log_first["cached"], json!(false));
    let log_second: Value = core
        .call("git.log", json!({ "cwd": cwd, "limit": 8 }))
        .expect("git.log again");
    assert_eq!(log_second["cached"], json!(true));
    assert_eq!(
        log_second["commits"].as_array().map(Vec::len),
        Some(1),
        "history must survive the cache"
    );

    let metrics: Value = core.call("metrics.snapshot", json!({})).expect("metrics");
    let cache = &metrics["cache"];
    assert!(
        cache["hits"].as_u64().unwrap_or_default() >= 2,
        "cache hits were not reported: {cache}"
    );
    assert!(
        cache["misses"].as_u64().unwrap_or_default() >= 3,
        "cache misses were not reported: {cache}"
    );
    assert!(
        cache["inserts"].as_u64().unwrap_or_default() >= 3,
        "cache inserts were not reported: {cache}"
    );
    assert!(
        cache["entries"].as_u64().unwrap_or_default() >= 1,
        "{cache}"
    );
    assert!(cache["maxEntries"].as_u64().unwrap_or_default() > 0);
    assert!(cache["maxBytes"].as_u64().unwrap_or_default() > 0);
    let _ = fs::remove_dir_all(&fixture);
}

#[test]
fn a_revision_marker_changes_with_the_described_state_and_holds_when_it_does_not() {
    let fixture = temp_dir("revision-marker");
    fs::write(fixture.join("file.txt"), "first\n").expect("write");
    let mut core = Core::launch();
    let root = fixture.to_string_lossy().to_string();

    let before: Value = core
        .call("workspace.revision", json!({ "root": root }))
        .expect("workspace.revision");
    assert!(before["value"].as_str().unwrap_or_default().len() >= 32);
    assert_eq!(before["scope"], json!("worktree"));
    assert_eq!(before["truncated"], json!(false));

    let unchanged: Value = core
        .call("workspace.revision", json!({ "root": root }))
        .expect("workspace.revision again");
    assert_eq!(unchanged["value"], before["value"]);

    fs::write(fixture.join("file.txt"), "second version, longer\n").expect("rewrite");
    let changed: Value = core
        .call("workspace.revision", json!({ "root": root }))
        .expect("workspace.revision after change");
    assert_ne!(changed["value"], before["value"]);

    let refs: Value = core
        .call(
            "workspace.revision",
            json!({ "root": root, "scope": "gitRefs" }),
        )
        .expect("workspace.revision gitRefs");
    assert_eq!(refs["scope"], json!("gitRefs"));
    assert_ne!(refs["value"], changed["value"]);

    let unknown = core
        .call::<Value>(
            "workspace.revision",
            json!({ "root": root, "scope": "everything" }),
        )
        .expect_err("an unknown scope must not silently default");
    assert_eq!(unknown.code, "invalid_params");
    let _ = fs::remove_dir_all(&fixture);
}

// ---------------------------------------------------------------------------------
// Section 5: bounded content search
// ---------------------------------------------------------------------------------

#[test]
fn workspace_search_is_bounded_ignore_aware_and_explicit_about_truncation() {
    let fixture = temp_dir("search");
    fs::create_dir_all(fixture.join("src")).expect("create src");
    fs::write(
        fixture.join("src").join("app.ts"),
        "const needle = 1\nconst other = 2\n",
    )
    .expect("write");
    fs::write(fixture.join(".gitignore"), "ignored-dir/\n").expect("write ignore");
    fs::create_dir_all(fixture.join("ignored-dir")).expect("create ignored dir");
    fs::write(
        fixture.join("ignored-dir").join("hidden.ts"),
        "needle in ignored\n",
    )
    .expect("write");
    fs::write(fixture.join("binary.bin"), b"\x00needle\x00").expect("write binary");
    for index in 0..25 {
        fs::write(
            fixture.join(format!("bulk-{index:02}.txt")),
            "needle in a bulk file\n".repeat(4),
        )
        .expect("write bulk");
    }
    let mut core = Core::launch();
    let root = fixture.to_string_lossy().to_string();

    let complete: Value = core
        .call(
            "workspace.search",
            json!({ "root": root, "query": "needle" }),
        )
        .expect("workspace.search");
    assert_eq!(complete["truncated"], json!(false));
    assert_eq!(complete["stopReason"], Value::Null);
    assert_eq!(complete["caseSensitive"], json!(false));
    assert_eq!(complete["includeHidden"], json!(false));
    assert!(
        complete["skippedBinaryFiles"].as_u64().unwrap_or_default() >= 1,
        "the binary file was not skipped and reported: {complete}"
    );
    let matched = complete["matches"]
        .as_array()
        .expect("matches")
        .iter()
        .map(|item| item["path"].as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    assert!(matched.contains(&"src/app.ts".to_owned()));
    assert!(!matched.iter().any(|path| path.starts_with("ignored-dir/")));
    let first = complete["matches"]
        .as_array()
        .expect("matches")
        .iter()
        .find(|item| item["path"] == json!("src/app.ts"))
        .expect("match in src/app.ts");
    assert_eq!(first["line"], json!(1));
    assert_eq!(first["column"], json!(7));
    assert!(
        first["preview"]
            .as_str()
            .unwrap_or_default()
            .contains("needle")
    );

    let capped: Value = core
        .call(
            "workspace.search",
            json!({ "root": root, "query": "needle", "maxResults": 3 }),
        )
        .expect("workspace.search capped");
    assert_eq!(capped["truncated"], json!(true));
    assert_eq!(capped["stopReason"], json!("resultLimit"));
    assert_eq!(capped["matches"].as_array().map(Vec::len), Some(3));

    let regex: Value = core
        .call(
            "workspace.search",
            json!({ "root": root, "query": "ne+dle", "regex": true }),
        )
        .expect("workspace.search regex");
    assert_eq!(regex["regex"], json!(true));
    assert!(!regex["matches"].as_array().expect("matches").is_empty());

    let broken = core
        .call::<Value>(
            "workspace.search",
            json!({ "root": root, "query": "(unclosed", "regex": true }),
        )
        .expect_err("an invalid pattern must be rejected");
    assert_eq!(broken.code, "invalid_params");

    let escape = core
        .call::<Value>(
            "workspace.search",
            json!({ "root": root, "query": "needle", "path": "../" }),
        )
        .expect_err("search must not escape the workspace root");
    assert!(escape.message.contains("escapes the root"), "{escape:?}");
    let _ = fs::remove_dir_all(&fixture);
}

#[test]
fn a_search_deadline_stops_the_scan_without_failing_the_request() {
    let fixture = temp_dir("search-deadline");
    for index in 0..400 {
        fs::write(
            fixture.join(format!("bulk-{index:03}.txt")),
            "needle in a bulk file\n".repeat(20),
        )
        .expect("write bulk");
    }
    let mut core = Core::launch();
    let id = core.send_with_deadline(
        "workspace.search",
        json!({
            "root": fixture.to_string_lossy(),
            "query": "needle",
            "maxResults": 5000,
        }),
        100,
    );
    let started = Instant::now();
    let result: Value = core
        .await_response(&id, Duration::from_secs(30))
        .expect("a stopped search still answers with what it found");
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(20),
        "search deadline took {elapsed:?}"
    );
    if result["truncated"] == json!(true) {
        assert!(
            result["stopReason"] == json!("deadlineExceeded")
                || result["stopReason"] == json!("resultLimit"),
            "unexpected stop reason: {}",
            result["stopReason"]
        );
    }
    let _ = fs::remove_dir_all(&fixture);
}

#[test]
fn workspace_snapshot_composes_reads_search_and_git_and_detects_stale_revisions() {
    if !git_available() {
        eprintln!("skipping: git is not available in this environment");
        return;
    }
    let fixture = temp_dir("workspace-snapshot");
    fs::create_dir_all(fixture.join("src")).expect("create src");
    fs::write(
        fixture.join("src").join("app.ts"),
        "export const needle = 1\n",
    )
    .expect("write app");
    git(&fixture, &["init"]);
    git(&fixture, &["config", "user.email", "snapshot@nd.local"]);
    git(&fixture, &["config", "user.name", "ND Snapshot"]);
    git(&fixture, &["add", "."]);
    git(&fixture, &["commit", "-m", "baseline"]);

    let mut core = Core::launch();
    let root = fixture.to_string_lossy().to_string();
    let first: Value = core
        .call(
            "workspace.snapshot",
            json!({
                "root": root,
                "reads": [{ "path": "src/app.ts", "maxBytes": 4096 }],
                "searches": [{ "query": "needle", "path": "src", "maxResults": 20 }],
                "includeGitStatus": true,
            }),
        )
        .expect("workspace.snapshot");
    assert_eq!(first["stale"], json!(false));
    assert_eq!(first["truncated"], json!(false));
    assert!(
        first["reads"][0]["data"]
            .as_str()
            .unwrap_or_default()
            .contains("needle")
    );
    assert_eq!(
        first["searches"][0]["matches"][0]["path"],
        json!("src/app.ts")
    );
    assert!(first["gitStatus"]["entries"].as_array().is_some());
    let revision = first["revision"]["value"]
        .as_str()
        .expect("revision")
        .to_owned();

    fs::write(
        fixture.join("src").join("app.ts"),
        "export const needle = 12345\nexport const changed = true\n",
    )
    .expect("mutate app");
    let stale: Value = core
        .call(
            "workspace.snapshot",
            json!({
                "root": root,
                "expectedRevision": revision,
                "reads": [{ "path": "src/app.ts" }],
                "searches": [{ "query": "needle" }],
                "includeGitStatus": true,
            }),
        )
        .expect("stale workspace.snapshot");
    assert_eq!(stale["stale"], json!(true));
    assert!(stale["reads"].as_array().expect("reads").is_empty());
    assert!(stale["searches"].as_array().expect("searches").is_empty());
    assert_eq!(stale["gitStatus"], Value::Null);

    let too_many = (0..13)
        .map(|_| json!({ "path": "src/app.ts" }))
        .collect::<Vec<_>>();
    let oversized = core
        .call::<Value>(
            "workspace.snapshot",
            json!({ "root": root, "reads": too_many }),
        )
        .expect_err("oversized snapshot request must fail predictably");
    assert_eq!(oversized.code, "invalid_params");
    let _ = fs::remove_dir_all(&fixture);
}

#[test]
fn workspace_fingerprint_artifacts_pins_the_recorded_layout() {
    let fixture = temp_dir("fingerprint");
    fs::write(fixture.join("research.md"), "hello").expect("write research");
    fs::create_dir_all(fixture.join("design").join("sub")).expect("create design");
    fs::write(fixture.join("design").join("a.txt"), "A").expect("write a");
    fs::write(fixture.join("design").join("sub").join("b.txt"), "B").expect("write b");
    let mut core = Core::launch();
    let root = fixture.to_string_lossy().to_string();

    let complete: Value = core
        .call(
            "workspace.fingerprint-artifacts",
            json!({ "root": root, "paths": ["research.md", "design"] }),
        )
        .expect("workspace.fingerprint-artifacts");
    let artifacts = complete["artifacts"].as_array().expect("artifacts");
    assert_eq!(artifacts.len(), 2);
    assert_eq!(artifacts[0]["path"], json!("research.md"));
    assert_eq!(artifacts[0]["kind"], json!("file"));
    assert_eq!(artifacts[0]["size"], json!(5));
    assert_eq!(
        artifacts[0]["sha256"],
        json!("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
    );
    assert_eq!(artifacts[1]["path"], json!("design"));
    assert_eq!(artifacts[1]["kind"], json!("directory"));
    assert_eq!(artifacts[1]["size"], json!(2));
    let mut expected = Sha256::new();
    expected.update(b"design/a.txt\0");
    expected.update(b"A");
    expected.update(b"design/sub\0");
    expected.update(b"design/sub/b.txt\0");
    expected.update(b"B");
    let expected: String = expected
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(artifacts[1]["sha256"], json!(expected));

    let escaped = core
        .call::<Value>(
            "workspace.fingerprint-artifacts",
            json!({ "root": root, "paths": ["../outside.md"] }),
        )
        .expect_err("an escaping path must be refused");
    assert_eq!(escaped.code, "method_failed");
    assert!(escaped.message.contains("escapes the root"), "{escaped:?}");
    let empty = core
        .call::<Value>(
            "workspace.fingerprint-artifacts",
            json!({ "root": root, "paths": [] }),
        )
        .expect_err("an empty path list must be refused");
    assert_eq!(empty.code, "invalid_params");
    let _ = fs::remove_dir_all(&fixture);
}

/// A real encoded PNG, so the contract tests exercise the sidecar's decoder
/// rather than a stub standing in for it.
fn write_png_fixture(path: &Path, width: u32, height: u32) {
    let buffer = image::ImageBuffer::from_fn(width, height, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 96u8])
    });
    buffer.save(path).expect("write png fixture");
}

#[test]
fn media_thumbnails_returns_decodable_jpeg_over_the_wire() {
    let fixture = temp_dir("media-thumbnails");
    let library = fixture.join("library");
    fs::create_dir_all(&library).expect("create library");
    write_png_fixture(&library.join("wide.png"), 640, 320);
    fs::write(library.join("corrupt.png"), b"this is not an image").expect("write corrupt");
    // A sibling tree the root has no business reaching into.
    let external = temp_dir("media-thumbnails-external");
    write_png_fixture(&external.join("secret.png"), 32, 32);

    let mut core = Core::launch();
    let root = fixture.to_string_lossy().to_string();

    let result: Value = core
        .call(
            "media.thumbnails",
            json!({ "root": root, "paths": ["library/wide.png"], "width": 160, "quality": 70 }),
        )
        .expect("media.thumbnails");

    assert!(!result["truncated"].as_bool().expect("truncated"));
    assert!(
        result["failures"].as_array().expect("failures").is_empty(),
        "unexpected failures: {result}"
    );
    let thumbnails = result["thumbnails"].as_array().expect("thumbnails");
    assert_eq!(thumbnails.len(), 1);
    let thumb = &thumbnails[0];
    assert_eq!(thumb["path"], json!("library/wide.png"));
    assert_eq!(thumb["format"], json!("jpeg"));
    assert_eq!(thumb["width"], json!(160));
    // 640x320 at width 160 keeps its 2:1 aspect ratio.
    assert_eq!(thumb["height"], json!(80));
    assert_eq!(thumb["sourceWidth"], json!(640));
    assert_eq!(thumb["sourceHeight"], json!(320));

    // The payload is base64 text (not a byte array) and really is a JPEG of the
    // promised dimensions — that is the whole contract the desktop relies on.
    let data = thumb["data"].as_str().expect("data must be a string");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .expect("payload must be base64");
    assert_eq!(
        bytes.len(),
        thumb["byteSize"].as_u64().expect("byteSize") as usize
    );
    let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg)
        .expect("payload must be decodable jpeg");
    assert_eq!(decoded.width(), 160);
    assert_eq!(decoded.height(), 80);

    // A corrupt sibling fails on its own and does not take the batch with it.
    let partial: Value = core
        .call(
            "media.thumbnails",
            json!({ "root": root, "paths": ["library/wide.png", "library/corrupt.png"] }),
        )
        .expect("partial batch");
    assert_eq!(partial["thumbnails"].as_array().expect("ok").len(), 1);
    let failures = partial["failures"].as_array().expect("failures");
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0]["path"], json!("library/corrupt.png"));

    // Confinement is enforced on the wire, not just inside the module. Both a
    // traversal and an absolute path to a file that genuinely exists must be
    // refused before it is opened.
    let traversed = core
        .call::<Value>(
            "media.thumbnails",
            json!({ "root": root, "paths": ["../secret.png"] }),
        )
        .expect_err("parent traversal must be refused");
    assert!(
        traversed.message.contains("escapes the root"),
        "unexpected message: {traversed:?}"
    );
    let absolute = core
        .call::<Value>(
            "media.thumbnails",
            json!({ "root": root, "paths": [external.join("secret.png").to_string_lossy()] }),
        )
        .expect_err("an absolute path must be refused even when the file exists");
    assert_eq!(absolute.code, "method_failed");
    // The root itself is not a readable image library entry.
    let nested_escape = core
        .call::<Value>(
            "media.thumbnails",
            json!({ "root": library.to_string_lossy(), "paths": ["../library/wide.png"] }),
        )
        .expect_err("a nested traversal must be refused");
    assert_eq!(nested_escape.code, "method_failed");

    let _ = fs::remove_dir_all(&fixture);
    let _ = fs::remove_dir_all(&external);
}

#[test]
fn media_thumbnails_leaves_the_workspace_metric_alone() {
    // A media root is a wallpaper library, not a linked workspace. Counting it
    // as one would make the desktop's workspace gauge lie.
    let fixture = temp_dir("media-metrics");
    write_png_fixture(&fixture.join("a.png"), 32, 32);
    let mut core = Core::launch();
    let before = core.health()["workspaceCount"]
        .as_u64()
        .expect("workspaceCount");
    let _: Value = core
        .call(
            "media.thumbnails",
            json!({ "root": fixture.to_string_lossy(), "paths": ["a.png"] }),
        )
        .expect("media.thumbnails");
    let after = core.health()["workspaceCount"]
        .as_u64()
        .expect("workspaceCount");
    assert_eq!(
        before, after,
        "a media root must not be counted as a workspace"
    );
    let _ = fs::remove_dir_all(&fixture);
}

#[test]
fn media_set_wallpaper_refuses_paths_it_must_not_touch() {
    // Only the rejection paths are exercised: the success path changes the
    // developer's real desktop, which a test run must never do.
    let fixture = temp_dir("media-wallpaper");
    write_png_fixture(&fixture.join("ok.png"), 32, 32);
    fs::write(fixture.join("notes.txt"), b"not an image").expect("write notes");
    let mut core = Core::launch();

    for (label, path) in [
        ("relative", "ok.png".to_owned()),
        ("blank", "   ".to_owned()),
        (
            "unsupported extension",
            fixture.join("notes.txt").to_string_lossy().into_owned(),
        ),
        (
            "missing file",
            fixture.join("absent.png").to_string_lossy().into_owned(),
        ),
        ("directory", fixture.to_string_lossy().into_owned()),
    ] {
        let error = match core.call::<Value>("media.set-wallpaper", json!({ "path": path })) {
            Ok(value) => panic!("{label} must be refused, got {value}"),
            Err(error) => error,
        };
        assert_eq!(error.code, "method_failed", "{label}: {error:?}");
    }

    let _ = fs::remove_dir_all(&fixture);
}

#[test]
fn every_declared_capability_is_reachable_and_unknown_methods_are_refused() {
    let mut core = Core::launch();
    let health = core.health();
    let capabilities = health["capabilities"]
        .as_array()
        .expect("capabilities")
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    for capability in [
        "scheduler",
        "process",
        "terminal",
        "git",
        "workspace",
        "media",
        "search",
        "revision",
        "cache",
        "deadline",
        "cancellation",
        "metrics",
    ] {
        assert!(
            capabilities.contains(&capability),
            "capability {capability} is not declared: {capabilities:?}"
        );
    }
    let error = core
        .call::<Value>("process.kill", json!({ "processId": "none" }))
        .expect_err("an unknown method must be refused");
    assert_eq!(error.code, "method_failed");
}

#[test]
fn health_reports_the_shape_the_desktop_handshake_depends_on() {
    let mut core = Core::launch();
    let health = core.health();
    assert_eq!(health["protocolVersion"], json!(PROTOCOL_VERSION));
    for field in [
        "binaryVersion",
        "platform",
        "arch",
        "processCount",
        "terminalCount",
        "workspaceCount",
        "pendingRpcCount",
    ] {
        assert!(
            health.get(field).is_some(),
            "core.health is missing {field}"
        );
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct TypedHealth {
    protocol_version: u16,
    binary_version: String,
    platform: String,
    arch: String,
    capabilities: Vec<String>,
    process_count: usize,
    terminal_count: usize,
    workspace_count: usize,
    pending_rpc_count: usize,
}

#[test]
fn health_deserializes_into_the_desktop_contract_type() {
    let mut core = Core::launch();
    let typed: TypedHealth = core.call("core.health", json!({})).expect("core.health");
    assert_eq!(typed.protocol_version, PROTOCOL_VERSION);
    assert!(!typed.binary_version.is_empty());
    assert!(!typed.capabilities.is_empty());
}

#[test]
fn scheduler_permits_are_shared_state_the_capability_list_still_promises() {
    let mut core = Core::launch();
    let acquired: Value = core
        .call(
            "scheduler.acquire",
            json!({
                "permitId": "contract-permit",
                "sessionId": "contract-session",
                "kind": "execution",
                "pools": [{ "key": "contract", "limit": 1 }],
            }),
        )
        .expect("scheduler.acquire");
    assert_eq!(acquired["granted"], json!(true));
    let snapshot: Value = core
        .call("scheduler.snapshot", json!({}))
        .expect("scheduler.snapshot");
    let permits: HashMap<String, Value> = snapshot["permits"]
        .as_array()
        .expect("permits")
        .iter()
        .map(|permit| {
            (
                permit["id"].as_str().unwrap_or_default().to_owned(),
                permit.clone(),
            )
        })
        .collect();
    assert!(permits.contains_key("contract-permit"));
    let released: Value = core
        .call(
            "scheduler.release",
            json!({ "permitId": "contract-permit" }),
        )
        .expect("scheduler.release");
    assert_eq!(released["released"], json!(true));
}
