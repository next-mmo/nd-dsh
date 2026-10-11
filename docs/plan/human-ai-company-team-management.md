# Human + AI company and project team management

Status: **planned extension to PRD 0009; authenticated remote access remains deferred under PRD 0010**
Updated: **2026-10-09**

## Product direction and inspiration

ND should let real humans and AI employees work together as a managed company across multiple projects. An authorized teammate should be able to discuss and carry out routine work without the CEO personally mediating every interaction.

The product owner's positive experience with Grok bot teams motivates clear teammate communication, visible delegation, coordinated parallel work and useful progress updates. This is a user-reported interaction reference, not an independently verified description of Grok's current architecture or capabilities.

Adapt those interaction qualities to ND's existing company/project/task control plane. Feature-for-feature Grok parity is not an acceptance target. ND owns membership, project access, assignments, budgets, execution, decisions, approvals and audit independently of any bot, model provider or coding engine.

## Existing foundation and remaining work

| Area | Existing foundation | Planned addition |
| --- | --- | --- |
| Human identity | Local member profiles with name, title and active/inactive status | Authenticated human identity bound to membership for independent users |
| Access | Company-bound member checks and existing ND action policy | Explicit company/project access grants and trusted authorization on reads and writes |
| Collaboration | Human-authored project/task messages, mentions, decisions and approval records | Agents participate through scoped typed APIs and respond in the relevant discussion |
| Assignment | Agent task assignment and execution provenance | Human accountability, human assignees, mixed teams, delegation and reassignment history |
| Independent remote users | Deferred cloud identity and transport design | Invitations, authenticated sessions, revocation and remote access under PRD 0010 |

A member's free-text title is not an access role. Selecting a local profile is attribution, not proof of identity. This plan does not claim the additions are implemented or validated.

## Company and project structure

The company is the boundary for members, teams, organizational policy and delegated administration. Each project has explicit membership, objectives, tasks, discussions, decisions and delivery history.

- A company may have many projects and mixed human/AI teams.
- Company membership alone does not grant access to every project. Company administrators have explicit administrative access according to company policy.
- Project membership and role grants determine which project records a person may read and which actions they may perform.
- Teams can be assigned to projects; team-based access must be explicit, inspectable and revocable.
- Private projects and guest access must not leak through search, mentions, activity, inbox, notifications, exports or agent context.
- General and Coding views use the same membership and authorization rules.

Keep organizational job roles, human access roles and agent execution capabilities separate. A CEO, designer or developer title describes work; authority comes from an explicit grant. Existing `OrganizationRole` remains the AI work-role contract unless a deliberate migration is designed.

## Human access and delegated administration

Company owner/authorized administrators manage human access. CEO is a business title, not an automatic permission bypass. An owner may delegate member administration or project management within a bounded scope.

The following are proposed default role templates, to be implemented as named capabilities rather than scattered role-name checks:

| Access role | Default scope and authority |
| --- | --- |
| Owner | Company administration, ownership transfer and policy, subject to protected-action requirements |
| Company admin | Manage members, teams and projects within delegated administrative authority; no implicit ownership transfer |
| Project manager | Manage an assigned project's work, assignments and permitted project membership; cannot widen company policy |
| Contributor | Read, chat, comment and perform assigned work in authorized projects; agent delegation requires a separate capability |
| Reviewer | Read relevant project work, discuss reviews and resolve authorized approval requests; approval scope is explicit |
| Viewer / guest | Read explicitly shared project context; commenting requires a grant; no default execution or approval rights |

Capabilities must distinguish reading, messaging, creating tasks, assigning work, delegating to agents, requesting execution, resolving approvals, integrating/publishing, managing membership and changing policy/budgets.

Effective authority is constrained by membership, company/project grants, ND policy, runtime permits and relevant agent/engine restrictions. Deny wins. No user may grant authority beyond their delegated scope or self-elevate through a title, message or task assignment.

Authenticated requests derive the actor from the trusted session. Caller-supplied member IDs, UI selection and model-generated claims cannot establish identity. Enforce authorization at the trusted control-plane/API boundary, including reads; hiding UI controls is insufficient.

Revocation must deny subsequent reads, mutations and dispatches, invalidate affected sessions/subscriptions as appropriate, and re-evaluate queued or active delegated work under existing cancellation/effect-journal rules. Previously completed external effects remain in audit history.

## Full work assignment and parallel coordination

Task management must support humans as accountable participants, alongside existing AI employees:

1. An authorized human or AI planner proposes a task graph under a company/project objective.
2. A permitted manager assigns each task to a human or agent, with an accountable human where the project requires one. Supporting collaborators and an independent reviewer are explicit references.
3. Each task records acceptance criteria, dependencies, priority, relevant skills, work scope and applicable budget/review requirements.
4. Human assignees can acknowledge work, post progress, ask questions, report blockers and submit artifacts for review. Agent assignees execute through existing ND runtime permits and isolation.
5. Delegation or reassignment records who changed ownership, why, and the current handoff/checkpoint. Reconcile active execution before transferring writable work; never create competing workers silently.
6. Independent tasks run in parallel within capacity, budget and workspace limits. Dependencies and conflicts remain visible in the project graph/Kanban.
7. Review, explicit approval and integration follow existing evidence/checkpoint rules. Human completion uses the task's evidence contract; it does not fabricate an agent run or Git checkpoint for non-coding work.

Human ownership must not be simulated by creating an `OrganizationAgent` for a person. The implementation must deliberately evolve the current agent-only task assignment contract while preserving existing run provenance.

Example: a project manager coordinates a launch across a human designer, an AI researcher and two coding agents. They discuss shared requirements in the project, work on independent tasks in parallel, and route only decisions or approvals requiring the owner's authority to the owner. Each coding task retains its own isolated workspace and review evidence.

## Shared conversation and agent participation

- Human-to-human, human-to-agent and relevant agent-to-agent collaboration stays attached to the company/project/task where it belongs.
- Mentions feed the recipient's authorized inbox. They do not grant access or automatically start paid/privileged execution.
- An agent can answer a question or propose a task in the thread through typed ND APIs. Starting or changing execution requires an explicit governed command and permission checks.
- Agent messages identify their agent/run/task provenance. Agents cannot impersonate humans or inherit the mentioning person's unrestricted session.
- Routine progress uses concise updates, blockers, handoffs and artifact links. Tool traces remain inspectable execution transcripts rather than flooding project chat.
- Human instructions stay within the sender's authority and the agent's permitted scope. A conversational request cannot override company policy, budget or approval requirements.
- Shared conclusions become durable decisions or task changes through explicit operations. Chat prose, reactions and agent consensus never count as protected approval.

An authorized contributor can therefore chat with coworkers and ask a project agent for help without involving the CEO every time; operations outside that contributor's authority still require the designated manager/reviewer/owner.

## Delivery boundaries

The Rust hosted-server direction is **approved for planning and tasks only (2026-10-09)**. [Task 0053](../tasks/0053-rust-hosted-human-ai-team-backend.md) breaks down local contracts, storage, authenticated access, realtime collaboration, connected-host execution, pilot validation and later paid entitlements. Implementation is explicitly on hold until a later coding instruction; existing local/cloud dependency gates remain in force.

### Chat storage and shared backend review

Reviewed **2026-10-09** against the current code and PRDs:

| Usage | Storage and service requirement | Current ND status |
| --- | --- | --- |
| One desktop, local human profiles and AI employees | Durable local storage; no hosted chat server required | Messages live in the organization snapshot at Electron `userData/organization.json`, with a `.bak` snapshot |
| Desktop plus a browser on that same machine | One local API service over loopback and the same durable store | Local Web parity is a planned PRD 0009 gate; do not infer it from the existing provider gateway |
| Independent humans on separate machines | A reachable authenticated application backend for shared history, authorization and realtime delivery | Deferred PRD 0010 work; local profile switching does not provide this |
| Chat that remains available while every ND desktop is offline | Independently running hosted backend and durable database | Requires hosted infrastructure; an Electron host alone cannot provide this availability |

Persistent chat data and network delivery are separate concerns. SQLite runs embedded without a separate database server ([SQLite documentation](https://www.sqlite.org/serverless.html)). A future application server could also own a local SQLite database for a bounded deployment; clients would call its API rather than open its database file. Concurrent direct database access from many computers over a shared filesystem is unsuitable ([SQLite deployment guidance](https://www.sqlite.org/whentouse.html)).

For ND's current roadmap, preserve the existing proposed split:

```text
Local-only project
  Desktop -> ND control plane -> local durable store
  Current: JSON snapshot; target: transactional SQLite

Future shared project (design must be finalized before implementation)
  Human clients -> authenticated ND API -> membership / policy checks
                                      -> shared durable records + change log
                                      -> realtime events -> authorized clients
  ND execution host <- governed commands / dispatch <- ND API
  ND execution host -> receipts / evidence / status -> shared records
```

PRD 0010 proposes PostgreSQL for hosted relational records, object storage for selected attachments and authenticated realtime delivery. These are draft infrastructure choices, not implemented services. Provider/model APIs and the existing ND provider gateway do not substitute for a team-chat backend.

The [Rust main server proposal](../prd/0010-nd-cloud-sync-and-customer-portal.md#rust-main-server-proposal--2026-10-09) records Rust as the recommended hosted-service candidate, with account/membership, collaboration, realtime, storage and future paid-entitlement modules. It preserves a separate deployment boundary from the desktop Rust core and keeps subscription status distinct from human access permissions.

Before remote implementation, resolve these concrete requirements:

1. **First-user scope:** decide whether the next deliverable is one-host local collaboration or independent remote teammates. If remote humans are required for the upcoming pilot, the minimum authenticated collaboration backend is required pilot scope; the local profile MVP alone is insufficient. Preserve the local durability gate, then implement a thin remote slice without waiting for billing, marketplace or the whole customer portal.
2. **Record authority:** specify the authoritative writer and revision owner for each shared record. Proposed direction: local-only projects remain locally authoritative; connected shared projects commit shared collaboration/membership state through the hosted service, while ND hosts own execution leases, workspaces and evidence. Any transition or synchronization between these modes must be explicit. Resolve PRD 0010's server-transactional state wording against local host authority before coding; never permit competing approval/policy authorities.
3. **Message reliability:** acknowledge accepted messages after durable commit; use client-generated idempotency keys, stable IDs, ordered replay cursors, pagination and transactional outbox delivery. Reconnection must not lose or duplicate messages. Realtime notification alone is not durable history.
4. **Offline semantics:** local-only projects keep working. For shared projects, distinguish pending offline drafts/commands from accepted shared state. Revalidate membership, revisions and permissions when reconnecting; no offline permission escalation or claim that a queued approval/execution command already succeeded.
5. **Availability:** define which collaboration actions work when the execution host is offline. Proposed target: hosted chat/history and permitted planning stay available; agent execution queues with visible host-offline status and is reauthorized before dispatch. An offline desktop cannot run its local coding agents.
6. **Data lifecycle:** define attachment size/access controls, per-project search, retention/deletion, backup and restore, and audit tombstones before promising production team history. Provider credentials and local secrets stay outside shared chat storage.
7. **Pilot gate:** demonstrate two independently authenticated humans on separate machines posting to one project, restricted-project isolation, agent replies with provenance, reconnect/deduplication, revocation and execution-host-offline behavior. Label these separately from local profile workflow tests.

This review clarifies dependencies; it does not enable LAN/public exposure or start cloud implementation.

### Local-to-remote sequence

1. **Contract and local workflow:** define membership/access grants, human assignment, agent participation and audit contracts; exercise workflow semantics on the existing local host. Keep local profile switching clearly labeled as attribution.
2. **Trusted enforcement:** centralize capability checks and actor resolution across Desktop, Local Web and typed agent APIs. Validate company/project isolation and prevent forged actor/grant requests. Do not advertise independent multi-user security while all callers can choose local profiles.
3. **Authenticated multi-user access:** PRD 0010 adds real accounts, invitation acceptance, independent sessions, remote transport and revocation after the existing local durability/reliability gate. Bind authenticated identities to the same membership model.

Remote hosting and invitations remain deferred. Company/project management and assignment contracts belong to ND's local product; cloud transports the same model and must not introduce a competing permission or task authority.

## Acceptance scenarios

These are planned gates, not recorded test results:

1. An owner delegates Project A management to a human PM. The PM manages permitted assignments and membership without gaining authority over private Project B or company policy.
2. A contributor chats with a human coworker, mentions an authorized agent and completes routine assigned work without CEO intervention. Execution requests still require the contributor's execution grant and ND runtime permits.
3. A mixed team completes dependent and independent tasks; concurrent coding tasks keep separate workspaces, checkpoints and reviewers. Human work retains its own assignee and evidence.
4. A viewer can read shared work but cannot dispatch agents, assign tasks, approve work or elevate their own role. Direct API calls receive the same denial as the UI.
5. A guest cannot discover another project's messages, files, tasks, mentions, activity or knowledge through any projection, export or agent response.
6. Reassignment during execution produces one explicit handoff and reconciles active ownership. Restart preserves assignments, messages, role grants and audit history.
7. A revoked member loses future access and dispatch authority; affected queued/active delegated actions are re-evaluated. Audit preserves historical attribution.
8. An agent reply or a human's "looks good" never resolves approval. A granted reviewer explicitly approves the exact applicable revision, and changed work invalidates stale approval.
9. Authenticated remote tests reject impersonation via caller-supplied member IDs. Local-profile tests remain labeled workflow tests rather than multi-user authentication evidence.

Validation must cover contract/authorization tests, negative read/write and impersonation tests, mixed-team E2E, restart/revocation checks and manual human-team UX. Compare communication clarity and parallel coordination with the product owner's Grok experience; assess ND's company/project governance against the scenarios above.
