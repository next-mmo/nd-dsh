# ND Cloud V4 — human spec conflicts and private recovery

Target: `next-mmo/nd-dsh`, direct `dev` delivery, `main` untouched.
Scope: local-only Go backend; implementation of a *portion* of E1 security/recovery and E3 human spec review. Does not satisfy all E0–E12 gates.

## Delivered code

- Version 4 state schema with automatic in-memory migration from v1/v2/v3 (save occurs only on next successful mutation). `specs` entries include immutable revision history: human author, source snapshot/file SHA-256, draft/approved/conflict state, actor and timestamp. Limit 100 specs per project; max 20 human edits/approvals, with source invalidation always fail-closed.
- Scoped HTTP endpoints `POST /v1/projects/{id}/specs`, `GET /v1/projects/{id}/specs`, `POST /v1/projects/{id}/specs/{spec}/revise`, and `POST /v1/projects/{id}/specs/{spec}/approve`. Different reviewer required; an invalid or stale revision is rejected. Source drift invalidates published visibility. Viewers see only currently approved specs without previous revision bodies.
- Source Wiki console now includes a human-spec draft, revision/rebase and review interface. No HTML injection for spec text (textContent nodes).
- Encrypted local backups using AES-256-GCM and PBKDF2-HMAC-SHA256 with 300,000 rounds, passphrase provided only through an environment variable. Private backup file, nonce/salt randomness, no-overwrite publish, validation/decryption before restore, authenticated envelope. Wrong passphrases and tampering cannot produce a restored state.
- Cooperative single-writer lock, shared by the server and mutating CLI commands; stale locks require manual operator review rather than automatic theft. Strict 32 MiB state bound prevents mutation that would produce an unreadable snapshot.
- `schema/postgres/0002_human_specs.sql` is **non-executed draft DDL** for later transactional PostgreSQL deployment.

## Verification

- `go test ./... -race -count=1` PASS (36 Go test functions) (includes v1–v4 migrations, scoped review, conflict invalidation, encrypted restore tampering, KDF reference vector, concurrent no-clobber file publish, writer lock).
- `go vet ./...` PASS.
- `node --check web/app.js` PASS.
- Go 1.23.2 Linux/amd64, Windows/amd64 unsigned binary cross-compile PASS; no real Windows execution.
- `python scripts/smoke_v4.py` PASS (real loopback HTTP, owner/reviewer separation across restart, writer lock denial, encrypted backup roundtrip).
- Interactive Chromium E2E **NOT RUN**; environment policy previously blocked local browser navigation. Browser UX requires real-device review.
- No connected production PostgreSQL, OIDC provider, external billing/provider audit, public network listener, or ND-DSH remote execution validation. No claims about those release gates.

## Operational limitations

The private JSON pilot is **not a production database**, and the `.writer.lock` is a cooperative guard rather than a high-availability lease. Offline passphrase crypto requires independent security review before handling sensitive customer data; prefer managed KMS and a memory-hard KDF for a hosted deployment. Legacy plaintext backups remain readable for migration, but are sensitive and should not be shared. The RLS DDL is not connected to the Go API. Existing PRD 0009 local acceptance and Go-vs-Rust hosted backend ADR remain unresolved.
