# ND Cloud Go pilot — implementation and verification (2026-11-15)

Status: **Runnable, loopback-only development pilot pushed to `dev`. Not a public ND Cloud release.**

## Delivered

- `services/nd-cloud/`: dependency-free Go 1.23 HTTP service, private atomic snapshot store, operator-only pilot credential provisioning, tenant/project scope, project owner creation, reviewer/viewer scoping, credential revocation.
- Host-only `PUT /v1/projects/{id}/board` accepts strictly bounded ND-DSH task summary data with exact local/company/project binding, explicit monotonic revisions, idempotent same-revision retry and 409 on stale/conflicting revisions.
- Read-only scoped board queries; no direct task mutation, runtime execution or protected approvals.
- ND Support cases, scoped visibility, expected-revision case proposals only; does not create an ND task.
- ND Knowledge source-linked drafts and independently reviewed publication, scoped by project and app release; deterministic ND Assist lookup returns human-reviewed unverified text or `unknown`. No AI inference or verified auto-demo.
- Same-origin browser pilot at `http://127.0.0.1:8787/`, embedded assets, CSP without external scripts, in-memory-only token handling.
- `src/shared/nd-cloud-bridge.ts` includes a pure wire formatter matching Go board contracts; this is not wired to privileged desktop auth or automatic transport.

## Local verification evidence

Environment: Go 1.23.2 on Linux amd64; Node 22 used for JavaScript syntax checking.

| Check | Result |
|---|---|
| `gofmt -w *.go` | PASS |
| `go test ./... -race -count=1` | PASS (12 unit tests/examples; isolation, replay, revocation, restart, knowledge review, web asset CSP) |
| `go test ./... -race -count=3` (before web addition) | PASS |
| `go vet ./...` | PASS |
| `GOOS=windows GOARCH=amd64 go test -c` | PASS (cross-compiled only; not executed on Windows) |
| `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build` | PASS (unsigned Windows x64 pilot executable) |
| `node --check web/app.js` | PASS |
| Real loopback HTTP smoke: bootstrap owner credential, `GET /v1/me`, create project, reject unknown credential | PASS |
| GitHub connector re-fetch/blob checks for 14 Go/web files on `dev` | PASS (exact source bytes) |

## Not verified / not claimed

- React/Electron root-repo `pnpm verify/typecheck/test/build` and `tests/nd-cloud-bridge.test.ts` were **not executed** against a full checkout.
- Browser UI was HTTP/content/CSP tested, but **no interactive Playwright browser E2E** was run.
- The Windows executable was compiled but **not executed or signed on Windows**.
- No PostgreSQL/pgvector, OIDC, object storage, hosted multi-instance consistency, key vault, credit ledger, paid Router, RAG, live voice or GitHub App ingestion.
- No deployed public URL, shared internet listener, real multi-user hosted auth, live ND-DSH sync daemon or release CI status.
- The source ZIP and executable are pilot artifacts, not a signed or audited release.

## Production / authority gates

1. Resolve **ADR-001 Go vs Rust** and repository deployment boundary; existing Rust hosted direction remains documented and unchanged.
2. Accept PRD 0009 local team durability, then approve PRD 0010 shared authority and host onboarding.
3. Replace local single-writer snapshots with transactional PostgreSQL, migrations, backup/restore and recovery drills.
4. Implement OIDC/OAuth actor resolution, short-lived/revocable device credentials, TLS, tenancy tests on real DB, rate limits, audit logs, lifecycle/retention and staff separation.
5. Prove two-device host disconnect/reconnect and strict ND review/permit/lease enforcement before any remote commands.
6. Require provider-rights, metering and immutable ledger reconciliation before a paid Router Cloud offer.

## Local handoff

See `services/nd-cloud/README.md`. No Git operations, credentials, code execution privileges or cloud providers are required to test the local pilot. The UI is served from the Go process at `http://127.0.0.1:8787/` after a one-time owner token bootstrap. 
