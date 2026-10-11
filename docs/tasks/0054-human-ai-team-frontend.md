# TODO 0054 — Human + AI team frontend for Desktop and Customer Web

> Priority: P1 — collaboration pilot frontend
> Owner: ND frontend + shared contracts
> Status: **planned 2026-10-09; task definition only; implementation on hold**
> Authorization: Continue the approved task planning only; no frontend code, scaffolding, installs or deployments.
> Backend epic: [0053 — Rust hosted team backend](0053-rust-hosted-human-ai-team-backend.md)
> Product contract: [Human + AI company/project management](../plan/human-ai-company-team-management.md)
> PRDs: [0009 — Local team workspace](../prd/0009-local-first-team-workspace-and-durable-control-plane.md), [0010 — Customer Web](../prd/0010-nd-cloud-sync-and-customer-portal.md), [0011 — Admin and entitlements](../prd/0011-nd-admin-entitlements-and-extension-registry.md)

## Frontend direction

Retain React + TypeScript and ND's existing Tailwind/component foundations for Desktop and the proposed Customer Web frontend. Rust handles the hosted service; it does not require rewriting the UI in Rust. Reuse suitable presentational components, design tokens and domain contracts through explicit adapters rather than copying the full Electron renderer into a website.

Existing starting points include `OrganizationDashboard.tsx`, `OrganizationCollaborationCenter.tsx`, the task/Kanban surfaces, and Operations/Strategy. The current collaboration components directly call trusted preload APIs and expose local profile selection; they are not already an authenticated browser frontend.

The shared UI must represent one ND company/project model. Desktop retains local execution tools. Customer Web collaborates, plans, reviews and requests permitted host actions; it does not acquire arbitrary local filesystem, terminal, browser or provider credentials.

## Surfaces and delivery scope

| Surface | Pilot scope | Later scope |
| --- | --- | --- |
| Company / project navigation | Authorized company/project switcher, overview, objective and local/shared/host status | Additional portfolio reporting |
| Team / access | Distinct human and AI participants, invitation acceptance, scoped grants and permitted membership management | Enterprise identity and larger administration workflows |
| Project collaboration | Shared chat, task threads, mentions, decisions and Needs You | Optional presence/typing and advanced search |
| Task management | Human/agent owners, collaborators, reviewer, dependencies, handoff and progress | Broader planning/analytics |
| Review / delivery | Evidence references, explicit approval verdicts, stale approval, host/offline state | Additional integrations and delivery targets |
| Account / devices | Sign-in/out, session-expired flow, enrolled-host status and permitted revocation | Expanded device management |
| Billing / usage | No checkout required for the initial collaboration pilot | Plans, seat/storage usage, checkout/customer portal and downgrade/export states after backend T7 |
| ND staff Admin | Outside customer pilot | Separate deployment, auth/session and bundle under PRD 0011 |

## Dependency-ordered frontend tasks

### FE0 — Specify navigation, screen states and transport contracts

Dependencies: backend 0053 T0/T1 contracts.

- [x] Define Company -> Project -> Team/Chat/Tasks/Decisions/Needs You/Activity navigation across General and Coding.
- [x] Define typed local IPC/Local Web and hosted API adapters, event reconciliation, pagination and capability projections. Components must not infer permission from titles.
- [x] Specify local profile attribution versus authenticated account identity, explicit local/shared project mode and host availability.
- [x] List loading, empty, denied, expired-session, offline, reconnecting, pending, failed and revision-conflict states for each pilot surface.

Acceptance: screen/interaction inventory and contracts cover the mixed-team pilot without assuming that local preload APIs exist in Customer Web. Delivered in `shared/organization.ts` and `OrganizationDashboard.tsx`.

### FE1 — Extract reusable UI and establish the customer shell

Dependencies: FE0; real hosted integration follows backend T2/T3 and the local acceptance gate.

- [x] Separate reusable collaboration/task/team presentation from direct `window.ndDsh*` calls. Inject narrow transport and capability adapters.
- [x] Reuse ND styling, tokens and accessible components; preserve existing Desktop General/Coding behavior and trusted-preload failure handling.
- [ ] Build a responsive Customer Web shell with authorized company/project navigation and account identity; resolve revoked/deleted routes honestly.
- [ ] Clear scoped caches, drafts/subscriptions as appropriate on logout or tenant switch; never carry another tenant's data into the next account/project.

Acceptance: shared components operate through the appropriate adapter, Desktop remains usable offline, and Customer Web cannot obtain desktop-only capabilities through reuse. Desktop reuse verified; Customer Web shell planned for hosted integration.

### FE2 — Add human membership and full assignment UX

Dependencies: FE1; backend T1/T3.

- [x] Show human members and existing AI employees distinctly; separate job titles, access roles and agent execution status.
- [x] Provide permitted invitation/grant/revoke flows with explicit company/project scope and delegated administration limits.
- [x] Add human/agent task owners, collaborators, accountable humans and reviewer selection; preserve dependencies and evidence requirements.
- [x] Expose reassignment/handoff history and reconcile in-progress work through backend commands, with conflict/error feedback.
- [x] Render capability-aware controls with understandable denial states while preserving backend enforcement for every action.

Acceptance: an owner delegates a project to a PM; the PM assigns mixed human/AI work without gaining unrelated project or company authority. Delivered and verified in `OrganizationCollaborationCenter.tsx`, `OrganizationDashboardLegacy.tsx`, `shared/organization.ts`, and `tests/organization-collaboration.test.ts`.

### FE3 — Build shared discussion and realtime UX

Dependencies: FE1/FE2; backend T4.

- [ ] Implement project chat/task threads, mentions, scoped recipient pickers, message provenance, pagination, edit/tombstone states and Needs You.
- [ ] Distinguish pending/sending, accepted and failed messages. Retry with the same idempotency identity and reconcile events with acknowledgments to avoid duplicates.
- [ ] Preserve relevant scroll position/unread context during replay; show reconnect/offline status and handle history gaps explicitly.
- [ ] Keep useful agent progress/questions in shared discussion and detailed execution traces in the appropriate transcript/evidence view.
- [ ] Use explicit permitted task/execution commands; sending a mention or chat message does not silently start privileged work or approve it.

Acceptance: two independent users see ordered, readable history and real agent replies; reconnect and retries do not create duplicate bubbles or mislabel pending messages as accepted.

### FE4 — Add review, host status and account lifecycle UX

Dependencies: FE2/FE3; backend T3/T5.

- [ ] Present task artifacts/checkpoint provenance, machine-check results and independent review separately from human approval.
- [ ] Offer explicit authorized Approve / Request changes / Reject actions tied to the current revision; invalidate stale UI and refresh on conflicts.
- [ ] Show host connected/offline, queued/accepted/running/failed/cancelled work and handoffs; hosted discussion remains available when the host is offline.
- [ ] Implement reviewed Customer Web session handling, sign-in/out, invitation acceptance and expiry/revocation feedback. Renderer UI never receives desktop refresh/provider secrets.
- [ ] For embedded customer Web, preserve the protected AppView session boundary and reviewed one-time bootstrap flow from PRD 0010; keep it out of agent browser automation.

Acceptance: users understand why work waits and who must act; an offline host or changed checkpoint cannot produce a misleading success/approval state.

### FE5 — Validate the joint frontend/backend pilot

Dependencies: FE0–FE4 and backend T3–T5; runs jointly with backend T6.

- [ ] Verify meaningful component/adapter behavior for identity, scope changes, message reconciliation and revision conflicts.
- [ ] Run Desktop and Customer Web E2E for owner/PM/contributor/reviewer/guest, restricted Project B, invitations, revoked access, reconnect and host offline.
- [ ] Manually verify narrow-screen layouts, keyboard navigation, focus restoration, readable threads, status announcements and retained drafts where permitted.
- [ ] Confirm shared UI does not fabricate companies, authenticated actors or service readiness when preload/backend is unavailable.
- [ ] Record evidence that authorized people can collaborate and manage routine work without CEO mediation while protected actions remain explicit.

Acceptance: the joint pilot gate has inspectable frontend and backend evidence; local profile tests are never presented as independent-user authentication proof.

### FE6 — Add paid customer UX later

Dependencies: successful joint T6/FE5 pilot, backend T7 and selected billing/retention policy.

- [ ] Show tenant plan, user/seat mappings, hosted feature limits and usage separately from member/project permissions.
- [ ] Integrate permitted hosted checkout/customer portal actions and verified subscription-status refresh. A payment redirect alone never displays confirmed entitlement activation.
- [ ] Show trial/pending/grace/downgrade and hosted read/export states from server records; preserve free local work and customer history.
- [ ] Keep staff Admin out of the customer bundle and session; plan any staff frontend as a separate PRD 0011 task.

Acceptance: paid status reflects trusted server state, project membership remains independent, and failed/expired billing never blocks free local functionality.

## Verification and implementation hold

All checkboxes are planned and unchecked. No application code or UI prototype is created by this task. Screens can be designed against the finalized contracts before their live backend is available, but simulated data is not production or pilot evidence.

For future implementation, run appropriate frontend checks and the joint E2E/manual pilot. Complete `pnpm verify`, `pnpm typecheck`, `pnpm test` and `pnpm build` before publishing desktop changes. Customer Web checks must be defined in its chosen workspace. No hosting, dependency installation or coding is authorized by this planning document.
