> **2026-11-15 V3 implementation update:** The Go loopback pilot now includes independently reviewed, source-linked Wiki drafts, conservative drift invalidation, replayable scoped events, governed task proposals and host receipts, a balanced nonmonetary demo-unit ledger, and an optional memory-only BYOK streaming lab. See [V3 implementation and 27-test QA evidence](../qa/nd-cloud-v3-milestone-handoff-2026-11-15.md). PostgreSQL, OIDC, hosted ND sync, public payments, real-money billing, finance and provider rights remain blocked. This update does not supersede PRD 0009/0010's authority gates or approve a Go-over-Rust production ADR.

# ND Cloud — first safe delivery on `dev`

Status: **runnable Go pilot implemented; no production ND Cloud service or public deployment**  
Repository: `next-mmo/nd-dsh`  
Source review: `ND_CLOUD_FULL_TEAM_REVIEW_PLAN_V1.zip` provided 2026-11-15

## What this change provides

- `src/shared/nd-cloud-bridge.ts`: versioned, narrow, opt-in **read-only** Kanban summary projection for one explicitly bound tenant/company/project.
- `tests/nd-cloud-bridge.test.ts`: isolation, minimal payload, version/capability denial, no cloud command acceptance.
- No changes to existing ND-DSH renderer permissions, local agent execution, background sync, billing, or package dependencies.
- `services/nd-cloud/`: runnable Go 1.23+ loopback HTTP service with operator-provisioned identity, tenant/project grants, scoped ND board ingestion, support cases, independently reviewed Knowledge Cards, deterministic Assist lookup and persistent private state.
- `services/nd-cloud/api_test.go`, `knowledge_test.go`, and `web_test.go`: authorization, isolation, revision, review, revocation, restart, concurrency and web-surface tests.
- `services/nd-cloud/web/`: local same-origin console for project selection, board viewing, knowledge draft/review, Assist lookup and support.

This is **M0 pilot code**, not a completed hosted backend, desktop sync daemon, OIDC deployment or paid service. A caller must still verify authenticated binding and project membership in a trusted main-process service. The `enabled` field is an opt-in record, **not proof of identity or permission**.

## Product boundaries

1. Desktop and local Web retain local task/approval/run ownership. The cloud receives no writable local authority.
2. ND Tutor remains the learning feature. Customer help is ND Assist; support operations are ND Support; model access is ND Router Cloud.
3. ND Claw 2.0 is a separate project, not an ND-DSH module.
4. Never sync provider keys, local user secrets, private repo contents, run transcripts, task descriptions, artifact paths, member identities or approvals by default.
5. Hosted collaboration and remote commands remain gated by [PRD 0009](../prd/0009-local-first-team-workspace-and-durable-control-plane.md) and [PRD 0010](../prd/0010-nd-cloud-sync-and-customer-portal.md). Historical code merges are not acceptance evidence.
6. The uploaded ND Cloud review pack suggests **Go** for a new independently deployable `nd-cloud` service; existing [Task 0053](../tasks/0053-rust-hosted-human-ai-team-backend.md) records the previously approved **Rust** direction for hosted collaboration. Resolve ADR-001 before starting a shared hosted backend. Do not add a second task authority into this repository.

## Required next gates

| Gate | Exit evidence |
|---|---|
| E0 ownership/ADR/security | Human-approved Go-vs-Rust ADR; tenant/project data classification; authenticated binding and source-of-truth contract |
| E1 tenant core | Independent `nd-cloud` service, PostgreSQL migrations, OIDC identity, membership/tenant denial tests and backup/restore evidence |
| E2 knowledge ingest | GitHub App/ZIP scanning, immutable source SHA, provenance and no-execution sandbox tests |
| E3 knowledge/assist | Human-approved guide, tested release proof, cited answer or explicit abstention |
| E4 router BYOK lab | Authorized provider rights, scoped secrets, streaming cancellation, attempt receipts and rate/usage limits |
| E7 support | Private case storage, consent-based escalation, human review and proposal-only ND task link |
| E8 ND board bridge | PRD 0009 acceptance, signed/revocable host binding, authenticated cursors, replay/dedup, disconnect-stale indicator |
| Paid access | Atomic ledger, tested refunds/reconciliation, model commercial rights and explicit financial sign-off |

## Local verification

Go service verification from `services/nd-cloud`:

```sh
go test ./... -race -count=1
go vet ./...
go run . bootstrap -tenant pilot -name Pilot -subject owner
go run . serve -addr 127.0.0.1:8787
```

**Evidence (2026-11-15):** 12 Go tests/examples passed under `-race`, `go vet` passed, Windows `GOOS=windows GOARCH=amd64 go test -c` passed, and a live loopback HTTP smoke test verified bootstrap authentication, project creation and unknown-token denial. Go browser console assets and CSP route tests passed; JavaScript syntax check passed. Interactive browser E2E, TypeScript Electron project-wide checks and production integration tests were not run here.

Desktop verification remains:

```sh
corepack pnpm vitest run tests/nd-cloud-bridge.test.ts
corepack pnpm typecheck
corepack pnpm verify
corepack pnpm test
corepack pnpm build
```

Run the full gate on a compatible local Node 24/pnpm 11 desktop checkout before any release. Passing the isolated contract tests alone does **not** establish release readiness.

## Security caveat

These pure functions are intentionally not an authenticated cloud exporter. Do **not** call them with untrusted client-provided binding values and then upload the result: the module is defense-in-depth, not authorization. A future trusted desktop integration must validate a previously enrolled, user-consented binding and recheck policy, revocation, exact project and remote session on every export. Cloud integration should be kept disabled until those checks and the transport have been implemented and tested.
