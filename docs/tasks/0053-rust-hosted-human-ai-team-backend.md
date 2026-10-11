# TODO 0053 — Rust hosted backend for human + AI company teams

> Priority: P1 — planned after local durability acceptance
> Owner: ND cloud/backend + desktop integration
> Status: **direction approved 2026-10-09; task definition only; implementation explicitly on hold**
> Authorization: The product owner approved the Rust hosted-server direction and requested tasks only, with no code yet. Approval does not authorize scaffolding, dependency installation, infrastructure creation, deployment or billing activation.
> Depends on: [PRD 0009 local durability/reliability acceptance](../prd/0009-local-first-team-workspace-and-durable-control-plane.md)
> PRDs: [0010 — ND Cloud](../prd/0010-nd-cloud-sync-and-customer-portal.md), [0011 — Admin and entitlements](../prd/0011-nd-admin-entitlements-and-extension-registry.md)
> Product contract: [Human + AI company/project team management](../plan/human-ai-company-team-management.md)
> Frontend companion: [0054 — Desktop and Customer Web team frontend](0054-human-ai-team-frontend.md)

## Approved direction

Build a separately deployed Rust backend for authenticated human collaboration across ND companies and projects. It owns shared data, scoped access, durable chat and realtime delivery, and later hosted usage/subscription entitlements. Desktop execution hosts retain local tools, workspaces, agent execution and evidence gates.

Use the proposed Rust/Axum/Tokio, PostgreSQL/SQLx and S3-compatible storage stack as the planning baseline. Exact versions, deployment vendor, identity provider, payment provider, pricing and retention remain design decisions. Begin with a modular application service and worker from one codebase; split deployments only when justified.

Grok bot teamwork inspires clear communication, delegation and coordinated parallel work. ND acceptance is based on managed companies/projects, mixed human/AI ownership, permissions and governed delivery, not Grok feature parity.

## Execution hold and dependency gate

All checkboxes below are future work and remain unchecked. No implementation begins until the product owner authorizes coding and the relevant prerequisite gates are satisfied. Documented historical local test passes do not automatically establish current SQLite durability, Local Web parity or authenticated multi-user readiness.

Local contracts and workflow tasks may proceed first once coding is authorized. Hosted implementation follows the PRD 0009 acceptance gate. Paid features follow a validated remote collaboration pilot; a full admin portal, registry or marketplace is not required for the pilot.

## Dependency-ordered work packages

### T0 — Confirm prerequisites and freeze the first pilot contract

Dependencies: coding authorization for implementation; PRD 0009 acceptance before hosted work.

- [ ] Record current local persistence, migration/export/restore, restart/recovery, approval and isolation evidence; link remaining work instead of treating it as complete.
- [ ] Define the pilot: two independently authenticated humans on separate devices, one shared project, restricted Project B, at least one existing ND agent, and an execution host that can disconnect.
- [ ] Specify authoritative writer, revision and transition rules for membership, messages, tasks, policies, approvals and execution receipts. Local-only projects stay locally authoritative; shared project records must have one explicit commit authority.
- [ ] Define local-to-shared project enrollment, source-ID mapping and offline drafts/commands without creating competing policy/approval state.
- [ ] Finalize versioned API/event/error contracts, pagination, idempotency keys, replay cursors, payload limits, actor provenance and pending/accepted/rejected command states.
- [ ] Confirm repository/deployment boundary, framework/library versions and identity provider; keep the hosted service separate from privileged desktop RPC.

Acceptance: a record-authority matrix and pilot contract identify every writer and failure path; unresolved blocking decisions are explicit.

### T1 — Complete local human/agent management contracts

Dependencies: T0 contracts; delivered locally before hosted deployment.

- [x] Define company/project membership, capabilities, delegated administration, explicit team-based grants and guest scope. Job titles and AI work roles do not establish access.
- [x] Extend agent-only task assignment deliberately to human/agent owners, collaborators, accountable humans and reviewers; preserve existing agent/run provenance.
- [x] Define ownership changes, human work evidence and active-run handoff/reconciliation rules.
- [x] Add typed agent collaboration operations for project/task replies, questions and mentions with actor/run/task attribution.
- [x] Keep conversation separate from execution commands and explicit approvals; local profile selection remains labeled attribution.

Acceptance: a mixed human/AI workflow survives restart and reassignment without fake agent identities, duplicate workers, or conversational approval. Delivered and verified in `src/shared/organization.ts`, `src/main/organization/store.ts`, `src/main/organization/orchestrator.ts`, and `tests/organization-collaboration.test.ts`.

### T2 — Establish the Rust service and durable storage boundary

Dependencies: T0; PRD 0009 acceptance.

- [ ] Implement the approved modular service/worker baseline with bounded configuration, graceful shutdown, health/readiness and structured metadata logs.
- [ ] Add versioned PostgreSQL migrations and scoped relations for identities, tenants, companies, projects, memberships, discussions, decisions, approvals, commands and audit/change records.
- [ ] Store attachment metadata in PostgreSQL; use object storage for explicitly shared files.
- [ ] Add transactional outbox, tenant-aware idempotency records, backup/restore and migration failure recovery.
- [ ] Keep provider credentials, local vault/runtime secrets, personal ND Home and raw repositories outside default shared storage.

Acceptance: schema/migration and recovery checks pass, accepted writes survive restart, logs contain no customer content/secrets by default, and no desktop filesystem/PTY/browser authority is publicly exposed.

### T3 — Implement authenticated identities and scoped authorization

Dependencies: T1, T2.

- [ ] Integrate the chosen OAuth/OIDC flow, trusted actor/session resolution, invitations, company/project grants, device enrollment and revocation.
- [ ] Enforce capabilities on reads, writes, realtime subscriptions, background jobs, search, exports and attachment downloads.
- [ ] Reject impersonation through member IDs, role names, room names or local profile selection; prevent grants beyond delegated authority.
- [ ] Re-evaluate queued/active delegated actions and subscriptions after revocation using existing cancellation/effect-journal semantics.
- [ ] Keep customer sessions separate from future ND staff/admin sessions.

Acceptance: two distinct users operate under different grants; unauthorized direct API calls and cross-project/tenant discovery fail; revoked sessions lose further access.

### T4 — Deliver durable chat and realtime collaboration

Dependencies: T2, T3.

- [ ] Implement project chat/task threads, authorized mentions and history queries with stable IDs, timestamps, pagination and defined edit/tombstone behavior.
- [ ] Commit messages and outbox events before acknowledgment; deduplicate retried requests.
- [ ] Add authenticated realtime delivery, bounded fanout/backpressure, reconnect replay and cursor-gap handling.
- [ ] Feed Needs You from authorized records and persist relevant inbox state; presence/typing remains optional and ephemeral.
- [ ] Integrate typed agent messages from T1 with clear provenance and permitted project context.

Acceptance: two humans and an agent share a project discussion; process failure, reconnect and retries preserve accepted history without duplicate records or unauthorized notifications.

### T5 — Connect ND hosts and mixed-team execution

Dependencies: T1, T3, T4.

- [ ] Connect enrolled hosts through authenticated outbound channels; map commands to explicit company/project/device scope.
- [ ] Route permitted assignments/execution requests through existing ND policy, budgets, runtime permits, leases, isolation, review and evidence checks.
- [ ] Model command IDs, authorization/revision rechecks, delivery acknowledgments and effect reconciliation so retries cannot silently duplicate execution.
- [ ] Keep hosted chat/planning available when hosts disconnect; show execution as queued/host-offline rather than completed.
- [ ] Return run receipts, evidence/checkpoint references and concise progress to shared records; do not upload unrestricted tool transcripts or credentials.
- [ ] Reconcile reassignment and host restart without competing writers or stale protected approval.

Acceptance: a human PM coordinates human work plus parallel agent tasks; coding workspaces remain isolated, revocation blocks dispatch, reconnect preserves lineage, and chat never substitutes for protected approval.

### T6 — Pass the remote pilot and customer-data lifecycle gate

Dependencies: T3–T5 and [frontend 0054 FE0–FE4](0054-human-ai-team-frontend.md); execute the pilot jointly with FE5.

- [ ] Run unit/contract and integration checks for authorization, transactions, idempotency, revision conflicts, replay and host commands.
- [ ] Run the two-device human/agent E2E including private Project B, reconnect, duplicate retries, revoked membership, host-offline work and restart.
- [ ] Set encryption, attachment limits, retention/deletion/tombstones, export and backup restore policies; verify tenant isolation through lifecycle operations.
- [ ] Record manual human-team UX evidence for clear assignments, useful communication, parallel progress and understandable exceptions.
- [ ] Measure expected-pilot connection load, event delivery, bounded resource use and recovery; set documented operating limits and alerting.

Acceptance: inspectable PASS/PARTIAL/FAIL evidence with no claimed security or durability success based only on local profile tests. Data migration and deployment proceed only through the separately authorized release process.

### T7 — Add hosted usage, subscriptions and paid entitlements later

Dependencies: T6; chosen billing units/provider and explicit paid-launch requirements.

Customer-facing paid-plan screens are tracked in frontend 0054 FE6 and depend on this backend's verified entitlement state.

- [ ] Define tenant subscriptions and user/seat mappings, hosted feature grants, storage/seat/usage limits and race-safe metering/quota enforcement.
- [ ] Integrate payment-provider checkout/customer management and verified webhooks; store identifiers/status, not raw payment-card data.
- [ ] Deduplicate billing events and reconcile current provider state across retries, delayed/out-of-order events and subscription changes.
- [ ] Keep membership authorization separate from paid entitlement checks. Paid status cannot grant project access.
- [ ] Define downgrade/nonpayment grace, hosted read/export access, retention and recovery; preserve customer history and all promised free local functionality.
- [ ] Enforce any internal support/admin operations under separate staff authority with a reason and audit receipt; a full admin UI remains a separate milestone.

Acceptance: test-mode subscription changes affect only applicable hosted capabilities; forged checkout success, replayed events and wrong-tenant mappings cannot grant access; cancellation never disables free local work.

## Implementation verification and publication requirements

For future implementation, run meaningful Rust formatting/lint/tests, migrations/integration tests and the remote pilot gates appropriate to each package. For desktop changes, complete `pnpm verify`, `pnpm typecheck`, `pnpm test` and `pnpm build` before publishing. Inspect staged diffs for secrets before any commit. Use test identities, environment-provided test credentials or explicit dummy tokens; never commit live secrets.

This document records planned acceptance criteria only. No implementation tests, service deployment or paid launch are claimed by task creation.

## Explicitly outside this authorization

- Creating a new repository, Rust crate, server scaffold or infrastructure account.
- Installing dependencies, provisioning databases/storage, exposing network ports or deploying services.
- Selecting prices, activating real payments or migrating customer data.
- Replacing desktop `nd-core`, broadening local IPC or exposing privileged runtime RPC over the internet.

Those actions require a later instruction to implement the relevant work package.
