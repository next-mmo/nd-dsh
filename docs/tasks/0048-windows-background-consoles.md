# Hide background Windows consoles

User reported repeated terminal windows during normal ND use.

Fixed 11 direct background launch sites in the harness and coding-engine
adapters with `windowsHide: true`, plus Git worktree and verification helpers.
Rust-managed processes and Git now combine `CREATE_NO_WINDOW` with their existing
process-group flag. The taskkill cleanup helper also suppresses its own console.
Piped output and Windows Job Object ownership remain intact. Native embedded
terminals retain their existing ConPTY path.

Validation: 76 focused adapter checks, full typecheck, static verification,
source build, 1,257 unit tests (nine skips), and Rust format/clippy/tests passed.
Two Windows tests invoke the actual managed-process and Git launch paths and
assert the child kernel32 `GetConsoleWindow` handle is zero. Read-only subagent
review found no actionable issues.

Full release staging encountered a missing system Node redistribution license.
The existing licensed runtime staging was reused; only rebuilt ND Core/Agent
binaries and their actual manifest hashes were refreshed. Release verification
passed. The first package retry found a detached agent-browser process from the
owned UI test holding the old executable. Its exact path, PID and creation time
were verified before stopping it and retrying packaging.

The rebuilt directory package passed packaged runtime smoke at
`benchmark-results/packaged-smoke/1791025086091`: bundled core readiness,
Harness gateway ready, actual Git history, embedded terminal output marker,
and cleanup of all 28 observed owned processes. Total launch/check time was
124.9 seconds. Twelve desktop samples observed no newly opened console windows;
the main app window was not visible in those samples, so they are supporting
evidence rather than a full interactive qualification. The actual child
`GetConsoleWindow=0` checks directly establish console suppression at the Rust
launch boundaries.

The updated local build is `dist/win-unpacked/ND-DSH.exe`. This fix does not
establish the separate one-shot Autopilot or public release qualification.

## Follow-up: browser wrapper console

The user still observed a terminal in that build. The first qualification missed
the browser helper's transitive launch: agent-browser 0.34.0's Node wrapper
explicitly sets `windowsHide: false` when spawning its native executable.
ND now uses its own `scripts/nd-agent-browser-cli.mjs` entry on Windows, retaining
the shared BIN/ENTRY/config/session contracts and passing argv and stdio through
with `windowsHide: true`. Upstream source remains unchanged. Packaging requires
and includes the bridge. Both development and packaged Windows defaults use it.

A real second-hop PowerShell child reports `GetConsoleWindow() = 0`, and the
installed native browser CLI version check passes. Full verification, typecheck,
build, and 1,259 tests pass (nine skips). Packaged runtime smoke now also requires
an actual embedded-browser snapshot, covering the helper omitted previously.

The initial bridge used inherited stdio; its Node-only regression passed but an
additional actual packaged Electron probe reported a nonzero console handle.
That bridge was corrected to use child pipes and forward stdin/stdout/stderr.
Libuv suppresses console creation only when stdio is not inherited:
https://raw.githubusercontent.com/libuv/libuv/v1.x/src/win/process.c
New regressions cover both Node and actual Electron. The corrected packaged
probe reports handle zero (`e2e-results/packaged-browser-console.json`).
The intermediate browser-inclusive packaged smoke passed at
`benchmark-results/packaged-smoke/1791026207826`, but does not qualify the final
pipe fix; a fresh package and smoke are required below.

Final rebuilt package passed the actual EXE child-console probe (handle zero)
and browser-inclusive runtime smoke at
`benchmark-results/packaged-smoke/1791026514597`: harness ready, browser snapshot,
Git history, embedded terminal marker, and cleanup of 21 observed owned processes.
Runtime checks took 90.8 seconds, total launch/check 109.9 seconds.
Final full suite: 1,261 passed, nine skipped.
Visible normal launch and the Browser Interactive snapshot button were tested
with Windows Computer Use. No new console windows appeared in 90 startup samples
(ND visible in 89) or 90 snapshot samples. Receipt:
`e2e-results/windows-console-visible-final.json`. These are bounded observations,
supported by the actual packaged child-console regression rather than a claim
about every arbitrary third-party tool users might execute.
Source and packaged bridge SHA-256 both:
`8cd0205ec465cf7be54e324eb08247bdd77248e7f035b56d04c42a0d47e883c7`.
