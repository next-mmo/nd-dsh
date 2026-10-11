# ND Translate and coding autopilot stability

Date: 2026-10-03 (Asia/Bangkok)
Status: implementing and validating; public release not yet qualified

Requested scenario: company **ND Team**, mission **Build ND super apps**,
project **ND Translate**. ND Translate installs on demand and uses the native
ND browser with Google Translate by default, ChatGPT and Gemini as alternatives.
Independent tasks should execute in parallel within capacity and actual
dependencies; child agents remain execution sessions under their parent.

Implemented fixes cover long ready queues hidden behind saturated roles,
duplicate plan titles, and shutdown races involving queued work, late permits,
and late session binding. Tests cover a 26-task backlog, dependencies, native
permit ownership, and isolated worktrees.

The translation package is optional, permission-brokered and context-scoped.
The two-pane native UI loads lazily. Provider results are read from owned
embedded browser tabs with bounded deadlines and explicit failures. Text,
source language and target language are validated; stale results cannot replace
a changed input. Provider login, verification and consent remain real barriers.

Initial evidence:

- `pnpm verify`, `pnpm typecheck`, `pnpm build`: passed.
- Combined unit run: 1,168 passed, nine skipped; 149 passing test files.
- `pnpm core:test`: format, clippy and Rust tests passed.
- Extension manifest validation and release configuration check passed.
- Source Electron install/activation/UI/live Google smoke: 3/3 passed.
- Translator chunk: 15.67 KB uncompressed, no new dependencies.
- First real PM scenario failed after 3.1 minutes before task creation:
  a valid final structured plan followed reasoning that quoted the protocol
  tag names; the parser selected the earlier literal-tag text.
- First live ChatGPT smoke exposed selection of a file-upload input as the
  composer. These failures require fixes and fresh checks before qualification.

Generated logs, throwaway profiles and any provider credentials stay ignored.
Evidence paths and final results will be recorded below after reruns. Public
readiness also requires the existing packaged clean-machine and soak gates;
source tests alone cannot satisfy them.

Continued evidence and findings:

- Source verification, typecheck, build and the 1,190-test unit run passed
  after authentication-dialog handling was added (nine unit tests skipped).
- The current lazy translator chunk is 18.11 KB uncompressed; no dependency
  was added. Browser routing restores the draft and clears prior output.
- Live Google host translation and the full UI/open-provider/reopen flow passed.
  Gemini has returned real Spanish output; ChatGPT has returned a real
  `login-required` barrier. Other runs timed out, so AI stability is unresolved.
- Phone authentication dialogs are detected structurally despite an existing
  background composer. Input/source text cannot trigger authentication status.
- The real PM rerun at `e2e-results/pm-fullstack-2026-10-03T04-46-40`
  produced nine tasks and started three independent workers. It failed after
  30.1 minutes with zero integrated tasks, two tasks in review, one execution
  still active and one failed machine check. The test worker imported a
  manifest from an unintegrated sibling worktree. This is failed delivery
  evidence, not a successful one-shot build.
- The PM planning contract now explains per-task verification in isolated
  worktrees and dependencies for tests that import another task's files.
- The driver now selects visible All work before Autopilot, uses actual
  `completedAt` and session-list `items` fields, requires every task's exact
  reviewed checkpoint and integration receipt, checks independent worktree
  overlap and real worker-child lineage, and rejects zero-test results.
- The next scenario reference spells out the real extension manifest layout;
  no prebuilt deliverable or fabricated plan is seeded.

Public qualification remains pending the fresh full delivery result, reliable
provider checks, packaged clean-machine testing and soak evidence.

GPT Web reuse and the next stability pass:

- ND Translate and the existing GPT Web coding adapter now share fixed
  assistant-turn identification. Explicit turn roles work without nested author
  attributes; user prompts cannot supply output. Root content, multiple sibling
  blocks and nested prose preserve the full response without duplicate text.
- The provider-opening UI locks edits while routing. Authorization is rechecked,
  and closing, replacing or unmounting a dialog invalidates its pending callback.
  Focused translation/UI coverage passed; the combined suite passed 1,209 tests
  with nine skips before the subsequent structured-parser repair.
- Verify, typecheck and source build passed. The translator chunk is now
  18.48 KB uncompressed; it still adds no dependencies.
- The real PM run `e2e-results/pm-fullstack-2026-10-03T05-38-20` failed in
  12.1 minutes. Its actual final response contained four task descriptions but
  repeated `tasks` arrays separated by other milestone fields. Ordinary JSON
  parsing retained only the final verifier. Object-local, string-aware array
  repair now preserves all four tasks and their dependencies from that recorded
  response. Fifty focused tests and an independent parser review passed.
  The driver now fails promptly when a completed plan has fewer than two tasks.
- Live full UI tests still exposed a ChatGPT reply-reading timeout despite
  actual Spanish output on the provider page. Fresh isolated probes instead
  returned explicit sign-in barriers. Gemini and Google have returned real
  translations; this state-dependent ChatGPT defect remains under investigation.
- An embedded Chrome-extension fallback is not implemented by this change.
  Existing content scripts can message extension workers, but there is no
  provider-response relay into ND main. A fallback needs an owned extension,
  declared host access, a known provider tab and request-token/origin checks;
  MV3 worker compatibility remains provisional. Content scripts would still
  need the same provider DOM and authentication handling. The canonical
  embedded ND browser remains the production translation route.

The captured failing ChatGPT page proved a different signed-out DOM variant:
`[data-conversation-transcript] [data-message-role="assistant"]` contains
`[data-assistant-markdown]`, with `data-message-complete` and a scoped
`Copy response` control. It had no legacy conversation-turn test IDs. The
shared reader now supports both variants and excludes user content; pending
generation cannot certify completion. Sixty focused backend tests and full
typecheck passed. After rebuilding, the complete five-test source Electron
suite passed in 1.1 minutes, with actual Google, ChatGPT and Gemini Spanish
translations plus the install/activation/UI/provider-routing/reopen flow.
This is a successful source-provider check; signed-out availability is still
provider-dependent. The next real autopilot run is recorded at
`e2e-results/pm-fullstack-2026-10-03T06-04-31` and must independently satisfy
delivery, review, integration, worker-child and parallel-overlap gates.

Final combined unit verification after the transcript and parser fixes:
1,215 passed, nine skipped, 151 passing test files (five skipped files).
Source verification, full typecheck, build, extension manifest validation and
release configuration verification passed. No commit, push or publication
has been performed.

Packaging checks now require the Translate resource in configuration and reject
missing, corrupt or mismatched packaged manifests. Six focused release-policy
tests passed; full release runtime-input verification passed. A fresh local
Windows directory package built with `electron-builder --win --dir`, including
the 884-byte Translate manifest. Its executable, app archive and manifest hashes
are recorded in `e2e-results/nd-translate-packaged-candidate.json`. The combined
suite after those release checks passed 1,219 tests with nine skips. Packaged
UI/provider testing is queued behind the exclusive live autopilot app.

The fresh autopilot plan preserved four tasks, selected All work visibly and
started independent manifest/README workers. Both executions succeeded in
distinct worktrees with 149,758 ms overlap and real delegated children.
README review/integration completed before manifest tests started; its missing
explicit dependency on final verification is still a plan robustness gap,
although no seeded-README race occurred in this run. Manifest review integrated
after 642,243 ms (10m42s), with 117,410 reasoning characters and nine tool
results. The test worker then started against integrated producer changes.
Continuing model reasoning keeps the production idle watchdog alive; there is
no separate per-review elapsed/output budget in the current run contract.
Review prompts also request the configured test command after ND machine
verification. These latency limits are recorded without claiming a deadlock or
changing the active qualification run.

That autopilot run ultimately failed in 43.6 minutes with three tasks integrated
and final verification still in review. The final reviewer repeated `node --test`
despite a passed ND machine gate, hit Windows sandbox `spawn EPERM`, then asked
for `danger-full-access`. No escalation was approved. The native approval is
surfaced through RuntimePrompts rather than organization approvalRequests;
ignored `approval-failure-audit.json` records the scrubbed action/reason.
The reviewer instructions are being corrected to inspect an authoritative
stored verification receipt for the exact checkpoint rather than requiring
another execution. Worker-written tags and truncated summaries cannot establish
trusted machine evidence. Full delivery still requires a fresh qualifying run.

Reviewer repair is now implemented: both actual verification paths store a
structured, optional run receipt through an internal main-process setter.
Review prompts read that field only and match completed execution, command,
workspace and evidence/run/review checkpoint. Worker tags are untrusted;
long prose cannot remove the receipt. Forty-three focused orchestrator/store
tests, full typecheck and independent trust review passed. The fresh run is
`e2e-results/pm-fullstack-2026-10-03T08-38-36`.

Fresh directory-packaged translation testing first failed Google at its
30-second deadline (two UI tests passed, two later tests skipped). A diagnostic
rerun then passed all five tests in one minute, including actual Google,
ChatGPT and Gemini output. Evidence is under
`e2e-results/nd-translate-packaged-ui-rerun`. This local directory package is
not a portable clean-machine or 24-hour soak qualification.

The combined suite after structured reviewer receipts passed 1,223 tests with
nine skips; source verification, full typecheck, build and release runtime-input
verification passed. A fresh local directory package is being rebuilt to match
this code. No live sandbox escalation was authorized or used to turn the failed
delivery into a pass.

The `08-38-36` run was stopped as a superseded diagnostic at 08:50:10 UTC.
Its PM produced nine tasks: four exact producer pairs duplicated across repeated
milestone lists, plus an installation check. Read-only `host-contract.md` scopes
also prevented the independent manifest and README workers from overlapping.
This run does not qualify delivery. Its stop state and duplication audit remain
in the ignored evidence directory.

Recovery now removes exact full-object task copies across recovered milestone
lists, retaining their final milestone ownership. This repair is enabled only
when the parser detects repeated JSON list keys; ordinary intentional duplicates
remain distinct. Numeric dependencies fail rather than silently changing targets.
The actual malformed plan replays as five tasks with title dependencies preserved.
PM instructions now reserve work scopes for writes and require verification tasks
to depend on every authoring task whose files they inspect. Nineteen normalizer
tests and thirty orchestrator tests passed, followed by full typecheck and an
independent recovery review. The fresh untouched run is
`e2e-results/pm-fullstack-2026-10-03T08-55-39`.

Packaged provider results above describe the earlier tested artifact. The existing
candidate receipt is historical until the latest source is repackaged and its
hashes recorded. Google normally supports signed-out translation; successful
ChatGPT/Gemini checks establish those sessions only. They do not establish
universal availability without login. ND's Chrome extension loader is available,
but a controlled provider response bridge has not been implemented or qualified.

Combined validation after repeated-task recovery passed 1,232 tests with nine
skips; verify, full typecheck, source build and release input verification passed.
A matching local Windows directory package built successfully; executable,
archive, translator manifest and source-main hashes are recorded in
`e2e-results/nd-translate-packaged-candidate-2026-10-03T09-03.json`.

The `08-55-39` untouched run failed after 8.4 minutes in PM planning with no tasks.
Its durable journal records an interrupted `turn/end` at 08:59:12 UTC and
`session/end-seed` at 08:59:22; session listing reports stopped, while the
organization run stayed running. No translation or delivery gate passed in this
run. The orchestrator currently depends on a separate stopped-status frame and
does not finalize the interrupted terminal journal event; PM plans also lack the
execution/review idle watchdog. This lifecycle gap is under repair, with the
failed evidence preserved. Do not treat these local packages as public-ready.

The matching directory package passed all five live translator checks in 1.1
minutes (`e2e-results/nd-translate-packaged-current-live`): on-demand installation,
activation denial, provider controls, actual Google output, provider navigation
and draft restoration, and actual ChatGPT/Gemini output. The initial UI-only run
passed two tests with three explicitly skipped provider tests and is not the live
result. Runtime diagnostics identify an unexpected harness child SIGTERM at
08:59:17 UTC, followed by automatic restart; no evidence attributes that stop to
human navigation. Crash recovery produced the interrupted journal evidence,
while the organization run remained active. Harness status recovery must release
affected runs even when recovered journal snapshots are adopted silently.

The same directory candidate also passed the packaged runtime smoke at
`benchmark-results/packaged-smoke/1791018445212`: bundled Rust core capabilities,
authenticated harness gateway, actual terminal marker and Git workspace were
verified, with owned-process cleanup. This is a local bundled-runtime check;
portable clean-machine installation and the required 24-hour soak remain pending.

The lifecycle repair adds strict interrupted-terminal handling in the
orchestrator and an adapter notification for each known running session on an
unexpected harness exit. Normal terminal events do not imply success;
cancellation remains authoritative, failed execution uses existing rollback,
and interrupted reviews retain their evidence for another review. Forty-six
combined lifecycle/orchestrator checks and full typecheck passed.

Two actual process-exit probes (`09-13-44` and `09-16-07`) then failed to release
the PM within 20 seconds. The second waited for running harness status, a running
session and an actual persisted turn/start before terminating the identified
owned child. Its exit was still classified `expectedStop=true`. This exposes
shared stop-state across overlapping launch/close operations; it is a failed
integration check, not successful recovery. The adapter classification is being
corrected before another qualifying one-shot run. Fault probes record
`kind: pm-runtime-interruption` and never substitute for full delivery gates.

Expected shutdown intent is now recorded per child process rather than inherited
from a service-wide stop flag. Launch generations stop canceled preparation from
spawning or publishing late; requests for a newer workspace wait for the old
canceled launch, while superseded requests fail. Late close cleanup cannot clear
a replacement runtime's tracking. Seventeen lifecycle checks, full typecheck,
source build and independent adapter review passed. The combined suite passed
1,252 tests with nine skips.

The `09-25-19` real fault probe passed interruption release (run failed in 62 ms,
observed within 281 ms) but failed its UI selector, so its overall receipt remains
failed. The corrected `09-28-49` probe passed all checks: accepted PM turn,
identified owned-child termination, prompt failed-run release, automatic runtime
recovery, and an enabled visible PM plan button after selecting Company Workspace.
This proves fault handling only. The fresh delivery attempt is
`e2e-results/pm-fullstack-2026-10-03T09-30-23`. Earlier packaged provider/runtime results still
refer to the candidate before these lifecycle changes.

A directory package matching the lifecycle fixes built successfully; its
executable, archive, optional manifest and source-main hashes are recorded in
`e2e-results/nd-translate-packaged-candidate-2026-10-03T09-34.json`.
The untouched `09-30-23` run has spawned and completed a genuine planning child
session. This is planning delegation, not the required completed-worker child or
successful delivery proof. Provider/runtime checks on this exact candidate wait
for the exclusive live run to finish.

Driver review identified an eight-minute PM stall based only on task/status
changes, which could reject active reasoning. Future runs retain the twelve-minute
absolute planning cap and explicit failed/unusable-plan checks, with that
status-only PM stall removed. The running attempt was not modified. Fault probes
now also assert that the recovered gateway lists the original session stopped;
the earlier fault pass predates that additional assertion.

The `09-30-23` delivery attempt ended after seven minutes with a successful PM
plan and no workers started. It produced three tasks with correct write scopes:
manifest and README independent, tests depending on manifest. PM delegated and
collected a real planning child. The driver then failed clicking the visible
All work option: pointer actionability reported unstable layout and DOM
detachment. This is a failed setup step, not delivery proof. The corrected driver
selects Company Workspace and Work explicitly, then uses ordinary Home/Enter
keyboard selection for the first All work menu entry and verifies persisted
scope. No force click or hidden state mutation is used. Failed runs now retain
UI screenshots and bounded visible text. The fresh attempt is
`e2e-results/pm-fullstack-2026-10-03T09-39-51`.

The `09-39-51` attempt failed after 4.7 minutes at the persisted All work
selection, with a valid five-task plan and no builders started. Radix queues
keyboard focus asynchronously; the driver now waits for the target option to
have focus before pressing Enter, for both All work and Autopilot. A diagnostic
using that failed run's real saved profile passed both navigation checks and
kept autonomy at level 2, with no workers started. Its receipt is
`e2e-results/pm-fullstack-2026-10-03T09-39-51/menu-diagnostic.json`; it is not fresh
delivery evidence.

Cancellation during interruption rollback previously performed cleanup twice.
Cancellation now joins the existing interruption finalization, keeps the
explicit cancellation reason and suppresses automatic retry. Deferred regressions
cover both event orders at autonomy 4, including late terminal/status frames;
rollback, blocking, completion and release each occur once. Fifty focused checks
and typecheck passed. The combined suite now passes 1,254 tests with nine skips;
static verification and the source build passed. Independent review could not
run because the reviewer hit an account usage limit, so its result is not claimed.
The fresh rebuilt delivery attempt is
`e2e-results/pm-fullstack-2026-10-03T09-52-29`.

That attempt exposed reasoning contamination: an `assistant/chunk` with
`chunk.type=reasoning-delta` repeated the complete schema and materialized the
placeholder task `...` before final answer text. The parent canceled this obsolete
qualification run through the ordinary organization cancellation API; the abort
is recorded in its `qualification-abort.json`. It is not successful delivery.
The first diagnostic CDP connection timed out before issuing cancellation; a
direct connection to the existing renderer then completed cancellation.

Typed reasoning now contributes no text to plan/review parsing or worker
summaries. New regressions prove a complete reasoning schema creates no tasks,
final answer text creates the real task, and a reasoning PASS cannot override a
final reviewer FAIL. Full typecheck and the combined suite pass: 1,256 tests,
nine skips. The directory package fingerprint at
`e2e-results/nd-translate-packaged-candidate-2026-10-03T09-55.json` predates this
parser fix and is superseded for final-candidate qualification.

The rebuilt directory package with both cancellation and reasoning fixes is
fingerprinted at
`e2e-results/nd-translate-packaged-candidate-2026-10-03T10-04.json`.
The fresh source delivery attempt is
`e2e-results/pm-fullstack-2026-10-03T10-02-06`; its source-main fingerprint is
recorded separately. Live packaged checks are queued behind this exclusive app.

The `10-02-06` fresh delivery attempt failed after 11.3 minutes: the PM ended
without a structured final plan. No builders started. Its failed summary is
retained; the one-shot claim is still unqualified.

User-requested Windows Computer Use tested the rebuilt directory package with
a fresh throwaway profile. Setup installed the optional manifest and activated
Personal through the trusted API; launcher navigation, provider/language
selection, text entry and Translate were exercised in the real Windows UI.
Google translated `Hello world` to Spanish `Hola Mundo` and displayed Translation
ready. ChatGPT reported sign-in required with no fabricated result. Gemini
returned `Hola, mundo`, but included a heading, explanations and suggested
follow-ups, which is a translation-output quality issue. No login or verification
barrier was automated. These observations are retained in
`e2e-results/nd-translate-computer-verification.json`, matched to the `10-04`
package fingerprint. This establishes a working Google path, not public readiness
or successful one-shot coding delivery.
