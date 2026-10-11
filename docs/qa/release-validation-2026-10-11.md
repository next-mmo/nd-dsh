# 0.1.1 source validation — 2026-10-11

Scope: `codex/release-0.1.1-validation`, starting at `a42d9d0`, against
`main` / `origin/main` at `ee6de97` (28 commits). Validation used the macOS
development app and the user's configured LLM route. This is source-merge
evidence, not approval to distribute a packaged release.

## Changes reviewed

The branch adds LLM-backed translation, translation history and image inputs;
human/AI team collaboration and task handoffs; customizable shortcuts;
launcher media controls; wallpaper discovery/collections; clipboard and vault
extensions; and sandboxed extension web views, including Mini Browser and a
three.js game. Harness remains an upstream submodule, now synchronized to
`d743267388641bc76f17c45ce8b4c231aed1d32c` (`0.2.1-alpha.2`). Its source tree
is clean; ND does not patch upstream runtime implementation.

## Defects fixed during validation

- Corepack selected ND's pnpm version for Harness builds despite `--dir`.
  Build and release-staging calls now run from the upstream package directory
  so upstream's own package-manager declaration applies. The Harness build passed.
- Release payload cleanup rejected macOS staging paths that resolve through a
  filesystem alias. Canonicalizing the root preserves containment checks;
  regression coverage also verifies external directory links are not followed.
- Wallpaper collection tests used Windows-only absolute paths. Temporary
  host-native paths exercise the same production path validation on macOS.
- Reopening a web extension hid iframe controls from accessibility and placed
  them outside the modal focus scope. Each stable portal container now docks
  inside the dialog, using Chromium's state-preserving DOM move operation.
- Task reassignment could detach ownership while an AI run continued. Both
  reassignment mutation paths reject active execution/review handoffs.
- Human submission could overwrite another assignee's work or duplicate an
  existing review. Submission now checks ownership, task status and active runs.
- Human review with a declared checkpoint could never resolve because only AI
  run checkpoints were recognized; approval also left human tasks in review.
  Human submissions now carry distinct revision identities, retain optional
  checkpoint metadata, require the assigned human reviewer, and complete on
  approval. Resubmission receives a fresh revision identity.
- The Team submission form discarded its optional checkpoint input. It now
  forwards the value to the typed mutation contract.

## Completed evidence

| Check | Result |
| --- | --- |
| `pnpm verify` | Passed; product, Harness, ND Pencil and VS Code Git boundaries |
| `pnpm typecheck` | Passed |
| `pnpm test` | 1,557 passed, 36 skipped; 180 files passed, 7 skipped |
| `pnpm build` | Passed |
| Rust formatting, Clippy and tests | Passed for protocol/runtime/core/agent and browser host on macOS |
| `pnpm dsh:build` | Passed for current upstream host, client and web outputs |
| Real app chat | Configured model returned the exact requested validation sentence |
| Real app translation | English-to-Khmer translation succeeded; history retained source and result |
| Real app Mini Browser | Opened a real visible ND browser tab; reopened chrome listed it correctly |
| Web-view keep-alive regression | Unsent address draft and iframe URL survived close/reopen; controls remained in the accessibility tree |
| Company/team workflow | Created local company/project/task, reassigned AI to human with audit reason, started human work |
| Restart and submission | Company, project, active human task and handoff survived restart; submission reached completed |
| Human review regressions | Assigned-reviewer enforcement, checkpoint metadata, approval completion, revisions and duplicate/foreign submission rejection passed |

No automated E2E suite was run for this validation pass, as requested by the
user. Interactive checks used Computer against the real dev app. An earlier
partial automated attempt, before that instruction, is not passing evidence
for this candidate.

## Limits and remaining release gates

ND Pencil runtime build/interactive testing was excluded at the user's request;
its static product-boundary verification passed. This macOS run does not
establish Windows native-host behavior, exact packaged startup, portable
payload completeness, unattended multi-agent delivery or a 24-hour soak.
Those release gates in the existing stability plan remain pending.

One `did-stop-loading` listener-count warning appeared during the earlier dev
session. It was not accompanied by a failed interaction and did not recur in
the restarted smoke session; long-running resource stability remains unproven.

Local test data is intentionally visible in the dev profile: the validation
chat/translation, Mini Browser tab, and `Release Validation` company with its
`Manual smoke check` project and completed task. No credentials or runtime
profile data are included in the Git change.
