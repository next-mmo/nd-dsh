# Current-feature release stability — 2026-10-01

Scope: Windows x64 portable private beta 0.1.1. Stabilize the currently exposed
features; keep ND Agent's private selection gate and existing capability
boundaries. No new product features or public-distribution claim are included.

## Candidate and evidence

The starting application source is `main` at `5a2f9cc`. Release-test hardening
and tester documentation are being prepared on `codex/release-0.1.1-stability`.
The effective Harness checkout is `21638c56315a` (`0.1.7-rc.2`), matching
`vendor/deepseek-harness.json`. The starting root Git index references a different
Harness commit; this branch reconciles the gitlink with the effective checkout
and metadata. No upstream runtime source was patched.

The completed baseline consolidated receipt is:

`e2e-results/beta-automated-2026-10-01T03-52-09-063Z/beta-automated-summary.json`

The baseline finished FAIL at packaged smoke. This run started before the release-test additions below. Its recorded root
commit identifies the starting source; it must not be presented as attestation
of a later clean candidate commit. Raw local receipts and profiles are ignored
by Git. This report records reviewed outcomes without copying credentials or
trial data into the repository.

## Completed checks

| Check | Result | Scope |
| --- | --- | --- |
| Static verification | Pass | ND product, runtime, ND Pencil, and source-control boundaries. |
| TypeScript type checking | Pass | Rechecked after release-test additions. |
| App unit/integration suite | 1,117 passed; 9 skipped | Includes runtime, terminal startup, approval, and bounded artifact hashing. Five temporary build-staging tests were removed with that obsolete helper. Initial sandbox failures cleared under normal Windows test permissions. |
| Rust core gate | Pass | Formatting, Clippy, and ND protocol/runtime/core/agent tests, including cancellation and restart contracts. |
| Browser native host gate | Pass | Formatting, Clippy, and the duplex-pipe contract. |
| Browser platform focus | 26 passed | Lease, policy, history, token, and extension coverage. |
| Production build | Pass | Rechecked after the approval-card fixes. |
| Full desktop acceptance suite | 60 passed; 3 skipped; exit 0 | Includes real model delivery, journal restart, isolation, launcher, terminal, ND Home, and extension tests. The long soak and two opt-in ad-block probes were skipped. |
| Explicit 3-company × 2-project matrix | Pass | Switching, forged ownership rejection, and full restart. |
| Release-test regressions | 23 passed | Runtime peers, target/profile isolation, exact-package evidence, and actual soak duration. |
| Real-user production journey | Pass; 19 gates passed | Three companies, five projects, three model routes, peak five parallel runs, and restart during active work. Its separate existing-suite gate was not rerun inside this journey; the baseline desktop suite passed independently. Source target. |
| Approval/question UI regressions | 3 passed; exit 0 | Includes raw JSON argument redaction, independent sessions, duplicate-submit prevention, and retry after transport failure. Source target; fourteen Windows descendants were observed and cleared on the latest run. |
| Portable artifact selection | 3 passed | Old packages cannot satisfy current-version smoke tests; absent or ambiguous artifacts fail closed. |
| Multi-model production stress | Completed; supervised | Seven tasks reached 100% in 46.1 minutes with three model routes and peak two concurrent runs. Two explicit driver interventions were required: retry one blocked task and resume after the MVP milestone. This is not unattended reliability evidence. Source target. |
| Generated stress project | 27 tests passed; build passed | Independently checked the produced application's tests and production build. |
| Browser/core/task benchmarks | Pass | Browser runtime proof, core contract, and committed task baseline. |
| Baseline portable build | Pass | Packaging completed, but its smoke failed; this artifact is not an approved release. |

The baseline desktop fixture did not enumerate descendants on Windows. Its
`descendantsBefore=0` logs establish no Windows descendant-cleanup claim. The
new fixture enumerates process ancestry and compares start-time identities;
subsequent desktop checks exercise this stronger contract.

## Latest packaged checkpoint

The clean candidate at `25c5524` passed verification, type checking, all
1,112 unit tests, Rust/browser gates, and the portable build in
`e2e-results/beta-automated-2026-10-01T06-24-04-663Z/beta-automated-summary.json`.
The portable smoke timed out; later acceptance stages did not run. A fresh
launch of its exact extracted payload identified 24 missing upstream runtime
peer packages. Bundled plain Node started correctly, but the required Harness
agent-loop plugin could not import its peer contracts. That artifact is rejected.

ND release staging now packs the missing upstream peers without changing
upstream implementation and audits dependencies throughout the staged closure.
A diagnostic unpacked build passes fresh-profile Harness gateway, Rust terminal,
Git history, and cleanup checks:
`benchmark-results/packaged-smoke/1790838904169/driver-result.json`.
Twenty-seven owned descendants were observed and cleared. This diagnostic
build is not an exact-portable release attestation.

The bundled ND Pencil check also passes actual rectangle input, save/reopen,
context isolation, sandbox settings, and graceful cleanup of twelve descendants.
It is now included in `e2e/nd-pencil.spec.ts` for packaged acceptance, and
`nd-pencil` is required in the three-layer release matrix. No failed trial
assertion is treated as a product defect or passing evidence.

A diagnostic build ran out of disk space after accumulated extraction copies.
Those failed copies were removed after checking their ownership and process
state. Release validation now checks disk headroom before packaging.

The user will perform the Human candidate checks. Their agreement to test is
not a Human PASS or release GO. Fresh exact-portable validation, repeated
scenarios, the full 24-hour soak, and the Human decision are pending.

The next consolidated attempt at `3a7f1b6` stopped on two real-Git test
timeouts before packaging. Both files passed together (eight tests), and the
full suite passed with four workers (1,116 passed; nine skipped). Vitest's
default used up to fifteen workers on this host, each able to spawn additional
processes. The suite now caps workers at four to limit resource contention;
assertions, product concurrency coverage, and test deadlines are unchanged.
The failed receipt is retained at
`e2e-results/beta-automated-2026-10-01T07-46-33-835Z/beta-automated-summary.json`.

The default portable built at `e297a2d` also hit the 240-second startup deadline
before Electron opened. Its launcher was still making a second copy of the
27,654-file payload despite sufficient disk space. A direct NSIS extraction
diagnostic passed in 165 seconds, including bundled Harness readiness, the
Rust terminal marker, Git history, and cleanup of 25 observed owned processes:
`benchmark-results/packaged-smoke/1790843960607/driver-result.json`.
This diagnostic used a temporary short build path and stored payload; its
1.6 GB executable is not yet the final clean-candidate attestation.

The consolidated run at `2a40102` passed all local checks but failed portable
packaging; later stages did not run. Its receipt is retained at
`e2e-results/beta-automated-2026-10-01T09-07-26-418Z/beta-automated-summary.json`.
A separate direct-file retry failed a Windows directory rename. The compressed
upstream portable with a shorter extraction directory also timed out while
making its second runtime copy. Neither trial establishes release readiness.

ND now uses electron-builder's supported custom NSIS script for a portable
launcher. It extracts one embedded archive directly into the launch's unique
plugin directory, forwards arguments, waits for ND, preserves its exit code,
and cleans that directory after exit. It creates no installation registry
entries or shortcuts. This avoids both the duplicate runtime copy and the
temporary build-directory move. The stored-archive diagnostic passed in 199
seconds with a ready Harness gateway, the Rust terminal marker, Git history,
and cleanup of all 28 observed owned processes:
`benchmark-results/packaged-smoke/1790847993538/driver-result.json`.
The final configuration compresses the archive and requires a fresh clean
candidate run. The builder's bundled 7-Zip inspects the exact embedded payload.
Artifact hashing uses bounded chunks; the startup deadline remains 240 seconds.

## Continuation on merged main — 2026-10-02

The release and lightweight-payload changes have merged into `main` at
`3936fef`. Validation continues on `codex/release-0.1.1-validation`. The local
Harness checkout differed from its recorded provenance, so `dsh:update` synced
upstream `master` to `639ed0153972` (`0.2.0-rc.2`) and refreshed the gitlink and
metadata together. No upstream implementation source was changed.

The clean candidate at `2149288` passed static verification, type checking,
all 1,122 unit tests (nine skipped), Rust core and browser-host gates, the
26-test browser platform focus, and the production renderer build. Its receipt
is `e2e-results/beta-automated-2026-10-01T16-42-11-537Z/beta-automated-summary.json`.
The run finished FAIL during portable staging; packaged smoke, desktop
acceptance, live journeys, and benchmarks did not run. No current-version
portable artifact was produced.

The bundler consumed ignored `lib/types` output from the removed upstream
`settings-file` package, which still imported the old `SettingsProvider` API.
Upstream's supported cleaner removed 334 generated-output paths, including
that orphan, and left the upstream source tree clean. ND's build adapter now
calls that boundary-checked cleaner before the native, host, and client builds
so submodule updates cannot silently reuse deleted-package output. A fresh
candidate build must verify the fix; cleanup alone is not packaging evidence.

This host's Node.js installation omitted the redistribution license required
by release staging. Validation uses the complete official Node.js `24.16.0`
Windows x64 distribution under ignored `.release/tools`. Both its archive and
the installed binary were checked against the version's official SHA-256
manifest; the binary matches. The bundled license requirement remains intact.

## Release-test hardening

- Launchers accept `ND_DSH_E2E_EXECUTABLE` for a packaged target, reject an invalid
  path, record its SHA-256 identity, and force a disposable user-data profile.
- The consolidated release runner builds the package before acceptance tests,
  extracts the app directly from that portable for Playwright attachment, and
  passes that app to desktop and live journeys. A hash manifest checks all
  extracted files and ties each launch to the original portable's SHA-256;
  the portable launcher itself receives a separate runtime smoke. The runner
  checks a clean source commit before and after every stage, verifies the
  extracted payload again at completion, and requires the portable hash to match.
- Packaged smoke selects exactly one current-version portable executable instead
  of selecting an arbitrary old executable left in `dist`.
- The live production journey can target the package and records its identity.
- The soak records whether the runtime is packaged, which executable was used,
  actual start/end times, and successful cleanup before writing a PASS receipt.
- `release:soak` requires a package and at least 1,440 minutes. The soak wrapper
  defaults to 1,440 minutes; explicit shorter diagnostic runs remain possible
  through `e2e:beta:soak` and cannot satisfy the release gate.
- The final gate rejects a short actual soak, a source-checkout soak, and evidence
  naming a different artifact, even if its requested duration says 24 hours.
- Windows desktop teardown enumerates real descendants instead of treating an
  unsupported inventory as an empty process tree. Inventory errors fail closed;
  Windows command lines and environment values are not logged by this helper.
- Teardown closes all of the verified-dead Electron child's transport pipes,
  including Playwright's extra descriptors. Process start chronology prevents
  stale parent PIDs from misattributing unrelated compiler helpers.
- Approval and question replies remain disabled while their response is pending.
  Failed responses remain retryable. Cards resolve context from their own session
  rather than the currently selected company/project and can show correlated tool
  arguments with common credential forms redacted.
- Raw JSON tool-argument strings are parsed before field-name redaction.
- Clean-profile packaged testing exposed Harness's rejection of Electron
  43.4.0's run-as-node fingerprint. Release staging now bundles the plain Node
  executable used to validate the Harness closure, its redistribution license,
  and its version/hash provenance. Packaged tests strip developer runtime
  overrides, and packaged smoke requires a responding Harness gateway.
- ConPTY can emit its startup cursor query before terminal creation returns.
  The terminal manager now recovers that query from the native retained tail;
  a regression exercises output emitted before listener attachment.
- Packaged smoke uses fresh per-run receipt paths, explicit disposable profiles,
  bounded extraction/startup and directory-lock retries, observed process
  identities, and a final driver receipt only after successful cleanup.
- The autonomous model driver uses a fresh disposable Git workspace by default
  and refuses to seed a nonempty non-Git directory.

## Remaining release evidence

The baseline portable smoke and a clean-environment extracted-app smoke failed.
Both observed a terminal stalled at ConPTY's startup query; the latter also
reported the incompatible Harness runtime fingerprint. An earlier extracted-app
smoke passed its functional checks but failed workspace cleanup, so it is not a
passing release receipt. The dependency-closure diagnostic now passes; fresh exact-portable packaging
and acceptance tests remain pending. The final candidate
must be frozen and rechecked after any fixes. The [tester guide](../private-beta-tester-guide.md)
documents prerequisites, recovery, rollback limitations, and current boundaries.

The [beta release gate](../plan/beta-release-gate.md) also requires a packaged
journey, repeated-scenario evidence, clean-machine testing, real Chrome Companion
permission/capture checks, failure drills, a genuine 24-hour soak, and a human
release-owner decision. None of those pending outcomes is filled with sample
data or marked passed here. The candidate is not yet approved for distribution.
