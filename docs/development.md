# ND-DSH local development

Full local setup for a new developer, including running **ND Cloud locally** alongside the
desktop. ND-DSH is local-first: the desktop, its Rust sidecar and the ND Cloud pilot all run on
your machine; nothing here requires a hosted service.

> Hosted **ND Cloud on a server is a later phase**, not part of local development. See
> [`nd-cloud.md`](nd-cloud.md) for the pilot's boundaries and next-phase gates.

## Prerequisites

- Node.js 24+ and pnpm 11 via Corepack
- Git
- Rust toolchain (pinned by `rust-toolchain.toml`) for the `nd-core` sidecar
- Go 1.23+ for the ND Cloud pilot (`services/nd-cloud`)
- Python 3 (optional) for the ND Cloud smoke script
- A supported Electron desktop OS (Windows x64 is actively validated)

## Bootstrap and run the desktop

```sh
corepack enable
corepack pnpm bootstrap   # installs deps and syncs the Harness submodule to upstream latest
corepack pnpm dev         # builds nd-core/nd-agent, then starts electron-vite + Electron
```

`pnpm dev` prints the renderer URL (normally `http://localhost:5173`) and the ND-DSH CDP port.
Configure model providers from **Settings → Models**. Opening the renderer URL in a regular
browser shows a labeled, fixture-only **UI Preview**; real agents, Git, browser and organization
runs function only inside Electron.

## Run ND Cloud locally (every new dev)

The ND Cloud pilot is part of the standard local stack. Run it next to the desktop:

```sh
cd services/nd-cloud
# Create a tenant + owner. Prints an ndp_... token ONCE — save it privately.
go run . bootstrap -tenant demo -name "ND Demo" -subject owner
# Start the loopback-only service (default data: .local/nd-cloud.json)
go run . serve -addr 127.0.0.1:8787
```

Open <http://127.0.0.1:8787/> (you can open it inside the ND built-in browser) and paste the owner
token. For a guided end-to-end check that uses a throwaway temp data dir:

```sh
python scripts/smoke_v4.py
```

Rules: the service refuses non-loopback listeners; stop the server before running mutating CLI
commands (`grant`, `bind-host`, `restore`, …) because a single cooperative writer lock guards the
snapshot; keep the data directory inside your private user profile. Full usage and feature list:
[`nd-cloud.md`](nd-cloud.md).

## Verification gate (run before publishing)

```sh
corepack pnpm verify
corepack pnpm typecheck
corepack pnpm test
corepack pnpm core:test
corepack pnpm build
```

End-to-end specs drive the real built app; build first, then:

```sh
corepack pnpm build
corepack pnpm e2e
```

ND Cloud service gate (from `services/nd-cloud`):

```sh
go test ./...          # add -race on CI/Linux where a C compiler exists
go vet ./...
node --check web/app.js
python scripts/smoke_v4.py
```

GitHub Actions is parked (`.github-bk/`); the local commands above are the release gate.

## Windows notes and common traps

- **Race detector:** `go test -race` needs cgo/a C compiler. On Windows without one, run
  `go test ./...` and keep race coverage on CI/Linux.
- **gofmt:** the checkout uses CRLF (`core.autocrlf=true`), so `gofmt -l` flags every file. Check
  formatting against committed LF blobs, not the CRLF working tree.
- **File permissions:** Windows has no POSIX `0600` bits; the pilot relies on NTFS directory ACLs.
- **Stale main bundle:** e2e runs the built `out/main`, not `src/main`. Run `pnpm build` after
  editing main-process code or e2e will exercise stale behavior.
- **Orphaned dev processes:** stopping `pnpm dev` can leave `electron.exe` / `nd-core.exe` children
  that block the next start. Terminate those specific children before relaunching.
- **Secrets:** never commit keys or `.env*`; provider keys entered in Settings use OS-backed secure
  storage and are never returned to the renderer.

## Where to go next

- Product and architecture: [`README.md`](../README.md), [`architecture.md`](architecture.md)
- ND Cloud pilot and next phase: [`nd-cloud.md`](nd-cloud.md)
- Extensions: [`extensions/authoring.md`](extensions/authoring.md)
- Contribution gate: [`CONTRIBUTING.md`](../CONTRIBUTING.md)
- Documentation index: [`README.md`](README.md)