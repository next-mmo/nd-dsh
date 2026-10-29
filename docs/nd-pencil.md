# ND Pencil

ND Pencil is ND's native Freeform design surface inside ND Design. It is **100% in-repo code**: a React/DOM/SVG editor in the trusted renderer, a main-process document session, and a typed agent bridge. There is no vendored editor, native design binary, CanvasKit runtime, loopback design shell, or child `WebContentsView`.

## Product boundary

ND Pencil keeps the local design primitives ND needs:

- editable `.op` documents in the active project
- vector frames, groups, rectangles, ellipses, lines, text, and images
- layers, inspector, move/resize, selection, viewport, undo/redo
- shared human/agent editing through one command pipeline
- local, project-scoped save, autosave, recovery, and legacy import
- the typed `nd_design` tool used by ND Agent
- Build into App through a real design spec, never a detached mockup

It is deliberately not a parity clone of a full vector design application. v1 omits auto-layout, components/instances, variables/themes, boolean/pen paths, multi-target code generation, collaboration, multi-page UI, and rulers/snapping.

## Document format

`.op` is ND's versioned design document:

```json
{
  "format": "nd-pencil",
  "version": 2,
  "pages": [{ "id": "page-…", "name": "Page 1", "children": ["frame-…"] }],
  "nodes": { "frame-…": { "type": "frame", "x": 0, "y": 0, "width": 1440, "height": 900 } }
}
```

Coordinates are absolute page coordinates. Commands (`insert`, `update`, `delete`, `reorder`, `group`, `ungroup`) are validated as an atomic batch in `src/shared/nd-design/commands.ts`; undo stores inverse command batches, not full documents.

Legacy OpenPencil 0.8.x documents are imported best-effort for frames, groups, basic shapes, text, and images. Unsupported features are counted and reported in the inspector. Before the first v2 write, the original bytes are copied to `.nd/design/.backups/`; if the user closes without editing, the original remains untouched.

## Ownership and persistence

`src/main/design/design-session-service.ts` owns the open document, revision, history, dirty state, selection mirror, and autosave. The renderer holds a replica and sends validated command batches. Manual edits are optimistic for a drag or text commit, then acknowledged; full documents are sent to the renderer only for open, agent edits, undo/redo, or conflict resync.

Saves are atomic and re-hash the file first. If the file changed outside ND, autosave stops, the document stays dirty, and the user must reload or save a copy. Closing or quitting flushes a save; a conflict aborts the close instead of overwriting. Image assets are copied into `.nd/design/assets/` (≤8 MB each); remote images are rejected.

Build into App writes `spec.json` and `reference.svg` under `.nd/design/.build/<design>/` and hands the spec path to the coding agent. The agent must edit the active project's real source and show the resulting Git diff and verification.

## Agent bridge

The typed `nd_design` tool exposes `state`, `open`, `create`, `apply`, `undo`, `redo`, `save`, and `export`.

- The default ND Harness is a separate process and reaches the live session through the authenticated loopback MCP bridge in `scripts/nd-design-mcp.mjs` → `src/main/design/design-agent-bridge.ts`.
- The Rust ND Agent path uses the same `DesignAgentTool` through `nd-native-tool-broker.ts` when that private engine is enabled.
- Both paths check that the calling session is bound to the active project root; worktree sessions cannot edit the active canvas.
- Generic `nd_workspace_write` is blocked for **every** `.op` path. The only document mutation path is `nd_design`.
- The MCP bridge listens on `127.0.0.1` only and requires a per-launch bearer token held in the Harness child environment. The renderer never receives the token.
- Agents should call `state` before editing and send small, validated command batches. Agent and human edits share undo history; agent undo is limited to its own newest change.

The design prompt bar starts the prompt in the existing chat without hiding the canvas. Live canvas editing is available when the active engine can call the design tool (the default ND Harness does); other engines can still use Build into App and the written spec.

## Verification

- `scripts/verify-design.mjs` enforces the in-repo boundary, v2 schema, session service, agent/MCP bridge, `.op` write block, and release configuration.
- `tests/nd-design-core.test.ts`, `tests/nd-design-session.test.ts`, `tests/design-agent-bridge.test.ts`, and `tests/nd-design-mcp.test.ts` cover the document engine, persistence, legacy migration, bridge authentication, and MCP forwarding.
- `e2e/design-editor.spec.ts` and `e2e/design-migration.spec.ts` exercise the real packaged/source Electron UI. `e2e/design-agent.spec.ts` is the live model gate and requires `ND_DESIGN_AGENT_E2E=1` plus the configured E2E model route.
- The live agent gate currently depends on a bootable ND Harness runtime. If the Harness returns HTTP 401 without publishing its authenticated URL, the chat cannot start; that is a Harness startup condition, separate from the design bridge. The bridge and MCP server are verified independently even when that gate is pending.

Normal users see only **ND Pencil**; the upstream product is gone from the codebase and release artifact.
