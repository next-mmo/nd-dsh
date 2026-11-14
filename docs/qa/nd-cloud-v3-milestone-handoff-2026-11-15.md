# ND Cloud full-plan milestone review — 2026-11-15

Repository: `next-mmo/nd-dsh`; target branch **`dev` only**; `main` must remain untouched. Source scope: uploaded `ND_CLOUD_FULL_TEAM_REVIEW_PLAN_V1.zip` (Epics E0–E12, M0–M6), plus repo PRD 0009/0010/0011 and tasks 0053/0054. This is a **pilot engineering delivery**, not certification of an internet-facing SaaS product.

## Implementation vs. full-plan gates

| Epic | V3 code delivered | Gate status |
|---|---|---|
| E0 Contracts/ADR | Explicit scoped Go wire models and authority boundaries, no remote ND mutation | **BLOCKED**: Go-vs-Rust ADR and company policy signoff |
| E1 Identity/DB | Operator tokens, tenant/project scope, revocation; SQL target schema draft | **BLOCKED**: PostgreSQL integration, OIDC login, audited hosted sessions, encrypted blobs |
| E2 Sources/Wiki | Bounded ZIP manifest, immutable SHA evidence, auto-draft source inventory, manual file-linked Wiki draft | **PARTIAL**: GitHub App, AST graph, content-backed Wiki generation and incremental sync |
| E3 Verified knowledge | Independent Wiki approval, source drift invalidation, existing reviewer-governed Cards, published-only keyword lookup | **PARTIAL**: source/spec conflict engine, hybrid RAG/pgvector, proof-backed UI demos |
| E4 Router lab | Disabled-by-default, fixed-upstream OpenAI SSE, memory-only project BYOK, upstream usage attempt receipts | **PARTIAL**: model catalog/capability registry, vault, provider retries/cancel matrix, verified live model access |
| E5 Wallet/plans | Idempotent, concurrent balanced **demo-unit-only** ledger and reservations | **BLOCKED**: finance-grade durable DB, payment webhooks, entitlements, refunds, rights and pricing |
| E6 Assist SDK | Existing exact-match, version-scoped, abstaining lookup | **PARTIAL**: POS SDK, verified demo, multilingual gold set, optional voice |
| E7 Support | Scoped cases and proposal notes, existing privacy rules | **PARTIAL**: case assignments, consent-driven escalation, staff operations |
| E8 ND-DSH bridge | Pure read-only desktop formatter, host-bound projection upload; ordered replay cursors and stale board detection | **PARTIAL**: desktop main-process sync client, real connected host auth/heartbeat, two-device test |
| E9 Task proposals | Explicit idempotent draft, independent owner approval, bound-host report with canonical task ID | **PARTIAL**: true ND authoritative accept/reject protocol and bidirectional E2E |
| E10 Remote collab | No remote execution or protected approval mutation | **BLOCKED** by ND-DSH PRD 0009 acceptance and hosted identity/authority |
| E11 Public billing | Disabled | **BLOCKED** by payment/rights/finance/product approval |
| E12 Live voice/scale | Disabled | **BLOCKED** by metering/privacy/provider availability/ops pilot |

## Executed verification

- Go 1.23.2 Linux amd64: **27 tests** with `go test ./... -race -count=1` **PASS**.
- `go vet ./...` **PASS**.
- Browser JavaScript `node --check web/app.js` **PASS**.
- Windows x64 cross-compile `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build` **PASS**; executable unsigned and **not executed on Windows**.
- Fake upstream integration checks: fixed authorization header, real SSE, measured provider token receipt, duplicate request prevention, cross-tenant denial, no key persistence, upstream 429 error sanitization and quota refund **PASS**.
- Concurrent demo reservation checks: 20 concurrent requests against 1000 demo units, exactly 10 reservations of 100 units, balanced legs, settlement and restart **PASS**.
- Source/Wiki/board/proposal tests: independent authorship, new-source stale invalidation, tenant isolation, project-scoped cursor replay, cursor gap and revocation **PASS**.
- Real local HTTP smoke: owner bootstrap/login, project create, ZIP import, generated Wiki draft, case creation, demo-unit ledger, event cursor, router disabled status and backup/restore **PASS**.
- A Chromium Playwright browser test was **blocked by container administrator policy** (`ERR_BLOCKED_BY_ADMINISTRATOR` on loopback) before page load. Interactive browser E2E is **NOT PASS**; run manually on actual Windows machine.
- No live OpenAI call, OIDC provider, PostgreSQL database, billing provider, GitHub App, browser agent test or ND-DSH real sync was exercised. No GitHub CI is asserted without a check status.

## Security boundaries and handoff

1. Service continues to reject non-loopback listeners. Public Internet deployment is prohibited for this pilot, even if a reverse proxy could reach loopback.
2. Only operator-provisioned test credentials are accepted; local membership is NOT an external identity or secure login substitute.
3. ND runtime approvals, leases, task creation and execution remain exclusively ND-DSH host authority. Host-reported proposal receipts are informational.
4. Router lab must be explicitly opted into with `-router-lab`. The Go process stores user-supplied BYOK in memory only. Demo units are **NOT currency**. No public or managed-key routing.
5. Source ZIP ingestion rejects symlink/traversal/bombs and retains only scoped metadata; manually authored Wiki/Knowledge Cards are separately reviewed. Inventory pages are not proof that behavior is correct.
6. PRD 0009 acceptance and the existing Rust planning decision still require human sign-off before any hosted deployment or switching backend stack.

## Required external acceptance for public release

A deployed transactional PostgreSQL service with migration/restore tests; legal and commercial model rights; OIDC/JWKS, PKCE and device enrollment; tenant/project ABAC and real DB isolation tests; HTTPS, secrets vault, audit retention and backup encryption; verified provider usage/price reconciliation and payment processor webhooks; ND-DSH two-user/two-host offline and revoked-account E2E with authoritative approval; SLO/load/incident/DR drills; signed distribution and human go/no-go. Any milestone lacking these remains **not shipped for production**.
