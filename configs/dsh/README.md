# DSH composition

ND-DSH boots the official DeepSeek Harness `web` profile — the base and web-app
bundle layers, the official browser UI, and the HTTP API gateway — and applies
`nd-dsh.patch.yml` as a `--patch` overlay on top. Everything here intentionally
stays outside the DeepSeek Harness submodule so upstream updates remain a
pinned-submodule review.

The desktop launch is:

```
node <harness>/apps/cli/lib/bin.js --profile web --patch configs/dsh/nd-dsh.patch.yml --no-open --port <port>
```

- **`nd-dsh.patch.yml`** pins the sandbox to the workspace the desktop selected,
  enables full-text session search, makes `nd-dsh` the default agent preset,
  and mounts the stable `nd-extensions` MCP bridge. Its `nd_browser_call`
  tool is ND's single model-facing browser API: it routes the built-in browser
  and explicit Chrome companions through `BrowserTargetRouter`, session-bound
  tab leases, organization policy, and audit receipts. Electron still binds
  agent-browser internally to the exact active built-in `WebContentsView`
  target for host-side inspection, but raw agent-browser MCP tools are not
  exposed to the model because that would bypass the unified policy boundary.
- **The ND-DSH agent preset** is the `preset-nd-dsh` declaration inside
  `nd-dsh.patch.yml`: the standard coding toolset plus the ND-DSH persona and
  the bundled `live-browser` skill. Harness 0.2.1 reads agent presets only from
  `@deepseek-ai/dsh-agent-preset` declarations in a patch layer, so the old
  user-preset directory is no longer a preset source. The desktop still copies
  `agent-presets/nd-dsh/` into `$DSH_HOME/.agent-presets` for its skills and
  coordination policy assets. The shipped `standard`, `ptc`, and `cordis`
  presets remain available from the launcher's system root.

Filesystem and shell providers use `workspace-write` by default. Set
`ND_DSH_PERMISSION_MODE=read-only` to disable model-driven mutations. Human
approvals follow the engine default (`ask`): the official DeepSeek UI answers
them directly, and the ND-DSH workbench answers through the gateway `respond`
endpoint. `danger-full-access` removes the sandbox boundary and must be an
explicit choice.
