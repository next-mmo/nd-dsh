# ND Password Vault

A 1Password-inspired, **local-first** credential store for ND. Save passwords,
API keys, and other secrets; find them again from the launcher; copy them to
the clipboard when you need them; or let a shell-capable agent use them through
the secure `nd-vault` CLI without ever receiving the value.

## What it does

- **Add Vault Entry** opens an ND-owned dialog where you type the title,
  username, website, secret, and optional notes. Launcher commands carry no
  typed arguments, so the secret is typed into the dialog, not the launcher.
- **Password Vault** opens the entry list. Rows show the title plus username
  and website — never the secret.
- Row actions: **Copy secret** (clipboard, through the sidecar's echo-
  suppressed write so Clipboard History never records it), **Edit**, and
  **Delete**.
- **Secure agent CLI** lets Codex, Claude Code, Cursor, Pi, ZCode, Antigravity,
  Minimax, and ND Harness use an entry in a command without reading it.

## Secure CLI (`nd-vault`)

ND injects `nd-vault` into every shell-capable agent session. The CLI is a thin
loopback client: ND resolves references and executes the command (or writes the
file) itself, so the value never crosses the API and never enters the agent
process.

```bash
nd-vault list --refs
nd-vault whoami
nd-vault run --env GITHUB_TOKEN=ndvault://<entry>/secret -- gh release create v1.0.0
nd-vault run --env-file .env.ndvault -- npm run deploy
nd-vault inject --in config.template --out .env.local
```

- References: `ndvault://<id>/secret` (default), `/username`, `/url`, `/notes`.
  A unique title works too.
- `.env.ndvault` lines are `KEY=ndvault://<entry>/<field>`; the file contains
  references, not values.
- `nd-vault run` refuses literal values as `--env KEY=value`. There is no
  `get`/`read` command.
- Commands are spawned without a shell and without stdin. Interactive prompts
  are not supported; a command that waits for input will time out.
- The `inject` output directory must already exist and must resolve inside the
  workspace (symlinked directories that escape it are refused).
- Each entry needs your approval the first time; choose **Allow once** or
  **Remember**. Remembered grants are per entry and per active context, and can
  be revoked in Settings → Extensions → Access and activity. A grant in one
  project never applies to another.
- Turn agent access off for a context in this extension's settings
  (**Allow agents to use nd-vault**).

Security boundaries:

- Agent commands run as your user, in the active workspace or an ND task
  worktree. `nd-vault` is not a sandbox; it is a secret broker. The approval
  dialog shows the exact command, so an attempted `printenv` is visible.
- ND records metadata only in the audit log (entry titles, command, context,
  outcome) — never a value.
- The value can still appear if the command itself prints it. The bundled
  `nd-vault` skill forbids that, and the approval prompt is your last check.
- Web agents and the Rust ND Agent have no shell, so they cannot use the CLI.

## What it never does

- No network. There is no sync, no cloud, no account. The vault is one file in
  your ND profile directory.
- No plaintext at rest. The whole vault is encrypted with AES-256-GCM; the key
  is random and protected by Windows DPAPI (user-scoped). The decrypted key
  lives only in the sidecar's memory.
- No secrets in the list. Listing returns metadata rows only; reading or
  copying a secret is a sensitive action that agents must be granted
  explicitly. Creating and editing are user-only actions.
- No secret values in the CLI protocol. `nd-vault` injects and writes; it never
  returns a value.
- No telemetry. The audit log records that an action happened — never its
  content.

## Install

Settings → Extensions → **Available** → Password Vault → Install, then
activate it for **Personal** and for any project where agents should be able to
request entries. Or validate this folder any time with:

```bash
node scripts/validate-nd-extension.mjs extensions/password-vault
```

## Storage location

`<ND profile>/nd-vault/vault.ndvault` plus a sibling `vault.ndvault.key`
holding the DPAPI-protected master key. Deleting both destroys every entry
permanently. The vault currently requires Windows; macOS Keychain and Linux
libsecret protectors are planned follow-ups.

## Agent resources

- Skill: `configs/dsh/agent-presets/nd-dsh/skills/nd-vault/SKILL.md`
- Broker: `src/main/vault/vault-access-service.ts`
- CLI: `scripts/nd-vault-cli.mjs`
