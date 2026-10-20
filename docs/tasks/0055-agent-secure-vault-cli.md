# TODO 0055 — Secure vault CLI for every shell-capable agent

> Priority: P1
> Owner: ND extensions + desktop main process
> Status: **implemented — awaiting manual packaged-build pass**
> Depends on: [0051](0051-local-password-vault-extension.md) (local vault, sidecar storage, extension broker)
> PRD: [0008 — Command Registry and Governed Native Extensions](../prd/0008-command-registry-native-extensions.md)
> Reference: [1Password CLI skill](https://mcpmarket.com/tools/skills/1password-cli-1) — product inspiration only. No 1Password code, SDK, service, or `op` CLI integration is used or shipped.

## Objective

Give every shell-capable ND agent a **secure secret broker**: a bundled
`nd-vault` CLI that resolves Password Vault entries at execution time. Agents
send references and a command (or template); ND resolves the values inside the
desktop process, injects them into the child environment, and never returns or
prints them.

This closes the deferred item in 0051 ("agent-side secret provisioning into
engine environments") without weakening the vault's local-only, DPAPI-backed
storage model.

## 1Password skill mapping (inspiration, not a dependency)

| 1Password CLI pattern | ND implementation |
| --- | --- |
| `op://vault/item/field` reference | `ndvault://<entry-id>/<field>` (title accepted when unique) |
| `op run --env-file` | `nd-vault run --env KEY=REF -- <command>`; ND spawns the command |
| `op inject` | `nd-vault inject --in template --out file`; ND writes the file, stdout is refused |
| `op whoami` | `nd-vault whoami` (context + version, no secrets) |
| Service accounts / biometrics | ND local vault + DPAPI; per-project activation and per-entry user approval |
| "Never print secrets" guidance | Enforced by design: no `get` endpoint or CLI command; values never cross the loopback API |

## Security invariants

1. **Values stay inside ND.** `/v1/run` executes the command server-side;
   `/v1/inject` writes the file server-side. The API response contains command
   output only. There is no agent-readable `get`.
2. **Loopback + bearer only.** Bind `127.0.0.1:0`, require the exact
   `Host: 127.0.0.1:<port>`, reject any `Origin`, no CORS, constant-time token
   compare. The token is random per app run, held in memory, and delivered only
   through the environment of shell-capable engines — never `process.env`, so
   user terminals do not inherit it.
3. **Per-entry, per-context grants.** Grants use the existing invocation store
   with `resource = entry id`. Project A's remembered grant never applies to
   Project B. `once` grants are consumed before a value is read.
4. **Activation and policy are checked on every request.** The package must be
   installed, declare `vault.read`, be active for the derived context, have
   `agentCli` enabled, and pass company policy. The context comes from the
   command's validated `cwd` (active project, known task worktree, or Personal).
5. **Workspace-bound commands.** `cwd` must be inside the active workspace or
   an ND-owned task worktree. Refs, env files, templates, argv, and output are
   bounded. Child commands run without a shell (`shell: false`).
6. **Metadata-only audit.** Audit rows record entry titles, command, context,
   outcome, and duration. The service never logs a value or child output.
7. **Vault crypto is unchanged.** No Rust changes; the sidecar remains the only
   component that decrypts the vault file.

## What shipped

- **Contracts** — an internal `vault.resolve` grant/audit label (deliberately not
  in the invokable host-method allowlist, so package manifests cannot call it);
  `detail`/`resources` on `NdPendingApprovalView`.
- **Broker** — resource-scoped `findGrant`; `requestAccess`/`cancelAccess` and an
  external-approval branch in `approve`/`deny` that records grants and resolves a
  waiter without executing anything or returning a value to the renderer.
- **Service** — `src/main/vault/vault-access-service.ts`:
  - authenticated loopback server on an ephemeral port;
  - `GET /v1/status`, `GET /v1/list` (metadata only), `POST /v1/run`,
    `POST /v1/inject`;
  - context derivation, activation/settings/policy checks, per-entry approval,
    one-shot grant consumption, NDJSON output streaming, timeout/abort kill;
  - generated `nd-vault`/`nd-vault.cmd` shims in `<userData>/nd-vault-bin`.
- **Refs** — `src/main/vault/vault-refs.ts`: strict `ndvault://` grammar,
  `.env.ndvault` parsing, template extraction/replacement.
- **CLI** — `scripts/nd-vault-cli.mjs` with `whoami`, `list`, `run`, `inject`;
  packaged through `electron-builder.yml` and `verify-release.mjs`.
- **Delivery** — `engineEnvironment()` provider (Codex, Antigravity, Claude,
  Cursor, Pi, ZCode, Minimax, structured CLI), Harness launch environment, and a
  `<nd-vault-cli>` prompt hint for shell-capable engines.
- **Package** — Password Vault 1.1.0: contexts Personal + Company + Project,
  commands/views stay Personal-only, `agentCli` setting.
- **Skill** — `configs/dsh/agent-presets/nd-dsh/skills/nd-vault/SKILL.md`.
- **UI** — pending approvals render the non-secret detail (context, command,
  entry titles) and existing grants list the resource id.

## Explicit non-goals

- No 1Password `op` binary or `op://` refs.
- No agent-readable `get`/`read`; no values in argv, stdout, or logs.
- No web-engine or Rust ND Agent support (no shell).
- No terminal/user-mode CLI; the shim exists only in agent engine environments.
- No secret sync, cloud, or cross-device sharing.

## Verification

```bash
node scripts/validate-nd-extension.mjs extensions/password-vault
pnpm verify
pnpm typecheck
pnpm test
pnpm core:test
pnpm build
```

Manual: install/activate Password Vault for Personal and a project, add an
entry, then in an agent session run `nd-vault status`, `nd-vault list --refs`,
`nd-vault run --env TOKEN=ndvault://<id>/secret -- node -e "console.log(process.env.TOKEN ? 'ok' : 'missing')"`,
approve, deny, remember, revoke, and `nd-vault inject`. Confirm the transcript,
app logs, audit rows, and CLI output contain no secret value, and that a second
project's grant does not apply to the first.
