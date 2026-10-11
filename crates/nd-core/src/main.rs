use anyhow::{Context, Result};
use nd_protocol::errors::{self, CODE_INVALID_PARAMS, CODE_METHOD_FAILED, CODE_RUNTIME_BUSY};
use nd_protocol::{PROTOCOL_VERSION, ProtocolWriter, read_request};
use nd_runtime::artifacts;
use nd_runtime::cache::{self, ResponseCache};
use nd_runtime::clipboard::{
    ClipboardManager, ClipboardReadParams, ClipboardUnwatchParams, ClipboardWatchParams,
    ClipboardWriteTextParams,
};
use nd_runtime::deadline::{Deadline, Interrupt, InterruptGuard, InterruptRegistry};
use nd_runtime::decision::{self, DecisionEvaluateParams};
use nd_runtime::dispatcher::{DispatchStats, Dispatcher, priority_for_method};
use nd_runtime::effect_journal::{
    EffectJournalAppendParams, EffectJournalConfigureParams, EffectJournalReplayParams,
    EffectJournalStateParams, EffectJournalStore,
};
use nd_runtime::evidence::{self, EvidenceParams};
use nd_runtime::git::{self, GitExecParams, GitLogParams, GitQueryParams};
use nd_runtime::media;
use nd_runtime::metrics::{self, MetricsRegistry};
use nd_runtime::process::{
    CancelParams, CloseStdinParams, ProcessManager, SpawnParams, WriteParams,
};
use nd_runtime::revision;
use nd_runtime::scheduler::{AcquireParams, BindParams, ReleaseParams, Scheduler};
use nd_runtime::search;
use nd_runtime::session_journal::{
    DEFAULT_MAX_BYTES_PER_SESSION, DEFAULT_MAX_EVENTS_PER_SESSION, SessionJournalAppendParams,
    SessionJournalSessionParams, SessionJournalStore, SessionJournalTailParams,
};
use nd_runtime::snapshot;
use nd_runtime::terminal::{
    TerminalCloseParams, TerminalCreateParams, TerminalHistoryAppendParams, TerminalManager,
    TerminalResizeParams, TerminalRestartParams, TerminalStateParams, TerminalWriteParams,
};
use nd_runtime::vault::{
    VaultDeleteResult, VaultIdParams, VaultListParams, VaultListResult, VaultRegistry,
    VaultUpdateParams, VaultWriteParams,
};
use nd_runtime::workspace::{
    self, IndexParams, ListParams, ReadParams, WriteParams as WorkspaceWriteParams,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::io::BufReader;
use std::sync::Arc;

struct AppState {
    writer: Arc<ProtocolWriter>,
    scheduler: Arc<Scheduler>,
    processes: Arc<ProcessManager>,
    terminals: Arc<TerminalManager>,
    clipboard: Arc<ClipboardManager>,
    vault: VaultRegistry,
    session_journal: Arc<SessionJournalStore>,
    effect_journal: Arc<EffectJournalStore>,
    metrics: Arc<MetricsRegistry>,
    cache: Arc<ResponseCache>,
    interrupts: Arc<InterruptRegistry>,
    dispatch_stats: DispatchStats,
}

impl AppState {
    fn new(dispatch_stats: DispatchStats) -> Arc<Self> {
        let writer = Arc::new(ProtocolWriter::new());
        let scheduler = Arc::new(Scheduler::new());
        let processes = Arc::new(ProcessManager::new(
            Arc::clone(&writer),
            Arc::clone(&scheduler),
        ));
        let terminals = Arc::new(TerminalManager::new(Arc::clone(&writer)));
        let clipboard_sink =
            Arc::clone(&writer) as Arc<dyn nd_runtime::clipboard::ClipboardEventSink>;
        let clipboard = Arc::new(ClipboardManager::new(
            clipboard_sink,
            nd_runtime::clipboard::platform_source(),
        ));
        let session_journal = Arc::new(SessionJournalStore::new(
            DEFAULT_MAX_EVENTS_PER_SESSION,
            DEFAULT_MAX_BYTES_PER_SESSION,
        ));
        let effect_journal = Arc::new(EffectJournalStore::new());
        Arc::new(Self {
            writer,
            scheduler,
            processes,
            terminals,
            clipboard,
            vault: VaultRegistry::new_platform(),
            session_journal,
            effect_journal,
            metrics: Arc::new(MetricsRegistry::new()),
            cache: Arc::new(ResponseCache::new(
                cache::DEFAULT_MAX_ENTRIES,
                cache::DEFAULT_MAX_BYTES,
            )),
            interrupts: Arc::new(InterruptRegistry::new()),
            dispatch_stats,
        })
    }

    fn shutdown(&self) {
        // Stopping in-flight work first is what lets shutdown finish: without it a
        // dispatcher worker sitting in a Git deadline would hold the join.
        self.interrupts.cancel_all();
        self.terminals.shutdown();
        self.processes.shutdown();
        // Watcher teardown is joined, not fire-and-forget: no leaked thread or
        // message-only window survives the sidecar.
        self.clipboard.shutdown();
    }
}

fn main() -> Result<()> {
    eprintln!(
        "[nd-core] starting {} protocol v{}",
        env!("CARGO_PKG_VERSION"),
        PROTOCOL_VERSION
    );

    let dispatcher = Dispatcher::new();
    let state = AppState::new(dispatcher.stats());
    let stdin = std::io::stdin();
    let mut input = BufReader::new(stdin.lock());

    loop {
        let request = match read_request(&mut input) {
            Ok(Some(request)) => request,
            Ok(None) => break,
            Err(error) => {
                eprintln!("[nd-core] protocol read failed: {error:#}");
                break;
            }
        };
        let id = request.id.clone();
        let method = request.method.clone();

        // A deadline that cannot be honoured is rejected before any work starts, so
        // an absurd value never becomes a queued request that runs unbounded.
        let deadline = match Deadline::from_option(request.deadline_ms) {
            Ok(deadline) => deadline,
            Err(error) => {
                let _ = state
                    .writer
                    .send_error(&id, CODE_INVALID_PARAMS, format!("{error:#}"));
                continue;
            }
        };
        let interrupt = state.interrupts.register(&id, deadline);
        let guard = InterruptGuard::new(Arc::clone(&state.interrupts), id.clone());

        let priority = priority_for_method(&method);
        let state_for_job = Arc::clone(&state);
        let writer = Arc::clone(&state.writer);
        let job_id = id.clone();
        if let Err(error) = dispatcher.submit(priority, move || {
            let _guard = guard;
            match dispatch(
                state_for_job.clone(),
                &job_id,
                &method,
                request.params,
                &interrupt,
            ) {
                Ok(result) => {
                    if let Err(error) = state_for_job.writer.send_result(&job_id, &result) {
                        eprintln!("[nd-core] response write failed: {error:#}");
                    }
                }
                Err(error) => {
                    if let Err(write_error) = state_for_job.writer.send_error(
                        &job_id,
                        errors::code_of(&error),
                        format!("{error:#}"),
                    ) {
                        eprintln!("[nd-core] error response write failed: {write_error:#}");
                    }
                }
            }
        }) {
            state.interrupts.finish(&id);
            let _ = writer.send_error(&id, CODE_RUNTIME_BUSY, format!("{error:#}"));
        }
    }

    state.shutdown();
    dispatcher.shutdown();
    eprintln!("[nd-core] stopped");
    Ok(())
}

fn dispatch(
    state: Arc<AppState>,
    request_id: &str,
    method: &str,
    params: Value,
    interrupt: &Interrupt,
) -> Result<Value> {
    interrupt.check(method)?;
    match method {
        "core.health" => {
            let dispatch = state.dispatch_stats.snapshot();
            Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "binaryVersion": env!("CARGO_PKG_VERSION"),
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "capabilities": [
                    "scheduler",
                    "process",
                    "terminal",
                    "clipboard",
                    "session-journal",
                    "effect-journal",
                    "decision-kernel",
                    "git",
                    "evidence",
                    "artifacts",
                    "workspace",
                    "media",
                    "vault",
                    "search",
                    "revision",
                    "cache",
                    "deadline",
                    "cancellation",
                    "metrics"
                ],
                "processCount": state.processes.process_count(),
                "terminalCount": state.terminals.terminal_count(),
                "clipboardWatcherCount": state.clipboard.watcher_count(),
                "workspaceCount": state.metrics.workspace_count(),
                "pendingRpcCount": dispatch.active + dispatch.queued_high + dispatch.queued_normal + dispatch.queued_background,
            }))
        }
        "core.cancel" => {
            let params = from_params::<CancelRequestParams>(params)?;
            Ok(json!({ "canceled": state.interrupts.cancel(&params.request_id) }))
        }
        "metrics.snapshot" => {
            let scheduler = state.scheduler.snapshot()?;
            let dispatch = state.dispatch_stats.snapshot();
            let outbound = state.writer.snapshot();
            let queued_event_count = outbound.queued_frames;
            let queued_event_bytes = outbound.queued_bytes;
            let bound_sessions = scheduler
                .permits
                .iter()
                .filter(|permit| permit.session_id.is_some())
                .count();
            let session_journal = state.session_journal.stats();
            let effect_journal = state.effect_journal.stats();
            Ok(json!({
                "processMemory": metrics::current_process_memory(),
                "logicalSessionCount": scheduler.permits.len(),
                "boundSessionCount": bound_sessions,
                "workspaceCount": state.metrics.workspace_count(),
                "processCount": state.processes.process_count(),
                "terminalCount": state.terminals.terminal_count(),
                "clipboardWatcherCount": state.clipboard.watcher_count(),
                "retainedTerminalCount": state.terminals.retained_terminal_count(),
                "retainedTerminalBufferBytes": state.terminals.retained_buffer_bytes(),
                "sessionJournalSessionCount": session_journal.session_count,
                "sessionJournalEventCount": session_journal.retained_event_count,
                "sessionJournalBytes": session_journal.retained_bytes,
                "sessionJournalMaxEventsPerSession": session_journal.max_events_per_session,
                "sessionJournalMaxBytesPerSession": session_journal.max_bytes_per_session,
                "effectJournalConfigured": effect_journal.configured,
                "effectJournalRecordCount": effect_journal.record_count,
                "effectJournalBytes": effect_journal.bytes,
                "effectJournalLastSeq": effect_journal.last_seq,
                "effectJournalMaxBytes": effect_journal.max_bytes,
                "inFlightRequestCount": state.interrupts.active_count(),
                "pendingRpcCount": dispatch.active + dispatch.queued_high + dispatch.queued_normal + dispatch.queued_background,
                "dispatcher": dispatch,
                "cache": state.cache.snapshot(),
                "outbound": outbound,
                "queuedEventCount": queued_event_count,
                "queuedEventBytes": queued_event_bytes,
            }))
        }
        "effectJournal.configure" => to_value(
            state
                .effect_journal
                .configure(from_params::<EffectJournalConfigureParams>(params)?)?,
        ),
        "effectJournal.append" => to_value(
            state
                .effect_journal
                .append(from_params::<EffectJournalAppendParams>(params)?)?,
        ),
        "effectJournal.replay" => to_value(
            state
                .effect_journal
                .replay(from_params::<EffectJournalReplayParams>(params)?)?,
        ),
        "effectJournal.state" => to_value(
            state
                .effect_journal
                .effect_state(from_params::<EffectJournalStateParams>(params)?)?,
        ),
        "effectJournal.stats" => to_value(state.effect_journal.stats()),
        "decision.evaluate" => to_value(decision::evaluate(
            from_params::<DecisionEvaluateParams>(params)?,
        )?),
        "scheduler.acquire" => {
            let acquire = from_params::<AcquireParams>(params)?;
            let effect_identity = acquire.permit_id.as_deref().unwrap_or(request_id);
            let intent_key = format!("lease.acquire:{effect_identity}");
            let journal_enabled = state.effect_journal.stats().configured;
            if journal_enabled {
                state.effect_journal.append(EffectJournalAppendParams {
                    record_id: None,
                    kind: "lease.acquire".into(),
                    state: nd_runtime::effect_journal::EffectState::Intent,
                    company_id: acquire.company_id.clone(),
                    project_id: acquire.project_id.clone(),
                    task_id: acquire.task_id.clone(),
                    run_id: acquire.run_id.clone(),
                    resource_id: acquire.permit_id.clone(),
                    idempotency_key: Some(intent_key.clone()),
                    data: Some(json!({
                        "kind": acquire.kind.clone(),
                        "pools": acquire.pools.clone()
                    })),
                })?;
            }
            match state.scheduler.acquire(acquire) {
                Ok(result) => {
                    if journal_enabled {
                        state.effect_journal.append(EffectJournalAppendParams {
                            record_id: None,
                            kind: "lease.acquire".into(),
                            state: if result.granted {
                                nd_runtime::effect_journal::EffectState::Complete
                            } else {
                                nd_runtime::effect_journal::EffectState::Failed
                            },
                            company_id: result
                                .permit
                                .as_ref()
                                .and_then(|permit| permit.company_id.clone()),
                            project_id: result
                                .permit
                                .as_ref()
                                .and_then(|permit| permit.project_id.clone()),
                            task_id: result
                                .permit
                                .as_ref()
                                .and_then(|permit| permit.task_id.clone()),
                            run_id: result
                                .permit
                                .as_ref()
                                .and_then(|permit| permit.run_id.clone()),
                            resource_id: result.permit.as_ref().map(|permit| permit.id.clone()),
                            idempotency_key: Some(intent_key),
                            data: Some(json!({
                                "granted": result.granted,
                                "reason": result.reason.clone()
                            })),
                        })?;
                    }
                    to_value(result)
                }
                Err(error) => {
                    if journal_enabled {
                        let _ = state.effect_journal.append(EffectJournalAppendParams {
                            record_id: None,
                            kind: "lease.acquire".into(),
                            state: nd_runtime::effect_journal::EffectState::Failed,
                            company_id: None,
                            project_id: None,
                            task_id: None,
                            run_id: None,
                            resource_id: None,
                            idempotency_key: Some(intent_key),
                            data: Some(json!({ "error": format!("{error:#}") })),
                        });
                    }
                    Err(error)
                }
            }
        }
        "scheduler.bind" => to_value(state.scheduler.bind(from_params::<BindParams>(params)?)?),
        "scheduler.heartbeat" => to_value(state.scheduler.heartbeat(from_params(params)?)?),
        "scheduler.release" => {
            let params = from_params::<ReleaseParams>(params)?;
            let key = format!("lease.release:{}", params.permit_id);
            let journal_enabled = state.effect_journal.stats().configured;
            if journal_enabled {
                state.effect_journal.append(EffectJournalAppendParams {
                    record_id: None,
                    kind: "lease.release".into(),
                    state: nd_runtime::effect_journal::EffectState::Intent,
                    company_id: None,
                    project_id: None,
                    task_id: None,
                    run_id: None,
                    resource_id: Some(params.permit_id.clone()),
                    idempotency_key: Some(key.clone()),
                    data: None,
                })?;
            }
            state.processes.cancel_permit(&params.permit_id);
            let released = state.scheduler.release(params)?;
            if journal_enabled {
                state.effect_journal.append(EffectJournalAppendParams {
                    record_id: None,
                    kind: "lease.release".into(),
                    state: nd_runtime::effect_journal::EffectState::Complete,
                    company_id: None,
                    project_id: None,
                    task_id: None,
                    run_id: None,
                    resource_id: None,
                    idempotency_key: Some(key),
                    data: Some(json!({ "released": released })),
                })?;
            }
            Ok(json!({ "released": released }))
        }
        "scheduler.snapshot" => to_value(state.scheduler.snapshot()?),
        "process.spawn" => {
            let params = from_params::<SpawnParams>(params)?;
            if let Some(cwd) = params.cwd.as_deref() {
                state.metrics.observe_workspace(cwd);
            }
            to_value(state.processes.spawn(params)?)
        }
        "process.write" => {
            state.processes.write(from_params::<WriteParams>(params)?)?;
            Ok(json!({ "ok": true }))
        }
        "process.cancel" => {
            let canceled = state
                .processes
                .cancel(from_params::<CancelParams>(params)?)?;
            Ok(json!({ "canceled": canceled }))
        }
        "process.closeStdin" => {
            let closed = state
                .processes
                .close_stdin(from_params::<CloseStdinParams>(params)?)?;
            Ok(json!({ "closed": closed }))
        }
        "process.snapshot" => to_value(state.processes.snapshot()?),
        "terminal.create" => {
            let params = from_params::<TerminalCreateParams>(params)?;
            state.metrics.observe_workspace(&params.cwd);
            to_value(state.terminals.create(params)?)
        }
        "terminal.restart" => to_value(
            state
                .terminals
                .restart(from_params::<TerminalRestartParams>(params)?)?,
        ),
        "terminal.state" => to_value(
            state
                .terminals
                .state(from_params::<TerminalStateParams>(params)?)?,
        ),
        "terminal.write" => {
            state
                .terminals
                .write(from_params::<TerminalWriteParams>(params)?)?;
            Ok(json!({ "ok": true }))
        }
        "terminal.resize" => {
            state
                .terminals
                .resize(from_params::<TerminalResizeParams>(params)?)?;
            Ok(json!({ "ok": true }))
        }
        "terminal.appendHistory" => {
            state
                .terminals
                .append_history(from_params::<TerminalHistoryAppendParams>(params)?)?;
            Ok(json!({ "ok": true }))
        }
        "terminal.close" => {
            let closed = state
                .terminals
                .close(from_params::<TerminalCloseParams>(params)?)?;
            Ok(json!({ "closed": closed }))
        }
        "sessionJournal.append" => to_value(
            state
                .session_journal
                .append(from_params::<SessionJournalAppendParams>(params)?)?,
        ),
        "sessionJournal.drop" => {
            let removed = state
                .session_journal
                .drop_session(from_params::<SessionJournalSessionParams>(params)?)?;
            Ok(json!({ "removed": removed }))
        }
        "sessionJournal.clear" => {
            let cleared = state.session_journal.clear()?;
            Ok(json!({ "cleared": cleared }))
        }
        "sessionJournal.tail" => to_value(
            state
                .session_journal
                .tail(from_params::<SessionJournalTailParams>(params)?)?,
        ),
        "git.exec" => {
            let params = from_params::<GitExecParams>(params)?;
            state.metrics.observe_workspace(&params.cwd);
            to_value(git::exec(params, interrupt)?)
        }
        "git.status" => {
            let params = from_params::<GitQueryParams>(params)?;
            state.metrics.observe_workspace(&params.cwd);
            git::cached_status(params, interrupt, &state.cache)
        }
        "git.log" => {
            let params = from_params::<GitLogParams>(params)?;
            state.metrics.observe_workspace(&params.cwd);
            git::cached_log(params, interrupt, &state.cache)
        }
        "workspace.list" => {
            let params = from_params::<ListParams>(params)?;
            state.metrics.observe_workspace(&params.root);
            to_value(workspace::list(params)?)
        }
        "workspace.read" => {
            let params = from_params::<ReadParams>(params)?;
            state.metrics.observe_workspace(&params.root);
            to_value(workspace::read(params)?)
        }
        "workspace.read-binary" => {
            let params = from_params::<ReadParams>(params)?;
            state.metrics.observe_workspace(&params.root);
            to_value(workspace::read_binary(params)?)
        }
        "workspace.write" => {
            let params = from_params::<WorkspaceWriteParams>(params)?;
            state.metrics.observe_workspace(&params.root);
            to_value(workspace::write(params)?)
        }
        "workspace.revision" => {
            let params = from_params::<RevisionParams>(params)?;
            state.metrics.observe_workspace(&params.root);
            let scope = revision::RevisionScope::parse(params.scope.as_deref())?;
            to_value(revision::workspace_revision(
                &params.root,
                scope,
                interrupt,
            )?)
        }
        "workspace.search" => {
            let params = from_params::<search::SearchParams>(params)?;
            state.metrics.observe_workspace(&params.root);
            to_value(search::search(params, interrupt)?)
        }
        "workspace.index" => {
            let params = from_params::<IndexParams>(params)?;
            state.metrics.observe_workspace(&params.root);
            to_value(workspace::index(params, interrupt)?)
        }
        "workspace.evidence" => {
            let params = from_params::<EvidenceParams>(params)?;
            state.metrics.observe_workspace(&params.root);
            to_value(evidence::capture(params, interrupt)?)
        }
        "workspace.fingerprint-artifacts" => {
            let params = from_params::<artifacts::ArtifactFingerprintParams>(params)?;
            state.metrics.observe_workspace(&params.root);
            to_value(artifacts::fingerprint(params, interrupt)?)
        }
        "workspace.snapshot" => {
            let params = from_params::<snapshot::SnapshotParams>(params)?;
            state.metrics.observe_workspace(&params.root);
            to_value(snapshot::snapshot(params, interrupt)?)
        }
        // Media roots are directories the desktop handed to the sidecar for a
        // native surface (a wallpaper library), not linked workspaces, so they
        // deliberately do not feed `observe_workspace`.
        "media.thumbnails" => {
            let params = from_params::<media::ThumbnailsParams>(params)?;
            to_value(media::thumbnails(params, interrupt)?)
        }
        "media.set-wallpaper" => {
            let params = from_params::<media::WallpaperSetParams>(params)?;
            to_value(media::set_wallpaper(params)?)
        }
        "media.key" => {
            let params = from_params::<media::MediaKeyParams>(params)?;
            to_value(media::send_media_key(params)?)
        }
        // The sidecar owns clipboard read, write, and observation in one
        // process, which is what makes write-back echo suppression exact.
        // Watchers exist only in response to `clipboard.watch` from the
        // desktop and never survive shutdown.
        "clipboard.watch" => {
            let params = from_params::<ClipboardWatchParams>(params)?;
            to_value(state.clipboard.watch(params)?)
        }
        "clipboard.unwatch" => {
            let params = from_params::<ClipboardUnwatchParams>(params)?;
            to_value(state.clipboard.unwatch(params)?)
        }
        "clipboard.read" => {
            let params = from_params::<ClipboardReadParams>(params)?;
            to_value(state.clipboard.read(params)?)
        }
        "clipboard.write" => {
            let params = from_params::<ClipboardWriteTextParams>(params)?;
            to_value(state.clipboard.write_text(params)?)
        }
        // Vault files are paths the desktop owns (its own userData), not linked
        // workspaces, so they deliberately do not feed `observe_workspace`. The
        // registry serializes load-modify-save per vault path and keeps the
        // decrypted key in memory only.
        "vault.list" => {
            let params = from_params::<VaultListParams>(params)?;
            let result: VaultListResult = state.vault.list(params)?;
            to_value(result)
        }
        "vault.get" => to_value(state.vault.get(from_params::<VaultIdParams>(params)?)?),
        "vault.create" => to_value(
            state
                .vault
                .create(from_params::<VaultWriteParams>(params)?)?,
        ),
        "vault.update" => to_value(
            state
                .vault
                .update(from_params::<VaultUpdateParams>(params)?)?,
        ),
        "vault.delete" => {
            let result: VaultDeleteResult =
                state.vault.delete(from_params::<VaultIdParams>(params)?)?;
            to_value(result)
        }
        other => {
            let _ = request_id;
            Err(errors::coded(
                CODE_METHOD_FAILED,
                format!("unknown nd-core method: {other}"),
            ))
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelRequestParams {
    request_id: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevisionParams {
    root: String,
    scope: Option<String>,
}

fn from_params<T: DeserializeOwned>(params: Value) -> Result<T> {
    serde_json::from_value(params).context("decode method parameters")
}

fn to_value<T: Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).context("encode method result")
}
