---
id: "0006"
title: "ND Extensions and Personal Home"
status: implemented-locally
created: 2026-09-27
---

# PRD 0006 — ND Extensions and Personal Home

## 1. Product outcome

ND is an agent harness with an extension ecosystem that serves both people and agents. Users install an extension once and invoke its capabilities through the global launcher, ND-rendered views, or chat. Every action retains ND-owned context, authorization, provider routing, and execution controls.

Add **ND Home**, a built-in personal space for chats, notes, captures, artifacts, and everyday commands. It must work before any company or project exists.

**Global installation is availability, not global data access.** An extension may work in Personal, Company A, or Company A → Project B, but each invocation has exactly one authorized context.

Status: implementation complete locally on 2026-09-27 (tasks 0035–0043). The
automated layers are green and recorded in
[`docs/qa/nd-extensions-home-manual.md`](../qa/nd-extensions-home-manual.md);
the operator manual gate and the agent-side MCP bridge are the open items, and
that document lists them explicitly. No claim beyond the recorded evidence is
made here.

## 2. Current foundations and gaps

Source review found:

- An agent capability manifest/router with MCP, skills, commands, hooks, memory, and subagent surfaces in `src/shared/extensions.ts` and `src/main/extensions/`.
- A stable MCP gateway and shell proxy in `scripts/nd-extension-mcp.mjs` and `scripts/nd-extension-runtime.mjs`.
- Separate workflow plugin contracts and persistence, including explicit company/project bindings and read-only Mirror behavior.
- A global launcher popup, screenshot capture, clipboard actions, and narrow desktop IPC. Some launcher work was present as local changes during review; recheck the implementation baseline before starting tasks.
- Quick notes currently require a company; capture inspection immediately starts an agent request; interactive engines still depend on filesystem workspace state.
- The existing extension tool proxy checks enablement and engine routes, but lacks trusted company/project/run identity.
- Several hook/command surfaces deliver instructions, not enforceable executable behavior. External MCP children execute with the desktop user's OS permissions.

Reuse these foundations. Add a package and invocation layer rather than replacing all registries or creating a new organization model.

## 3. Goals and non-goals

### Goals

- Native ND extension packages for local and team developers.
- Personal daily use without company/project onboarding.
- One operation shared by launcher, views, and agent tools.
- Explicit personal, company, and project contexts, independent of installation.
- ND-rendered forms, lists, detail views, and actions.
- Central grants, revocation, audit metadata, and engine-neutral delivery.
- Install/update/rollback lifecycle with preserved settings and source provenance.
- Two proving packages: Daily Essentials and Project Workflow.

### Deferred

- Public marketplace publishing, review infrastructure, billing, and automatic updates.
- Running existing Raycast or VS Code packages unchanged.
- Arbitrary extension HTML/React panels or renderer DOM access.
- A second general-purpose JavaScript extension runtime.
- Native-app clicking/typing, unattended desktop automation, and executable lifecycle hooks.
- An OS sandbox for arbitrary external MCP executables.
- Company/project task lifecycle changes or a personal Kanban product.

## 4. Context and storage model

| Context | Purpose | Default access |
| --- | --- | --- |
| Personal / ND Home | Personal chat, notes, captures, daily actions | Personal ND records and specifically authorized resources |
| Company | Company assistance and knowledge | Authorized records of that company |
| Project | Development, workflow, project tasks | Authorized company/project records and its workspace |

Introduce a discriminated context contract: personal; company with company ID; project with company and project IDs. Validate company/project relationships on the trusted side.

Installation is local to the user's ND profile and independent of context. Activation and grants are separate records. Global package settings hold nonsecret defaults; context settings may override them without expanding permissions.

ND Home owns persistent personal notes, capture/artifact references, and explicitly scoped chat records in ND-managed user storage. It is not a synthetic company, project, or a grant over the user's home directory.

**Personal is a place, not an absence.** The product surface for the personal context is labeled **Personal** in navigation, headings, and action results; ND Home remains the name of the personal storage layer. Personal must never be presented as the empty state of a company.

**A surface belongs to exactly one context.** When an extension action makes ND present something — a browser tab, an extension view, a chat — ND presents it in the context that owns it:

- A Personal-owned browser tab surfaces in the Personal space's browser pane at full size — the same pane treatment as the Agent workbench, not a side panel — even while a company or project is the active selection. It must not appear inside a company's or a project's workbench.
- A company/project-owned tab keeps the company/project workbench.
- Ownership travels with the event (`browser-focus` carries the owning context). The renderer presents that context; it must not re-derive the context from whatever company or project happens to be selected.
- Running extension views are labeled with their owning context wherever they are listed, so a Personal view sitting on the company/project row is identifiable as Personal.

The embedded browser profile is shared app-wide, so context labeling — not profile separation — is what currently keeps Personal browsing identifiable. Per-context browser profiles and context-scoped history remain an open isolation item.

An engine requiring a working directory receives a managed per-chat working folder. That path alone is not a sandbox. Enable filesystem/process capabilities only when the adapter can enforce the selected policy.

Bind each chat/run to its initial context and working folder. Switching the active company, project, or launcher context does not rebind existing sessions. Starting a chat in another context creates a separate context-bound session.

Personal data is not implicitly included in company/project prompts. Cross-context transfer requires explicit user selection and authorization. Existing sessions retain recorded scope; unattributed historical sessions stay associated with their original standalone workspace until explicitly attributed. Do not silently import them into Personal.

## 5. Extension package contract

Use `nd-extension.json` with protocol `nd.extension/1`.

Required contract areas:

- Package identity, display metadata, version, and supported ND API version.
- Requested permissions and nonsecret settings definitions.
- Contributions with unique package-qualified identities and supported contexts.
- Runtime references where executable capabilities are needed.

Supported contribution kinds:

| Kind | Delivery |
| --- | --- |
| Tool | Existing MCP stdio transport through ND's invocation broker |
| Skill/context | Bounded, scoped instruction or context contribution |
| Command | Invoke a declared tool, open a declared view, or start an ND agent task/chat |
| View | Typed list, detail, form, and action descriptions rendered by ND |
| Workflow | Existing `nd.workflow/1` adapter and read-only Mirror contract |

Commands are deterministic actions unless explicitly declared to start agent work. Simple note, capture, URL, and app actions do not need an LLM.

ND-maintained Daily Essentials uses declarative contributions targeting an allowlisted native host API. Third-party manifests cannot register arbitrary host method names or inject renderer code.

ND retains provider routing, model selection, organization identity, and coding-engine registration. Preserve existing instruction-based extensions through compatibility adapters; never label instructions as executable hook enforcement.

## 6. Installation and lifecycle

- Install from a local directory or private Git repository using existing supported local credentials; do not persist credentials in manifests or source URLs.
- Validate the manifest, API compatibility, contribution identities, and package-relative paths. Reject paths or links escaping the package root.
- Snapshot validated package content into ND-managed storage. Record content identity and source provenance, including resolved Git revision when available.
- Installation does not activate a package or execute dependency installation/build scripts. Developers supply built dependencies before installation.
- Activate contributions for an explicit context after permission review. A project-only workflow remains unavailable in Personal.
- Provide explicit update, disable, uninstall, and rollback to the previous installed version.
- Validate updates before atomically switching active versions. Permission increases require review; the current version remains usable if an update fails or is declined.
- Bind invocations to a package version. Stop accepting new calls on disable/revocation; cancel supervised calls where possible and discard late results that no longer have authorization. Do not claim already-completed external effects can be undone.
- Retain previous version settings for rollback. Uninstall revokes activation and executable access; personal notes/captures remain user data and are not silently deleted with a package.

## 7. Invocation and permission model

One trusted invocation service serves launcher actions, views, and agent MCP/shell gateways. Its envelope contains extension/contribution identity, context, caller type, run identity when applicable, input, and cancellation.

ND derives actor, company/project membership, engine/provider identity, and workspace from trusted session/context records. Caller arguments cannot manufacture authority.

Agent gateways use opaque run credentials bound to context, engine/provider, and permitted capabilities. Recheck current activation, routing, grants, and policy on every invocation. Credentials expire at run completion; stale or cross-context calls fail closed.

Effective authorization is the intersection of ND policy, context authorization, extension grants, and applicable engine restrictions. Deny wins. User-level permissions cannot override organization restrictions. For browser actions, PRD 0005's target access, tab-lease, and organization action policy remains the normative source; this section generalizes the same deny-wins rule to every invocation.

Grants identify extension, action, context, and relevant resource. Keep executable trust separate from ND API grants.

### Daily action defaults

- Remember scoped grants for routine approved operations; expose inspection and revocation in Extensions settings.
- An explicit user capture command authorizes that single capture, including its selected display/area.
- An explicit clipboard capture command authorizes that single read.
- Agent-initiated screen or clipboard reads require approval each time.
- User authorization applies to the named action/target, not background polling, unrelated resources, or implicit model uploads.
- Capture remains local until the user chooses to attach it or asks ND to analyze it.
- App/file/folder opening uses approved target handles or user selection. Do not accept shell command strings or implicit arbitrary execution arguments.

Move daily clipboard access behind the broker. Native APIs stay in trusted main-process services behind narrow IPC. Preserve renderer sandboxing and context isolation.

Supervise executable children with deadlines, output caps, cancellation, and restricted environment inheritance. Store credential references, never secret values. External MCP code remains trusted local executable code, not OS-sandboxed code; require explicit executable trust and describe this distinction in activation details.

Log action identity, context, decision, timing, and outcome. Do not log raw clipboard contents, screenshots, credentials, or opaque run tokens.

## 8. ND Home and launcher experience

- Reuse the existing global shortcut and popup.
- The OS shortcut defaults to Personal on each opening. The in-app launcher uses its current context.
- Show a persistent, explicit context selector in both surfaces.
- Notes and simple actions complete inside the popup. Browser interactions and longer chats can hand off to the main window with the same bound context.
- Personal chat and notes remain usable with zero companies/projects. Project-only actions explain that a project context is required.
- Extension views use host-rendered controls, with loading, empty, denied, cancelled, and failed states.
- Rename the main package-management surface to **Extensions**, retaining existing plugin/extension route aliases. Keep browser extensions a separately labelled browser capability.

### Daily Essentials

| Command | Required behavior |
| --- | --- |
| Quick note | Create, search, and open notes in the selected context |
| Capture area | Display a selection overlay, then save the selected region locally |
| Capture screen | Capture the display under the pointer by default; allow explicit display selection |
| Capture result | Preview, copy, export, or explicitly attach to a chat |
| Open Google / search web | Open Google or URL-encoded search in the visible ND browser |
| Open website | Validate HTTP(S) input; open in ND's embedded browser |
| Open externally | Explicit action to use the system browser |
| Open app/file/folder | Launch a user-selected or approved target through the native host API |
| Ask ND | Start or continue a context-bound chat |

Hide ND's capture overlays/popup from the image. Cancellation creates no saved capture or model request. Handle negative monitor coordinates and different display scale factors correctly.

The canonical agent browser remains the visible embedded WebContentsView, with existing browser session/config and policy contracts. Never start a hidden automation browser. Explicit external opening is not an agent browser-control bypass.

### Personal browser dialpad

The Personal space presents the ND browser as its own full-size pane, and that pane opens on a dialpad: ND's top sites (Google, YouTube, Gmail, Maps, Translate, Wikipedia, GitHub, X, Reddit) plus the user's own saved links.

- A tile opens a real tab of the embedded browser and the dialpad gets out of the way; the Dialpad control on the pane strip brings it back.
- "Save this site" records the current address as a personal ND record in ND-managed user storage — the same store as notes, captures, and chats — and re-saving an address refreshes its tile instead of duplicating it.
- Saved links are Personal records: they are never written to company or project memory, and removing a tile deletes only the link.
- Dialpad links belong to the personal context only. The Agent workbench browser stays a work surface without a personal speed dial.

## 9. Project Workflow pilot

Package the existing workflow integration with a searchable repository-task list, task-detail view, launcher open/refresh commands, and agent tools for the same snapshot and bounded context.

Reuse existing company/project bindings, provenance, source evidence, and stale-state diagnostics. Retain read-only Mirror semantics: do not execute project checks, mutate repository tasks, or grant approval.

The pilot is unavailable in Personal and demonstrates that global installation can coexist with project-scoped contributions.

## 10. Migration and compatibility

- Add the package layer around existing agent/workflow registries using compatibility adapters.
- Preserve custom extension manifests, engine/provider route choices, enablement, workflow bindings, and existing ND user data.
- Preserve legacy standalone workspace behavior and original session attribution.
- Existing executable trust must not be silently expanded into new native host grants.
- Retain existing IPC compatibility during migration; new scoped contracts must not infer authority from whichever project is currently visible.
- Reinspect current local launcher changes before implementation; do not overwrite unrelated work.
- Do not copy or patch upstream Harness core. Preserve ND Pencil identity, browser security, and all repository contributor constraints.

## 11. Acceptance and validation

- With no companies/projects, save and find a personal note, capture a region/display, open Google, launch a selected app/file, and use personal chat.
- With Company A → Project B active, the global popup still defaults to Personal and never leaks that project's data into personal actions.
- A globally installed extension cannot read other company/project data without authorized activation and context.
- Existing chats remain bound to their original context across navigation and restart.
- User-triggered captures remain local; agent-triggered screen/clipboard reads require per-action approval.
- Revocation, stale credentials, unsupported engine policy, invalid targets, and cross-context invocations fail closed.
- Multi-monitor/DPI capture, cancellation, missing apps, invalid URLs, unavailable models, and child-process failure produce useful results/errors.
- Installation does not execute package scripts; update failure and rollback preserve the previous usable version and settings.
- Both proving packages use shared contribution/invocation contracts; Project Workflow retains Mirror behavior.
- Existing extension routes, sessions, and workflow bindings survive migration.
- Include unit/integration authorization and lifecycle checks plus Electron E2E for the complete user journeys.
- Before publishing implementation, run `pnpm verify`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Record actual results and limitations rather than claiming success from mocks.

## 12. Task backlog

All tasks are implemented locally as of 2026-09-27; each task record carries
its own status line, and validation evidence lives in the
[extensions and Home QA gate](../qa/nd-extensions-home-manual.md).

| Task | Deliverable | Depends on |
| --- | --- | --- |
| [0035](../tasks/0035-extension-context-and-scope-contracts.md) | Context, ownership, and compatibility contracts | — |
| [0036](../tasks/0036-extension-invocation-and-permissions.md) | Shared invocation broker and grants | 0035 |
| [0037](../tasks/0037-nd-home-personal-storage-and-chat.md) | Personal data, ND Home, and scoped chat | 0035, 0036 |
| [0038](../tasks/0038-extension-packages-and-lifecycle.md) | Manifest, installation, activation, update/rollback | 0035, 0036 |
| [0039](../tasks/0039-extension-launcher-and-native-views.md) | Global commands, views, and management UI | 0037, 0038 |
| [0040](../tasks/0040-daily-essentials-extension.md) | Notes, capture, browser, and OS launch actions | 0036, 0037, 0038, 0039 |
| [0041](../tasks/0041-project-workflow-extension-pilot.md) | Scoped workflow package and compatibility | 0038, 0039 |
| [0042](../tasks/0042-extension-sdk-and-authoring-guide.md) | Schema, types, validator, and examples | 0038, 0039, 0040, 0041 |
| [0043](../tasks/0043-extension-home-validation-and-release.md) | Migration, E2E, runtime validation and release evidence | 0035–0042 |

## 13. Reference patterns

Borrow Raycast's discoverable commands and tools/instructions/evaluations model, and VS Code's manifest contributions and separation from the host UI. These are design references, not package compatibility commitments.

- [Raycast AI extension concepts](https://developers.raycast.com/ai/learn-core-concepts-of-ai-extensions)
- [Raycast manifest](https://developers.raycast.com/information/manifest)
- [VS Code extension capabilities](https://code.visualstudio.com/api/extension-capabilities/overview)
- [VS Code extension host](https://code.visualstudio.com/api/advanced-topics/extension-host)
- [VS Code workspace trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)
