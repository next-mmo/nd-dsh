//! Safety guard for the Antigravity CLI lane.
//!
//! The lane runs a consumer Google account through the user's own `agy`
//! binary, so ND enforces a conservative local policy: disabled by default,
//! one-shot manual approval per job, hard hourly/daily job limits, a daily
//! token budget from the CLI's own usage reporting, no automatic retries, and
//! a circuit breaker that locks the lane on quota/auth/policy failures until
//! the user re-arms it. These limits are internal budgets, not
//! Google-validated safe thresholds.

use crate::RouterState;
use crate::store;
use crate::types::{
    AGY_DAY_MS, AGY_HOUR_MS, AGY_USAGE_FILE, AgyOutcome, AgyStateRecord, CreateAgyApprovalInput,
    MAX_PENDING_AGY_APPROVALS, RouterError, SetAgyEnabledInput, SetAgyPolicyInput,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{BufRead, Write};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgyCategory {
    Coding,
    Review,
    Translation,
    Test,
    /// Only used when the user turns manual approval off; routed jobs then
    /// carry no declared intent.
    Unclassified,
}

impl AgyCategory {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "coding" | "dev" | "development" => Some(Self::Coding),
            "review" => Some(Self::Review),
            "translation" => Some(Self::Translation),
            "test" => Some(Self::Test),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Coding => "coding",
            Self::Review => "review",
            Self::Translation => "translation",
            Self::Test => "test",
            Self::Unclassified => "unclassified",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgyFailureClass {
    Quota,
    Auth,
    Policy,
    Other,
}

impl AgyFailureClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Quota => "quota",
            Self::Auth => "auth",
            Self::Policy => "policy",
            Self::Other => "other",
        }
    }
}

pub fn classify_agy_failure(message: &str) -> AgyFailureClass {
    let lower = message.to_ascii_lowercase();
    const QUOTA: &[&str] = &[
        "quota",
        "rate limit",
        "rate-limit",
        "too many requests",
        "usage limit",
        "daily limit",
        "weekly limit",
        "exhausted",
        "429",
    ];
    const AUTH: &[&str] = &[
        "authentication",
        "signed out",
        "sign in",
        "reauth",
        "re-auth",
        "login",
        "credential",
        "token expired",
        "not signed in",
        "unauthorized",
    ];
    const POLICY: &[&str] = &[
        "terms of service",
        "suspended",
        "banned",
        "forbidden",
        "access denied",
        "policy",
        "403",
    ];
    if QUOTA.iter().any(|key| lower.contains(key)) {
        AgyFailureClass::Quota
    } else if AUTH.iter().any(|key| lower.contains(key)) {
        AgyFailureClass::Auth
    } else if POLICY.iter().any(|key| lower.contains(key)) {
        AgyFailureClass::Policy
    } else {
        AgyFailureClass::Other
    }
}

#[derive(Clone, Debug)]
pub struct AgyBlock {
    pub code: &'static str,
    pub message: String,
}

/// A permitted agy job. Holding the gate owns the lane's concurrency slot;
/// drop it (or call `agy_finish`) to release the slot.
pub struct AgyGate<'a> {
    pub category: AgyCategory,
    _slot: tokio::sync::MutexGuard<'a, ()>,
}

#[derive(Clone, Debug)]
pub(crate) struct Approval {
    token: String,
    category: AgyCategory,
    expires_at_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgyUsageLine {
    ts_ms: u64,
    #[serde(default)]
    category: Option<String>,
    provider: String,
    model: String,
    ok: bool,
    status: u16,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    block_code: Option<String>,
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
    #[serde(default)]
    class: Option<String>,
}

fn roll_windows(record: &mut AgyStateRecord, now: u64) {
    if record.window_start_ms == 0 || now.saturating_sub(record.window_start_ms) >= AGY_HOUR_MS {
        record.window_start_ms = now;
        record.window_jobs = 0;
    }
    if record.day_start_ms == 0 || now.saturating_sub(record.day_start_ms) >= AGY_DAY_MS {
        record.day_start_ms = now;
        record.day_jobs = 0;
        record.day_tokens = 0;
    }
}

impl RouterState {
    pub fn agy_view(&self) -> Value {
        let guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
        let agy = &guard.agy;
        json!({
            "policy": agy.policy,
            "locked": agy.locked,
            "lockReason": agy.lock_reason,
            "window": {
                "startMs": agy.window_start_ms,
                "jobs": agy.window_jobs,
                "limit": agy.policy.max_jobs_per_hour,
            },
            "day": {
                "startMs": agy.day_start_ms,
                "jobs": agy.day_jobs,
                "jobsLimit": agy.policy.max_jobs_per_day,
                "tokens": agy.day_tokens,
                "tokensLimit": agy.policy.max_tokens_per_day,
            },
            "pendingApprovals": self.agy_approvals.lock().unwrap_or_else(|error| error.into_inner()).len(),
        })
    }

    pub fn set_agy_policy(&self, input: SetAgyPolicyInput) -> Result<Value, RouterError> {
        let mut guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
        let policy = &mut guard.agy.policy;
        if let Some(value) = input.enabled {
            policy.enabled = value;
        }
        if let Some(value) = input.manual_approval_required {
            policy.manual_approval_required = value;
        }
        if let Some(value) = input.max_concurrent_jobs {
            if !(1..=8).contains(&value) {
                return Err(RouterError::bad_request(
                    "maxConcurrentJobs must be between 1 and 8",
                ));
            }
            policy.max_concurrent_jobs = value;
        }
        if let Some(value) = input.max_jobs_per_hour {
            if !(1..=60).contains(&value) {
                return Err(RouterError::bad_request(
                    "maxJobsPerHour must be between 1 and 60",
                ));
            }
            policy.max_jobs_per_hour = value;
        }
        if let Some(value) = input.max_jobs_per_day {
            if !(1..=500).contains(&value) {
                return Err(RouterError::bad_request(
                    "maxJobsPerDay must be between 1 and 500",
                ));
            }
            policy.max_jobs_per_day = value;
        }
        if let Some(value) = input.max_tokens_per_day {
            if value > 10_000_000 {
                return Err(RouterError::bad_request(
                    "maxTokensPerDay must be at most 10,000,000 (0 disables the budget)",
                ));
            }
            policy.max_tokens_per_day = value;
        }
        if let Some(value) = input.approval_ttl_secs {
            if !(30..=3600).contains(&value) {
                return Err(RouterError::bad_request(
                    "approvalTtlSecs must be between 30 and 3600 seconds",
                ));
            }
            policy.approval_ttl_secs = value;
        }
        store::save(&self.store_path, &guard)
            .map_err(|error| RouterError::internal(error.to_string()))?;
        drop(guard);
        Ok(self.agy_view())
    }

    /// Kill switch. Disabling locks the lane immediately (persisted); enabling
    /// is the manual re-arm that clears a user or circuit-breaker lock.
    pub fn set_agy_enabled(&self, input: SetAgyEnabledInput) -> Result<Value, RouterError> {
        let mut guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
        guard.agy.locked = !input.enabled;
        guard.agy.lock_reason = if input.enabled {
            None
        } else {
            Some("disabled by the user (kill switch)".to_owned())
        };
        store::save(&self.store_path, &guard)
            .map_err(|error| RouterError::internal(error.to_string()))?;
        drop(guard);
        Ok(self.agy_view())
    }

    pub fn create_agy_approval(&self, input: CreateAgyApprovalInput) -> Result<Value, RouterError> {
        let category = AgyCategory::parse(&input.category)
            .filter(|category| *category != AgyCategory::Test)
            .ok_or_else(|| {
                RouterError::bad_request("category must be coding, review or translation")
            })?;
        let (ttl_secs, enabled, locked) = {
            let guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
            (
                guard.agy.policy.approval_ttl_secs,
                guard.agy.policy.enabled,
                guard.agy.locked,
            )
        };
        if !enabled {
            return Err(RouterError::bad_request(
                "the Antigravity lane is disabled; enable it in Router Settings first",
            ));
        }
        if locked {
            return Err(RouterError::bad_request(
                "the Antigravity lane is locked; re-enable it in Router Settings first",
            ));
        }
        let mut approvals = self
            .agy_approvals
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let now = store::now_ms();
        approvals.retain(|approval| approval.expires_at_ms > now);
        if approvals.len() >= MAX_PENDING_AGY_APPROVALS {
            return Err(RouterError::bad_request(
                "too many pending Antigravity approvals; use one or wait for expiry",
            ));
        }
        let token = format!("agy_ap_{}", uuid::Uuid::new_v4().simple());
        let expires_at_ms = now + ttl_secs * 1000;
        approvals.push(Approval {
            token: token.clone(),
            category,
            expires_at_ms,
        });
        Ok(json!({
            "token": token,
            "category": category,
            "expiresAtMs": expires_at_ms,
            "pendingApprovals": approvals.len(),
        }))
    }

    /// Gate a routed request before the antigravity lane runs.
    pub fn agy_begin_request(&self, approval: Option<&str>) -> Result<AgyGate<'_>, AgyBlock> {
        self.agy_begin(approval, false)
    }

    /// Gate the provider "Test" button: the click is the human approval, but
    /// every other control (enabled, lock, concurrency, limits) still applies.
    pub fn agy_begin_test(&self) -> Result<AgyGate<'_>, AgyBlock> {
        self.agy_begin(None, true)
    }

    fn agy_begin(
        &self,
        approval: Option<&str>,
        human_action: bool,
    ) -> Result<AgyGate<'_>, AgyBlock> {
        let slot = match self.agy_slot.try_lock() {
            Ok(slot) => slot,
            Err(_) => {
                let limit = {
                    let guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
                    guard.agy.policy.max_concurrent_jobs
                };
                return Err(AgyBlock {
                    code: "agy_busy",
                    message: format!(
                        "an Antigravity job is already running (maxConcurrentJobs = {limit})"
                    ),
                });
            }
        };
        // Verify limits before consuming an approval so an invalid or expired
        // token never burns quota. The slot serializes all agy jobs, so the
        // verify-then-reserve pair below is race-free.
        let now = store::now_ms();
        let manual_approval_required = {
            let guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
            let agy = &guard.agy;
            if agy.locked {
                return Err(AgyBlock {
                    code: "agy_locked",
                    message: format!(
                        "Antigravity lane is locked: {}. Re-enable it in Router Settings → Antigravity.",
                        agy.lock_reason.as_deref().unwrap_or("disabled by policy")
                    ),
                });
            }
            if !agy.policy.enabled {
                return Err(AgyBlock {
                    code: "agy_disabled",
                    message:
                        "Antigravity lane is disabled. Enable it in Router Settings → Antigravity."
                            .to_owned(),
                });
            }
            if agy.window_start_ms != 0
                && now.saturating_sub(agy.window_start_ms) < AGY_HOUR_MS
                && agy.window_jobs >= agy.policy.max_jobs_per_hour
            {
                return Err(AgyBlock {
                    code: "agy_rate_limited",
                    message: format!(
                        "Antigravity hourly limit reached ({} jobs/hour). Wait for the window to reset.",
                        agy.policy.max_jobs_per_hour
                    ),
                });
            }
            if agy.day_start_ms != 0
                && now.saturating_sub(agy.day_start_ms) < AGY_DAY_MS
                && agy.day_jobs >= agy.policy.max_jobs_per_day
            {
                return Err(AgyBlock {
                    code: "agy_rate_limited",
                    message: format!(
                        "Antigravity daily limit reached ({} jobs/day). Wait for the window to reset.",
                        agy.policy.max_jobs_per_day
                    ),
                });
            }
            if agy.policy.max_tokens_per_day > 0
                && agy.day_start_ms != 0
                && now.saturating_sub(agy.day_start_ms) < AGY_DAY_MS
                && agy.day_tokens >= agy.policy.max_tokens_per_day
            {
                return Err(AgyBlock {
                    code: "agy_token_budget",
                    message: format!(
                        "Antigravity daily token budget reached ({} tokens). Wait for the window to reset.",
                        agy.policy.max_tokens_per_day
                    ),
                });
            }
            agy.policy.manual_approval_required
        };
        let category = if human_action {
            AgyCategory::Test
        } else if manual_approval_required {
            let mut approvals = self
                .agy_approvals
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            approvals.retain(|pending| pending.expires_at_ms > now);
            match approval.map(str::trim).filter(|value| !value.is_empty()) {
                None => {
                    return Err(AgyBlock {
                        code: "agy_approval_required",
                        message: "Antigravity lane requires a manual approval token. Create one in Router Settings → Antigravity, then retry.".to_owned(),
                    });
                }
                Some(token) => {
                    let Some(index) = approvals.iter().position(|pending| pending.token == token)
                    else {
                        return Err(AgyBlock {
                            code: "agy_approval_invalid",
                            message: "the Antigravity approval token is invalid or expired"
                                .to_owned(),
                        });
                    };
                    let consumed = approvals.remove(index);
                    consumed.category
                }
            }
        } else {
            AgyCategory::Unclassified
        };
        {
            let mut guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
            let agy = &mut guard.agy;
            roll_windows(agy, now);
            agy.window_jobs += 1;
            agy.day_jobs += 1;
            let _ = store::save(&self.store_path, &guard);
        }
        Ok(AgyGate {
            category,
            _slot: slot,
        })
    }

    /// Record the outcome of a gated job: token accounting, circuit breaker
    /// classification, and the lane's usage log. Drops the concurrency slot.
    pub fn agy_finish(
        &self,
        gate: AgyGate<'_>,
        provider_label: &str,
        model: &str,
        outcome: &AgyOutcome,
    ) {
        let category = gate.category.as_str().to_owned();
        let (class, error) = if outcome.ok {
            (None, None)
        } else {
            let class = classify_agy_failure(outcome.message.as_deref().unwrap_or_default());
            (Some(class), outcome.message.clone())
        };
        {
            let mut guard = self.store.lock().unwrap_or_else(|error| error.into_inner());
            let agy = &mut guard.agy;
            agy.day_tokens = agy
                .day_tokens
                .saturating_add(outcome.prompt_tokens + outcome.completion_tokens);
            // Quota, auth and policy failures trip the circuit breaker: the
            // lane stays locked until the user re-arms it. Transient failures
            // (network, timeouts) keep the normal per-account cooldown path.
            if let Some(class) = class.filter(|class| *class != AgyFailureClass::Other) {
                agy.locked = true;
                agy.lock_reason = Some(format!(
                    "automatically locked after a {} error: {}",
                    class.as_str(),
                    crate::catalog::truncate(outcome.message.as_deref().unwrap_or("unknown"), 200)
                ));
            }
            let _ = store::save(&self.store_path, &guard);
        }
        let line = AgyUsageLine {
            ts_ms: store::now_ms(),
            category: Some(category),
            provider: provider_label.to_owned(),
            model: model.to_owned(),
            ok: outcome.ok,
            status: outcome.status,
            error,
            block_code: None,
            prompt_tokens: outcome.prompt_tokens,
            completion_tokens: outcome.completion_tokens,
            class: class.map(|value| value.as_str().to_owned()),
        };
        append_agy_usage(&self.data_dir, &line);
    }

    /// Record a policy block (disabled, locked, rate-limited, unapproved) so
    /// the dashboard can show why a request never reached the CLI.
    pub fn agy_record_block(&self, provider_label: &str, model: &str, block: &AgyBlock) {
        let line = AgyUsageLine {
            ts_ms: store::now_ms(),
            category: None,
            provider: provider_label.to_owned(),
            model: model.to_owned(),
            ok: false,
            status: 403,
            error: Some(block.message.clone()),
            block_code: Some(block.code.to_owned()),
            prompt_tokens: 0,
            completion_tokens: 0,
            class: Some("blocked".to_owned()),
        };
        append_agy_usage(&self.data_dir, &line);
    }

    pub fn agy_usage_summary(&self) -> Value {
        let view = self.agy_view();
        let path = self.data_dir.join(AGY_USAGE_FILE);
        let mut total = 0u64;
        let mut ok = 0u64;
        let mut failed = 0u64;
        let mut by_category: std::collections::HashMap<String, u64> =
            std::collections::HashMap::new();
        let mut recent: Vec<Value> = Vec::new();
        if let Ok(file) = std::fs::File::open(&path) {
            for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
                let Ok(entry) = serde_json::from_str::<AgyUsageLine>(&line) else {
                    continue;
                };
                total += 1;
                if entry.ok {
                    ok += 1;
                } else {
                    failed += 1;
                }
                if let Some(ref category) = entry.category {
                    *by_category.entry(category.clone()).or_insert(0) += 1;
                }
                recent.push(json!({
                    "tsMs": entry.ts_ms,
                    "category": entry.category,
                    "provider": entry.provider,
                    "model": entry.model,
                    "ok": entry.ok,
                    "status": entry.status,
                    "error": entry.error,
                    "blockCode": entry.block_code,
                    "promptTokens": entry.prompt_tokens,
                    "completionTokens": entry.completion_tokens,
                    "class": entry.class,
                }));
                if recent.len() > 10 {
                    recent.remove(0);
                }
            }
        }
        json!({
            "state": view,
            "summary": {
                "total": total,
                "ok": ok,
                "failed": failed,
                "byCategory": by_category,
            },
            "recent": recent,
        })
    }
}

fn append_agy_usage(data_dir: &std::path::Path, line: &AgyUsageLine) {
    let path = data_dir.join(AGY_USAGE_FILE);
    let Ok(encoded) = serde_json::to_string(line) else {
        return;
    };
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{encoded}");
    }
    if std::fs::metadata(&path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
        > 4 * 1024 * 1024
    {
        prune_agy_usage(&path);
    }
}

fn prune_agy_usage(path: &std::path::Path) {
    let Ok(file) = std::fs::File::open(path) else {
        return;
    };
    let lines: Vec<String> = std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .collect();
    let keep = lines.len().saturating_sub(2_000);
    if keep == 0 {
        return;
    }
    let _ = std::fs::write(path, lines[keep..].join("\n") + "\n");
}
