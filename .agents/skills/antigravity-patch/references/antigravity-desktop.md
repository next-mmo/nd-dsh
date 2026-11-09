# Observed desktop architecture and annotation recipe

Observed on Windows, Antigravity **2.28.2**, November 3, 2026. Reinspect on later versions.

## Source discovery

Installation: `%LOCALAPPDATA%/Programs/Antigravity/`. `resources/app.asar` contains the Electron shell and `dist/*.js`; there is no `resources/app/package.json` directory. The main renderer bundle is served by the local HTTPS server. Find its changing port from the running app, not a previous session.

Useful entries: `package.json` (version), `dist/main.js` (lifecycle), `dist/preload.js` (bridge), `dist/ipcHandlers.js` (ownership checks), `dist/webviewBrowser.js` (guest behavior).

The app already configured a dynamic debugging port; adding a fixed one was unnecessary. Read relevant source excerpts; avoid dumping huge bundles/headers or printing CSRF/authentication configuration. Remove temporary copies containing session data.

## Existing browser-annotate implementation

Reusable code: [../assets/browser-annotate/annotate.js](../assets/browser-annotate/annotate.js). This is the installed implementation, not a generic new-version installer.

- Header: Inspect / Annotate, native Screenshot, native Open externally.
- Click an element or drag a rectangle; Escape or the same icon cancels.
- Comment editor adds page URL, viewport, bounds, selector/text/styles and requested change to the **draft**. Optional screenshot uses the native camera. No auto-send.
- Guard against saving after conversation, tab, or page URL changes.
- Limits: top-level document; no cross-origin iframe/closed-shadow inspection; viewport screenshots rather than crops; draft text rather than persistent page pins.

The implementation and [recipe](../assets/browser-annotate/recipe.json) are bundled here. Use [the candidate builder](../scripts/build_browser_annotate.py) for a first installation on the inspected compatible build. No original chat folder, globally installed skill, local registry, or existing backup is required to build a candidate. Create machine-local state when actually installing; do not assume a machine already has this patch.

The original one-off installer is replaced by the portable candidate builder. It did not support patch-stack removal. ND now maintains `%LOCALAPPDATA%/ND/Patches/Antigravity/` independently. Use the CLI's exact-recipe `adopt` workflow for a recognized existing patch; do not copy another manager's history or blindly restore `app.asar.orig`. All managers must recheck the live archive hash before any write, so a stale registry is refused instead of overwriting another manager's changes.

## Inspected 2.29.0 port

The pinned `assets/browser-annotate/2.29.0-block.js` observes native `electronNative.wcvBrowser.onGuestEvent` snapshots and matches tab identity to the current browser tab. It retains the existing ownership-checked isolated-world execution API and uses native elevation/overlay methods for picking and the comment editor. It adds no IPC or Node capability. Inspect the block hash and expected preload hash in `recipes.json` before changing this recipe.

Observed Windows UI checks on November 4, 2026: element selection, rectangle selection, draft insertion with and without a native screenshot, Escape and panel Cancel; test text/attachment removed without sending messages. All 745 packed-entry hashes and JavaScript syntax passed. Switch-during-selection guards were reviewed but not independently exercised. The remaining recipe details describe the original 2.28.2 implementation.

### Hook and anchors

The preload ends with marker `// AGY_TEMP_ANNOTATOR_V1`, the implementation function and:

```javascript
window.addEventListener('DOMContentLoaded', () => {
  if (window.top !== window) return;
  electron_1.webFrame.executeJavaScript(
    '(' + installAntigravityAnnotator.toString() + ')()'
  ).catch(error => console.error('[Temporary annotator]', error));
}, { once: true });
```

Existing host API: `window.electronNative.executeJavaScriptInIsolatedWorld(wcId, worldId, code)`. Its handler verifies guest ownership and accepts world IDs 1000–100000. This patch uses **96137**; inspect for collisions before choosing worlds for future patches. No new Node/IPC capability was exposed to guests.

Anchors in this build:

- Camera: `[data-testid="webview-url-bar-screenshot"]`.
- External: `[data-testid="webview-url-bar-open-external"]`.
- Composer: `[contenteditable="true"][aria-label="Message input"]`.
- Guests: visible `<webview>` elements correlated to the toolbar region.

Reinspect on upgrade. Do not assume the first guest is active or use transient React IDs as stable anchors.

### Observed lessons

- Lexical paste commits asynchronously. Wait for render frames and normalize whitespace before checking insertion; avoid retries duplicating a successful paste.
- HTML `textContent` can include style/script text; prefer rendered `innerText`. SVG may require bounded text/accessibility labels.
- Picker overlays must consume the click following pointerup to avoid activating links. Cancellation/navigation/timeout should release listeners and pending promises.
- A running app locked the ASAR: fully quit rather than force-write.
- Window minimization/movement makes captured geometry stale; refresh. Restart changes window IDs and local server ports.

## Actual checks retained

Verified UI: element/rectangle picking, draft insertion with/without screenshot, Escape cancellation; test drafts/attachments removed, no messages sent. Syntax and all 738 packed hashes passed. The navigation/conversation save guard was code-reviewed, not independently tested by changing pages during selection.

These are historical checks of the source implementation on its original machine, not proof of a new installation. Repeat relevant checks when installing or changing a patch.
