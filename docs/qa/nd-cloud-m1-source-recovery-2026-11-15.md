# ND Cloud M1 — source provenance and recovery verification

Date: 2026-11-15
Branch: `dev` only, in `next-mmo/nd-dsh`
Product status: **local pilot; NOT an internet-ready or production hosted ND Cloud release**

## Delivered

1. Go v2 snapshot model adds project-scoped immutable source provenance manifests. Legacy v1 snapshots remain readable, are upgraded in memory, and persist v2 on a successful transaction; unknown future schemas fail closed.
2. Human owner may upload a ZIP for an explicitly selected project at `POST /v1/projects/{project}/sources/zip`. Supported source file paths, per-file SHA-256 hashes, byte sizes, source kinds, uploader, tenant/project and ZIP hash are stored. **Raw ZIP and file contents are intentionally discarded.**
3. User-requested ZIP contents are never executed. Archive parsing rejects symlinks, traversal, absolute/Windows paths, duplicate case-folded paths, hidden `.env` paths, dependencies/private directories, unsupported file types and ZIP bombs using bounded streaming reads. Explicit per-archive and project quotas apply.
4. Project-scoped `GET /v1/projects/{project}/sources` and `.../sources/{snapshot}` are owner/reviewer only. Human viewer and host credentials cannot access them. Revocation is rechecked before project-scoped reads.
5. Private operator `backup -out` and `restore -from` commands provide checksum-verified copy and fail-closed, no-overwrite restore into a fresh path. Backup files include customer data and hashed tokens; **not encrypted**, so treat them as sensitive.
6. Same-origin console adds **Source snapshots** tab and safe ZIP upload. No external browser tokens, scripts, AI inference, raw source retention, GitHub integration or automatic Wiki publication.

## Verification, local Linux x86-64

- `go test ./... -count=1`: **19 passed Go tests/examples**.
- `go test ./... -race -count=2`: **PASS**.
- `go vet ./...`: **PASS**.
- `node --check web/app.js`: **PASS**.
- `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build`: **PASS (cross-compiled, not executed on Windows)**.
- Live loopback HTTP: owner login, create project, upload 2-file ZIP, retrieve manifest: **PASS**.
- Live CLI: backup private snapshot, restore to a fresh data path, recover source manifest and v2 version: **PASS**.
- Negative tests: cross-tenant, viewer/host denial, revoked owner token, unsafe ZIP paths/symlinks/decompression/case collisions, duplicate hash, quota, backup tampering, world-readable backup, restore-overwrite, legacy v1 state and future version: **PASS**.

## Known constraints and production blockers

- Source manifests only: no source text search, source code graph, generated/approved Wiki, RAG, LLM, source webhook or GitHub App yet.
- Atomic local JSON snapshot with a single trusted writer; no PostgreSQL, migrations for hosted DB, point-in-time recovery, multi-node concurrency, online backup guarantees or object store. Stop the process before local operator migration/restore.
- Operator-provisioned bearer credentials are for loopback development only; no OIDC/PKCE, staff/customer separation, TLS, dedicated tenant database/RLS, public abuse controls or audit attestation.
- Full root Electron/TypeScript test suite and interactive browser Playwright tests not performed in this phase. Windows binary is not signed or tested on Windows hardware.
- ND-DSH local PRD 0009 remains the authority gate for shared task state, review and execution; Go-versus-Rust hosted-service ADR-001 remains open.

See `services/nd-cloud/README.md` for local operation and request examples. Do not deploy the pilot externally.
