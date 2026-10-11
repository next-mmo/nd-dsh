---
id: "0009"
title: "Local-First Team Workspace and Durable Control Plane"
status: draft
created: 2026-09-29
---

# PRD 0009 — Local-First Team Workspace and Durable Control Plane

## 1. Product outcome

Turn ND's existing company/task/agent control plane into a first-class **local human + AI team workspace** before building any cloud service.

The milestone must support useful team collaboration semantics on one ND host:

- human members;
- AI agents;
- project chat;
- task comments/threads;
- @mentions;
- durable decisions;
- review requests;
- explicit approve / request-changes / reject actions;
- Needs You / inbox projection;
- activity/audit history;
- Desktop and Local Web parity.

No ND server or external cloud account is required.

## 2. Why now

ND already has:

- companies/projects;
- teams/roles/AI employees;
- task graphs and Kanban;
- structured agent coordination events;
- task worktree/checkpoint provenance;
- independent reviewer flows;
- policy gates;
- local activity;
- local Web direction.

What is missing is the human-grade collaboration layer that lets a real team discuss work, record decisions and perform explicit approvals without leaving the ND project context.

## 2.1 Competitive reference

This PRD uses [ND Team Workspace Competitive Reference](../plan/team-workspace-competitive-reference.md) as an implementation benchmark.

Primary references:

- Asana — shared human/agent plan, context and governance;
- Linear — agent-as-workspace-participant UX, delegation, comments and mentions;
- GitHub Agent HQ — coding-agent mission control, identity and policy;
- OpenAI Codex — parallel agent desktop workflows and worktree supervision;
- Microsoft Copilot — convergence of General, Code and persistent teammates.

The goal is not feature parity with their hosted platforms. PRD 0009 must match baseline collaboration expectations locally, then demonstrate ND-specific advantages: no required server, General + Coding over one project model, engine-neutral execution, isolated task/checkpoint lineage and explicit revision-bound approvals.

## 2.2 Stability before parity

Competitive references do not expand the PRD 0009 scope while the local foundation is still being stabilized.

Implementation priority is:

1. correctness;
2. durability;
3. restart/recovery;
4. task/workspace isolation;
5. explicit review/approval correctness;
6. understandable local UX;
7. only then broader competitive inspiration.

A reference feature may be adopted later only if it preserves PRD 0009's local-first and governance invariants.

## 3. Scope boundary

### Human + AI company management direction

The [Human + AI company and project team management plan](../plan/human-ai-company-team-management.md) extends this PRD's product direction with explicit company/project membership, delegated human access, mixed human/agent assignment and governed shared conversation. It incorporates the product owner's Grok bot team experience as inspiration for communication and parallel coordination, adapted to ND's managed company/project model rather than feature-for-feature parity.

These additions are planned requirements, not a claim that the existing local member profiles provide enforced access roles or authenticated multi-user security. Local profile workflow remains within this PRD's one-host boundary; independent remote identities, invitations and transport remain deferred under PRD 0010.

This PRD is **one-host local collaboration**.

Supported conceptually:

```text
one ND host
  |
  +-- human member A
  +-- human member B
  +-- AI agent 1
  +-- AI agent 2
  |
  +-- shared local company/project/task state
```

The local data model may contain multiple named humans for attribution and workflow testing.

It does **not** claim that two remote PCs are synchronizing in this milestone.

## 4. Non-goals

- ND Cloud;
- Google Drive/Dropbox/S3 sync;
- multi-device or remote-team synchronization;
- LAN/public Web exposure;
- hosted identity;
- SSO/MFA;
- email invitations;
- billing;
- hosted push notifications;
- cross-device presence/typing;
- CRDT editing;
- a Slack clone;
- replacing Git with chat attachments;
- replacing existing task/reviewer policy with conversational inference.

## 5. Core architecture

```text
Electron UI -----------+
                       |
Local Web (loopback) --+--> NdControlPlane
                              |
                              +--> Organization / Task services
                              +--> Collaboration service
                              +--> Approval/policy service
                              +--> Inbox projection
                              |
                              v
                         NdRepository
                              |
                              v
                       local durable store
                              |
                              v
                           nd-core
```

Desktop and Local Web are clients. Neither becomes a second authority.

## 6. Actor model

Humans and AI agents share collaboration surfaces but remain different principals.

Candidate contract:

```text
OrganizationMember
  id
  companyId
  displayName
  role/title
  status
  createdAt
  updatedAt

OrganizationActorRef
  kind: human | agent | system
  id
```

Existing `OrganizationAgent` remains the AI employee/execution identity.

A local member profile is primarily attribution/workflow state. Until a real authenticated multi-user layer exists, ND must not present local profile switching as a strong security boundary.

## 7. Relationship with PRD 0003

PRD 0003 already owns execution isolation and structured team/task coordination such as:

- progress;
- blocker;
- interface-change;
- artifact-ready;
- handoff;
- review-request;
- dependency-unblocked.

Keep that channel focused on machine/execution coordination.

This PRD adds the human-grade collaboration layer:

```text
execution coordination     collaboration
----------------------     --------------------------
progress event             project chat message
blocker event              task comment/thread
review-request event       review discussion
checkpoint provenance      explicit approval verdict
agent handoff              durable decision
```

Do not overload one model until it becomes ambiguous.

## 8. Communication primitives

### 8.1 Project chat

Fast, chronological conversation scoped to a company/project.

MVP requirements:

- human or agent author;
- plain/rich text payload;
- mentions;
- optional reference to task/decision/artifact;
- edit history or edited marker;
- soft delete/tombstone rather than silent disappearance;
- stable message ID;
- created/updated timestamps.

Chat is not authorization.

### 8.2 Task comments and threads

Task discussion is durable work context.

A comment may:

- be top-level on a task;
- reply to another comment;
- mention humans/agents;
- reference a checkpoint/file/artifact;
- carry a review category such as question, note, blocker or change-request.

Comments survive task completion and restart.

### 8.3 Reactions

Reactions are lightweight social signals only.

They must never count as:

- approval;
- permission;
- policy grant;
- task completion;
- deployment authorization.

### 8.4 Decisions

A decision is a first-class durable object, not a specially formatted chat line.

Candidate fields:

```text
Decision
  id
  companyId
  projectId
  taskId?
  title
  summary
  rationale
  status: active | superseded | archived
  createdBy
  supersedesDecisionId?
  createdAt
  updatedAt
```

Agents may propose decisions. Policy may require human confirmation before a proposed decision becomes active.

## 9. Approval model

Approval is transactional state.

Candidate target kinds:

- task review;
- exact task checkpoint;
- merge/integration;
- dependency/security exception;
- privileged extension action;
- future deployment/publish action.

Candidate state:

```text
ApprovalRequest
  id
  targetKind
  targetId
  targetRevision / checkpointCommit
  requestedBy
  requiredApproverKind
  requiredCount
  status: pending | approved | changes_requested | rejected | cancelled
  createdAt
  resolvedAt?
```

Verdicts are append-only records:

```text
ApprovalVerdict
  id
  requestId
  actor
  verdict: approve | request_changes | reject
  comment?
  createdAt
```

### 9.1 Hard rules

1. Approval only changes through an explicit command/button/API.
2. Natural-language text never implies approval.
3. Reactions never imply approval.
4. Approval is bound to an exact target revision/checkpoint where applicable.
5. If the target changes materially, prior approval becomes stale.
6. Policy can require an independent human.
7. An agent cannot approve its own protected work when independence is required.
8. Existing machine verification remains authoritative and cannot be overridden by friendly reviewer prose.
9. Approval history remains inspectable after completion.

## 10. Review flow

Target UX:

```text
Task in progress
   |
worker/agent checkpoint
   |
Request review
   |
review discussion/comments
   |
   +-- Approve ----------> ready for integration/next gate
   +-- Request changes --> rework
   `-- Reject -----------> blocked/closed according to policy
```

ND should keep automated reviewer execution and human approval distinct.

An AI reviewer may produce semantic review evidence. A human approval gate, when configured, is a separate explicit state transition.

## 11. Mentions and Needs You

`@mentions` should feed a local inbox projection.

Needs You should aggregate actionable items such as:

- mentioned in project chat;
- mentioned in task comment;
- task assigned;
- review requested;
- approval requested;
- changes requested;
- decision confirmation needed;
- agent blocked waiting for human input.

Inbox is a projection over authoritative records/events, not a second task database.

MVP can avoid complex read-receipt synchronization. Local per-member seen/dismissed state is enough.

## 12. Activity and audit

Meaningful actions emit stable activity records, for example:

```text
MEMBER_CREATED
MESSAGE_POSTED
COMMENT_ADDED
DECISION_CREATED
DECISION_SUPERSEDED
REVIEW_REQUESTED
APPROVAL_REQUESTED
APPROVAL_GRANTED
CHANGES_REQUESTED
APPROVAL_REJECTED
TASK_ASSIGNED
TASK_STATUS_CHANGED
AGENT_BLOCKED
CHECKPOINT_CREATED
INTEGRATION_COMPLETED
```

Activity supports timeline/audit/recovery and later sync readiness.

Do not make the entire product event-sourced in this milestone. Canonical mutable state remains relational/domain state plus append-only activity/change history.

## 13. Local storage

Target local persistence is SQLite behind a repository abstraction.

Likely collaboration tables:

```text
organization_members
collaboration_threads
collaboration_messages
message_mentions
decisions
approval_requests
approval_verdicts
member_inbox_state
activity_events
```

Existing organization/task/run records may migrate incrementally.

Requirements:

- SQLite WAL mode;
- transactions for approval/task transitions;
- foreign-key integrity;
- explicit schema migration version;
- stable IDs;
- optimistic record versions where mutable;
- index by company/project/task/time;
- FTS added when search volume justifies it;
- periodic backup/export path;
- crash-safe migration from current JSON snapshots.

The initial UI may temporarily use the current repository snapshot path while the abstraction lands, but high-volume collaboration must not remain a giant JSON append pattern.

## 14. Version and conflict rules

Even on one host, version correctness matters because Desktop, Local Web and agents can mutate concurrently.

Rules:

- mutable records carry revision/version;
- stale protected updates fail instead of silent last-write-wins;
- comments/messages are append-first;
- edits preserve revision/edited metadata;
- decisions supersede rather than silently rewriting history;
- approvals reject stale target revisions;
- task/policy/approval transitions are transactional.

These choices also make future cloud sync possible without redesigning semantics.

## 15. Local Web

Initial Local Web remains loopback-only.

Security requirements:

- authenticated local session;
- strict Host/Origin validation;
- no wildcard CORS;
- CSRF protection where applicable;
- authenticated WebSocket;
- no raw unrestricted IPC/RPC bridge;
- no secret readback;
- collaboration mutations re-enter the same policy/control-plane path as Electron.

## 16. Attachments

MVP attachments are optional and bounded.

Prefer references/metadata for existing project artifacts instead of duplicating whole repositories into collaboration storage.

Never auto-attach:

- `.env`;
- API keys;
- credential stores;
- provider secrets;
- large source trees;
- private runtime storage.

## 17. UX surfaces

### Company / Team

- human members;
- AI employees;
- roles/teams;
- active/blocked state.

### Project

- Overview;
- Chat;
- Kanban;
- Knowledge;
- Decisions;
- Activity;
- Needs You.

### Task drawer/page

- task details;
- assignee;
- agent run/checkpoint;
- discussion thread;
- review request;
- approval state/history;
- decision links;
- activity timeline.

### Header / inbox

- mentions;
- review requests;
- approvals;
- blockers/questions.

## 18. Local permission semantics

Reuse ND policy for privileged actions.

Collaboration-specific policy examples:

```text
collaboration.message.create
collaboration.comment.create
decision.create
decision.activate
task.review.request
task.approval.grant
task.approval.reject
integration.approve
```

Default behavior can remain ergonomic locally, but high-risk state changes must be explicit and auditable.

The [human access and delegated administration contract](../plan/human-ai-company-team-management.md#human-access-and-delegated-administration) specifies the planned company/project capability model. A member's title, agent job role, mention or task assignment must never substitute for an access grant. The target permits authorized teammates to collaborate and manage routine work without CEO mediation, while preserving explicit approval for protected actions. Trusted actor resolution and authorization on reads and writes are prerequisites for claiming independent multi-user access.

## 19. Agent behavior

Agents participate through typed ND APIs, not by pretending to be the human UI.

Agents may:

- post progress or questions;
- comment on tasks;
- mention a human;
- propose a decision;
- request review;
- request approval;
- respond to requested changes.

Agents must not:

- impersonate a human member;
- infer an approval from chat;
- approve protected work they own where independence is required;
- bypass policy because a human said something conversationally;
- expose secrets into collaboration records without an explicit allowed path.

## 19.1 Always-On local autonomy

ND's local team workspace includes a local autonomy layer inspired by proven OpenClaw/Hermes patterns without introducing a second agent model.

Required capabilities:

- Always-On local mode that can keep the current trusted runtime alive when the visible ND window is closed;
- optional packaged start-at-login where the OS integration is supported;
- one-shot schedules;
- recurring interval schedules;
- 5-field cron schedules with explicit timezone;
- agent routines that bind an existing `OrganizationAgent` to a recurring objective and optional skill hints;
- cheap deterministic heartbeat checks for blocked tasks, failed runs, pending approvals and unresolved human actions;
- event triggers from ND-owned organization activity into governed tasks or signals;
- learned-skill candidates with evidence and explicit promotion/rejection.

Hard rules:

1. automation re-enters the same ND control plane;
2. a schedule or trigger cannot bypass autonomy, policy, budget or runtime permits;
3. a routine uses the existing `OrganizationAgent`; do not add a second Bot identity model;
4. heartbeat should avoid a full model turn when deterministic state checks are sufficient;
5. event triggers must be idempotent and must not replay history that predates the trigger;
6. learned skills cannot silently grant permissions, rewrite policy or self-activate;
7. external messaging channels remain extension territory and are deferred until the local stability gate;
8. an Always-On desktop host is not represented as a crash-independent OS daemon; a later `nd-agentd` extraction is a separate reliability milestone.

## 20. Migration safety

Migration from current organization snapshots:

```text
read + validate existing JSON
        |
create backup
        |
open/migrate local DB
        |
import domain records
        |
validate counts + relationships
        |
commit
        |
write migration marker
```

A failed migration leaves the previous authority recoverable.

## 21. Acceptance criteria

### Domain

- human member and agent actor references are unambiguous;
- project chat and task comments persist across restart;
- decisions support supersession;
- approval binds to an exact target revision/checkpoint;
- stale approval is rejected;
- "looks good" message does not approve anything;
- emoji/reaction does not approve anything;
- independent-human policy blocks agent self-approval.

### UX

- project chat is reachable without entering a coding-only surface;
- task discussion and approval state are visible together;
- Needs You shows pending mention/review/approval/blocker items;
- General and Coding workspace profiles see the same project collaboration truth;
- switching workspace profile does not pause agents or alter approvals.

### Reliability

- Electron and Local Web observe consistent state;
- concurrent stale mutations produce explicit conflict;
- restart does not lose comments/decisions/approval history;
- export/import round-trips collaboration state;
- no cloud/network dependency is required.

### Existing guarantees

- task worktree isolation remains unchanged;
- machine verification remains authoritative;
- agent review and human approval remain separate;
- Git integration still binds to reviewed checkpoint provenance;
- policy/effect journal boundaries remain intact.

## 22. Validation plan

Three levels:

1. **unit/contract** — schemas, actor references, thread rules, decision supersession, approval state machine, stale revisions, self-approval policy;
2. **E2E** — Desktop local team flow, restart, Local Web parity, concurrent mutation/conflict, real agent asks human for approval;
3. **manual local QA** — operate a real project with at least two local human profiles plus multiple agents for an extended session.

No hosted service is required for validation.

## 23. Milestone sequence

```text
M0 contract
  member/actor/thread/message/decision/approval/inbox schemas

M1 local UX
  project chat + task discussion + Needs You + explicit review/approval

M2 durable store
  repository abstraction + SQLite collaboration schema + migration/export

M3 Local Web parity
  typed local API + authenticated realtime updates

M4 Always-On local runtime
  background operation + optional start-at-login + liveness

M5 automation v2
  once + interval + cron/timezone + agent routines

M6 heartbeat + events
  deterministic attention + idempotent organization-event triggers

M7 gated skill learning
  candidate + evidence + explicit promotion/rejection

M8 reliability gate
  window-closed operation + restart + conflict + stale approval + policy + E2E/manual evidence
```

Cloud/sync work does not start until M8 is accepted.

## 24. Future compatibility

Future PRD 0010 may synchronize these records across devices.

To keep that option open now:

- use globally unique stable IDs;
- keep actor references explicit;
- store revisions;
- keep timestamps and provenance;
- use immutable verdict/event IDs;
- avoid filesystem paths as global identity;
- separate local secrets from collaboration data.

No sync provider is implemented by this PRD.

## 25. Open questions

- exact `nd-store` Rust/TypeScript boundary;
- whether member profiles initially live at organization or ND-account scope;
- whether project chat uses one default thread or explicit channels;
- edit/delete retention policy for messages;
- maximum attachment size;
- whether decision activation always requires a human at higher autonomy levels;
- exact mapping between current reviewer pass and optional human approval;
- how much of collaboration ships before full SQLite migration;
- Local Web port/session lifecycle;
- local backup retention.
