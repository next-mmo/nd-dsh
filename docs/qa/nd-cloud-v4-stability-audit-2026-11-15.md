# ND Cloud V4 — independent stability audit (2026-11-15)

**Scope:** `services/nd-cloud` loopback-only Go V4 source archive, Windows x64 PE artifact metadata, and the `next-mmo/nd-dsh` `dev` branch. **This is not production release certification.**

## Reproducible finding and correction

**Fixed: read-side lock hold stalled unrelated writes.**

Previously `Store.read` held the global `RWMutex.RLock` while invoking a callback. API callbacks include response serialization; a slow or stalled client could therefore hold the lock and block all `Store.transact` writes. A regression test confirmed the defect on unpatched V4 by failing when an independent write could not finish while a read callback was paused.

The fix takes a point-in-time `State` snapshot while briefly holding `RLock`, unlocks, and then invokes the callback. This is safe with this service's existing **copy-on-write transaction rule**: `transact` deep-clones state and atomically replaces `s.state`; callbacks must never mutate state or its nested maps/slices. Added `services/nd-cloud/store_stability_test.go` to verify read consistency, write progress and restart persistence.

## Verification performed on extracted V4 ZIP, plus the corrected files

| Check | Result |
| --- | --- |
| Unmodified V4 `go test ./... -race -count=1` | PASS |
| Regression reproducer against unmodified `Store.read` | FAIL as expected (write blocked by slow reader) |
| Patched `go test ./... -race -count=3` | PASS |
| Patched `go test ./... -race -shuffle=on -count=5` | PASS |
| Concurrency/revision/ledger/backup regression subset, `-race -count=15` | PASS |
| `go vet ./...` | PASS |
| `gofmt -l *.go` | PASS |
| `node --check web/app.js` | PASS |
| `python3 scripts/smoke_v4.py`: auth, source import, spec review, process-lock denial, restart, encrypted restore | PASS |
| `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build` | PASS (cross-compiled Windows executable) |
| GitHub `dev` `store.go` and regression test SHA against local tested files | PASS |

There are **37 named Go test functions** with the new regression test; the table reports repeated suite executions, not 37 independent application features.

## Explicitly not verified

- **Interactive web browser E2E:** system Chromium launches, but attempting to navigate to the local pilot HTTP URL returns `net::ERR_BLOCKED_BY_ADMINISTRATOR`; therefore login/forms/navigation were **not** executed in a real browser.
- **Native Windows runtime:** the x64 PE build compiles but was **not launched on Windows**. File-locking and filesystem semantics need Windows real-device validation.
- **Production hosted implementation:** no PostgreSQL transaction/migration execution, OIDC, public TLS service, CI checks, hosted durability drill, signed installer, cloud/ND-DSH authority proof, distributed load test, or provider/billing approval. The local JSON snapshot service must not be presented as an internet-ready SaaS.
- **Disk fault injection:** process crash during fsync/rename, power-loss recovery, out-of-disk-space and malformed external state recovery have not been certified; encrypted round-trip, tampering, wrong password and normal restart are covered.
- The full Electron ND-DSH root `pnpm verify/typecheck/test/build` suite was **not** run as part of this Go service-only audit.

## Operational advice

- Keep the listener bound to `127.0.0.1`; do **not** forward port 8787 to the internet.
- Back up the existing `.local/nd-cloud.json` before installing a new binary. Prefer `backup-encrypted` with a passphrase kept separate from the backup.
- Gracefully stop the service before replacing binaries or data. Writer-lock files are deliberately not stolen automatically; investigate whether the prior process is still active before removing a stale lock after a crash.
- Restart and validate tenant, project, board, spec-review and case state after upgrade; run the provided `scripts/smoke_v4.py` on a development machine.
- Treat the same-origin web console as **development only** until actual Windows and browser E2E, identity, database, and operational gates pass.

## Ship decision

**Local pilot: conditional PASS** for continued supervised development testing after the read-lock fix. **Production SaaS: NO-GO.** This audit does not alter main or authorize a production rollout.
