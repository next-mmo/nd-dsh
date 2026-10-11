# ND Team Workspace Competitive Reference

Status: **active reference for PRD 0009**
Reviewed: **2026-09-29**

This document is a maintained product reference, not a clone list.

ND should study products that are already proving pieces of the human + AI workspace market, then compete through a different architectural combination:

> **local-first human + AI work OS, General + Coding in one desktop, multi-engine/BYOK, isolated task execution, explicit approvals and extensible local capabilities.**

## Strategy: stabilize first, inspire second

ND will **not chase competitor features during the local milestone**.

The order is:

```text
1. Make ND local stable
2. Prove the full workflow offline
3. Pass restart/recovery/security/review gates
4. Re-check reference products
5. Select only the strongest proven ideas
6. Adapt them to ND's architecture
7. Add them without weakening local-first guarantees
```

A competitor launch does not automatically become an ND task.

A reference idea should only enter implementation when all of these are true:

- it solves a real ND user/workflow problem;
- it fits the existing ND control-plane model;
- it does not make cloud mandatory for local core;
- it does not weaken task isolation, policy, approval or audit guarantees;
- it can be implemented without creating a parallel source of truth;
- it has a concrete acceptance scenario and evidence plan.

This makes the competitive reference set a **design library and future radar**, not a moving backlog.

### Later combination model

After the local gate, ND can intentionally combine the best patterns:

```text
Asana
  shared human + agent work graph
        +
Linear
  low-friction task/mention/comment UX
        +
GitHub Agent HQ
  agent mission control + code review visibility
        +
Codex
  parallel coding-agent/worktree supervision
        +
Microsoft Copilot
  General + Code + persistent teammate convergence
        +
ND
  local-first + engine-neutral + explicit governance
  + extensible desktop + isolated execution
```

The result should feel like ND, not like five products glued together.

## Reference products

| Product | What it proves | What ND should learn | Where ND should differentiate |
| --- | --- | --- | --- |
| [Asana — operating system for human-agent teams](https://investors.asana.com/news-releases/news-release-details/asana-unveils-operating-system-human-agent-teams) | Humans and agents can share one plan, context, memory and governance model across business workflows. | Shared company/project context, clear next actions, durable handoffs, human attention surfaces and governance should feel native rather than bolted on. | ND remains complete locally, adds deep code execution/worktree/checkpoint semantics, supports multiple engines/BYOK, and does not require hosted infrastructure for core work. |
| [Linear — AI Agents](https://linear.app/docs/agents-in-linear) | Agents can behave like workspace participants: delegation, @mentions, comments, projects and activity. Human accountability remains visible. | Make agents feel like understandable teammates in the same task/project UI; preserve human ownership and lightweight interactions. | ND adds first-class decisions, explicit approval objects, local durable execution, broader General workspace use and governed agent actions beyond issue tracking. |
| [GitHub — Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents/) | A mission-control model for multiple coding agents, identity, policy, progress, code review and parallel work is becoming standard developer UX. | Strong agent identity, one control surface, parallel task visibility, branch/review controls and transparent activity. | ND spans non-coding + coding work, keeps one local company control plane across different engines, and binds writable tasks to ND-owned isolated workspaces/checkpoints rather than one vendor ecosystem. |
| [OpenAI — Codex app](https://openai.com/index/introducing-the-codex-app/) | Developers want a desktop command center for parallel long-running agents, project threads, review and worktree isolation. | Fast task/session switching, readable progress, inspectable diffs, worktrees and supervision should be first-class. | ND is engine-neutral, team/company-oriented, includes humans and business workflows, and makes policy/approval/audit part of the product model rather than only coding-agent supervision. |
| [Microsoft — Copilot Home, Code and Autopilot](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/) | General work, delegated work, code creation and persistent digital teammates are converging into one work hub. | General and Coding should be profiles of one product; persistent teammates need role, memory, permission, audit and clear boundaries. | ND prioritizes local ownership/offline operation, extensible local desktop capabilities, BYOK/multi-engine choice and no mandatory cloud-hosted teammate runtime. |

## Competitive thesis

### Grok bot teams — product-owner experience reference

Added **2026-10-09** from the product owner's reported experience: team communication and coordinated parallel work felt effective and resembled a real team carrying out a project. This is experiential design input, not an independently verified assessment of Grok's current features, architecture or comparative quality.

ND should adapt clear teammate communication, visible delegation, progress and parallel coordination to its own managed companies and projects. Feature-for-feature Grok parity is not the target. Human membership, project access, task ownership, delegated administration, budget/policy enforcement, review and audit remain ND-owned domain contracts.

The concrete requirements and acceptance scenarios are in [Human + AI company and project team management](./human-ai-company-team-management.md). Local profile attribution and authenticated remote membership remain separate delivery stages.

The market is validating the category. ND should therefore avoid positioning around features that are becoming table stakes:

- AI teammate;
- agent assignment/delegation;
- comments and @mentions;
- Kanban/tasks;
- multi-agent execution;
- agent activity;
- review;
- General/Code mode by itself.

ND's stronger combination is:

```text
Human + AI Team Workspace
          |
  General + Coding
          |
   ND Control Plane
          |
 policy / approvals / audit
          |
 multi-engine / BYOK / skills / extensions
          |
 local task isolation / worktrees / checkpoints
          |
 SQLite + local files + Git
          |
      works offline
      no server required
```

## Must-match baseline

Before calling PRD 0009 competitive, ND should match the essential interaction quality users will expect from these references:

1. humans and agents are visibly distinct actors;
2. tasks can be assigned/delegated without losing human accountability;
3. project/task comments and threads are easy to follow;
4. humans and agents can @mention one another;
5. agent activity and current work are inspectable;
6. review requests are first-class;
7. the user has a clear "Needs You" / attention surface;
8. project context survives across sessions;
9. multi-agent work is understandable instead of hidden behind one chat transcript;
10. General and Coding views share the same underlying project truth.

These are baseline expectations, not ND's differentiation.

## Must-differentiate

PRD 0009 should actively protect the areas where ND can be meaningfully different.

### 1. Local-first complete product

Core company/project/task/chat/decision/approval/agent operation must work without:

- ND account;
- hosted server;
- Google Drive;
- remote database;
- vendor cloud control plane.

Future cloud adds transport and hosted convenience, not basic permission to use the workspace.

### 2. General + Coding are one workspace model

Microsoft validates the convergence of general work and code. ND should go further locally:

```text
General
  chat / files / knowledge / workflows / desktop / browser / extensions
       \
        same project + team + decisions + approvals
       /
Coding
  repo / Git / worktrees / terminal / tests / browser devtools / coding agents
```

Switching profile must never change task execution state.

### 3. Engine-neutral execution

GitHub and Codex provide strong agent control inside their own ecosystems.

ND should preserve:

- Codex;
- Claude Code;
- ZCode;
- Cursor;
- Antigravity;
- ND Native/Harness;
- future engines;

behind one ND task/control-plane contract.

The engine is replaceable. ND owns the task, policy, workspace, checkpoint, review and integration state.

### 4. Stronger task transaction boundary

For writable software work:

```text
Task
  <-> human/agent owner
  <-> lease
  <-> isolated workspace/worktree
  <-> engine session
  <-> baseline
  <-> checkpoint
  <-> verification
  <-> approval/review
  <-> integration
```

Parallel-agent UX is not enough if outputs cannot be independently verified, rolled back and integrated.

### 5. Explicit governance

ND should be stricter than conversational products around protected actions:

- chat is not approval;
- emoji/reaction is not approval;
- "looks good" is not approval;
- approval binds to an exact checkpoint/revision;
- changed work invalidates stale approval;
- policy may require an independent human;
- an agent cannot self-approve protected work;
- machine verification cannot be overridden by friendly prose.

### 6. Extensible local desktop

ND's extension/skill/browser/OS capability layer should let the same workspace model support:

- coding;
- project management;
- research;
- documents/files;
- browser operations;
- desktop workflows;
- design;
- future local OS integrations.

Do not make each extension invent a separate task/comment/approval system.

## Do not copy blindly

### Do not clone Asana

Do not turn ND into a cloud-first enterprise project-management suite. Learn the human-agent work graph and governance concepts while preserving ND's local execution depth.

### Do not clone Linear

Do not stop at a beautiful issue tracker with agents. ND tasks need execution provenance, decisions, checkpoints, approvals and local runtime authority.

### Do not clone GitHub Agent HQ

Do not make GitHub the product boundary. Git is one source-code transport inside the broader ND workspace.

### Do not clone Codex

Do not become a single-engine agent manager. ND must remain engine-neutral and useful outside software development.

### Do not clone Microsoft Copilot

Do not require one vendor tenant/cloud ecosystem to make General + Code + persistent agents useful.

## Competitive milestone gates

### M0 — Domain contract

Reference checks:

- **Linear:** actors, delegation, mentions and comments feel first-class.
- **Asana:** shared project context and governance are explicit.
- **ND advantage:** decisions and approvals are structured from day one.

### M1 — Local UX

Reference checks:

- **Linear:** task collaboration is low friction.
- **Asana:** attention/next-action surfaces are obvious.
- **Microsoft:** General and Coding feel like profiles of one product.
- **ND advantage:** same UX works against local authority with no account/server.

### M2 — Durable store

Reference checks:

- competitors hide durability behind SaaS;
- **ND advantage:** restart-safe local ownership is visible, exportable and recoverable.

### M3 — Agent execution

Reference checks:

- **GitHub/Codex:** parallel agent work is understandable and inspectable.
- **ND advantage:** multiple engines share the same task/workspace/checkpoint contract.

### M4 — Review/governance gate

Reference checks:

- **GitHub/Codex:** review of generated output is easy.
- **Asana/Microsoft:** governance and human control are clear.
- **ND advantage:** explicit checkpoint-bound approvals, stale-approval rejection and local policy enforcement.

## Competitive acceptance scenarios

PRD 0009 is not competitive just because the database schema exists. It should pass realistic scenarios.

### Scenario A — Product team

```text
Human PM creates request
-> AI PM breaks it into tasks
-> designer/human comments
-> agent proposes decision
-> human activates decision
-> worker completes task
-> reviewer comments
-> human explicitly approves
-> activity + knowledge update
```

Reference target: Asana + Linear quality of collaboration.

### Scenario B — Coding team

```text
task assigned to coding agent
-> isolated worktree
-> checkpoint
-> machine verification
-> AI reviewer
-> human discussion
-> explicit checkpoint approval
-> integration
```

Reference target: GitHub Agent HQ + Codex visibility, with stronger ND transaction semantics.

### Scenario C — Mixed General/Coding

```text
General workspace:
  customer feedback + docs + decision

same project -> Coding:
  implementation tasks + Git/worktree + tests

same project -> General:
  review + approval + status update
```

Reference target: Microsoft Home/Code convergence, while staying local-first.

## Scorecard for future reviews

Use a simple evidence table instead of subjective "we are better" claims:

| Capability | Reference product(s) | ND evidence required |
| --- | --- | --- |
| Human + agent shared workspace | Asana, Linear | real local E2E with human + agent actors |
| Agent delegation/mentions/comments | Linear | task + comment + mention E2E |
| Attention / Needs You | Asana, Linear | pending approval/blocker/mention projection |
| Multi-agent mission control | GitHub, Codex | parallel-task UI + session provenance |
| Worktree isolation | Codex, GitHub | independent ND worktree/checkpoint proof |
| General + Coding | Microsoft | same project truth across profiles |
| Governance | Asana, Microsoft, GitHub | policy + audit + explicit approval E2E |
| Local-first / offline | ND differentiator | full workflow with network disabled |
| Multi-engine | ND differentiator | same scenario across at least two engines |
| Checkpoint-bound approval | ND differentiator | stale-checkpoint rejection test |

Do not assign marketing scores without real evidence. Record PASS / PARTIAL / NOT TESTED and link the test/evidence.

## Review cadence

Revisit this reference set:

- before implementation starts for a major collaboration milestone;
- before Beta/RC;
- when one of the primary reference products launches a material team-agent workflow change.

New competitors may be added, but they should only affect ND's plan when they reveal a useful interaction pattern, missing baseline expectation, or meaningful differentiation risk.
