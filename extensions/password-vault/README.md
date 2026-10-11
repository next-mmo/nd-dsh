# ND Password Vault

A 1Password-inspired, **local-first** credential store for ND. Save passwords,
API keys, and other secrets; find them again from the launcher; copy them to
the clipboard when you need them.

## What it does

- **Add Vault Entry** opens an ND-owned dialog where you type the title,
  username, website, secret, and optional notes. Launcher commands carry no
  typed arguments, so the secret is typed into the dialog, not the launcher.
- **Password Vault** opens the entry list. Rows show the title plus username
  and website — never the secret.
- Row actions: **Copy secret** (clipboard, through the sidecar's echo-
  suppressed write so Clipboard History never records it), **Edit**, and
  **Delete**.

## What it never does

- No network. There is no sync, no cloud, no account. The vault is one file in
  your ND profile directory.
- No plaintext at rest. The whole vault is encrypted with AES-256-GCM; the key
  is random and protected by Windows DPAPI (user-scoped). The decrypted key
  lives only in the sidecar's memory.
- No secrets in the list. Listing returns metadata rows only; reading or
  copying a secret is a sensitive action that agents must be granted
  explicitly. Creating and editing are user-only actions.
- No telemetry. The audit log records that an action happened — never its
  content.

## Install

Settings → Extensions → **Available** → Password Vault → Install, then
activate it for **Personal** (the only context it supports). Or validate this
folder any time with:

```bash
node scripts/validate-nd-extension.mjs extensions/password-vault
```

## Storage location

`<ND profile>/nd-vault/vault.ndvault` plus a sibling `vault.ndvault.key`
holding the DPAPI-protected master key. Deleting both destroys every entry
permanently. The vault currently requires Windows; macOS Keychain and Linux
libsecret protectors are planned follow-ups.
