# ND Access

A user-only mailbox and 2FA reader for ND.

## What it does

- Saves a Gmail mailbox with a Google **app password** and an optional **TOTP seed**.
- Reads the inbox over Gmail **IMAP over TLS** (read-only: `EXAMINE`, `BODY.PEEK`).
- Generates 6-digit TOTP codes locally from a stored Base32 seed or an
  `otpauth://totp/...` link.
- Displays one message at a time. Nothing is sent, deleted, or marked as read.

## Security model

- Secrets live in a dedicated store written by ND's main process and encrypted
  with the OS keystore (Windows DPAPI through Electron `safeStorage`). The file
  never contains plaintext credentials.
- The extension UI can only write secrets in and request derived results (mail
  rows, message text, TOTP codes). Stored secrets are never returned.
- Every host method refuses agents and CLI callers; the package declares no
  agent tools. There is no HTTP/REST route to this data.
- The UI has no clipboard integration, no network access, and renders all
  dynamic content with `textContent` (no HTML injection).

## Setup

1. Create a Google **App Password** for the mailbox (Google Account → Security →
   2-Step Verification → App passwords).
2. Optionally open the 2FA page's **Show QR** and copy the encoded
   `otpauth://totp/...` link (or the Base32 secret) into the 2FA field.
3. Save. The password field is write-only; leave it blank when editing to keep
   the saved value.

## Limits

- Gmail IMAP only (default `imap.gmail.com:993`).
- TOTP is SHA-1, 6 digits, 30 seconds (Google Authenticator).
- Read-only mail: no send, reply, delete, or attachment download.
- Removing the account deletes the sealed secrets from this device.

## Permissions

| Permission | Used for |
| --- | --- |
| `access.read` | List accounts, read mail, generate codes |
| `access.write` | Save, update, and delete account records |
