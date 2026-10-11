# TODO 0050 — Sidecar push events and governed clipboard history

> Priority: P1
> Owner: ND extensions + nd-core sidecar
> Status: **implemented — local validation recorded 2026-10-07 (Rust unit + real-clipboard spike tests, desktop reconcile/store tests, all repo gates green); packaged-build manual pass still open**
> Depends on: [0036](0036-extension-invocation-and-permissions.md) (invocation broker), [0045](0045-command-registry-native-wallpaper.md) (command registry + native capability proof)
> PRD: [0008 — Command Registry and Governed Native Extensions](../prd/0008-command-registry-native-extensions.md)
> Reference: [magibarapp `clipboard-history`](https://github.com/invisal/magibarapp/tree/main/src/extensions/clipboard-history) — design only, see §Licensing

## Objective

Give the nd-core sidecar its first **background push-event resource**, then use it to ship Clipboard History as an ND-maintained package that is **installed on demand and records nothing until the user explicitly opts in**.

Same framing as PRD 0008 §1 and task 0045: take the useful architectural idea from a launcher platform without turning ND into an unrestricted plugin host. The transferable idea here is *not* clipboard history — it is a long-lived sidecar resource that emits events without being polled. Clipboard is the first consumer and the cheapest thing to prove it on.

## Licensing

magibarapp ships **no LICENSE file** (checked 2026-10-06: `GET /repos/invisal/magibarapp/license` → 404, `license: null`). Unlicensed means all rights reserved by default.

This task takes **behavioural and architectural inspiration only**. No source code, no translated ports, no copied comments or doc prose, no substantially similar expression. Every design decision below is restated in ND terms and must be implemented against ND's own contracts. Contrast the deliberate handling of `vendor/openpencil`, which preserves an MIT notice in `vendor/openpencil.LICENSE` and a tested pin in `vendor/openpencil.json` — magibarapp has no such grant and must not be vendored, copied, or patched into this repository.

## Why this is a sidecar task

The push plumbing already exists and is generic; only the watcher is missing.

- `ProtocolWriter::send_event(event, resource_id, seq, priority, data)` at `crates/nd-protocol/src/wire.rs:166` is not process- or terminal-specific.
- It already carries three event streams: `process.output` and `process.exit` (`crates/nd-runtime/src/process.rs:448` and `:281`) and `terminal.output` (`crates/nd-runtime/src/terminal.rs:874`).
- The desktop already parses them: `NdCoreEventFrame` with `kind: 'event'` (`src/main/core/core-protocol.ts:85-87`, consumed in `src/main/core/core-client.ts`).
- Rust already owns native OS effects and image work: `media.set_wallpaper` (`crates/nd-runtime/src/media.rs:319`) and `media.thumbnails` (`:122`, private `decode_image` at `:306`), with source and output bounds at `:50-56`.
- Shutdown already joins long-lived resources: `AppState::shutdown()` (`crates/nd-core/src/main.rs:85-90`) cancels interrupts, then shuts down terminals and processes. A watcher must join there.
- The sidecar is spawned non-detached with piped stdio and `windowsHide: true` (`src/main/core/core-client.ts:185-187`), so it inherits Electron's window station — the precondition for `AddClipboardFormatListener` to observe the session clipboard.

There is precedent for consolidating a native effect into Rust instead of shelling out: wallpaper moved into the sidecar precisely because the previous implementation spawned PowerShell and recompiled an inline C# type on every change (`src/main/core/core-media.ts:41-46`). Task 0048 established the console-suppression invariants that any new native Windows resource must not regress.

## Why this cannot be a third-party extension

A manifest-only package cannot own a background watcher today, and this task must not change that.

- `docs/extensions/authoring.md` §6 excludes executable lifecycle hooks and arbitrary renderer code.
- Installation is inert and never executes anything (`src/main/extensions/package-store.ts:132-196`).
- The only refresh mechanism is a renderer `setInterval` that runs while a view is open (`src/renderer/src/components/ExtensionPackages.tsx:1835-1852`).
- The nd-core dispatch table (`crates/nd-core/src/main.rs:180-570`) has zero extension methods; extension RPC is Electron IPC only (`ND_EXTENSIONS_IPC`, `src/shared/nd-invocations.ts:296-314`).

So Clipboard History ships as an ND-maintained package whose views and commands sit on new host methods backed by the sidecar. It must **not** go into `BUILTIN_EXTENSION_PACKAGES` — see the next section for why, and for what it ships as instead.

## On-demand install and watcher lifecycle

**This is a hard requirement, and the obvious precedent gets it wrong.** ND already has two distinct packaging categories, and picking the wrong one silently turns a clipboard watcher into always-on surveillance:

- **Built-in** (`src/shared/builtin-extension-packages.ts:275`) — auto-registered *and auto-activated*. `seedBuiltinPackages` (`src/main/extensions/nd-ipc.ts:1531-1542`) calls `registerBuiltin` for every built-in, then `setActivation(id, personal, true)` for any manifest whose `contexts` include `personal`, via `defaultActivationContexts` (`src/shared/builtin-extension-packages.ts:286-288`). It runs lazily through the memoized `ensureSeeded()` on the first extension IPC call (`nd-ipc.ts:161-167`) — which any launcher or settings surface triggers, so in practice it fires early in every session. Wallpaper Manager and Daily Essentials therefore start **enabled by default** for every user.
- **Available / on-demand** — bundled under `extensions/<name>/`, surfaced in the catalog by `packageCatalogView` (`src/main/extensions/nd-ipc.ts:1470`, `:1476`), and installed only by explicit user action through `nd-ext:install-available` (`src/shared/nd-invocations.ts:300`), which enforces a hardcoded id allowlist and throws `Unknown available ND extension` otherwise (`nd-ipc.ts:249-251`). Today that allowlist is exactly `nd.quit-process` and ND Translate. `refreshAvailablePackages` (`nd-ipc.ts:1545-1562`) re-snapshots them at startup **only if already installed**, and never activates them.

**Clipboard History ships as available/on-demand**, following ND Translate and Quit Process:

1. Package lives at `extensions/clipboard-history/`.
2. Add its id to the `installAvailable` allowlist (`nd-ipc.ts:250`) and to the catalog view.
3. It is **not** added to `BUILTIN_EXTENSION_PACKAGES`, so `defaultActivationContexts` never auto-enables it.

**Install still must not start the watcher.** Installation is inert by contract (`src/main/extensions/package-store.ts:132-196`), and neither install nor first activation may begin recording — history captures passwords and tokens, so recording starts only on an explicit, separately-defaulted opt-in.

**Watcher lifecycle is a reconcile function, modelled on `syncWallpaperRotation`** (`src/main/extensions/nd-ipc.ts:135-158`). That function is the correct existing pattern: it clears any running timer first, then requires *both* `activation?.enabled` (`:143`) and a positive `intervalMinutes` setting whose default is `0` (`:144-145`), so rotation is off by default even though Wallpaper Manager is auto-activated. It is re-invoked through `refreshWallpaperRotation` (`:159`) whenever activation or settings change.

The clipboard equivalent — call it `syncClipboardWatcher` — must:

- Stop any running watcher before deciding whether to start one, so a disable can never be missed.
- Require `activation?.enabled` for the Personal context.
- Require a dedicated setting (e.g. `recordHistory`, boolean, **default `false`**) declared in the manifest `settings` (`src/shared/extension-package.ts:208-214`). Two independent switches, not one.
- Be re-run on activation change, on setting change, on package update and rollback, and on uninstall.
- Fail closed: any error resolving activation leaves the watcher stopped.

**The sidecar never starts a watcher on its own.** A watcher exists only because the desktop issued `clipboard.watch`, and it must be gone after `clipboard.unwatch`, after sidecar shutdown, and after a sidecar restart that the desktop did not follow with a fresh `clipboard.watch`.

## Existing surface to supersede

- `clipboard.read` (`src/main/extensions/nd-ipc.ts:1246-1262`) is text-only, one-shot, and routes the result into a note. Marked `sensitive: true` (`src/shared/extension-package.ts:67`).
- `clipboard.write` (`:1266-1269`) truncates at 256,000 characters.
- Daily Essentials already ships a `capture-clipboard` command (`src/shared/builtin-extension-packages.ts:51`).

Neither host method has history, images, or any change notification. Both stay working unchanged, and the Daily Essentials command keeps routing through `clipboard.read`; this task adds alongside them.

## Scope

### Phase 0 — spike (must complete before any commitment)

Answer these four questions with recorded evidence. Do not write production code until they are answered.

1. **Does the watcher actually receive events from the sidecar process?** Confirm a message-only window plus `AddClipboardFormatListener` in nd-core receives `WM_CLIPBOARDUPDATE` for copies made both in Electron and in a third-party app, on a **packaged** build (`dist/win-unpacked/ND-DSH.exe`), not only in dev.
2. **Console suppression interaction.** Task 0048 drives `GetConsoleWindow() == 0` at Rust launch boundaries. Confirm a console-suppressed, non-detached child still creates a message-only window and runs a message pump reliably.
3. **Self-echo.** With the watcher in Rust and `clipboard.write` in Electron (`nd-ipc.ts:1266`), ND's own write-back will be observed as a fresh copy. Decide between (a) moving clipboard read *and* write into nd-core so one process owns both and can serialise them — preferred, and consistent with the `set_wallpaper` consolidation — and (b) a hash-plus-timestamp suppression window across the process boundary.
4. **Cost.** Measure event-to-emit latency and idle CPU over a 30-minute watcher session against a 750 ms interval baseline. Record the numbers; do not assert them. The Wallpaper Studio decode work is the precedent for measuring before and after.

### Phase 1 — watcher primitive in `nd-runtime`

- A `clipboard.watch` method returning a resource id, plus `clipboard.unwatch`.
- A `clipboard.changed` event carrying **no content**: id, format signature, content type, timestamp. Content is fetched through broker-checked host methods, keeping the event path content-free the way 0036 keeps diagnostics content-free.
- Bounded event emission. `send_event` enqueues into a priority queue; define a bound and a drop policy, or do not emit while no subscriber exists. Unbounded accumulation while the renderer is closed is not acceptable.
- Injectable clipboard source (Rust trait) so the watcher is unit-testable with no real clipboard.
- Teardown joined in `AppState::shutdown()`.

### Phase 2 — on-demand package

- Package at `extensions/clipboard-history/`, registered in the `installAvailable` allowlist and catalog view per §On-demand install and watcher lifecycle. Not added to `BUILTIN_EXTENSION_PACKAGES`.
- A `recordHistory` boolean setting, default `false`, plus the `syncClipboardWatcher` reconcile function.
- Host methods for `clipboard.history.list` / `get` / `delete` / `clear` / `pin` / `copyAgain`, each mapped to an existing permission with `clipboard.read` remaining `sensitive: true`.
- A declarative `view` contribution (`kind: 'list'`) plus launcher commands. No extension renderer code.
- Image bytes stored as **files on disk with a fingerprint in the index**, following the `workspace`/`artifacts` pattern — see §Rejected item 1.
- Personal context only.

## Design decisions adopted

Behavioural patterns worth taking, restated for ND:

1. **Three-tier degradation.** Push event → cheap change *signal* → bounded interval. Ship tier 1 on Windows and fall back to tier 3 elsewhere rather than hard-gating the feature by platform. The middle tier (a near-free counter that short-circuits expensive reads) generalises to file watching later.
2. **Change detection by format-signature transition, not content hashing.** Never repeatedly decode a large image that is sitting untouched on the clipboard. This is the same cost class the `media.rs` bounds at `:50-56` already guard against.
3. **Seed on watch start** so clipboard content from before ND launched is never recorded. One line of behaviour, real privacy win, easy to miss.
4. **Watch-start failure must be an error result, never a success that silently never emits.** The reference deliberately reports window/listener creation failure back through a channel so the caller gets a dead handle rather than a plausible one. This matches ND's fail-closed dispatch (`crates/nd-core/src/main.rs:563-569`).
5. **Idempotent stop** with guaranteed thread and window teardown.
6. **One-time window-class registration guard** so a second watcher cannot re-register the class.
7. **Caps by content type with pins exempt.** The reference uses 300 text / 30 image / 25 pinned. Expose as manifest `settings` (`src/shared/extension-package.ts:208-214`) rather than hardcoding.
8. **File-copy resolution.** A single image file copied from Explorer arrives as a file reference, not pixels. Resolve it and decode through the existing `media` path.

## Design decisions rejected

1. **Base64 image data URLs inline in one JSON document.** The reference stores up to 30 images at ≤1024 px as data URLs in a single `<userData>/extensions/clipboard-history.json`, synchronously rewritten in full (temp-write plus rename) on *every* mutation. That is multi-megabyte blocking I/O per clipboard copy. ND already moved image decode out of the desktop main process into the sidecar because doing it there froze every window in the app (`src/main/core/core-media.ts:41-46`); reintroducing per-mutation blocking image I/O on the desktop side would undo that. Store bytes as files and keep only metadata plus a fingerprint in the index.
2. **Shell-based paste-back.** The reference sends the paste keystroke via PowerShell `SendKeys`, `osascript`, or `xdotool`/`wtype`/`ydotool`. This contradicts the `core-media.ts:41-46` precedent, and paste-back needs foreground-window state the sidecar cannot observe. Out of scope; if wanted later it stays in Electron.
3. **The in-process trusted extension class model.** PRD 0008 §2 keeps extensions as data/manifest contributions. Adopting a `provide()`/`execute()`/`init()` base class would create exactly the second unrestricted plugin runtime PRD 0008 rules out.
4. **Source-app attribution as the privacy control.** The reference can identify the copying app on macOS only, and therefore defers per-app exclusion entirely. ND has a structurally stronger control already: context, activation, and the `sensitive` grant path from 0036. Use Personal-only plus the two-switch opt-in in §On-demand install and watcher lifecycle — activation alone is not enough, because built-in packages are auto-activated.

## Hazards

- **Cross-process self-echo** (Phase 0 item 3). The reference needs no lock discipline across processes because its writer and watcher share one event loop; ND's do not.
- **Sensitive content at rest.** History will capture passwords and tokens. The two-switch opt-in in §On-demand install and watcher lifecycle is the mitigation; it is only a mitigation if it is actually tested, since a reconcile function that forgets to stop is indistinguishable from one that was never started. Also requires a bounded retention and a defined clear-all — decide explicitly whether pins survive clear-all (the reference keeps them).
- **Unbounded event accumulation** while no renderer subscribes.
- **Remote desktop, fast user switching, and the secure desktop.** Clipboard watch must fail closed rather than record partial or cross-session data.
- **Watcher outliving its usefulness** across sidecar restarts. A restart must not silently leave history unrecorded without surfacing that state.

## Safety invariants

- **Nothing is recorded until the user explicitly opts in.** Not at app start, not at install, not at first activation. The package is not a built-in, so `defaultActivationContexts` never auto-enables it, and `recordHistory` defaults to `false` behind activation.
- **A disable always stops the watcher.** The reconcile function stops before it decides whether to start, so no ordering of activation, setting, update, rollback, or uninstall events can leave a watcher running that the user believes is off.
- **The sidecar never self-starts a watcher.** One exists only in response to `clipboard.watch`, and never survives shutdown or an unrequested restart.
- The watcher grants no new permission. Reading history still goes through `clipboard.read`, still `sensitive: true`, still via the broker.
- Company and Project contexts cannot read Personal clipboard history.
- Agent access requires the existing explicit per-action grant from 0036; nothing here widens it.
- No extension manifest can start, stop, or configure a watcher. Only ND-maintained packages may expose these host methods.
- Events are content-free; content is fetched through broker-checked host methods.
- Watcher teardown is guaranteed on sidecar shutdown: no leaked thread, no leaked message-only window.
- Console suppression from task 0048 is not regressed.

## Acceptance

On-demand and lifecycle:

- A fresh ND install with the package present but not installed records nothing; installing it still records nothing; enabling activation still records nothing while `recordHistory` is `false`.
- The package does not appear in `BUILTIN_EXTENSION_PACKAGES`, and has no activation record even after `ensureSeeded()` has run.
- `installAvailable` rejects any id outside its allowlist, including this one before it is added.
- Turning `recordHistory` on starts exactly one watcher; turning it off, disabling activation, rolling back, and uninstalling each leave zero watchers running.
- After a sidecar restart with no new `clipboard.watch` issued, no watcher is running.
- Killing the watcher mid-session and re-enabling does not double-register a window class or leak a thread.

Behaviour and cost:

- `clipboard.watch` returns either a resource id or an error — never a silent success.
- One copy from Electron and one from a third-party app each produce exactly one event; an ND write-back produces none.
- After shutdown, the watcher thread and message-only window are gone, asserted by handle/thread count rather than inferred.
- Idle CPU and event latency are measured and recorded, with the watcher both off and on.
- History renders through a declarative `view` contribution with no extension renderer code.
- Caps enforced, pins exempt, clear-all behaviour defined and tested.
- Sensitive reads still require the existing grant path; a denied policy still denies.

## Validation

Record actual evidence when implemented; this planning document establishes none.

**Recorded 2026-10-07 (local, Windows dev machine):**

- `pnpm core:test` steps: `cargo fmt --check` clean; `cargo clippy -p nd-protocol -p nd-runtime -p nd-core -p nd-agent --all-targets -- -D warnings` clean; `cargo test` for all four crates green (nd-runtime 95 passed incl. 23 new clipboard tests + 2 spike tests run separately, protocol contract 21, nd-protocol 10, nd-agent 15 + stdio contract 1). The `cargo test` link ran with `CARGO_TARGET_DIR=target-check` because a concurrently running dev app held `target\debug\nd-core.exe`; fmt and clippy ran against the default target dir.
- `pnpm typecheck` clean; `pnpm test` green (169 files / 1434 tests passed, incl. the new `tests/clipboard-watcher.test.ts` and `tests/clipboard-history-store.test.ts`); `pnpm build` green; `pnpm verify` green (345 source files, 183 test files).
- `node scripts/validate-nd-extension.mjs extensions/clipboard-history` PASS. A protocol-level smoke against the freshly built `nd-core` binary confirmed the full surface end to end: `core.health` advertises `clipboard` + `clipboardWatcherCount`, `clipboard.watch` returns an id with `mode: "push"`, `clipboard.write` then `clipboard.read` round-trips text, the write-back emitted **zero** `clipboard.changed` events (echo suppression holds across the protocol), and `clipboard.unwatch` returned the watcher count to 0. As planned, `--builtins` does not cover this package — it is deliberately not a built-in; the catalog/allowlist path is exercised by the desktop catalog view code and the on-demand install handler (`AVAILABLE_PACKAGES` allowlist).

**Phase 0 spike evidence (from the `#[ignore]` real-clipboard tests, run with `cargo test -p nd-runtime clipboard::tests::real_clipboard -- --ignored --test-threads=1`):**

1. *Does the watcher receive events?* Yes — same-session proof: a message-only window + `AddClipboardFormatListener` in the nd-runtime test process observed a copy made by **another process** (`cmd /C clip`) with tier 1 (`mode: "push"`). Recorded: event-to-emit latency ≈ 66–68 ms across two runs, signature `[1, 7, 13, 16]` (text + locale formats), and a 2-second idle window produced zero events. Packaged-build confirmation remains open (below).
2. *Console suppression interaction.* The spike process is a console subprocess and still created the message-only window, ran the pump, and received updates; message-only windows do not allocate a console. The packaged-build check under 0048's `GetConsoleWindow() == 0` invariant is part of the manual pass.
3. *Self-echo.* Option (a) adopted: nd-core owns clipboard read **and** write (plus the watcher), and a shared operation lock serialises writes against observation so the suppression guard is always armed before a `WM_CLIPBOARDUPDATE` is processed. Verified by the spike test: an nd-core write-back produced no event, and the following external copy still did. Two implementation refinements beyond the plan: signatures carry the platform change counter (`GetClipboardSequenceNumber`) because consecutive *text* copies share the same format list, and the counter doubles as the tier-2 near-free poll short-circuit.
4. *Cost.* Event-to-emit latency ≈ 66–68 ms measured (mostly `clip.exe` process spawn outside the watcher); idle window clean. The 30-minute idle-CPU comparison against the 750 ms poll baseline is **not yet recorded** — it needs the packaged build session below.

**Still open (manual, packaged build `dist/win-unpacked/ND-DSH.exe`):**

- Third-party-app and Electron copies observed end-to-end with history recording, image copy, file copy, write-back non-echo in the real app.
- Opt-out stops recording (validated by desktop tests against the reconcile contract; confirm in the packaged UI).
- Console/window suppression coexistence with 0048 invariants, teardown asserted by handle/thread count, and the 30-minute idle-CPU measurement with the watcher off and on.

## Open product question

ND's existing answer to "remember this" is already different: `clipboard.read` routes the clipboard into a **note** (`nd-ipc.ts:1252`). Clipboard history is a launcher-class utility; ND is an organisation control plane with companies, projects, agents, and policies.

**Resolved for this implementation (2026-10-07):** Phase 0 and Phase 1 were worth doing either way and are done; Phase 2 shipped as a *minimal* utility — Personal-only, declarative list view, no paste-back, no agent affordances — so ND gains the watcher primitive and the cheapest consumer of it without becoming a launcher platform. If the utility earns its place, file-watch/git-watch/process-watch reuse the same resource shape.

## Implemented

- **`crates/nd-runtime/src/clipboard.rs`** — the watcher primitive: `clipboard.watch`/`clipboard.unwatch` returning a resource id and delivery tier, content-free `clipboard.changed` events (format list, content class, timestamp, drop accounting), tier-1 push on Windows (message-only window + `AddClipboardFormatListener`, one-time class registration, idempotent stop, joined teardown) with visible fallback to a bounded 750 ms poll tier, injectable `ClipboardSource` trait, in-process write-echo suppression serialised through an operation lock, per-watcher bounded notification channel plus an outbound-queue room check as the drop policy, and sidecar-owned `clipboard.read` (bounded text, DIB/PNG/HDROP-file image decode to fingerprinted PNG, file lists) and `clipboard.write`.
- **`crates/nd-core/src/main.rs`** — dispatch arms for the four clipboard methods, `clipboard` capability, `clipboardWatcherCount` in health/metrics, and watcher teardown joined in `AppState::shutdown()`.
- **`src/main/core/core-clipboard.ts`** — typed desktop client for the sidecar surface, with `core.ready`/`core.exit` subscription so a sidecar restart forgets the stale watcher and reconciles again.
- **`src/main/extensions/clipboard-history.ts`** — the history index (JSON metadata only; image bytes on disk named by pixel fingerprint), caps with pins exempt and pins-survive-clear semantics, the `ClipboardWatcherController` reconcile loop (stop first, then require Personal activation AND `recordHistory === true`, fail closed), and the event→read→record pipeline.
- **`src/main/extensions/nd-ipc.ts` + `src/main/ipc.ts` + `src/main/index.ts`** — on-demand wiring: `AVAILABLE_PACKAGES` allowlist (translate, quit-process, clipboard-history), catalog view, manifest re-snapshot, reconcile hooks on install/update/rollback/uninstall/activation/setting change and sidecar ready; `clipboard.read`/`clipboard.write` now prefer the sidecar and fall back to Electron's clipboard when it is unavailable; six `clipboard.history.*` host methods (Personal only; reads keep `sensitive: true`).
- **`extensions/clipboard-history/`** — the on-demand package manifest (`nd.clipboard-history`, Personal, `recordHistory` default false, caps as settings, list view + two commands). **Not** in `BUILTIN_EXTENSION_PACKAGES`; nothing registers, activates, or records it automatically.
- Tests: `tests/clipboard-watcher.test.ts` (every acceptance lifecycle transition, asserted against watcher count) and `tests/clipboard-history-store.test.ts` (dedup, caps, pins, clear, orphan image cleanup, corruption recovery, truncation bounds).

## Out of scope

- Paste-back keystroke injection.
- Third-party authoring of watchers or any lifecycle hook.
- macOS and Linux push tiers.
- The MCP agent bridge, still deferred per 0036 — `InvocationBroker.invokeAsAgent` continues to refuse executable tool contributions (`src/main/extensions/invocation-broker.ts:373-374`).

## Starting points

Sidecar:

- `crates/nd-protocol/src/wire.rs` — `send_event`, priority queue
- `crates/nd-runtime/src/media.rs` — existing native image bounds and patterns
- `crates/nd-runtime/src/terminal.rs` — closest existing long-lived streaming resource
- `crates/nd-core/src/main.rs` — dispatch table, `AppState::shutdown()`
- `src/main/core/core-client.ts` — spawn options, event-frame consumption

Desktop:

- `src/main/extensions/nd-ipc.ts:135-159` — `syncWallpaperRotation` / `refreshWallpaperRotation`, the reconcile pattern to copy
- `src/main/extensions/nd-ipc.ts:161-167` — `ensureSeeded`, the lazy seed that auto-activates built-ins
- `src/main/extensions/nd-ipc.ts:249-251` — `installAvailable` allowlist
- `src/main/extensions/nd-ipc.ts:1470`, `:1476` — `packageCatalogView` for available packages
- `src/main/extensions/nd-ipc.ts:1531-1542` — `seedBuiltinPackages`; the auto-activation to avoid
- `src/main/extensions/invocation-state.ts` — activation records and settings
- `src/main/extensions/nd-ipc.ts:1246-1269` — existing clipboard host methods
- `src/shared/extension-package.ts` — host-method allowlist, permissions, `settings`
- `src/shared/builtin-extension-packages.ts:275-288` — `BUILTIN_EXTENSION_PACKAGES` and `defaultActivationContexts`; **do not add to these**
- `extensions/translate/`, `extensions/quit-process/` — on-demand bundled package shape to follow

Reinspect current code and applicable contributor guidance before implementation. Preserve unrelated work and keep ND's provider/engine, organization, browser, and ND Pencil boundaries intact.
