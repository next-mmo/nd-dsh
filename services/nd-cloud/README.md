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

### Browser console (working UI)

Start `go run . serve` and open <http://127.0.0.1:8787/>. This is a small **same-origin dependency-free pilot UI** (not the future React production customer portal), supporting authenticated project selection, Kanban summaries, case submission/task proposals, Knowledge Card drafts/independent publication and deterministic ND Assist lookup. Paste an operator-generated human pilot credential; the console keeps it only in memory and clears it when you disconnect or reload. The server embeds all assets and applies a restrictive Content Security Policy. No CDN, external JS, localStorage or cookies are used.

## Continued implementation: M1 metadata-only ZIP ingestion + v2 snapshot recovery

**Source import is manual, opt-in and project-scoped.** A tenant owner imports a selected `.zip` via the new **Source snapshots** page at `http://127.0.0.1:8787/`, or via HTTP. The Go server validates the ZIP and stores only an immutable manifest of file paths, SHA-256 hashes, byte lengths, ZIP hash, uploader, tenant/project scope and timestamp. Archive bytes and raw file contents are **discarded immediately**. It never executes repository scripts, generates a Wiki, trains an AI, performs RAG, or publishes approved knowledge automatically. An independently approved source-to-Wiki step remains a future milestone.

Limits: 8 MiB ZIP; 250 entries; 1 MiB per supported source file; 16 MiB total expanded; max 50 snapshots per project. Supported `.md`, `.markdown`, `.txt`, `.json`, `.yaml`, `.yml`, `.toml`, `.ts`, `.tsx`, `.js`, `.jsx`, `.go`, `.rs`, `.java`, `.py`, `.vue`, `.svelte`, `.html`, `.css`. Other file types, special files/symlinks, traversal paths, duplicate case-insensitive paths and private/dependency directories are rejected. Avoid uploading `.env`, API keys, sensitive code or any data not approved for the pilot. The path/hash manifest is private project metadata even though raw bytes are not stored.

```sh
export OWNER_TOKEN='ndp_your_private_owner_token'
export PROJECT_ID='prj_your_project_id'
curl --fail-with-body -X POST \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H 'Content-Type: application/zip' \
  -H 'X-ND-Source-Filename: pos-source.zip' \
  --data-binary @pos-source.zip \
  "http://127.0.0.1:8787/v1/projects/$PROJECT_ID/sources/zip"
curl --fail-with-body -H "Authorization: Bearer $OWNER_TOKEN" \
  "http://127.0.0.1:8787/v1/projects/$PROJECT_ID/sources"
```

Owners and reviewers may list or read manifests; viewers and host credentials cannot. Duplicate ZIP hashes in one project return `409`. This is a **provenance foundation**, not source-content search or an automated code analysis agent.

### Schema migration and private backups

Snapshot schema `v2` adds a `sources` collection. Existing **v1** local pilot stores are readable without data loss and are upgraded in memory; the *first successful mutation* persists v2 atomically. Future schema versions fail closed. Before upgrading, **stop the local service and all operator CLI writers**, create a backup and keep a second offline copy. No multi-process writer coordination exists in this pilot.

```sh
# With the service stopped; never commit or email this backup.
go run . backup -data .local/nd-cloud.json -out .local/backup-2026-11-15.nd.json
# Restore refuses to overwrite an existing data path. Use a fresh path.
go run . restore -from .local/backup-2026-11-15.nd.json -data .local/restored/nd-cloud.json
# Verify recovered data by pointing the server at the restored file:
go run . serve -data .local/restored/nd-cloud.json -addr 127.0.0.1:8787
```

Backups are private mode `0600` and SHA-256 integrity checked, with restore refusing existing destinations or world-readable backup files. **They are not encrypted.** Backups include tenant/project data, case/knowledge content and hashed pilot bearer credentials; protect the files and copied token secrets. This does not replace PostgreSQL transactions, cross-host backups or a tested hosted recovery/retention plan.

## V3 extension — reviewed source Wiki, scoped replay, proposals, BYOK lab and quota ledger

The original single-process pilot now includes experimental API features. They do **not** replace a production ND Cloud deployment or complete ND-DSH remote collaboration.

### Source Wiki and drift (M1–M3 groundwork)

A valid owner-imported ZIP creates a deterministic **draft** Wiki inventory of file paths, kinds, and SHA-256 values. It is not an AI-generated manual and it does not contain raw source code. An authorized owner/reviewer can create a human-authored page tied to a specific uploaded file via `POST /v1/projects/{project}/wiki/pages` with `{ "source_snapshot_id":"src_...", "source_path":"docs/guide.md", "title":"...", "body":"..." }`. A *different human* owner/reviewer must `POST /v1/projects/{project}/wiki/pages/{page}/publish` with `{ "expected_revision":1 }`. Published pages can be found through `GET .../wiki/search?q=...` by authorized project members. The server always labels this as unverified and does not allow automatic UI demos. On the next source ZIP import, prior published pages become **stale** and stop appearing in viewer searches. Reviewed Knowledge Cards and exact version-scoped Assist lookup remain separate flows; broad keyword Wiki search does not become an authoritative customer answer.

### ND-DSH event replay and task proposals (M4 groundwork)

`GET /v1/projects/{project}/events?after=0&limit=50` returns tenant/project-authorized ordered receipts plus `next_cursor`, `latest_cursor`, and `has_more`. Duplicated unchanged board revision uploads do not duplicate events. Only the latest 1024 events are retained: an expired or future cursor returns HTTP 409 and clients must fetch a fresh snapshot. `GET /v1/projects/{project}/sync/status` reports a stale/recent projection but **never claims host connectivity**, even immediately after an upload.

The existing support-case proposal note remains for compatibility. New, idempotent typed proposals can be created at `POST .../support/cases/{case}/task-proposals` with `{ "expected_case_revision":1, "idempotency_key":"case-001", "text":"..." }`, listed with `GET .../task-proposals`, independently approved by a tenant owner at `POST .../task-proposals/{proposal}/approve`, and receipted only by the **bound host** at `POST .../task-proposals/{proposal}/host-receipt`. These statuses are explicitly `host-reported`; the actual ND Task ID and every policy, worktree, approval and execution decision remain authoritative in ND-DSH. **No task is created or executed by these cloud endpoints.** Host receipts are not trusted evidence of ND task acceptance without a subsequent integration contract and E2E gate.

### Test-unit ledger (M5 groundwork, NOT billing)

`POST /v1/projects/{project}/ledger/demo-grant` (owner) with `{ "idempotency_key":"seed-1", "units":1000 }` grants **nonredeemable demo units**. `POST .../ledger/reservations` with `{ "idempotency_key":"r1", "units":100 }` holds them atomically, while `POST .../ledger/reservations/{id}/settle` with `{ "actual_units": 30 }` consumes 30 and releases 70. `GET .../ledger` (owner only) returns balanced append-only transactions and balances. Concurrent reservations cannot overspend. There are **no prices, card data, topups, invoices, payment providers, currency, or public entitlements**. Do not use this file-backed ledger for money or paid Router plans.

### Optional, disabled-by-default OpenAI BYOK streaming lab

The service is **loopback-only**. Opt in to a local lab by starting the Go server with `serve -router-lab` after issuing an owner token. The owner can configure a memory-only per-project OpenAI key through `POST /v1/projects/{project}/router/credentials` with `{ "api_key":"sk_...", "model":"..." }` and can inspect `GET .../router/status`. Keys vanish when the service stops, are not stored in snapshots or backups, and the upstream URL is hardcoded to `https://api.openai.com/v1/chat/completions` (no user-supplied proxy URL). The owner or reviewer may call `POST .../router/chat/stream` with `{ "request_id":"req-1", "messages":[{"role":"user","content":"Hello"}], "max_output_tokens":64 }` **only after** an owner grants nonmonetary demo units. The server reserves an estimated upper-bound quota before issuing an upstream call, streams real SSE, accepts provider-reported token counts when present, and stores sanitized attempt receipts under `GET .../router/attempts` (owner only). If usage is unavailable or streaming fails mid-flight, the entire reservation is consumed **in demo units only**. Upstream failures before stream acceptance release demo quota. Retries with the same request ID are blocked. No model availability, provider cost, token pricing, resale rights, financial suitability or API response compatibility are guaranteed; real BYOK calls may incur external provider charges. A mock HTTP upstream is used in tests; real provider access was not tested in this environment.

### Schema and verification

Local private JSON schema v3 adds Wiki, project events, task proposals, nonmonetary ledger, reservations and sanitized Router attempt receipts. Existing v1/v2 data loads through explicit in-memory upgrade and is persisted as v3 on its next successful write. Preserve an offline backup before a pilot upgrade; no simultaneous CLI + server writers.

```sh
cd services/nd-cloud
go test ./... -race -count=1
go vet ./...
node --check web/app.js
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o nd-cloud-v3-windows.exe .
```

The experimental `schema/postgres/0001_init.sql` is **not connected to the Go service and is untested against PostgreSQL**. It is design preparation only. Production needs a real database driver and migration runner, reviewable Go-vs-Rust ADR, independent membership/OIDC, host enrollment revocation, a true ND-DSH outbox, backups/restore, TLS, monitoring, and financial/provider/legal sign-offs. See `docs/qa/nd-cloud-v3-milestone-handoff-2026-11-15.md`.

## V4: human specifications, encrypted backups and single-writer guard

**Still a loopback development pilot, not an internet-facing service.** Source-linked human specs close a portion of M2. All approvals are explicit, versioned, project-scoped and independent of the current author's login. An approved spec is *human reviewed*; this does not prove code behavior or authorize ND-DSH task execution.

From the web console, select **Source Wiki → Versioned Specs**, then create a draft against the *latest* ZIP source snapshot and exact file path. Review with a different owner/reviewer credential. When the pinned file's SHA-256 changes or the file is removed in a newer imported archive, the spec switches to **conflict** and disappears from viewer reads. Revise/rebase to the latest source snapshot and ask another authorized human to approve the new revision. Full author/reviewer history remains visible only to authorized owner/reviewer members. The server publishes scoped `spec.draft`, `spec.revised`, `spec.approved` and `spec.conflict` events through the existing replay endpoint.

API: `POST /v1/projects/{project}/specs`, `GET /v1/projects/{project}/specs`, `POST /v1/projects/{project}/specs/{spec}/revise`, `POST /v1/projects/{project}/specs/{spec}/approve`. Creation body:

```json
{"source_snapshot_id":"src_...","source_path":"docs/pos.md","title":"Refund policy","body":"Refunds require the supervisor role"}
```

Revision body additionally requires `expected_revision` and the latest source snapshot ID; approval requires `{"expected_revision":1}`. Revision conflicts return 409, not silent last-write-wins. Self-approval and cross-project reads fail.

### Encrypted recovery (recommended over legacy plaintext backup)

Set a **private, minimum 16-character passphrase** using an environment variable; do not pass it as a CLI argument or commit it. Example PowerShell commands:

```powershell
$env:ND_CLOUD_BACKUP_PASSPHRASE = Read-Host "ND Cloud offline backup passphrase"
.\ND_Cloud_Pilot_V4_Windows_x64.exe backup-encrypted -data .local/nd-cloud.json -out .local/nd-cloud.enc.json
.\ND_Cloud_Pilot_V4_Windows_x64.exe restore-encrypted -data .local/restored/nd-cloud.json -from .local/nd-cloud.enc.json
Remove-Item Env:ND_CLOUD_BACKUP_PASSPHRASE
```

The format uses AES-256-GCM with a random 96-bit nonce, a random 128-bit salt, and PBKDF2-HMAC-SHA256 (300,000 rounds), authenticated against a fixed backup context. Wrong passwords and tampering fail before state is written. The key derivation scheme is suitable for local pilot backups; independent production review should select an appropriate memory-hard password KDF and tested key management. Restore requires an absent destination and strict private file permissions; it cannot silently replace existing state. V1–V3 backup files remain compatible with the **legacy unencrypted** `restore` command but *do not* become encrypted by upgrading the schema. Use the encrypted commands to protect new backup copies. Backups contain internal tenant data; protect the passphrase separately.

### Process-exclusive writer lock

The server and all mutating operator CLI commands now acquire `<data-path>.writer.lock` before reading/writing. A second writer exits with an explicit conflict instead of overwriting another process's snapshot. The file records a random owner nonce and PID but **no secrets**. If a process crashes without releasing the lock, **first confirm there is no active ND Cloud server or writer** and then manually remove this specific lock file. A stale lock is never auto-stolen.

This is intentionally a cooperative **single-host pilot** guard, not distributed locking. It does not replace PostgreSQL transactions, migration recovery, backups, OIDC user authentication, or an audited cloud deployment. Snapshot version 4 is accepted; old v1–v3 data migrates in memory and persists v4 on its next successful write. The standalone `schema/postgres/0002_human_specs.sql` is a reviewed-proposal DDL extension, **not an executed migration**.

### V4 verification

```sh
go test ./... -race -count=1
go vet ./...
node --check web/app.js
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build
```

Run the actual Windows binary and browser UI on a Windows host before any wider distribution; local cross-compilation is not a Windows E2E pass.
