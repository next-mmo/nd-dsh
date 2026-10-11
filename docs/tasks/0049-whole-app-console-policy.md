# Whole-app Windows background console review

User requested a review covering all coding providers and desktop helpers after
the earlier browser-specific popup fix.

ND now loads `scripts/nd-background-process.cjs` in its Windows Node runtime
children. The scoped and unscoped Rust spawn adapters inject the preload through
`NODE_OPTIONS`; Harness and capability setup do the same. Electron-as-Node
account commands, workflows, and the development ND Pencil builder additionally
load the policy with explicit `--require` arguments. The policy covers spawn,
spawnSync, fork, exec/execFile and synchronous variants, including ESM consumers.
Inherited standard I/O is forwarded through pipes so console creation can be
suppressed. Scrubbed child environments receive only the policy requirement,
never restored parent credentials. Extra IPC descriptors are preserved.

The shared provider CLI helper also enforces windowsHide, covering direct,
resolved Node shim, and unresolved Windows command-script launches. The shipped
runtime updater now pipes npm output and errors instead of inheriting console
handles. Codex account JS wrappers run in Node mode rather than opening another
Electron GUI. Native account commands clear the Electron Node-mode flag.

## Audit coverage

| Area | Evidence and outcome |
| --- | --- |
| Codex | Official JS wrapper previously lacked windowsHide on native child; now covered by the ND Node preload through CoreSpawn. |
| Claude, Cursor, Pi, ZCode, MiniMax, OpenCode, Goose, JCode, Hermes and other registered CLI adapters | Production adapters share policy-enabled CoreSpawn; helper and model discovery roots already hide/pipeline I/O. |
| Antigravity and ND Native | Direct roots already hide/pipeline I/O; production CoreSpawn remains the managed boundary. |
| ChatGPT Web | Canonical embedded browser; no provider CLI. |
| Harness | Managed subprocesses already hide; optional SSH, Python, sandbox/SDK probes and node-pty cleanup forks had transitive gaps covered by the ND preload. No vendor source patched. |
| Rust process, Git, cleanup | Existing CREATE_NO_WINDOW checks retained. |
| Native terminal | ConPTY/pseudoconsole path preserved. |
| Capabilities, design, OS helpers, workflows, token saver | Direct launches audited; hidden/piped or execFile default pipes. Node setup/workflow/design roots receive policy. |
| Extensions and shipped helpers | MCP children hide/pipeline I/O; Node policy propagates through scrubbed subprocess environments. Browser bridge remains console-free. |
| NSIS and intentional external application/file opening | GUI launcher only; explicit user-selected applications continue to open normally. |

## Verification

Actual Windows tests cover Electron and Node child/grandchild console probes,
fork IPC, ESM imports, explicit false/omitted hide flags, inherited I/O, stdin,
sync output/error behavior, scrubbed environments, path quoting, exit failures,
promisify handles, and documented argument overloads. Independent review found
and resolved null/undefined execFile argument and sync encoding compatibility
regressions. No authenticated provider requests were used.

Synchronous inherited output is forwarded after completion. Synchronous callers
needing input use the input option; interactive input belongs in async pipes or
ND's embedded terminal. Arbitrary native third-party programs that explicitly
create their own GUI/console are outside the Node launch policy; this audit
qualifies ND-managed launch boundaries, not every possible user command.

Integration gates passed: pnpm verify (329 source files, 172 test files), pnpm typecheck, pnpm test (1,286 passed, nine skipped; 157 passed test files), pnpm build, and pnpm release:verify. The full test run initially exposed a missing Electron app fixture in workflow-service tests; the fixture was corrected and the complete rerun passed. Directory packaging passed. The rebuilt EXE passed native-child and browser console probes (GetConsoleWindow = 0); receipts: e2e-results/packaged-provider-console.json and e2e-results/packaged-browser-console.json. Packaged runtime smoke passed in benchmark-results/packaged-smoke/1791042203865: Harness, canonical browser snapshot, bundled codex-cli 0.153.4 through ND Core, Rust PTY marker, Git history, and cleanup of 24 observed owned processes. Normal visible startup was observed for 90 samples with ND visible in all samples and no console windows; evidence: e2e-results/whole-app-startup-console-visible.json. The normal profile briefly reported slow Harness chat listing; this console audit does not establish full public-release readiness or authenticated end-to-end quality across every provider. The owned verification instance was closed.
