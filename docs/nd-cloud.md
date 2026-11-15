# ND Cloud — local pilot and next phase

**Status: loopback-only local pilot (M0–M5 groundwork), private beta. NOT a hosted service.**
ND Cloud currently ships as a runnable Go service in `services/nd-cloud` plus a dormant,
read-only ND-DSH bridge contract. There is no public deployment, no OIDC, no PostgreSQL and no
desktop sync daemon enabled.

> **Next phase: ND Cloud on a server (hosted).** Running the pilot locally is the current phase;
> hosting it is explicitly deferred behind the release gates below. Do not present the local JSON
> pilot as an internet-ready SaaS.

## Run locally

```sh
cd services/nd-cloud
go run . bootstrap -tenant demo -name "ND Demo" -subject owner   # prints owner token once
go run . serve -addr 127.0.0.1:8787                              # loopback only
```

Open <http://127.0.0.1:8787/> and paste the token (memory-only; no localStorage/cookies). The
same-origin console provides: Overview, Kanban (read-only ND-DSH projection), Source snapshots,
Source Wiki, Versioned Specs, Knowledge, ND Assist, ND Support, Sync Events, Router Lab, Ledger.
Guided end-to-end: `python scripts/smoke_v4.py`. Every new dev should run this alongside the
desktop — see [`development.md`](development.md).

## What the pilot provides

- Operator-provisioned 30-day opaque bearer credentials (SHA-256-only storage), revocation,
  separate human and host capability classes; tenant/project isolation.
- Host-only versioned **read-only** Kanban projection upload (`PUT /board`): monotonic revision,
  identical-retry dedup, 409 on conflict/older; scoped event replay and `sync/status` that never
  claims connectivity.
- Metadata-only ZIP source ingestion (immutable path/SHA-256 manifest; raw bytes discarded).
- **Source Wiki**: human-authored, source-linked pages with independent publish and source-drift
  staleness. Not an AI-generated Repo Wiki and not RAG.
- **Versioned Specs**: immutable revision history, independent review, viewer-safe visibility,
  source-hash conflict invalidation.
- Reviewed Knowledge Cards + deterministic, version-scoped ND Assist lookup that abstains when
  unknown. ND Support cases with proposal-only ND task links (no remote execution).
- Nonmonetary demo-unit ledger; optional memory-only BYOK streaming lab (disabled by default).
- Atomic JSON snapshot persistence, schema v1→v4 migration, AES-256-GCM passphrase backups,
  no-overwrite restore, cooperative single-writer lock.

**Not present:** Tutor (that is the ND-DSH `nd-tutor` learning extension), AI Repo Wiki/RAG,
billing/payments, OIDC, PostgreSQL, public sync.

## Relationship to ND-DSH (current)

- ND-DSH remains authoritative for local tasks, approvals and execution. The cloud receives no
  writable local authority.
- The desktop side is a **dormant read-only contract**: `src/shared/nd-cloud-bridge.ts`
  (projection builders, binding validation, `canNdCloudDispatchLocalCommand() === false`), covered
  by `tests/nd-cloud-bridge.test.ts`. Nothing in main/renderer calls it yet; there is no live sync.
- The cloud host-ingestion API is complete and server-tested, awaiting a trusted desktop exporter.
- Provider keys, secrets, transcripts and private repo contents never leave local by default.

A future **Local/Cloud Kanban source toggle** (Local = offline authoritative board; Cloud =
read-only cloud projection once a binding is enrolled) is a recorded idea, deferred; it must keep
writes/execution local-first.

## Operator CLI and recovery

Stop the server before mutating CLI commands (single-writer lock):

```sh
go run . grant -tenant demo -subject reviewer -role reviewer -projects prj_...
go run . bind-host -tenant demo -project prj_... -local-company c -local-project p
# Encrypted backup; passphrase via env only, never on the command line:
ND_CLOUD_BACKUP_PASSPHRASE=... go run . backup-encrypted -data .local/nd-cloud.json -out backup.enc.json
go run . restore-encrypted -data .local/restored.json -from backup.enc.json
```

A stale `.writer.lock` after a crash is never auto-stolen; confirm no writer is active first.

## Verification evidence

- Native Windows x64: 37 Go tests pass (`-count=3`, `-shuffle=on -count=5`, concurrency subset
  `-count=15`), `go vet`, `gofmt` (LF blobs), `node --check web/app.js`, and `smoke_v4.py` (auth,
  source import, spec review, writer-lock denial, restart persistence, encrypted restore).
- Desktop gate green: `pnpm typecheck / verify / test / build`; bridge contract tests 7/7.
- `-race` runs on CI/Linux (needs a C compiler); Windows relies on NTFS ACLs, not POSIX bits.
- See [`qa/nd-cloud-v4-stability-audit-2026-11-15.md`](qa/nd-cloud-v4-stability-audit-2026-11-15.md).

## Release gates (open) and next phase

Hosted **ND Cloud on a server** requires, before any public deployment:

- ADR-001 Go-vs-Rust decision and PRD 0009/0010 reconciliation (owner approval).
- PostgreSQL migrations + RLS/ABAC, OIDC identity, authenticated/revocable host binding.
- A trusted ND-DSH main-process exporter that revalidates enrolled, consented bindings per export.
- Billing/ledger reconciliation and provider commercial rights (paid access only).
- TLS, monitoring, backup/restore rehearsal, incident rollback, independent human sign-off.

Until these pass, ND Cloud stays a supervised local pilot: **local pilot PASS, production NO-GO**.

## References

- Delivery and boundaries: [`plan/nd-cloud-dev-delivery.md`](plan/nd-cloud-dev-delivery.md)
- V4 specs/recovery: [`qa/nd-cloud-v4-specs-and-recovery-2026-11-15.md`](qa/nd-cloud-v4-specs-and-recovery-2026-11-15.md)
- Full-team review pack (draft): `ND_CLOUD_FULL_TEAM_REVIEW_PLAN_V1.zip` (E0–E8 gates, ADR-001)
- Service README: [`../services/nd-cloud/README.md`](../services/nd-cloud/README.md)