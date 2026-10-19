# Account Manager (ND extension)

A local-first inventory of the accounts you own, with a guided registration
walkthrough for ChatGPT.

## What it does

- Lists accounts with service, email, username, mailbox link, site link, notes,
  and a registration status (`planned`, `awaiting-code`, `active`, `disabled`).
- Creates, edits, and deletes account metadata.
- **Register with ChatGPT** walks you through:
  1. Enter the mailbox address and its inbox URL (for example a
     `https://www.mailticking.com/` mailbox) and open it in ND's browser.
  2. Open ChatGPT's login/signup page in ND's browser, with an **Open mailbox**
     button to switch back for the code.
  3. Complete signup yourself, including typing the verification code from the
     mailbox on ChatGPT's page.
  4. Mark the record active.
- **Open site** and **Open mailbox** buttons navigate ND's visible embedded
  browser (`browser.openUrl`).

## What it deliberately does not do

- It does not create ChatGPT accounts, fill signup forms, generate passwords,
  read mailbox contents, or read/enter verification codes.
- It stores no passwords or codes. Account metadata lives in
  `userData/nd-account-mgt/accounts.json`; put any password in ND Vault.
- It does not bypass CAPTCHAs, phone checks, or any other human-verification
  gate. Those remain with you.

The guided flow exists because the human must remain the account holder and
complete the service's verification steps. Automating those steps would violate
the provider's signup rules and ND's human-verification policy.

## Install

1. Validate the package:

   ```bash
   node scripts/validate-nd-extension.mjs extensions/account-mgt
   ```

2. In ND: Settings → Extensions → Discover → **Account Manager** → Install.
3. Activate the package for Personal.
4. Run **Account Manager** from the launcher (Ctrl+K).

The package is fully external: it ships no code in the app bundle, uses no
executable runtime, and runs its UI in ND's sandboxed web-view iframe.

## Permissions

| Permission | Used for |
| --- | --- |
| `accountmgt.read` | Listing account metadata |
| `accountmgt.write` | Creating, editing, deleting account records |
| `browser.navigate` | Opening the site and mailbox links in ND's browser |

## Data

`accounts.json` contains service, email, username, mailbox URL, site URL,
status, notes, and timestamps. It is written atomically with owner-only file
permissions. Corrupt or missing data starts an empty list; nothing is synced.
