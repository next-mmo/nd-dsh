# ND Extensions

ND Extensions are declarative packages that add commands, views, skills,
workflows, and tools to ND. A package is one folder containing an
`nd-extension.json` manifest. ND renders and executes every contribution inside
its own trusted surfaces against an allowlist of host methods; packages never
inject renderer code.

## Start here

| I want to… | Go to |
| --- | --- |
| Build my first extension | **Download the starter ZIP** from the in-app guide (Extensions → Extension developer guide), or copy [`examples/nd-extension-hello`](../../examples/nd-extension-hello) |
| Choose how my extension ships (built-in, Discover, external) | **Pick a delivery model** below, or the agent skill **`create-extension`** |
| Read the full contract | [`authoring.md`](authoring.md) |
| Autocomplete my manifest | [`schema/nd-extension.schema.json`](../../schema/nd-extension.schema.json) |
| See every host method and permission | `ND_HOST_METHODS` in [`src/shared/extension-package.ts`](../../src/shared/extension-package.ts) |
| Validate a package | `pnpm ext:validate <package-dir>` |
| Read a real shipped package | [`extensions/translate`](../../extensions/translate), [`extensions/quit-process`](../../extensions/quit-process), [`extensions/tic-tac-toe`](../../extensions/tic-tac-toe) (external + web view) |
| Read the built-in packages | [`src/shared/builtin-extension-packages.ts`](../../src/shared/builtin-extension-packages.ts) |

## Pick a delivery model

Every package follows exactly one delivery model. **The default for new work is
fully external, on demand** — the package lives in git, ships zero bytes in the
release, and users install it when they want it. See
[`authoring.md` §5](authoring.md#5-distribution-and-lifecycle) for the full
promotion paths.

| | **Built-in** | **On-demand (staged catalog)** | **Fully external (default)** |
| --- | --- | --- | --- |
| Source of truth | `builtin-extension-packages.ts` | `extensions/<name>/` | `extensions/<name>/` |
| Release bundle | Inside the app | Staged via `electron-builder.yml` (+ its size) | **Nothing — zero impact** |
| Found in Discover | Always (cannot uninstall) | Every build, one-click Install | Dev builds only; packaged builds install from folder |
| Use when | Part of ND itself, must always exist | First-party extra small enough to ship for everyone | Everything else: experiments, large assets, opt-in packages |
| Example | Wallpaper Manager, Daily Essentials | Translate, Clipboard History, Password Vault | ND 3D Tic-Tac-Toe |

For **rich package-owned UI** (games, canvases, bespoke tools), a package can
contribute a **web view** (`kind: "web"`): ND renders the package's own
`ui/index.html` in a token-scoped, cross-origin, no-network iframe and brokers
every privileged call. Typed `list`/`detail` views remain the default when ND's
own rendering is enough. See [`authoring.md` §5 — Web views](authoring.md#web-views-packages-that-ship-their-own-ui).

## Is there an SDK?

No published SDK, and no scaffolding CLI. An extension is data, not a library,
so the "SDK" is three checked-in artifacts:

1. **JSON Schema** — `schema/nd-extension.schema.json`
2. **TypeScript contracts + host-method allowlist** — `src/shared/extension-package.ts`
3. **Validator CLI** — `scripts/validate-nd-extension.mjs` (`pnpm ext:validate`),
   which bundles the production rules through Vite so the CLI and the runtime
   installer cannot drift

The TypeScript source is the authoritative contract. The schema is maintained by
hand beside it; if they disagree, the validator wins.

## Validate, install, activate

```bash
node scripts/validate-nd-extension.mjs examples/nd-extension-hello
```

Then in the app: **Settings → Extensions → Install from folder** → select the
package directory. Installation makes a package *available*; **activation is per
context** (Personal, a company, or a project) and is a separate step. Declared
permissions are a ceiling, activation is the second switch, and a per-action
grant is the third.

Run the result from the launcher with **Ctrl+K**.

## Two capability classes share the word "extension"

| | **ND Extensions** | **Agent capabilities** |
| --- | --- | --- |
| Contract | `src/shared/extension-package.ts` | `src/shared/extensions.ts` |
| Manifest | `nd-extension.json` | descriptor with `surface`, `enabled`, `engineRoutes` |
| UI | Settings → Extensions | Settings → Agent capabilities |
| Example | `examples/nd-extension-hello` | `examples/extension-counter` |

Their manifests are not interchangeable. Despite its filename,
`examples/extension-counter/nd-extension.example.json` is an **agent
capabilities** descriptor and fails ND extension validation. **Browser
extensions** (Chromium packages loaded into the ND built-in browser) are a third,
unrelated class.

## What v1 does not support

Renderer-code injection outside the sandboxed **web-view contract**
(typed list/detail packages still ship no UI), executable lifecycle hooks, a
second JavaScript runtime, an OS sandbox for external MCP executables, and
public marketplace publishing. See
[`authoring.md` §6](authoring.md#6-what-v1-deliberately-does-not-support).

## Design and validation history

- [PRD 0006 — ND Extensions and Personal Home](../prd/0006-nd-extensions-and-personal-home.md)
- [PRD 0008 — Command registry and native extensions](../prd/0008-command-registry-native-extensions.md)
- [PRD 0011 — ND admin entitlements and extension registry](../prd/0011-nd-admin-entitlements-and-extension-registry.md)
- [Task 0042 — Extension SDK and authoring guide](../tasks/0042-extension-sdk-and-authoring-guide.md)
- [QA gate — extensions and ND Home](../qa/nd-extensions-home-manual.md)
- [QA gate — command registry and native extensions](../qa/command-registry-native-extension-manual.md)

The **agent-side native-host bridge is deferred**: run credentials, per-action
approval, revocation, and expiry are implemented and unit-tested, but no coding
engine can invoke ND native host methods in a built app yet. User-initiated
invocations work.
