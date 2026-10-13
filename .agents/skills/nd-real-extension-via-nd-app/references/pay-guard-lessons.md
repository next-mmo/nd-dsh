# Conditional lessons from the ND Pay Guard exercise

Use these when reviewing reminders, desktop notifications, or ND worktree
failures. Re-check current implementation and platform documentation; the
observations below describe a particular exercise, not permanent product state.

## Subscription reminders

- Preserve the billing-day anchor through clipped months. January 31 → February
  28 → March 31 is different from repeatedly advancing the last numeric day.
  A name-only edit that resubmits the unchanged February date must not reset 31
  to 28. Test the actual UI edit followed by marking paid.
- Serialize overlapping startup, timer, create, and update checks. Re-read live
  subscription and activation state before delivery. Test simultaneous checks
  with exactly one accepted notification for the same renewal.
- Persist the deduplication marker only after the delivery mechanism accepts the
  notification. Failure or timeout must remain retryable. Restart and verify
  the same delivered renewal is skipped.
- Catch up missed renewals on reopening; an arbitrary one-day overdue cutoff can
  silently lose reminders. Make the chosen catch-up policy explicit.
- Share the initial storage-load promise between concurrent callers. Test cold
  concurrent creates against existing saved records. Initialize empty storage
  only for a missing file; corrupt/unreadable data must not be silently replaced.
- Test paused/cancelled/deactivated/uninstalled states and recurring versus
  one-time payment behavior. Explain whether the app must remain running.

## Native desktop notifications on macOS

The exercise used Electron 43.4.0. `Notification.isSupported()` returning true
and `notification.show()` returning without throwing did not establish delivery.
The stock dev binary asynchronously emitted `failed` because its signature did
not bind the app bundle correctly. Read current official documentation:
[Electron Notification](https://www.electronjs.org/docs/latest/api/notification).

Attach `show` and `failed` listeners before calling `show()`, retain the instance
until settlement, and use a bounded timeout. Await that outcome in the scheduler
and test-notification handler. Test success, asynchronous failure, timeout, and
unsupported cases. OS acceptance still does not guarantee a visible banner when
notification permissions, Focus, or screen-sharing policy suppress presentation.
Do not label an accepted request as proof that the user saw it.

For local verification, an ad-hoc deep signature on a **temporary copy** of
Electron worked in this exercise. Do not alter installed dependencies, create
keychain credentials, disable security, or change release packaging as an
unannounced test workaround. First inspect current signing status and applicable
instructions. Let ND's agent prepare/recommend the reversible copy if needed.
Verify the actual running executable: `ELECTRON_OVERRIDE_DIST_PATH` did not make
this repository's dev launcher select the copy. Launching the signed copy against
the built repository output did. This is a local test technique, not distribution
signing or notarization.

Use System Settings → Notifications to inspect the sender and desktop permission.
The dev sender appeared as **Electron**, not ND Pay Guard. Enable notifications
only within the user's authorized notification task. Confirm native receipt and
visible presentation separately. If Computer binds to a calendar widget instead
of the notification panel, do not invent a screenshot result; a user confirmation
of the banner can supplement native event evidence.

## ND worktree and operator pitfalls

- Recursive cleanup by directory name deleted tracked source at
  `vendor/vscode-git/build/update-emoji.js`. Protect tracked paths and their
  ancestors; fail closed if Git cannot provide that information.
- Skip nested Git/submodule roots when cleaning host-generated artifacts.
  Distinguish tracked source from disposable build output.
- Electron resources produced an `ENOTEMPTY` cleanup failure. Bounded filesystem
  retries can handle transient contention, but persistent errors must remain
  visible. Retest original dispatch after a repair.
- Do not assume earlier agent edits survived an interrupted task. Check status,
  HEAD, checkpoints, and recovery evidence before resuming or restoring anything.
- Native date/select controls and delayed UI updates can produce misleading
  snapshots. Verify the saved date/status after submitting the form. Re-query
  stale accessibility indices instead of repeatedly clicking them.
- Main-process or concurrent repository edits can restart the window. Rebind the
  current app and confirm the tested build. Preserve other work in the shared
  checkout; do not attribute all changed files to the extension agent.
