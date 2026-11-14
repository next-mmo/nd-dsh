# ND Cloud — runnable local pilot (M0 + ND board projection + Support)

This is **working Go HTTP code**, implemented independently under ND-DSH's `dev` branch for an isolated pilot. It is NOT ND Cloud production, not public multi-user identity, and not an enabled ND Desktop integration. Go-vs-Rust ADR-001 remains pending. ND-DSH local task/approval/agent execution stays authoritative.

## What works

- Operator-provisioned **30-day random opaque bearer credentials**, SHA-256-only credential storage, revocation, separate human and host capability classes.
- Tenant isolation, owner-only project creation, explicitly scoped human project membership, authenticated project listing.
- Host-only versioned **read-only** ND-DSH Kanban projection upload; strict tenant/company/project binding, monotonic revision, identical-retry dedup, conflict detection, bounded task summaries, no local agent commands.
- Project-scoped support cases, reporter visibility, reviewer/owner listing, and **proposal text only** for ND-DSH tasks (no automatic execution).
- Atomic JSON snapshot persistence with fsync and file mode 0600, restart recovery, loopback-only HTTP listener, bounded JSON requests, typed responses and security headers.
- Pure Go standard library; no download, database container, or external API key required to run tests.

## Run locally (Go 1.23+)

```sh
cd services/nd-cloud
go test ./... -race
go run . bootstrap -tenant demo -name "ND Demo" -subject owner
# Save the token printed once in a password manager. Do not put it in source.
go run . serve -addr 127.0.0.1:8787
```

From another terminal:

```sh
export OWNER_TOKEN='paste-owner-token-here'
curl -fsS -H "Authorization: Bearer $OWNER_TOKEN" http://127.0.0.1:8787/v1/me
curl -fsS -X POST http://127.0.0.1:8787/v1/tenants/demo/projects \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"POS Help"}'
```

Copy the returned `prj_...` project ID. Stop the server before operator provisioning (server and CLI do not coordinate concurrent processes over the same snapshot file):

```sh
go run . grant -tenant demo -subject support-user -role reviewer -projects prj_REPLACE
go run . bind-host -tenant demo -project prj_REPLACE -local-company company-a -local-project project-a
```

Restart the service. The host credential may now PUT a payload to `/v1/projects/prj_REPLACE/board`:

```json
{
  "schema_version":1, "source_system":"nd-dsh", "tenant_id":"demo",
  "cloud_project_id":"prj_REPLACE", "local_company_id":"company-a",
  "local_project_id":"project-a", "revision":1,
  "tasks":[{"id":"task-1","title":"Fix onboarding","status":"ready","priority":"high","updated_at":1700000000}]
}
```

Only enrolled host credentials can upload and only permitted humans can read. An identical replay of the same revision returns HTTP 200. A conflicting or older revision returns HTTP 409. Next revision returns HTTP 201. Owners cannot upload as hosts, and host tokens cannot read as humans.

### Support API

`POST /v1/projects/{project}/support/cases` accepts `{ "subject": "...", "description": "..." }` under a human token. `GET /v1/projects/{project}/support/cases` returns the reporter's cases for viewers, or all project cases for reviewer/owner. `POST /v1/projects/{project}/support/cases/{case}/propose-task` accepts `{ "expected_revision": 1, "proposal": "..." }` for owner/reviewer. It creates **no** ND-DSH task and cannot approve work.

### Operator credentials

`grant`, `bind-host`, `bootstrap`, and `revoke -token-id tok_...` are **trusted local CLI** operations. The credential ID is stored in the private data file and can be viewed by the operator to revoke it; **never** share the raw token or snapshot. CLI and server must not run concurrently against the same file. Never expose the service publicly; `serve` refuses non-loopback addresses.

## Explicit limitations / release gates

1. **Persistence is local atomic JSON for this pilot**, not PostgreSQL, not multi-instance, and not appropriate for production cloud tenant data. External file access is not encrypted at rest. Back up private files safely; add PostgreSQL transactions, migrations, backups and retention before public use.
2. **Human authentication is operator-provisioned pilot tokens**, not OIDC, browser login, MFA, refresh sessions or customer identity lifecycle. Operator CLI uses local filesystem trust. Do not deploy publicly.
3. No cloud desktop sync daemon or automatic export is enabled. The ND-DSH bridge remains a separately controlled read-only contract; no public IPC escalation.
4. No real LLM, RAG/verified Wiki, paid Router, model reselling, BYOK vault, live voice, financial ledger, production Admin, GitHub App or arbitrary ZIP ingest exists here.
5. Project and tenant cross-access negative tests pass only the pilot model. Before release: OIDC, policy audit, PostgreSQL RLS/ABAC, authenticated host enrollment and revocation, two-device E2E, rate limiting, TLS, monitoring and data lifecycle tests.
6. Standalone ND Cloud deploy/repository separation and Go-vs-Rust production ADR require team approval; PRD 0009 local durability and PRD 0010 cloud gates remain intact.

No GitHub Actions have been enabled and no production installer is claimed.

### Reviewed knowledge and abstaining Assist lookup

`POST /v1/projects/{project}/knowledge/cards` creates a **draft** with `app_release`, `question`, `answer`, and at least one citation `{url,revision,label}`. A distinct owner/reviewer must call `POST /v1/projects/{project}/knowledge/cards/{card}/publish` with `{ "expected_revision":1 }`; the author cannot self-publish. New publication for the same project/release/question stales older publications. Viewers never see drafts.

`POST /v1/projects/{project}/assist/lookup` accepts `{ "app_release":"v1.2.0", "question":"How do I refund an order?" }`. It returns matching human-reviewed text and citations with `status: "unverified"` or `status: "unknown"` when absent. This is **deterministic exact-question retrieval**, not RAG, vector search, an LLM, executable proof or a live UI guide. `auto_demo_allowed` is always false. Project/release authorization happens before lookup. No unmatched question can produce a fabricated guide.

### Windows PowerShell quick start

Install Go 1.23+ and open PowerShell in `services/nd-cloud`:

```powershell
go test ./... -race
go run . bootstrap -tenant demo -name "ND Demo" -subject owner
# Copy the generated token into $env:OWNER_TOKEN for this PowerShell session.
$env:OWNER_TOKEN = 'ndp_PASTE_YOUR_TOKEN_HERE'
go run . serve -addr 127.0.0.1:8787
```

In **another** PowerShell window with the same token set:

```powershell
$headers = @{ Authorization = "Bearer $env:OWNER_TOKEN" }
Invoke-RestMethod 'http://127.0.0.1:8787/v1/me' -Headers $headers
Invoke-RestMethod 'http://127.0.0.1:8787/v1/tenants/demo/projects' -Method Post -Headers $headers -ContentType 'application/json' -Body '{"name":"POS Help"}'
```

Use the same `-data` path for all CLI commands and the server. `go test -race` may require a C compiler; if your Windows Go installation lacks one, run `go test ./...` and perform race tests on CI/Linux.
