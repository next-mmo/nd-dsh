# Antigravity CLI safety controls

Local-only, risk-controlled use of the official Google Antigravity CLI (`agy`) in ND Router.
Owner: ND Toolkit. Verified: 2026-11-03.

> These limits are conservative operating defaults, not Google-approved thresholds.
> **Local CLI access and low request volume do not guarantee Google account safety.**

## 1. Scope

The `antigravity` router lane runs the user's installed `agy` binary with
CLI-owned credentials (ND never reads, exports, or refreshes OAuth tokens; it
only points the CLI at an `authorized_user` file the CLI itself reads). This
document covers the safety controls around that lane:

- disabled by default, opt-in from ND Router Settings;
- one-shot manual approval per routed job;
- hard hourly / daily / token budgets with one concurrent job;
- a persisted circuit breaker that locks the lane on quota, auth, or policy
  failures until the user re-arms it;
- no automatic retries, no account rotation, no fallback selection;
- separate, honest accounting per task category.

Out of scope: the interactive ND Chat coding engine (`antigravity-engine.ts`),
which is a human-driven conversation in ND's UI, and any external Google API
usage (AI Studio / Vertex keys are the sanctioned path for unattended work).

## 2. Policy research (verified 2026-11-03)

### Documented / allowed

- Headless mode is an official, documented CLI feature:
  `agy -p`, `--output-format text|json|stream-json`, `--continue`,
  `--json-schema`, and token-usage reporting; the docs show a shell/CI example.
- Approval modes are official; auto mode approves workspace edits and sandbox
  commands by default, and `--dangerously-skip-permissions` is documented with
  a warning.
- CLI versions: 1.3.x existed; the public changelog listed 1.4.12 as latest.
- Google staff replies on the official forum state that calling the locally
  installed binary from your own tooling is acceptable **provided OAuth tokens
  are never extracted or intercepted**, and that "local manual scripting" on
  consumer plans is allowed while "automatic background requests" violate
  consumer terms.
- Paid plans have a "higher weekly rate limit" (Ultra ~5x Pro); no numeric
  request rates are published.

### Explicitly restricted

- Antigravity ToS clause 6: using third-party software/tools/services to access
  the Service (e.g. third-party clients riding on Antigravity OAuth) breaches
  the agreement and can lead to suspension. The FAQ repeats this and directs
  users to Gemini Enterprise / AI Studio API keys instead.
- Automated background requests on consumer plans are described by Google staff
  as against the consumer terms; API keys are the sanctioned path.
- February–September 2026 saw mass 403/TOS bans of paying users running
  third-party OAuth clients; Google later ran an automated unban wave and a
  reinstatement form. A September 2026 ToS update reportedly narrowed the
  penalty scope to Antigravity/Gemini CLI access, but reports of wider account
  disablement exist.

### Ambiguous / unanswered

1. Clause 6's literal text ("third party software, tools, or services to access
   the Service") could be read to cover **any** wrapper that spawns `agy`,
   including ND. The only counterweight is forum staff replies, which are not
   the ToS.
2. "Manual" vs "automatic" is not defined anywhere official. This design puts a
   human approval in front of every routed job, but Google has not quantified
   where tolerated scripting ends.
3. No published numeric rate limits for Pro/Ultra; hard-stop vs soft-throttle
   behavior is undocumented.
4. The exact JSON fields for token-usage reporting are documented as a feature
   but not specified field-by-field; ND parses `usage.input_tokens`,
   `output_tokens`, `total_tokens` and counts 0 when absent.
5. Suspension scope (Antigravity access vs the whole Google account) is not
   stated in the ToS; community reports conflict.

### Sources

- Headless mode: https://antigravity.google/docs/cli/headless/
- Execution modes: https://antigravity.google/docs/cli/modes/
- CLI settings/usage: https://antigravity.google/docs/cli/using/
- FAQ: https://antigravity.google/docs/faq/
- Plans: https://antigravity.google/docs/plans/
- Terms: https://antigravity.google/terms/
- Plan changes blog: https://antigravity.google/blog/changes-to-antigravity-plans/
- CLI changelog (1.4.12): https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md
- Staff thread, headless third-party CLI: https://discuss.ai.google.dev/t/is-it-allowed-for-an-open-source-tool-to-call-the-official-agy-cli-in-headless-mode/183429
- Staff thread, monitoring app on consumer quota: https://discuss.ai.google.dev/t/policy-clarification-private-monitoring-app-using-official-antigravity-cli-and-subscription-quota/190756
- Mass 403 bans & reinstatement: https://github.com/google-gemini/gemini-cli/discussions/20632
- Gemini API terms: https://ai.google.dev/gemini-api/terms

## 3. Account-risk matrix

| Workflow | Category | ND behavior | Residual risk |
| --- | --- | --- | --- |
| Interactive coding in ND Chat (Antigravity engine) | A: development | Allowed; human-driven session, CLI-owned auth | Low; interactive use matches staff-described safe zone |
| Router one-shot job with manual approval (coding / review / translation) | A/B | Allowed only with a one-shot approval token; 1 concurrent, 2/hour, 10/day, 200k tokens/day | Medium; clause 6 ambiguity remains, volume is human-scale |
| Provider "Test" click | A (human-initiated) | Allowed; counts against the same budgets | Low |
| Batch SRT translation via ND REST API (`/api/translate-srt`, `/gpt-web/translate-srt`) | C: automated inference | **Blocked** with HTTP 403; must use local models or authorized APIs | None from AGY |
| Exposed REST prompt runs (`/api/run`, `/gpt-web/run`) | C | **Blocked** for `engine=antigravity` | None from AGY |
| Silent provider fallback / ND production jobs | C | Impossible: unapproved antigravity entries are skipped and recorded as blocked; no automatic route can satisfy the approval gate | None from AGY |
| Account rotation on quota errors | — | Not implemented and prohibited by design; a quota/auth/policy error locks the lane | None |

## 4. Architecture

```
ND Chat / ND Router playground / REST / external apps
                |
                v
        ND Router (/v1, loopback only, bearer key)
                |
        resolve(combo, model)  -> ordered RoutedEntries (priority / round-robin)
                |
        per entry: web lane -> CLI lane -> HTTP lane
                |
        antigravity entry:
          agy_begin_request(approval header)
            |- locked?          -> 403 + record block  -> next entry
            |- disabled?        -> 403 + record block  -> next entry
            |- hourly/daily/
            |  token budget?    -> 403 + record block  -> next entry
            |- concurrency busy -> 403 + record block  -> next entry
            |- approval missing/invalid/expired -> 403 + record block -> next entry
            `- reserve window counters (persisted)
                |
          run: agy --print=... --output-format=json (CLI-owned creds, 135 s cap)
                |
          agy_finish: token accounting, failure classification,
                      circuit breaker on quota/auth/policy, agy-usage.jsonl
                |
          response (or next combo entry on transport failures)
```

State lives in `router-state.json` (`agy` block: policy, lock, window counters).
Approvals are in-memory, single-use, TTL-bound, and lost on restart (fail
closed). Accounting goes to `agy-usage.jsonl` (separate from `usage.jsonl`) so
blocks, categories, and token spend are visible without prompt content.

## 5. Policy defaults

| Control | Default | Notes |
| --- | --- | --- |
| `enabled` | `false` | Lane is inert until the user opts in |
| `manualApprovalRequired` | `true` | One-shot token per routed job |
| `maxConcurrentJobs` | `1` | 1–8 |
| `maxJobsPerHour` | `2` | 1–60, rolling hour window |
| `maxJobsPerDay` | `10` | 1–500, rolling day window |
| `maxTokensPerDay` | `200000` | CLI-reported tokens; 0 disables the budget |
| `approvalTtlSecs` | `600` | 30–3600 s |
| `maxRetries` | `0` | ND never re-invokes the CLI after a failure |
| `maxTimeoutSecs` | `300` | Informational; the process cap is 135 s |

Provider test clicks are implicitly approved (the click is the human action)
but still respect enabled, lock, concurrency, and budgets.

## 6. Operating guide (Windows / Linux)

1. Install the official Antigravity CLI and sign in with the account you intend
   to use. ND only stores the account selector (`AGY_ACCOUNT`) and, for Google
   sign-in from ND, a CLI-readable `authorized_user` file under ND's data dir.
2. Add an `Antigravity` provider in ND Router and connect the account.
   `ND_AGY_BIN` is a developer override for tests only.
3. Open ND Router Settings → Overview → **Antigravity safety**:
   - flip the lane switch on;
   - pick a category (coding / review / translation) and press **Approve one
     job** (valid 10 minutes, single use);
   - the token is shown so other local apps can send
     `x-nd-agy-approval: agy_ap_...`; the playground attaches it automatically.
4. Run the request. Watch **Usage → Antigravity CLI activity** for runs, blocks,
   failures, token spend, and the lock reason.
5. On quota/auth/policy failure the lane locks itself. Read the reason, fix the
   account or wait out the window, then press **Re-arm lane**. Never rotate
   accounts to work around a quota.
6. **Lock now** is the kill switch: it blocks every new AGY job immediately and
   persists across restarts.

Rules of the lane:

- One job at a time, human-approved, low volume.
- No random delays, no artificial coding prompts to mask translation work, no
  account swapping, no retrying quota failures.
- ND never exposes the lane as an OpenAI-compatible endpoint for unattended use;
  the REST API rejects `engine=antigravity`.

## 7. Open questions for Google

1. Does clause 6 treat a local wrapper that spawns the official binary and never
   touches OAuth tokens as "third-party software accessing the Service"?
2. Where exactly is the line between "manual scripting" (staff-tolerated) and
   "automatic background requests" (prohibited) for consumer plans?
3. Are there documented per-hour/per-day request limits for Pro/Ultra, and does
   exceeding them throttle or hard-stop?
4. Which exact JSON fields report token usage, and are they authoritative for
   local budgeting?
5. Does a suspension affect only Antigravity access or the entire Google
   account?

Until these are answered in writing, treat this lane as tolerated-but-unwarranted
and keep usage human-scale.

## 8. Acceptance checklist

- [x] Official CLI only (`agy`, CLI-owned credentials, no token extraction)
- [x] Consumer subscription restrictions documented (this file)
- [x] No unofficial OAuth extraction, browser interception, or MITM
- [x] No public proxy (loopback router only)
- [x] No unattended consumer-account inference (approval + REST block + budgets)
- [x] No enforcement-evasion techniques (no jitter, no rotation, no fake tasks)
- [x] Manual approval functioning (one-shot tokens, single use, TTL, persisted lock)
- [x] Conservative hard limits functioning (concurrency, hour/day/token windows)
- [x] Quota/auth/policy errors stop processing (circuit breaker until re-arm)
- [x] AGY cannot be selected automatically by ND Router (unapproved = blocked)
- [x] Production translation defaults to local/authorized providers
- [x] Tests pass (`cargo test -p nd-router`, router/REST vitest suites)
- [x] Residual account-ban risk disclosed (UI warning + this document)

## 9. Implementation map

- Guard: `crates/nd-router/src/agy_policy.rs` (gate, policy, breaker, usage log)
- Types/store: `crates/nd-router/src/types.rs` (`AgyPolicyRecord`, `AgyStateRecord`)
- Lane gate: `crates/nd-router/src/state.rs` (`chat_with_request`, `run_provider_test`)
- Header: `crates/nd-router/src/http.rs` (`x-nd-agy-approval`)
- RPC: `crates/nd-core/src/main.rs` (`router.getAgyPolicy`, `router.setAgyPolicy`,
  `router.setAgyEnabled`, `router.createAgyApproval`, `router.agyUsage`)
- Service/IPC/preload: `src/main/router/router-service.ts`, `ipc.ts`,
  `src/preload/terminal.ts`, `src/shared/router.ts`
- UI: `src/renderer/src/components/RouterSettings.tsx` (Antigravity safety card,
  CLI activity panel)
- REST block: `src/main/rest-api/rest-api-service.ts`
- Tests: `crates/nd-router/src/tests.rs` (9 safety tests), `tests/router-service.test.ts`,
  `tests/rest-api-service.test.ts`
