# ND Pay Guard

**ND Pay Guard** (`nd.pay-guard`) is a privacy-first, local subscription tracker and renewal alert extension for the ND desktop environment. It keeps track of recurring subscriptions, calculates monthly and annual software run-rates, and dispatches native desktop OS notifications before renewal charges occur.

---

## Key Principles & Privacy Guarantees

1. **100% Local & Manual**: ND Pay Guard is strictly local-first. There are **no bank integrations**, **no credit card numbers**, **no account logins**, and **no third-party server syncs**.
2. **No Automatic Cancellations**: Pay Guard alerts you in advance so you can review, pause, or cancel subscriptions yourself; it never touches external payment gateways or executes financial transactions.
3. **Desktop OS Notification Requirements & Lifecycle**:
   - **ND must remain running** (or minimized in the background) for reminders to trigger.
   - **System notifications must be enabled for ND** in your operating system's notification center (macOS Notification Center, Windows Action Center, or Linux notification daemon).
   - **Truthful Delivery & Event-Based Settle**: Reminders await asynchronous native OS presentation events (`show` vs `failed`) with a 5-second bounded timeout, retaining notification references until settled to avoid premature garbage collection. Unconfirmed dispatches are not marked as delivered and remain retryable.
   - **macOS UNNotification & Unsigned Dev Binaries**: On macOS (Electron v42+), notifications use Apple's UserNotifications framework (`UNNotification`), which requires a code-signed application bundle with a bound `Info.plist`. In local development (`node_modules/electron/dist/Electron.app`), stock binaries have an unbound adhoc linker signature which causes macOS to asynchronously emit a `failed` event (`UNErrorDomain error 1`).
   - **Local Dev Testing Verification**: To test native OS notifications in development without creating certificates or touching release packaging, deep-sign an ad-hoc copy:
     ```bash
     cp -R node_modules/electron/dist/Electron.app /tmp/Electron-dev.app
     codesign --force --deep --sign - /tmp/Electron-dev.app
     ELECTRON_OVERRIDE_DIST_PATH=/tmp /tmp/Electron-dev.app/Contents/MacOS/Electron .
     ```
   - Use the **Test Notification** button inside the extension to immediately verify OS notification delivery. If the OS rejects presentation, the UI displays actionable diagnostic guidance rather than claiming delivery.

---

## Features

- **Full Subscription CRUD**:
  - Name, amount, and ISO currency code (USD, EUR, GBP, CAD, AUD, JPY, SGD, IDR, etc.).
  - Billing cycles: `weekly`, `monthly`, `yearly`, and `one-time`.
  - Next renewal date picker (`YYYY-MM-DD`).
  - Configurable reminder window: specify how many days before renewal (0–30 days) to fire desktop OS notifications.
  - Status management: `active`, `paused`, or `cancelled`.
  - Account/Billing management URL (launchable directly in your default system browser).
  - Private notes (e.g. payment method reminder, trial terms).
- **Leap Year & Month-End Date Math**:
  - Automatically advances next renewal date when marked as paid.
  - Accurate month-end clamping and leap year preservation:
    - `Jan 31` (monthly) -> `Feb 29` (leap year 2024) -> `Mar 31` -> `Apr 30` -> `May 31`.
    - `Feb 29` (yearly, leap year) -> `Feb 28` (non-leap year) -> `Feb 29` (next leap year).
- **OS Reminders & Deduplication**:
  - Checks for due reminders on ND startup.
  - Runs a bounded background check timer while the extension is active.
  - Deduplicates notifications per renewal cycle date so you are never spammed twice for the same billing date.
  - Automatically suspends timer and stops alerts when uninstalled, deactivated, or when subscriptions are paused.
- **Run-Rate Analytics & Upcoming Charges**:
  - Real-time monthly spend run-rate and annual projection grouped by currency.
  - Upcoming renewal charge timeline (charges due in the next 30 days) with urgency badges (`Due today`, `Due tomorrow`, `Due in 3d`, `Overdue`).
  - Quick **Mark Paid** action to record payment and advance the cycle in one click.

---

## Architecture & Permissions

ND Pay Guard is implemented as an external **Personal** extension following the `nd.extension/1` specification.

### Manifest Contributions
- **Commands**:
  - `open`: Launcher shortcut to open the Pay Guard dashboard (`payguard.subscriptions.list` -> view `guard`).
- **Views**:
  - `guard`: Package-shipped sandboxed web view (`ui/index.html`) running in an isolated iframe with a strict Content Security Policy (`connect-src 'none'`).

### Allowlisted Host Methods
- `payguard.subscriptions.list`: Retrieves all subscriptions, upcoming charges, and run-rate summaries (`payguard.read`).
- `payguard.subscriptions.create`: Creates a new tracked subscription (`payguard.write`).
- `payguard.subscriptions.update`: Edits an existing subscription (`payguard.write`).
- `payguard.subscriptions.delete`: Deletes a tracked subscription (`payguard.write`).
- `payguard.subscriptions.markPaid`: Marks subscription as paid and advances next renewal date (`payguard.write`).
- `payguard.subscriptions.upcoming`: Lists charges due within a customizable day horizon (`payguard.read`).
- `payguard.notifications.test`: Triggers an immediate OS test notification (`payguard.write`).
- `browser.openExternal`: Opens the subscription's account or cancellation URL in the system browser (`browser.openExternal`).

---

## Storage & File Structure

Persistent data is stored in the user profile directory:
```
<userData>/nd-pay-guard/subscriptions.json
```
Atomic file persistence ensures data integrity even across sudden application restarts.

### Package Layout
```
extensions/nd-pay-guard/
├── nd-extension.json      # Declarative extension manifest (nd.extension/1)
├── README.md              # Documentation and operational requirements
└── ui/
    ├── index.html         # Sandboxed web view UI
    ├── pay-guard.js       # nd.webview/1 bridge controller & event bindings
    ├── pay-guard-core.js  # Pure client logic (formatting, date differences, filtering)
    └── pay-guard-core.d.ts # TypeScript definitions for unit testing
```

---

## Validation & Testing

Validate manifest conformance:
```bash
pnpm ext:validate extensions/nd-pay-guard
```

Run test suite:
```bash
pnpm vitest run tests/pay-guard-store.test.ts tests/pay-guard-scheduler.test.ts tests/pay-guard-core.test.ts tests/pay-guard-extension.test.ts
```

The test suite validates:
- Event-based notification delivery lifecycle (`show`, `failed`, 5s timeout, reference retention).
- Asynchronous notifier rejection/failure handling without premature deduplication.
- Retry mechanics and cycle advancing on payment.
- Manifest conformance and personal context isolation.
