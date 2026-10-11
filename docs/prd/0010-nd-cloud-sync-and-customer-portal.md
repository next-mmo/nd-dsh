---
id: "0010"
title: "ND Cloud Sync and Customer Portal"
status: deferred
created: 2026-09-27
---

# PRD 0010 — ND Cloud Sync and Customer Portal

## 1. Product outcome

After PRD 0009 is accepted, add optional hosted infrastructure around the complete free local ND product.

ND Cloud provides cross-device sync, remote access and hosted services for the local collaboration model defined by PRD 0009. It must not become required for normal local work.

## 1.1 Dependency gate\n\nImplementation is deferred until PRD 0009 local collaboration passes its durability/reliability gate. Cloud must transport the local model rather than inventing a second task/comment/approval system.\n\n## 2. Customer value

Potential paid capabilities:

- cross-device/company sync;
- remote Web access to connected ND hosts;
- cross-device synchronization of the local team workspace;\n- remote team access to the same comments/decisions/approvals model;
- hosted backup/history;
- devices/host management;
- team membership and roles;
- private organization extension registry;
- cloud notifications;
- future hosted workers and managed runtime services.

## 3. Tenant hierarchy

Draft identity model:

```text
Account
└── Tenant / Organization
    ├── Users
    ├── Companies
    │   └── Projects
    ├── Devices
    ├── Subscription
    ├── Sync policy
    └── Extension policy
```

Cloud tenant and ND Company are separate concepts. One tenant may contain multiple ND companies.

Authenticated users must bind to the company/project membership and capability contracts in [Human + AI company and project team management](../plan/human-ai-company-team-management.md). Implement invitations, scoped role grants, delegated administration and revocation over that shared model. Cloud sessions must not trust a selected local profile or caller-supplied member ID as identity, and tenant membership must not implicitly expose every company/project. This remains deferred work after the PRD 0009 local gate.

## 4. Local-first rule

ND starts and operates from local state. If cloud is unavailable:

- local companies/projects continue;
- agents continue;
- Kanban continues;
- Git/browser/terminal continue;
- local Web Control continues.

Only cloud-backed capabilities degrade.


## 5. ND Desktop account and device identity

ND product identity is separate from coding-engine/provider accounts.

Desktop should own an `NdAccountService` in the trusted main process. Draft login flow:

```text
User -> Sign in to ND
Desktop main -> OAuth/OIDC + PKCE + state/nonce
ND Identity -> callback/deep-link/loopback completion
Desktop main -> authenticated ND account
```

Security rules:

- customer access/refresh tokens are never exposed to React;
- no auth tokens in URL query strings;
- no auth tokens in renderer localStorage;
- refresh credentials use OS secure storage when a secure backend is available;
- if secure persistence is unavailable, fail honestly or keep only bounded in-memory session state according to the final security review;
- coding-engine/provider credentials remain separate.

Signing in may enroll the installation as an ND device with metadata such as device ID, label, platform, ND version, public-key/device credential, last-seen state and enabled cloud capabilities.

## 6. Automatic customer-Web session handoff

After Desktop login, opening Company/Kanban/Needs You/Agents inside the protected ND customer Web surface should not require a second interactive login.

Preferred flow:

```text
Desktop main (already authenticated)
    │
    ├── request one-time short-lived Web bootstrap
    ▼
ND Cloud session broker
    │
    ▼
protected ND Cloud AppView
    │
    ├── exchange bootstrap
    └── receive Secure + HttpOnly customer session cookie
```

The bootstrap is single-use, narrowly scoped, short-lived and never logged. The Web page receives a normal customer session, not the Desktop refresh credential.

The embedded customer Web runs in a dedicated Electron session partition such as `persist:nd-cloud-app`. It must not share cookies/storage with the agent-controllable built-in browser profile.

The protected AppView is not registered as a normal browser automation target and is not available to agent-browser/CDP routing. Agents needing company/task data use typed ND APIs under their own scoped authority instead of inheriting the human user's Web cookie.

External links leave the protected AppView and open in the normal ND browser or system browser according to ND policy.

## 7. Local/offline behavior

Sign-in never becomes a prerequisite for local Kanban, company state, knowledge, agents, Git, browser, terminal or local Web Control.

The customer Web UI may eventually share components across:

```text
local transport -> localhost Control Gateway -> ND Host
cloud transport -> ND Cloud -> synced state / connected ND Host
```

Cloud outage or sign-out only degrades hosted features.

## 8. Tenant/company/device binding

A local company must not be implicitly attached to a cloud tenant merely because it is active in Desktop.

Persist an explicit sync binding between:

- local company/project identity;
- cloud tenant;
- cloud company/project identity;
- sync state/revision.

Tenant switching in customer Web must respect those bindings and never reinterpret a local active company as cloud authorization.

## 9. Logout and revocation

Desktop logout should:

1. revoke/expire the ND customer refresh session as supported;
2. revoke or disable the device session as appropriate;
3. erase the protected local refresh credential;
4. clear `persist:nd-cloud-app` customer cookies/site data as required;
5. close cloud sync/realtime channels;
6. leave all local companies/projects/tasks/knowledge/extensions/repositories untouched.

Remote device revocation should make future cloud commands/sync fail closed while preserving local-only operation.

## 10. Sync architecture

```text
Local ND Store
    │
change/outbox events
    v
ND Sync Client
    │ secure outbound connection
    v
ND Cloud Sync
    │
    ├── PostgreSQL
    └── object storage
```

Do not open a local database over Dropbox/network shares for multiple writers.

## 11. Realtime/remote control

A connected ND host establishes an authenticated outbound channel to ND Cloud.

Customer Web sends typed commands through cloud to the intended connected host. The command must re-enter the same ND policy/control-plane path used locally.

No cloud command may bypass:

- policy;
- approvals;
- runtime capacity;
- leases;
- workspace isolation;
- evidence/review gates;
- credential boundaries.

## 12. Sync scope

Sync candidates:

- companies/projects;
- teams/roles/agents;
- goals/milestones/tasks;
- comments/activity;
- company/project knowledge;
- policies/budgets;
- strategic anchors;
- run/evidence summaries;
- audit receipts;
- selected artifacts.

Off/never by default:

- provider/API credentials;
- `.env` secrets;
- raw source repositories;
- local engine private storage;
- personal ND Home;
- personal chats/captures.

Personal content may be explicitly promoted into a company/project/task record.

## 13. Conflict model

Use entity versions/revisions and ordered sync cursors.

Transactions that conflict should surface a clear conflict state instead of silent last-write-wins.

Task/policy/approval state remains server-transactional. CRDT is not required for v1 sync.

## 14. Customer Web

The [0054 frontend task](../tasks/0054-human-ai-team-frontend.md) covers Desktop/Customer Web screen reuse, transport adapters, human membership, mixed-team assignment, realtime discussion, review and account/host states. React/TypeScript and existing ND component foundations are the planning baseline; Rust serves the backend. Customer billing UX follows backend entitlements, and staff Admin remains a separate application. This is task planning only; implementation remains on hold.

Primary surfaces may include:

- Overview / Needs You;
- Companies;
- Projects;
- Kanban;
- Agents and Runs;
- Knowledge;
- Team;
- Devices;
- Sync;
- Backups;
- Extensions;
- Usage;
- Subscription;
- Account.

Remote source editing is not a v1 requirement. The Web portal controls ND work and reads approved synced state.

## 15. Hosted data boundary

Customer data remains tenant-isolated.

ND staff do not receive default content access merely because ND operates the infrastructure.

Future support access to customer content must require:

- explicit support reason;
- customer authorization where appropriate;
- time-bounded grant;
- least privilege;
- audit receipt.

## 16. Infrastructure draft

Initial preference:

- PostgreSQL for relational cloud truth;
- S3-compatible storage for blobs;
- outbox/event stream for realtime;
- WebSocket/SSE service for client updates;
- add Redis only when measured fanout/cache needs justify it.

### Rust main server proposal — 2026-10-09

The product owner approved Rust for the hosted server, shared user data and realtime collaboration on **2026-10-09**, with paid hosted accounts later. Approval is for direction and task definition only: **do not code yet**. The [0053 task breakdown](../tasks/0053-rust-hosted-human-ai-team-backend.md) records dependencies and acceptance gates. Exact framework/library versions, deployment, identity/billing providers and schemas remain design decisions; hosted implementation remains behind the local acceptance gate and a later coding instruction.

Start with one modular Rust application service and a background worker from the same codebase. Separate modules by authority, rather than starting with independently deployed microservices:

| Module | Responsibility |
| --- | --- |
| Accounts / devices | Authenticated identities, sessions, device enrollment and revocation; integrate a reviewed OAuth/OIDC provider |
| Membership / policy | Tenant, company and project membership, scoped grants, invitation acceptance and authorization |
| Collaboration | Durable messages, task discussion, decisions, approval records and authorized history/search |
| Realtime / sync | Authenticated subscriptions, scoped event delivery, replay cursors, offline reconciliation and connected-host commands |
| Storage / audit | Database migrations, transactions, attachment metadata, backup/restore and audit records |
| Usage / entitlements | Tenant subscription mapping, hosted feature grants, seat/storage quotas and usage accounting |
| Billing adapter | Verified provider events, subscription reconciliation and idempotent entitlement updates; provider remains undecided |

Proposed implementation stack:

- Rust + Tokio + [Axum](https://docs.rs/axum/latest/axum/) for the HTTP service; Axum's [WebSocket support](https://docs.rs/axum/latest/axum/extract/ws/index.html) for bidirectional realtime/host channels.
- [SQLx PostgreSQL support](https://docs.rs/sqlx/latest/sqlx/postgres/index.html) for transactions and connection pooling against the hosted relational database.
- PostgreSQL for shared users/memberships, company/project records, messages, decisions/approvals, ordered change/outbox records, subscription metadata and usage counters.
- S3-compatible object storage for explicitly shared attachments/artifacts; the database stores object metadata and access scope.
- Local desktop storage remains independent: current organization JSON snapshots, planned transactional SQLite. Hosted storage does not replace offline local operation.

```text
ND Desktop / Customer Web
    -> Rust API: identity + membership + policy + hosted entitlement checks
        -> PostgreSQL: durable shared records + transactional outbox
        -> object storage: authorized attachments
        -> worker / WebSocket delivery: persisted events to authorized clients

Connected ND host <-> authenticated outbound channel <-> Rust service
    -> existing ND runtime permits, leases, workspaces and evidence gates

Billing provider -> verified events -> Rust billing adapter
    -> subscription metadata -> hosted entitlements / quotas
```

Commit accepted messages and outbox events transactionally before acknowledging them. Realtime sockets deliver notifications; reconnecting clients recover history through authorized durable queries/cursors. Presence/typing can be ephemeral. Subscription filters must be enforced by the service and re-evaluated after revocation, not trusted from client-supplied room names.

Tenant-owned content must carry its tenant and company/project scope; user identity may span multiple tenants without making their content mutually visible. Apply scoped authorization to API reads, mutations, background jobs, search and object downloads. Define encryption in transit/at rest, backup restore, export/deletion and retention requirements before production storage of customer data. Provider credentials, `.env` files and personal ND Home content stay outside default cloud sync.

Keep the hosted service a separate deployable boundary, preferably in the future `nd-cloud` repository. The existing Rust desktop crates are not already a hosted team backend. Reuse reviewed portable protocol/domain contracts where suitable; do not deploy the privileged desktop `nd-core` RPC surface or bring filesystem, PTY, browser or local credential authority into customer-facing HTTP APIs. Local-only records and execution remain ND-host owned; shared-record writer/revision authority must be finalized as described in the [team management storage review](../plan/human-ai-company-team-management.md#chat-storage-and-shared-backend-review).

Paid hosted accounts follow PRD 0011. Store billing customer/subscription identifiers and entitlement state in ND; use a payment provider for payment collection rather than placing raw card data in ND's application schema. A payment success redirect is not authority to grant service: verify provider events, deduplicate retries and reconcile current subscription state. For example, [Stripe's subscription lifecycle documentation](https://docs.stripe.com/billing/subscriptions/webhooks) describes webhook-based provisioning; Stripe is an example, not a selected provider.

An active subscription does not grant company/project membership. A project role does not bypass hosted feature limits. Nonpayment must not erase customer history or disable promised local-core functionality; define hosted grace, read/export access and retention explicitly before paid launch.

Build order: local durability gate -> authenticated two-person collaboration pilot -> reconnect/revocation/host-offline proof -> hosted quota/usage accounting -> billing and paid entitlements. No hosted services, crates or deployments are created by this proposal.

## 17. Monetization principle

Charge for hosted value/cost, not artificial local limitations.

Free local functionality must not be remotely disabled by subscription state.

## 18. Validation

Three layers:

1. contract/integration — tenant isolation, sync cursors, conflict rules, offline/reconnect, device auth;
2. E2E — two devices + customer Web + offline edits + reconnect + conflict paths;
3. human QA — real multi-device project operation for an extended session.

## 19. Open questions for deep review

- cloud repository/framework selection;
- account/auth provider and OAuth/OIDC redirect/deep-link strategy;
- secure Desktop token/session persistence policy by OS;
- Web session bootstrap TTL, audience and replay protection;
- protected AppView partition lifecycle/origin policy;
- exact pricing/retention;
- sync encryption design;
- object-storage limits;
- remote command channel protocol;
- device enrollment/revocation;
- backup restore authority;
- tenant/company membership semantics;
- regional hosting/data residency.
