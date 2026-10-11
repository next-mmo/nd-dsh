# ND Ad Block — local validation

> Runtime: Electron 43.4.0 / Chromium 150.0.7871.224 / `persist:nd-dsh-browser`
> Package: `resources/browser-extensions/nd-ad-block`
> Status: automated evidence recorded; **live YouTube playback not yet verified**

## 1. What ships

ND Ad Block is a first-party manifest v3 package bundled as an `extraResource`
and enabled by default on a profile that has not seen it before.

- `rules/ads.json` — 141 blocking rules for ad-network, ad-auction and
  cross-site ad-tracking hosts.
- `rules/youtube.json` — 8 rules for YouTube's own ad endpoints (`/pagead/`,
  `/ptracking`, `/api/stats/ads`, `/get_midroll_info`, `/pcs/activeview`,
  `/api/stats/atr`, `/ads/`).
- `content/youtube-ads.js` — main-world script that deletes ad placements from
  the data YouTube hands the player (`ytInitialPlayerResponse`, the
  `/youtubei/v1/player` XHR and fetch responses, and feed ad renderers).
- `content/youtube-ads-report.js` + `content/youtube-ads.css` — counts real
  removals for the popup and hides ad containers.
- `background.js` — enables the rule sets (see §2).

No third-party filter list is bundled or required; the rules were authored as
first-party data.

## 2. Why the design is not just a manifest rule set

Three measured constraints shaped this package:

1. **Electron does not honour `enabled: true` on manifest-declared rule
   resources.** After `loadExtension`, `getEnabledRulesets()` returned `[]` and
   nothing was blocked; the ad hosts were still requested. Calling
   `updateEnabledRulesets({ enableRulesetIds })` enabled both sets and blocking
   started working. `background.js` therefore activates the rule sets on every
   worker start. `tests/nd-ad-block-package.test.ts` fails if that activation
   stops naming a declared rule set.
2. **`googlevideo.com` serves ad media and content media from the same place.**
   Blocking it would stop playback instead of ads, so it is deliberately absent
   from the rule set and a test asserts it stays absent.
3. **Chromium has to write into the extension directory to index rule sets.**
   With the package directory made unwritable for the current user,
   `loadExtension` still succeeded and content scripts still ran, but
   `updateEnabledRulesets` rejected with `Internal error.`,
   `getEnabledRulesets()` stayed `[]`, and the ad request went through
   untouched — a package that looks installed and blocks nothing. A packaged ND
   install keeps bundled resources in a read-only location, so this is the
   normal case, not an edge case. `BrowserExtensionManager` therefore copies
   each bundled package into `<userData>/browser-extensions/<id>` and loads the
   copy; Chromium's generated `_metadata` index is never copied back out, and
   the packaged source is left untouched.
4. **A page reads `responseText` before a listener added inside `send()` runs.**
   The first version flipped a "pruned" flag from a `readystatechange` listener
   registered during `send()`. Pages install `xhr.onreadystatechange` *before*
   calling `send()`, so the page's handler ran first, saw the flag unset, and
   received the raw player response with its ad placements intact — the network
   rules blocked, and ads still played. Pruning now happens on read, memoised
   per instance, with no flag and no ordering assumption.

In-stream YouTube ads are removed by pruning ad placements from the player
response rather than by blocking media, because the ad video is delivered as
part of the same stream. If an ad still starts, the neutralizer ends it by
clicking the skip button, seeking to the end, and ramping the playback rate,
while muting; the user's own mute state and playback rate are restored once the
ad is over.

## 3. Evidence

| Check | Command | Result |
| --- | --- | --- |
| Ad hosts blocked by static rules | raw Electron probe, hosts mapped to a local server | blocked: no request reached the server, `adRan: false` |
| Rule sets active without manual steps | raw Electron probe | `getEnabledRulesets()` → `['nd_ads','nd_youtube']` |
| Ordinary content unaffected | same probe | `contentRan: true`, page CSS still applied |
| YouTube-shaped page: inline player data | raw Electron probe over HTTPS | `playerAds`/`adPlacements` → `absent`, `streamingData` → `present` |
| YouTube-shaped page: XHR + fetch | same probe | both pruned; `/pagead/`, `/api/stats/ads`, `/ptracking` never requested |
| XHR read ordering | probe whose handler is installed before `send()` | `playerAds`/`adPlacements`/`adSlots` → `absent` |
| Ad dismissal and restoration | probe with a synthetic `ad-showing` player | one skip click, `muted: true`, `playbackRate: 16`; after the ad `muted: false`, `playbackRate: 1` |
| Counters are not inflated | same probe | one ad break reported as `adBreaks: 1`, `pruned: 11` |
| Cosmetic filter | same probe | `#player-ads` → `display: none` |
| Unwritable package directory | raw Electron probe, write denied via ACL | `updateEnabledRulesets` → `Internal error.`, rulesets `[]`, ad request not blocked |
| Default on, first launch | `playwright test e2e/ad-block-default.spec.ts` | ad block enabled, rulesets `['nd_ads','nd_youtube']`, popup reads `On` |
| Loaded from a writable copy | same spec | extension path is inside the app profile, not the packaged resources |
| Disable persists | same spec, restart on the same profile | still disabled after restart |
| Unit tests | `pnpm test` | 177 files / 1499 tests passed |
| Types | `pnpm typecheck` | clean |
| Build | `pnpm build` | clean |

## 4. Open gap — live YouTube

Live `youtube.com` verification could **not** be completed from this machine:
Google answers with a bot check (`https://www.google.com/sorry/index?...`) for
this network's IP, so no watch page or player response ever loaded. Everything
above was measured without YouTube itself, using a locally served
YouTube-shaped page on a mapped host.

A human on an unblocked connection should confirm, on a profile where ND Ad
Block is enabled:

1. open a YouTube video with music and confirm no pre-roll or mid-roll ad plays;
2. confirm the video still plays and seeks normally, and that sound is not left
   muted after an ad was dismissed;
3. open the ND Ad Block popup and confirm **Ad breaks ended** is non-zero;
4. if an ad still plays, record the extension version and the video URL.

Do not describe YouTube ad blocking as verified until that pass is recorded.
Note that YouTube changes its player and ad delivery continuously; the network
rule sets in this package are static, so the in-page neutralizer is what carries
most of the YouTube behaviour and it will need maintenance as YouTube changes.

A second, narrower unknown: on a brand-new profile the very first page load in
the moments right after the package is installed can occur before the service
worker has enabled the rule sets, so that one load is unfiltered. ND installs
bundled packages during browser-platform startup, before the user can navigate,
so the window is not reachable in normal use; it is recorded here because it was
observed while measuring, not because it is expected in practice.
