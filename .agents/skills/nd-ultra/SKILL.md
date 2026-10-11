---
name: nd-ultra
description: Complete substantial ND-DSH jobs with parallel subagents, critical-path scheduling, bounded context, and verified integration across Electron, React, Rust, and engine adapters. Use when the user invokes nd-ultra or requests a parallel agent team or simultaneous work in this repository.
---

# ND Ultra for ND-DSH

Run a coordinated agent team to complete the user's authorized job quickly. This skill explicitly calls for subagents when independent work is available. Preserve the requested outcome and all existing approval, resource, and repository constraints.

Optimize elapsed time and total work while meeting acceptance criteria. This skill controls workflow; it does not enable the product's Ultra intelligence setting or grant access to models. For comparisons with product Ultra, reasoning effort, and latency guidance, read [official guidance](references/official-guidance.md) only when relevant.

## Apply the ND-DSH context

Read the repository's current `AGENTS.md`, its referenced RTK instructions, and any applicable nested contributor guidance before assigning work. Read [ND-DSH coordination](references/nd-dsh.md) for project ownership, shared runtime constraints, and validation routing. Pass the relevant constraints to workers with bounded or no history; a shared checkout alone does not give them those instructions.

Use the active checkout or a suitable attached worktree and preserve existing edits. Keep this project skill named `nd-ultra`; the shared user-level skill is its source, not a file to overwrite during project work. This skill coordinates development of ND-DSH; it does not authorize creating companies, production agents, sessions, or tasks in the product.

## Start and divide

- Recover the current goal, accepted scope, existing changes, task record, and pending verification. Continue existing work instead of restarting it.
- Identify deliverables, prerequisites, shared resources, and the critical path. Start work that unlocks other groups first. Split substantial work into independent groups with concrete outputs; batch tiny related tasks for one owner.
- Launch independent groups when their useful overlap outweighs startup, context, and integration overhead. Use as many slots as help the job; available capacity is a ceiling. Derive it from current tools, leaving the parent to handle integration and useful critical-path work.
- Keep tasks that need unfinished inputs queued. A–Z is a possible backlog, not a requirement to create twenty-six agents. Small indivisible jobs may stay with the parent; prefer batched tool calls for independent simple lookups.

## Give each worker a clear contract

Each assignment should include:

- The user's goal, this worker's deliverable, and acceptance criteria.
- The files or output directories the worker owns, plus protected files and existing edits to preserve.
- Required inputs, dependencies, relevant interfaces, and any exclusive resource such as a live app, port, database, or installation.
- Focused verification and the expected return: changed paths, observable results, failures, and remaining limits.
- A clear boundary for external actions and any missing authorization.

Pass a compact packet of relevant intent, constraints, decisions, paths, and inputs. Use a bounded history fork or no-history assignment for narrow jobs; use full history when necessary to preserve context. Workers return a concise result with evidence and artifact paths, keeping bulk logs outside the parent chat.

Inherit the current model. Respect user-fixed reasoning effort. When supported per-worker effort controls are available and effort is not fixed, this skill permits lower effort for clear bounded execution and deeper effort for difficult diagnosis or review. Choose only supported values; escalate after a concrete quality failure or unresolved complexity. Do not force maximum/Ultra effort on every worker or modify persistent model settings. With tools that require a bounded fork for effort overrides, supply a complete assignment packet in that fork. Report unavailable delegation honestly and continue useful local work.

## Keep parallel work moving

- Use disjoint file ownership or supported isolated worktrees. Agents sharing a checkout must coordinate before changing the same file. Keep one integration owner for shared contracts and central registration files.
- Publish shared interface decisions early so dependent workers can proceed. Ask workers to report material blockers promptly while continuing independent work.
- Reuse workers for related follow-ups. Start a fresh bounded context when a different assignment would carry irrelevant history. Dispatch the next useful ready group without waiting for the whole batch; avoid duplicate investigations and nested trees that exhaust capacity.
- Serialize conflicting writes, installs, schema changes, and operations on the same live resource. Start with one heavyweight local job when contention is unknown; expand concurrency when observed capacity supports it. Throttle jobs sharing CPU, memory, GPU, or disk and provider calls nearing rate limits. File isolation alone does not isolate these resources.
- Batch independent read-only tool calls. Keep mutations with dependencies sequential. Bound tool output, retries, verification, and waits; communicate meaningful progress at least once a minute during active work.
- Track groups as queued, running, blocked, ready for integration, or verified. Describe actual work and tool-observed duration when available; never simulate activity or invent timing or savings.
- Prefer completion notifications or bounded waits to frequent status polling. Interrupt obsolete or duplicated work promptly. Diagnose a failed tool before retrying; if a wrapper rejects a supported command, resolve the intended executable once and use its verified path for the session. Preserve completed outputs instead of restarting a group.

Keep worker conversations within the current task's subagent team. Create or message separate user-visible sidebar chats only when the user explicitly asks for those actions. Delegating subtasks does not itself authorize publication, deployment, account changes, or messages to other people.

## Integrate and prove the result

- Review each worker's files and evidence before integration. Resolve interface mismatches and assign fixes to their owner, keeping unrelated groups moving.
- Require real verification for the combined outcome. For coding, generated source and hashes prove file creation; user-facing app behavior needs appropriate API/UI checks. Installation and public readiness need their own artifact and environment evidence.
- Run the cheapest checks that establish acceptance, including affected regression and integration checks. Repeat only after relevant edits, failures, or unresolved coverage gaps.
- Reuse valid evidence for unchanged behavior and share common build results. The parent reviews changed contracts and integration risks rather than repeating every worker's investigation.
- Use an independent reviewer for substantial integrated changes when capacity permits. Give the reviewer acceptance criteria and current artifacts, rather than a desired verdict.
- If a provider, credential, runtime, or exclusive environment is missing, finish independent authorized work and identify the exact remaining prerequisite. Ask only for inputs or approval that existing authorization does not supply.
- Keep the task's progress and evidence current. Preserve a concise continuation record if interrupted. Apply the repository's actual acceptance requirements before closing tasks or making release claims; do not invent an additional approval gate.

At existing integration checkpoints, assess whether delegation is still helping. If observed coordination, repeated reads, idle dependency waits, or resource contention dominate, combine tiny jobs, reduce fan-out, or reassign the bottleneck. Use task-scoped time/token counters when available; otherwise report specific observed overhead. Account-wide usage and tool-output estimates are not task cost. Avoid adding a benchmark project or repeated telemetry calls to ordinary work.

Finish with the delivered outcome, verification evidence, and material remaining work. Stop completed or obsolete workers; do not leave duplicate jobs running.
