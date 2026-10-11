use crate::protocol::ProtocolWriter;
use crate::scheduler::{Scheduler, now_ms};
#[cfg(windows)]
use crate::windows_job::WindowsJob;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnParams {
    pub id: Option<String>,
    pub permit_id: Option<String>,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub inherit_env: Option<bool>,
    #[serde(default)]
    pub verbatim_args: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteParams {
    pub process_id: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    pub process_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseStdinParams {
    pub process_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    pub process_id: String,
    pub pid: u32,
    pub started_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSnapshot {
    pub process_id: String,
    pub pid: u32,
    pub permit_id: Option<String>,
    pub started_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessOutput {
    process_id: String,
    stream: &'static str,
    #[serde(with = "serde_bytes")]
    bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessExit {
    process_id: String,
    pid: u32,
    exit_code: i32,
    duration_ms: u64,
}

struct ManagedProcess {
    pid: u32,
    child: Arc<Mutex<Child>>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    permit_id: Option<String>,
    started_at: u64,
    #[cfg(windows)]
    _job: WindowsJob,
}

pub struct ProcessManager {
    writer: Arc<ProtocolWriter>,
    scheduler: Arc<Scheduler>,
    processes: Mutex<HashMap<String, ManagedProcess>>,
}

impl ProcessManager {
    pub fn new(writer: Arc<ProtocolWriter>, scheduler: Arc<Scheduler>) -> Self {
        Self {
            writer,
            scheduler,
            processes: Mutex::new(HashMap::new()),
        }
    }

    pub fn spawn(self: &Arc<Self>, params: SpawnParams) -> Result<SpawnResult> {
        if params.command.trim().is_empty() || params.command.len() > 4096 {
            bail!("invalid process command");
        }
        if params.args.len() > 512 || params.args.iter().any(|arg| arg.len() > 64 * 1024) {
            bail!("invalid process arguments");
        }
        if let Some(permit_id) = params.permit_id.as_deref()
            && !self.scheduler.has_permit(permit_id)
        {
            bail!("runtime permit is missing or expired");
        }

        let id = params.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        if id.is_empty() || id.len() > 256 {
            bail!("invalid process id");
        }
        {
            let processes = self
                .processes
                .lock()
                .map_err(|_| anyhow::anyhow!("process registry lock poisoned"))?;
            if processes.contains_key(&id) {
                bail!("process id already exists");
            }
        }

        let mut command = Command::new(&params.command);
        // Shell wrappers (`cmd.exe /d /s /c "..."`) rely on the command line
        // reaching CreateProcess byte-for-byte. The default escaping rewrites
        // inner quotes the way cmd.exe cannot parse, so verbatim delivery is
        // required for that call shape.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            if params.verbatim_args {
                for arg in &params.args {
                    command.raw_arg(arg);
                }
            } else {
                command.args(&params.args);
            }
        }
        #[cfg(not(windows))]
        command.args(&params.args);
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        if let Some(cwd) = params.cwd.as_deref() {
            command.current_dir(cwd);
        }

        command.env_clear();
        if params.inherit_env.unwrap_or(true) {
            for (key, value) in filtered_environment() {
                command.env(key, value);
            }
        }
        for (key, value) in params.env {
            if key.len() > 256 || value.len() > 64 * 1024 {
                bail!("invalid process environment");
            }
            // Explicit env comes from the owning TypeScript engine adapter.
            // ND safeStorage credentials are never inserted here implicitly;
            // user/CLI-owned auth variables may be intentionally forwarded.
            command.env(key, value);
        }

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
            // Managed CLI output belongs in ND's pipes, never a desktop console.
            command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .with_context(|| format!("spawn {}", params.command))?;
        #[cfg(windows)]
        let job = {
            use std::os::windows::io::AsRawHandle;
            match WindowsJob::assign(child.as_raw_handle()) {
                Ok(job) => job,
                Err(error) => {
                    let _ = child.kill();
                    return Err(error).context("attach managed process to kill-on-close job");
                }
            }
        };
        let pid = child.id();
        let stdin = child.stdin.take().map(|input| Arc::new(Mutex::new(input)));
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let child = Arc::new(Mutex::new(child));
        let started_at = now_ms();

        {
            let mut processes = self
                .processes
                .lock()
                .map_err(|_| anyhow::anyhow!("process registry lock poisoned"))?;
            processes.insert(
                id.clone(),
                ManagedProcess {
                    pid,
                    child: Arc::clone(&child),
                    stdin,
                    permit_id: params.permit_id,
                    started_at,
                    #[cfg(windows)]
                    _job: job,
                },
            );
        }

        let stdout_done = stdout
            .map(|stdout| spawn_reader(Arc::clone(&self.writer), id.clone(), "stdout", stdout));
        let stderr_done = stderr
            .map(|stderr| spawn_reader(Arc::clone(&self.writer), id.clone(), "stderr", stderr));

        let manager = Arc::clone(self);
        let wait_id = id.clone();
        thread::spawn(move || {
            loop {
                let status = {
                    let Ok(mut child) = child.lock() else {
                        return;
                    };
                    match child.try_wait() {
                        Ok(status) => status,
                        Err(error) => {
                            eprintln!("[nd-core] process wait failed for {wait_id}: {error}");
                            None
                        }
                    }
                };
                if let Some(status) = status {
                    // stdout/stderr pipes usually reach EOF immediately when the
                    // child exits. Give both reader threads one bounded window to
                    // enqueue their final output before process.exit; never join
                    // indefinitely because a descendant may have inherited a pipe.
                    let drain_deadline = Instant::now() + Duration::from_millis(250);
                    for done in [&stdout_done, &stderr_done].into_iter().flatten() {
                        let remaining = drain_deadline.saturating_duration_since(Instant::now());
                        if remaining.is_zero() {
                            break;
                        }
                        let _ = done.recv_timeout(remaining);
                    }
                    let record = {
                        let Ok(mut processes) = manager.processes.lock() else {
                            return;
                        };
                        processes.remove(&wait_id)
                    };
                    if let Some(record) = record {
                        let event = ProcessExit {
                            process_id: wait_id.clone(),
                            pid: record.pid,
                            exit_code: status.code().unwrap_or(-1),
                            duration_ms: now_ms().saturating_sub(record.started_at),
                        };
                        let _ = manager.writer.send_event(
                            "process.exit",
                            Some(&wait_id),
                            None,
                            "normal",
                            &event,
                        );
                    }
                    break;
                }

                let expired_permit = manager
                    .processes
                    .lock()
                    .ok()
                    .and_then(|processes| {
                        processes
                            .get(&wait_id)
                            .and_then(|record| record.permit_id.clone())
                    })
                    .is_some_and(|permit_id| !manager.scheduler.has_permit(&permit_id));
                if expired_permit {
                    let _ = manager.cancel(CancelParams {
                        process_id: wait_id.clone(),
                    });
                }
                thread::sleep(Duration::from_millis(25));
            }
        });

        Ok(SpawnResult {
            process_id: id,
            pid,
            started_at,
        })
    }

    pub fn write(&self, params: WriteParams) -> Result<()> {
        if params.data.len() > 64 * 1024 {
            bail!("process stdin chunk is too large");
        }
        let stdin = {
            let processes = self
                .processes
                .lock()
                .map_err(|_| anyhow::anyhow!("process registry lock poisoned"))?;
            processes
                .get(&params.process_id)
                .and_then(|record| record.stdin.as_ref().map(Arc::clone))
                .ok_or_else(|| anyhow::anyhow!("process stdin is unavailable"))?
        };
        let mut stdin = stdin
            .lock()
            .map_err(|_| anyhow::anyhow!("process stdin lock poisoned"))?;
        stdin.write_all(params.data.as_bytes())?;
        stdin.flush()?;
        Ok(())
    }

    pub fn cancel(&self, params: CancelParams) -> Result<bool> {
        let (pid, child) = {
            let processes = self
                .processes
                .lock()
                .map_err(|_| anyhow::anyhow!("process registry lock poisoned"))?;
            let Some(record) = processes.get(&params.process_id) else {
                return Ok(false);
            };
            (record.pid, Arc::clone(&record.child))
        };

        kill_process_tree(pid);
        if let Ok(mut child) = child.lock() {
            let _ = child.kill();
        }
        Ok(true)
    }

    pub fn close_stdin(&self, params: CloseStdinParams) -> Result<bool> {
        let stdin = {
            let mut processes = self
                .processes
                .lock()
                .map_err(|_| anyhow::anyhow!("process registry lock poisoned"))?;
            let Some(record) = processes.get_mut(&params.process_id) else {
                return Ok(false);
            };
            record.stdin.take()
        };
        Ok(stdin.is_some())
    }

    pub fn cancel_permit(&self, permit_id: &str) -> usize {
        let ids = self
            .processes
            .lock()
            .map(|processes| {
                processes
                    .iter()
                    .filter(|(_, record)| record.permit_id.as_deref() == Some(permit_id))
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for process_id in &ids {
            let _ = self.cancel(CancelParams {
                process_id: process_id.clone(),
            });
        }
        ids.len()
    }

    pub fn snapshot(&self) -> Result<Vec<ProcessSnapshot>> {
        let processes = self
            .processes
            .lock()
            .map_err(|_| anyhow::anyhow!("process registry lock poisoned"))?;
        let mut result = processes
            .iter()
            .map(|(id, record)| ProcessSnapshot {
                process_id: id.clone(),
                pid: record.pid,
                permit_id: record.permit_id.clone(),
                started_at: record.started_at,
            })
            .collect::<Vec<_>>();
        result.sort_by_key(|item| item.started_at);
        Ok(result)
    }

    pub fn shutdown(&self) {
        let ids = self
            .processes
            .lock()
            .map(|processes| processes.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for process_id in ids {
            let _ = self.cancel(CancelParams { process_id });
        }
    }

    pub fn process_count(&self) -> usize {
        self.processes
            .lock()
            .map(|map| map.len())
            .unwrap_or_default()
    }
}

fn spawn_reader<R: Read + Send + 'static>(
    writer: Arc<ProtocolWriter>,
    process_id: String,
    stream: &'static str,
    mut reader: R,
) -> mpsc::Receiver<()> {
    let (done_tx, done_rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut buffer = vec![0u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let event = ProcessOutput {
                        process_id: process_id.clone(),
                        stream,
                        bytes: buffer[..read].to_vec(),
                    };
                    if writer
                        .send_event("process.output", Some(&process_id), None, "normal", &event)
                        .is_err()
                    {
                        break;
                    }
                }
                Err(error) => {
                    eprintln!("[nd-core] process {stream} read failed for {process_id}: {error}");
                    break;
                }
            }
        }
        let _ = done_tx.send(());
    });
    done_rx
}

pub fn filtered_environment() -> impl Iterator<Item = (String, String)> {
    std::env::vars().filter(|(key, _)| !looks_secret(key))
}

fn looks_secret(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    [
        "API_KEY",
        "ACCESS_KEY",
        "SECRET",
        "TOKEN",
        "PASSWORD",
        "AUTHORIZATION",
        "PRIVATE_KEY",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

pub fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .and_then(|mut child| child.wait());
    }

    #[cfg(unix)]
    unsafe {
        let _ = libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(all(test, windows))]
pub(crate) const WINDOWS_CONSOLE_PROBE: &str = r#"
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class NdConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }';
$result = [NdConsoleProbe]::GetConsoleWindow().ToInt64().ToString();
if ($env:ND_CONSOLE_PROBE_FILE) { [IO.File]::WriteAllText($env:ND_CONSOLE_PROBE_FILE, $result) };
Write-Output $result
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn managed_background_process_has_no_windows_console() {
        let manager = Arc::new(ProcessManager::new(
            Arc::new(ProtocolWriter::new()),
            Arc::new(Scheduler::new()),
        ));
        let dir = std::env::temp_dir().join(format!("nd-console-probe-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create probe directory");
        let marker = dir.join("console.txt");
        manager
            .spawn(SpawnParams {
                id: None,
                permit_id: None,
                command: "powershell.exe".to_owned(),
                args: vec![
                    "-NoProfile".to_owned(),
                    "-NonInteractive".to_owned(),
                    "-Command".to_owned(),
                    WINDOWS_CONSOLE_PROBE.to_owned(),
                ],
                cwd: Some(dir.display().to_string()),
                env: HashMap::from([(
                    "ND_CONSOLE_PROBE_FILE".to_owned(),
                    marker.display().to_string(),
                )]),
                inherit_env: Some(true),
                verbatim_args: false,
            })
            .expect("spawn managed console probe");
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut observed = None;
        while Instant::now() < deadline {
            if let Ok(text) = std::fs::read_to_string(&marker)
                && !text.is_empty()
            {
                observed = Some(text);
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert_eq!(
            observed.as_deref(),
            Some("0"),
            "background child must not own a Windows console"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn secret_environment_names_are_filtered() {
        assert!(looks_secret("OPENAI_API_KEY"));
        assert!(looks_secret("AUTHORIZATION"));
        assert!(looks_secret("my_private_key"));
        assert!(!looks_secret("PATH"));
        assert!(!looks_secret("TERM"));
    }

    #[cfg(windows)]
    #[test]
    fn verbatim_args_deliver_quoted_shell_commands_intact() {
        let manager = Arc::new(ProcessManager::new(
            Arc::new(ProtocolWriter::new()),
            Arc::new(Scheduler::new()),
        ));
        let dir = std::env::temp_dir().join(format!("nd-core-verbatim-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let marker = dir.join("marker.txt");
        let inner = format!("echo \"quoted ok\" > \"{}\"", marker.display());
        manager
            .spawn(SpawnParams {
                id: None,
                permit_id: None,
                command: std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_owned()),
                args: vec![
                    "/d".to_owned(),
                    "/s".to_owned(),
                    "/c".to_owned(),
                    format!("\"{inner}\""),
                ],
                cwd: Some(dir.display().to_string()),
                env: HashMap::new(),
                inherit_env: Some(true),
                verbatim_args: true,
            })
            .expect("spawn verbatim cmd.exe command");

        let deadline = Instant::now() + Duration::from_secs(15);
        let mut observed = String::new();
        while Instant::now() < deadline {
            if let Ok(text) = std::fs::read_to_string(&marker) {
                observed = text.trim().to_owned();
                if observed == "\"quoted ok\"" {
                    break;
                }
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert_eq!(
            observed, "\"quoted ok\"",
            "quoted cmd.exe command was not delivered intact"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
