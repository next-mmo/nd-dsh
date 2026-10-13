---
name: nd-real-extension-via-nd-app
description: Build a useful real ND extension by managing ND's own agent through its desktop UI, while testing ND workflows, finding product bugs, requesting repairs inside ND, and verifying the resulting extension. Use when the user wants a human-style ND app exercise that produces an actual extension; ordinary direct repository implementation uses create-extension instead.
---

# Real extension work through ND

Act as the human product owner, operator, reviewer, and tester of ND. ND's agent
does the implementation. Produce two outcomes: a usable extension for the user's
real job, and evidence about whether ND can reliably deliver it.

## Engine and execution boundaries

- Start with **ND's configured default agent/engine and provider route**. Do not
  select agy, Codex, another CLI, or a model merely because it worked in a prior
  session. An alternative engine is appropriate only when the user requests or
  authorizes it. Preserve existing credentials and configuration.
- Use Computer (`cua_repl`) to operate ND's desktop UI: create the project/task,
  submit prompts, inspect progress, use its terminal, install/activate packages,
  and test the extension. Use the currently documented API and fresh UI state.
- Do not bypass ND by writing extension or ND repair code directly through
  Codex file tools, running an external coding agent, calling private IPC, or
  injecting JavaScript into the renderer. Ask ND's agent to implement repairs.
- Read-only repository inspection is useful for independent review and checking
  claims. Prefer ND's Files/Source Control/terminal for inspectable evidence;
  ordinary read-only file tools may supplement it. Dev start/restart/build
  infrastructure may be managed from the shell when needed to run the app.
- Test the visible app with Computer. Do not substitute Playwright/E2E, a hidden
  automation browser, or mock production sessions for this workflow. Use ND's
  canonical embedded browser if the job needs browsing.

## Define and commission a real job

Read repository `AGENTS.md` and [create-extension](../create-extension/SKILL.md).
Tell the user when applying these skills. Follow the extension authoring contract;
do not copy its whole specification into this skill.

Translate the user's idea into a small useful release with observable acceptance
criteria. Specify the actual inputs, actions, persisted results, lifecycle,
failure behavior, and limits. Identify how a user will benefit after testing.
Use clearly labelled disposable QA records, not personal credentials or bank data.

Default to an optional external package with Personal activation and dev Discover
availability unless the user requests another delivery model. Do not silently
promote an experiment into release packaging.

Create a company/project/task through ND when those flows are being exercised.
Bind the correct workspace, assign a role, confirm the chosen default engine,
and save enough detail that a new worker can finish without relying on this chat.
For a smaller job, a normal ND agent chat is sufficient.

The commissioning prompt should include:

- User purpose and concrete acceptance criteria; request implementation, not just
  a plan or a final message claiming completion.
- Workspace and package location, delivery/context choice, relevant instructions
  and closest existing example.
- Broker permissions, host descriptors/handlers, narrow IPC, sandboxing, and
  native capabilities needed by the feature.
- Persistence, date/time, deduplication, activation/uninstall, invalid-input, and
  error cases relevant to the job.
- Required validation: extension validation plus repository verify, typecheck,
  tests, build, and applicable Rust checks. No hidden browser/E2E for this exercise.
- Preserve unrelated changes and secrets; do not commit, push, publish, or merge
  unless those actions are already within the user's authorized scope.
- Report changed files, actual check results, install/use steps, and limitations.

## Manage ND as a human would

Observe progress rather than treating a spinner or tool count as evidence of
success. A command appearing in chat does not establish its exit status. Look
for saved edits, meaningful test outcomes, and the task's final state.

If the agent repeats discovery or experiments without producing a patch, narrow
the next prompt to the known files and one concrete defect. Stop the current turn
through ND if necessary, preserve its work, and give a focused implementation
request with the expected behavior and regression case.

When ND blocks the job:

1. Capture the exact UI error, context, engine, task/attempt, workspace, and
   relevant Git status. Distinguish provider errors from adapter, task dispatch,
   worktree, UI, and feature failures.
2. Ask the ND agent for a focused repair. Do not blindly reset, clean, delete
   worktrees, or restore files over unknown edits. Establish what is recoverable.
3. Review the repair independently and require a test tied to the observed bug.
4. Restart only when needed to load main-process changes. Confirm the actual
   process/window and build being tested; a restart can lose an in-memory engine
   chat even when company/task state persists.
5. Retry the original action and verify the result. Passing a unit test alone
   does not prove the dispatch path works.

Keep retries bounded by evidence. If company orchestration remains stuck, a
normal **ND default-engine chat** may continue the extension after preserving
work and explaining the change. Record the company-flow defect as unresolved;
do not call the company task successful because another path delivered code.
If the configured LLM cannot execute, investigate its existing setup first. Ask
for an authorized alternative when needed; do not silently install or switch CLIs.

## Review, install, and verify

Read the real diff while ND implements. Send concrete findings back through ND:
trigger, observed failure, expected behavior, and a meaningful regression test.
Avoid patching the code yourself to make the exercise appear successful.

Install from Discover or the intended folder flow, activate in the correct
context, and open from its launcher command. Confirm context gating: a Personal
command may correctly be absent while the launcher targets a project.
Update/reinstall the package after shipped UI assets change; restarting the host
alone may leave an older installed package snapshot.

Test the real acceptance path with Computer, including:

- Create/edit/use the main feature; invalid-input and failure feedback.
- Close/reopen and full restart persistence, using the same ND user-data profile.
- Relevant boundary cases (for example month-end and leap-day renewal dates).
- Activation/deactivation, pause/cancel, or uninstall effects where applicable.
- Real privileged effects, such as OS notification receipt, rather than an
  in-app toast. Separate API submission, OS acceptance, and visible presentation.

Use [lessons from Pay Guard](references/pay-guard-lessons.md) for subscription
reminders, native desktop notifications, or worktree-cleanup failures. These are
conditional lessons, not a requirement to choose Pay Guard or agy again.

Before completion, require actual gate results and distinguish ND-reported
results from independently observed evidence. Inspect the diff for unrelated
concurrent work and secrets before any authorized commit. Re-run affected checks
after fixes; do not rely on checks for an earlier code revision.

Deliver the usable extension and a concise account of ND defects found/fixed,
remaining blockers, verified behavior, and limits. Leave QA records inactive
when possible without destroying user data. State whether work is committed or
merged. Do not claim merge readiness while required checks or product blockers
remain unresolved.
