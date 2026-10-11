use crate::cache::{self, ResponseCache};
use crate::deadline::Interrupt;
use crate::errors::coded;
use crate::process::{filtered_environment, kill_process_tree};
use crate::revision::RevisionScope;
use crate::scheduler::now_ms;
#[cfg(windows)]
use crate::windows_job::WindowsJob;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::thread::{self, JoinHandle};

const DEFAULT_MAX_OUTPUT: usize = 24 * 1024 * 1024;

/// Held for the lifetime of one Git request. On Windows that is the Job Object whose
/// close ends the tree; elsewhere the process group set at spawn is enough.
#[cfg(windows)]
type JobHandle = Option<WindowsJob>;
#[cfg(not(windows))]
type JobHandle = ();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitExecParams {
    pub cwd: String,
    pub args: Vec<String>,
    pub input: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub max_output_bytes: Option<usize>,
    pub git_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitQueryParams {
    pub cwd: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub git_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogParams {
    pub cwd: String,
    pub limit: usize,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub git_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub x: String,
    pub y: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rename: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub exit_code: i32,
    pub stderr: String,
    pub duration_ms: u64,
    pub truncated: bool,
    pub entries: Vec<GitStatusEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub hash: String,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub author_timestamp: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogResult {
    pub exit_code: i32,
    pub stderr: String,
    pub duration_ms: u64,
    pub truncated: bool,
    pub commits: Vec<GitLogEntry>,
}

/// `git status` reports on the working tree and the index, so its cache marker is the
/// worktree fingerprint; `git log` depends only on refs, so its marker is the much
/// cheaper Git-metadata one.
pub fn cached_status(
    params: GitQueryParams,
    interrupt: &Interrupt,
    cache: &ResponseCache,
) -> Result<Value> {
    let cwd = params.cwd.clone();
    let revision = crate::revision::workspace_revision(&cwd, RevisionScope::Worktree, interrupt)?;
    let key = format!("git.status:{cwd}");
    if revision.safe_for_cache()
        && let Some(hit) = cache.get(&key, &revision.value)
    {
        return Ok(hit);
    }
    let result = status(params, interrupt)?;
    let mut value = serde_json::to_value(&result).context("encode git.status result")?;
    cache::annotate(&mut value, &revision.value, false);
    if revision.safe_for_cache() {
        cache.put(&key, &revision.value, &value);
    }
    Ok(value)
}

pub fn cached_log(
    params: GitLogParams,
    interrupt: &Interrupt,
    cache: &ResponseCache,
) -> Result<Value> {
    let cwd = params.cwd.clone();
    let revision = crate::revision::workspace_revision(&cwd, RevisionScope::GitRefs, interrupt)?;
    let key = format!("git.log:{cwd}:{}", params.limit);
    if revision.safe_for_cache()
        && let Some(hit) = cache.get(&key, &revision.value)
    {
        return Ok(hit);
    }
    let result = log(params, interrupt)?;
    let mut value = serde_json::to_value(&result).context("encode git.log result")?;
    cache::annotate(&mut value, &revision.value, false);
    if revision.safe_for_cache() {
        cache.put(&key, &revision.value, &value);
    }
    Ok(value)
}

pub fn status(params: GitQueryParams, interrupt: &Interrupt) -> Result<GitStatusResult> {
    let started_at = now_ms();
    let result = exec(
        GitExecParams {
            cwd: params.cwd,
            args: vec!["status".into(), "-z".into(), "-uall".into()],
            input: None,
            env: params.env,
            max_output_bytes: Some(DEFAULT_MAX_OUTPUT),
            git_path: params.git_path,
        },
        interrupt,
    )?;
    let entries = if result.exit_code == 0 && !result.truncated {
        parse_status(&result.stdout)?
    } else {
        Vec::new()
    };
    Ok(GitStatusResult {
        exit_code: result.exit_code,
        stderr: result.stderr,
        duration_ms: now_ms().saturating_sub(started_at),
        truncated: result.truncated,
        entries,
    })
}

pub fn log(params: GitLogParams, interrupt: &Interrupt) -> Result<GitLogResult> {
    let started_at = now_ms();
    let limit = params.limit.clamp(1, 1000);
    let result = exec(
        GitExecParams {
            cwd: params.cwd,
            args: vec![
                "log".into(),
                format!("-n{limit}"),
                "--format=%H%x00%aN%x00%aE%x00%at%x00%B%x00".into(),
            ],
            input: None,
            env: params.env,
            max_output_bytes: Some(DEFAULT_MAX_OUTPUT),
            git_path: params.git_path,
        },
        interrupt,
    )?;
    let commits = if result.exit_code == 0 && !result.truncated {
        parse_log(&result.stdout)?
    } else {
        Vec::new()
    };
    Ok(GitLogResult {
        exit_code: result.exit_code,
        stderr: result.stderr,
        duration_ms: now_ms().saturating_sub(started_at),
        truncated: result.truncated,
        commits,
    })
}

fn parse_status(raw: &str) -> Result<Vec<GitStatusEntry>> {
    let fields = raw.split('\0').collect::<Vec<_>>();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let field = fields[index];
        if field.is_empty() {
            index += 1;
            continue;
        }
        if field.len() < 3 || field.as_bytes()[2] != b' ' {
            bail!("malformed Git porcelain status entry");
        }
        let x = field[0..1].to_owned();
        let y = field[1..2].to_owned();
        let first_path = field[3..].to_owned();
        let renamed = x == "R" || y == "R" || x == "C";
        let (path, rename) = if renamed {
            let original = fields
                .get(index + 1)
                .ok_or_else(|| anyhow::anyhow!("malformed Git rename status entry"))?
                .to_string();
            index += 1;
            (original, Some(first_path))
        } else {
            (first_path, None)
        };
        if !path.ends_with('/') {
            entries.push(GitStatusEntry { x, y, path, rename });
        }
        index += 1;
    }
    Ok(entries)
}

fn parse_log(raw: &str) -> Result<Vec<GitLogEntry>> {
    let fields = raw.split('\0').collect::<Vec<_>>();
    let mut commits = Vec::new();
    let mut index = 0;
    while index + 4 < fields.len() {
        let hash = fields[index].trim_matches(['\r', '\n']).to_owned();
        if hash.is_empty() {
            index += 1;
            continue;
        }
        if !(hash.len() == 40 || hash.len() == 64)
            || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            bail!("malformed Git log hash");
        }
        let author_name = fields[index + 1].to_owned();
        let author_email = fields[index + 2].to_owned();
        let author_timestamp = fields[index + 3]
            .trim()
            .parse::<i64>()
            .context("parse Git author timestamp")?;
        let message = fields[index + 4].trim_end_matches(['\r', '\n']).to_owned();
        commits.push(GitLogEntry {
            hash,
            message,
            author_name,
            author_email,
            author_timestamp,
        });
        index += 5;
    }
    Ok(commits)
}

pub fn exec(params: GitExecParams, interrupt: &Interrupt) -> Result<GitExecResult> {
    let max_output = params
        .max_output_bytes
        .unwrap_or(DEFAULT_MAX_OUTPUT)
        .clamp(64 * 1024, 64 * 1024 * 1024);
    let started_at = now_ms();
    let run = run_owned(params, interrupt, BufferSink::new(max_output), max_output)?;
    Ok(GitExecResult {
        exit_code: run.exit_code,
        stdout: String::from_utf8_lossy(&run.stdout.kept).into_owned(),
        stderr: String::from_utf8_lossy(&run.stderr.kept).into_owned(),
        duration_ms: now_ms().saturating_sub(started_at),
        truncated: run.stdout.truncated || run.stderr.truncated,
    })
}

/// Result of a streamed Git command whose stdout was hashed rather than kept.
pub struct HashedOutput {
    pub hasher: Sha256,
    pub bytes: usize,
}

/// Run a Git command and feed its stdout into `hasher` without retaining it, so a
/// diff far larger than any RPC frame can still be fingerprinted under the same
/// deadline, cancellation, and process-tree ownership as `exec`.
pub fn hash_stdout(
    params: GitExecParams,
    interrupt: &Interrupt,
    hasher: Sha256,
    max_bytes: usize,
) -> Result<HashedOutput> {
    let args = params.args.join(" ");
    let sink = HashSink {
        hasher,
        bytes: 0,
        max_bytes,
        overflow: false,
    };
    let run = run_owned(params, interrupt, sink, DEFAULT_MAX_OUTPUT)?;
    if run.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&run.stderr.kept);
        let stderr = stderr.trim();
        if stderr.is_empty() {
            bail!("git {args} exited {}", run.exit_code);
        }
        bail!("{stderr}");
    }
    if run.stdout.overflow {
        bail!("git {args} output exceeded the {max_bytes}-byte bound");
    }
    Ok(HashedOutput {
        hasher: run.stdout.hasher,
        bytes: run.stdout.bytes,
    })
}

/// Where a Git child's stdout goes. Every sink drains the pipe to EOF, so a full
/// bound never leaves Git blocked on a write while the owner waits for its exit.
trait StdoutSink: Send + 'static {
    fn accept(&mut self, chunk: &[u8]);
}

struct BufferSink {
    kept: Vec<u8>,
    max: usize,
    truncated: bool,
}

impl BufferSink {
    fn new(max: usize) -> Self {
        Self {
            kept: Vec::with_capacity(max.min(64 * 1024)),
            max,
            truncated: false,
        }
    }
}

impl StdoutSink for BufferSink {
    fn accept(&mut self, chunk: &[u8]) {
        let remaining = self.max.saturating_sub(self.kept.len());
        let take = remaining.min(chunk.len());
        self.kept.extend_from_slice(&chunk[..take]);
        if chunk.len() > remaining {
            self.truncated = true;
        }
    }
}

struct HashSink {
    hasher: Sha256,
    bytes: usize,
    max_bytes: usize,
    overflow: bool,
}

impl StdoutSink for HashSink {
    fn accept(&mut self, chunk: &[u8]) {
        self.bytes = self.bytes.saturating_add(chunk.len());
        if self.bytes > self.max_bytes {
            self.overflow = true;
        }
        if !self.overflow {
            self.hasher.update(chunk);
        }
    }
}

struct OwnedRun<S> {
    exit_code: i32,
    stdout: S,
    stderr: BufferSink,
}

fn run_owned<S: StdoutSink>(
    params: GitExecParams,
    interrupt: &Interrupt,
    stdout_sink: S,
    max_output: usize,
) -> Result<OwnedRun<S>> {
    interrupt.check("git.exec")?;
    if params.cwd.trim().is_empty() || params.cwd.len() > 4096 {
        bail!("invalid Git cwd");
    }
    if params.args.is_empty()
        || params.args.len() > 512
        || params.args.iter().any(|arg| arg.len() > 64 * 1024)
    {
        bail!("invalid Git arguments");
    }

    let git = params
        .git_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("git");

    let mut command = Command::new(git);
    command
        .args(&params.args)
        .current_dir(&params.cwd)
        .stdin(if params.input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();

    for (key, value) in filtered_environment() {
        command.env(key, value);
    }
    command
        .env("LANGUAGE", "en")
        .env("LC_ALL", "C.UTF-8")
        .env("LANG", "C.UTF-8")
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "echo")
        .env("SSH_ASKPASS", "echo");
    for (key, value) in params.env {
        command.env(key, value);
    }

    // Own process group/job so an interrupt can end the whole Git tree, not just the
    // process this request spawned.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .with_context(|| format!("spawn git command {}", params.args.join(" ")))?;
    #[cfg(windows)]
    // Held for the lifetime of the request: closing it kills anything still in the
    // tree, which is what makes an interrupted Git command leave no descendants.
    let mut job = {
        use std::os::windows::io::AsRawHandle;
        match WindowsJob::assign(child.as_raw_handle()) {
            Ok(job) => Some(job),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error).context("attach Git child to kill-on-close job");
            }
        }
    };
    #[cfg(not(windows))]
    let mut job = ();

    if let Some(input) = params.input {
        if input.len() > max_output {
            let _ = child.kill();
            let _ = child.wait();
            bail!("Git input exceeds configured bound");
        }
        if let Some(mut stdin) = child.stdin.take() {
            let write_result = stdin.write_all(input.as_bytes());
            drop(stdin);
            if let Err(error) = write_result {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error).context("write Git stdin");
            }
        }
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("Git stdout pipe is unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("Git stderr pipe is unavailable"))?;
    let stdout_reader = spawn_sink_reader(stdout, stdout_sink);
    let stderr_reader = spawn_sink_reader(stderr, BufferSink::new(max_output));

    // The child is owned by this thread, which is what keeps the interrupt honest: a
    // stop kills the tree this thread is waiting on, and no other thread ever holds a
    // pid it could reuse after the child is reaped.
    let stopped = loop {
        if let Some(stop_reason) = interrupt.stop_reason() {
            end_git_tree(&mut child, &mut job);
            break Some(stop_reason);
        }
        match child.try_wait()? {
            Some(_) => break None,
            None => thread::sleep(interrupt.poll_slice()),
        }
    };

    let status = child.wait()?;
    let stdout = join_reader(stdout_reader, "stdout")?;
    let stderr = join_reader(stderr_reader, "stderr")?;

    if let Some(stop_reason) = stopped {
        return Err(coded(
            stop_reason.code(),
            format!(
                "git command was stopped before it finished: {}",
                params.args.join(" ")
            ),
        ));
    }

    Ok(OwnedRun {
        exit_code: status.code().unwrap_or(-1),
        stdout,
        stderr,
    })
}

/// End the Git tree this request owns and reap the child, so a stopped request
/// leaves neither a process nor a zombie behind.
fn end_git_tree(child: &mut Child, job: &mut JobHandle) {
    kill_process_tree(child.id());
    let _ = child.kill();
    #[cfg(windows)]
    drop(job.take());
    #[cfg(not(windows))]
    let _ = job;
    let _ = child.wait();
}

fn spawn_sink_reader<R: Read + Send + 'static, S: StdoutSink>(
    mut reader: R,
    mut sink: S,
) -> JoinHandle<Result<S>> {
    thread::spawn(move || {
        let mut buffer = [0u8; 16 * 1024];
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            sink.accept(&buffer[..read]);
        }
        Ok(sink)
    })
}

fn join_reader<S>(handle: JoinHandle<Result<S>>, stream: &str) -> Result<S> {
    handle
        .join()
        .map_err(|_| anyhow::anyhow!("Git {stream} reader thread panicked"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn git_background_launcher_has_no_windows_console() {
        let result = exec(
            GitExecParams {
                cwd: std::env::temp_dir().display().to_string(),
                args: vec![
                    "-NoProfile".to_owned(),
                    "-NonInteractive".to_owned(),
                    "-Command".to_owned(),
                    crate::process::WINDOWS_CONSOLE_PROBE.to_owned(),
                ],
                input: None,
                env: HashMap::new(),
                max_output_bytes: None,
                git_path: Some("powershell.exe".to_owned()),
            },
            &Interrupt::never(),
        )
        .expect("run console probe through actual Git launcher");
        assert_eq!(result.exit_code, 0, "{}", result.stderr);
        assert_eq!(
            result.stdout.trim(),
            "0",
            "Git launcher must not create a Windows console"
        );
    }

    #[test]
    fn parses_porcelain_status_including_rename_order() {
        let parsed =
            parse_status("M  src/app.ts\0R  src/new.ts\0src/old.ts\0?? new.txt\0").unwrap();
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].path, "src/app.ts");
        assert_eq!(parsed[1].path, "src/old.ts");
        assert_eq!(parsed[1].rename.as_deref(), Some("src/new.ts"));
        assert_eq!(parsed[2].x, "?");
        assert_eq!(parsed[2].y, "?");
    }

    #[test]
    fn parses_nul_delimited_log_without_regex_scanning() {
        let raw = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0Jane Doe\0jane@example.test\x001700000000\0Subject\n\nBody\n\0\n";
        let parsed = parse_log(raw).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].hash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(parsed[0].author_name, "Jane Doe");
        assert_eq!(parsed[0].author_timestamp, 1_700_000_000);
        assert_eq!(parsed[0].message, "Subject\n\nBody");
    }
}
