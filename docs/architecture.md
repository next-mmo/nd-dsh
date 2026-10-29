# ND-DSH architecture

ND-DSH is the product and control plane. Model vendors and coding runtimes are replaceable execution dependencies.

## Private Windows build

The private release is a local portable `.exe` (`ND-DSH-<version>-private-beta-x64.exe`). It is not a signed public installer and has no update channel.

The diagrams below are the product architecture, including boundaries that are designed but not shipped. In this private build, these are **not** user-facing features, and the product must not present them as working:

- Team / admin web portal
- Cloud sync
- Arbitrary Chrome Web Store extension parity (only the compatibility subset that the built-in browser actually loads)
- A coding engine that is not installed on the machine (OpenCode, Goose, JCode, Hermes, Codex, Claude Code, Cursor, ZCode, Antigravity and Pi appear only when their CLI is present)
- Workflow-template authoring in the product UI (internal workflow behavior exists; users do not create or edit templates)

Provider API keys are desktop-global for this private build: one ND desktop is one trusted operator. Local models are supported by pointing an OpenAI-compatible provider at a local endpoint (for example Ollama); there is no separate bundled local-model runtime.

## Ownership

| Subsystem | Product owner | Runtime implementation |
| --- | --- | --- |
| companies, projects, goals, tasks | ND-DSH | `OrganizationStore` + orchestrator |
| teams, roles, AI employees | ND-DSH | organization domain |
| General / Coding workspace profiles | ND-DSH | persisted workspace-profile contract + renderer surface gating |
| ND Home / personal context | ND-DSH | personal notes, captures and context-bound chats in ND-managed storage |
| ND Extensions | ND-DSH | `nd.extension/1` packages + lifecycle store + trusted invocation broker |
| command registry | ND-DSH | core/context/capture/extension/project/company command sources → shared launcher |
| skills and memory | ND-DSH | compiled into runtime context/tools |
| company policy | ND-DSH | orchestrator + main-process approval gate |
| model-provider routes | ND-DSH | provider compiler → Harness LLM adapters |
| coding-engine routes | ND-DSH | engine registry + per-employee assignments |
| task workspace / checkpoint provenance | ND-DSH | TaskWorktreeManager + organization run ledger |
| runtime permits / parallel capacity | ND-DSH | ExecutionCoordinator + nd-core scheduler |
| primary coding runtime | ND-DSH adapter | DeepSeek Harness (tracks upstream latest) |
| delegated Codex execution | ND-DSH adapter | pinned Harness Codex provider → official Codex app-server |
| visible embedded browser | ND-DSH / Electron | ND-owned persistent Chromium session with sandboxed multi-tab `WebContentsView` runtime + exact CDP target |
| built-in browser extensions | ND-DSH / Electron | extension manager on the ND browser session; compatibility is capability/evidence-gated |
| existing-profile browser companion | ND-DSH integration | optional MV3 extension + Native Messaging + `nd-browser-host` |
| browser automation | ND-DSH integration | exact-visible-tab agent-browser path + optional companion semantic driver through the extension router |
| desktop lifecycle / IPC | ND-DSH | Electron main + context-isolated preload |
| product UI | ND-DSH | React renderer |

The source may contain upstream package names where they are technically required, but product-domain state and user-facing identity must not depend on one model vendor or coding engine.

## Full platform flow

General and Coding are two presentation/authoring profiles over one trusted ND control plane. Extensions, plugins, skills, agents, workflows, browser state and organization execution are shared capabilities; changing the visible profile is not an execution command.

```mermaid
flowchart TB
    U[Users / Teams] --> D[ND Desktop / ND DSH]

    subgraph WORKSPACES[Human Workspace Profiles]
      direction LR
      G[General Workspace<br/>Home · chat · files · browser · knowledge · design · launcher] 
      C[Coding Workspace<br/>General + code · terminal · Git · QA · debug/build/release]
    end

    D --> G
    D --> C

    G --> NE[ND Extensions / Daily Workflows]
    C --> DEV[Developer Tools / Coding Engines]

    NE --> CORE[Shared ND Core Platform]
    DEV --> CORE

    subgraph CORE_SERVICES[Shared ND Core Platform]
      direction LR
      E[Extensions Runtime]
      P[Plugins / Integrations]
      S[Skills Registry]
      W[Workflow Templates]
      K[Kanban / Tasks]
      M[Memory / Context]
      A[Agent Runtime / Orchestration]
      R[BYOK / Provider Routing]
      Q[Permissions / Security / Credentials]
    end

    CORE --> E
    CORE --> P
    CORE --> S
    CORE --> W
    CORE --> K
    CORE --> M
    CORE --> A
    CORE --> R
    CORE --> Q

    subgraph ARCH[Architecture Services]
      direction LR
      CK[Context & Knowledge<br/>company · project · team · docs · conversations]
      AS[Agent System<br/>main agent · subagents · planner · execution · audit]
      WS[Workflow System<br/>templates · approvals · automation rules]
      MP[Model & Provider Layer<br/>OpenAI-compatible · provider-native · local endpoint · budgets]
      SG[Security & Governance<br/>permissions · secrets · push guard · access control]
    end

    M --> CK
    A --> AS
    W --> WS
    R --> MP
    Q --> SG

    CK <--> AS
    AS <--> WS
    WS <--> MP
    MP <--> SG

    subgraph BROWSER[Built-in Browser — Primary Path]
      direction LR
      NB[ND Chromium Runtime]
      BT[Tabs]
      BP[Profiles / Sessions]
      BX[Browser Extensions]
      POP[In-app Extension Popup]
      BAC[Agent Browser Control]
    end

    CORE --> NB
    NB --> BT
    NB --> BP
    NB --> BX
    BX --> POP
    NB --> BAC

    BC[Browser Companion<br/>optional existing external Chrome/Chromium profile]
    NB -. explicit optional target .-> BC

    subgraph EXEC[Execution / Integration Layer]
      direction LR
      OS[OS Actions]
      FS[Local Filesystem]
      BA[Browser Automation]
      TC[Terminal Commands]
      API[External APIs]
      CS[Cloud / Sync — not in this release]
      WP[Team / Admin Web Portal — not in this release]
    end

    ARCH --> EXEC
    NB --> BA
    E --> EXEC
    P --> EXEC
    A --> EXEC
    SG --> EXEC

    EXEC --> OUT[Outcomes / Value]
    OUT --> O1[General users manage daily work]
    OUT --> O2[Developers build and ship software]
    OUT --> O3[Teams coordinate projects and workflows]
    OUT --> O4[Extensions expand ND beyond coding]
    OUT --> O5[Agents automate repetitive work]
```

### Capability boundaries

| Capability | What it owns | What it does **not** automatically own |
| --- | --- | --- |
| **Workspace profile** | Which human-facing surfaces are visible | Task/agent lifecycle, company identity, permissions or model routing |
| **ND Extension** | Manifest-declared commands, views, tools, skills/workflows and narrow host capabilities | Arbitrary Electron/Node/renderer/shell authority |
| **Plugin / integration** | Third-party service/tool connectivity through an adapter | Permission bypass or hidden cross-context access |
| **Skill** | Reusable expert instructions/context for a bounded task | Independent authority to execute OS/browser actions |
| **Agent / subagent** | Planning/execution under a context, budget, policy and audit scope | Self-granted permissions or silent context switching |
| **Browser extension** | Supported Chromium extension behavior inside the ND browser profile | ND host privileges or full Chrome API parity by assumption |
| **Browser Companion** | Explicit access to an existing external Chrome/Chromium profile | Replacement for the ND built-in browser |

Normative product requirements are split across [PRD 0005 — Unified Browser Platform](prd/0005-unified-browser-platform.md), [PRD 0006 — ND Extensions and Personal Home](prd/0006-nd-extensions-and-personal-home.md), [PRD 0007 — General and Coding Workspace Profiles](prd/0007-general-and-coding-workspaces.md), and [PRD 0008 — Command Registry and Governed Native Extensions](prd/0008-command-registry-native-extensions.md).
## Process graph

```text
ND-DSH React product UI
        |
        v
context-isolated preload / narrow IPC
        |
        v
Electron main process
  |-- workspace profile + ND Home context services
  |-- extension package store + invocation broker + command registry sources
  |-- organization state + PM/task/review/integration orchestrator
  |-- per-task lease/worktree/checkpoint provenance
  |-- ExecutionCoordinator + nd-core shared runtime permits
  |-- provider control plane + encrypted credentials
  |-- coding-engine registry + employee assignments
  |-- engine-session router with immutable task workspace binding
  |-- company approval policy gate
  |-- workspace service + ND built-in browser controller / browser platform
  |-- BrowserCompanionService -> local pipe/socket -> Rust Native Messaging host -> explicitly selected external profile
  |
  +-- ND Harness adapter
  +-- Codex app-server adapter
  +-- ZCode app-server adapter
  +-- direct CLI adapters (Claude Code / Cursor / Antigravity / Pi / OpenCode / Goose / JCode / Hermes)
  `-- browser-only / model-only interactive adapters when they do not expose an ND workspace
```

The hidden Harness web surface remains compatibility/debug infrastructure. ND-DSH forces the normal product surface to the ND workbench and does not present the upstream UI as product identity.

## Control-plane state

ND keeps durable product state outside runtime-vendor configuration:

- `settings.json` — desktop settings including the persisted General/Coding workspace profile; profile selection is presentation state, not organization execution state.
- ND Home / extension stores — personal notes/captures/chats plus installed package, activation, grant and audit records under ND-managed user data.
- `browser-extensions.json` — built-in browser extension enablement/source metadata. Approved extensions load into every Chrome-style browser profile with isolated runtime state.
- `browser-profiles.json` — Chrome-style browser identities (name, color, active profile, global default). The seeded `default` profile keeps the historical `persist:nd-dsh-browser` partition, so existing cookies and sign-ins survive; every other profile owns a separate Chromium partition plus profile-scoped ND history, site permissions and saved credentials.
- `organization.json` — companies, projects, workforce, workflows, tasks, policies, memory, activity, run receipts, coordination events, task workspace/checkpoint provenance, integration state.
- `organization.json.bak` — last-known-good organization recovery copy.
- `providers.json` — provider metadata only; no API keys.
- `provider-secrets.json` — OS-backed encrypted provider credentials where secure storage is available.
- `engine-assignments.json` — per-AI-employee coding-engine routes; absence means `nd-harness`.
- Harness session storage — durable execution transcripts owned by the runtime adapter.

Organization state uses validated snapshots, serialized/atomic writes, backup recovery, and startup reconciliation for interrupted runs. Engine assignments use atomic writes and fail back to the primary ND Harness route if the assignment file is unreadable.

Provider credentials are write-only from the renderer's point of view. `ProviderStore.list()` returns `apiKey: ''` plus a `hasApiKey` flag; replacement and clearing use dedicated validated IPC calls. The decrypted value stays in the trusted main process and only enters the ephemeral environment inherited by the model-runtime child.

## Model providers are not coding engines

A **provider** supplies a model endpoint. A **coding engine** supplies an agent/execution environment.

```text
AI employee
   |
   +-- model route --------> DeepSeek / OpenAI-style / Anthropic-style / catalog / gateway
   |
   `-- coding engine ------> ND Harness, or an installed CLI (Codex, ZCode, Claude Code, Cursor, Antigravity, Pi, OpenCode, Goose, JCode, Hermes)
```

`src/main/provider-runtime.ts` compiles enabled ND provider settings into provider+model routes. DeepSeek remains a seeded compatibility route; the company/task domain does not depend on it.

`src/main/engines/` owns the coding-engine registry and employee assignments. ND currently supports the primary Harness plus direct workspace-capable adapters including Codex, ZCode, Claude Code, Cursor, Antigravity and Pi, with additional installed CLI adapters such as OpenCode, Goose, JCode and Hermes. Delegated Codex remains a fallback. Vendor authentication/model/tool policy stays native; the organization domain never requires vendor-specific task fields.

## AI company execution

```text
objective
  -> AI PM plan
  -> goal / milestones / dependency-aware tasks
  -> safe ready tasks dispatched in parallel
  -> task lease + dedicated worktree + engine session
  -> checkpoint exact output
  -> ND machine/artifact verification
  -> independent reviewer
  -> integration queue
     pass: integrate + memory + unlock dependency
     conflict/fail: preserve task branch + explicit rework/block
  -> next safe work
```

Global planning runs remain serialized where they mutate shared planning truth, but isolated task execution/review runs may run concurrently across projects/companies when leases, dependency/scope checks, policies and runtime pools allow it. Each independent writable task has its own transaction/worktree boundary. Cancellation never counts as completion, and a desktop restart converts stale running receipts to explicit interrupted failures so work can recover from a known task boundary.

## Approval and policy boundary

Organization-level plan/execute/review policy is checked before a run starts. Runtime permission escalations are also intercepted in the main process before they reach React.

For an approval-bearing organization run:

1. ND associates the session with its organization run.
2. A conservative classifier maps high-confidence requests to existing company actions such as `external.publish`, `production.deploy`, `money.spend`, or `data.destructive`.
3. `DENY` is rejected in the main process.
4. `ALLOW` is resolved as allow-once.
5. `ASK`, unknown requests, classification uncertainty, or gate errors remain human-visible.

The pinned Harness approval wire exposes tool name and reason, not arbitrary tool arguments. ND therefore does **not** claim perfect semantic enforcement for every possible command. Non-approval-bearing browser/MCP/external actions still need normalized action metadata before enterprise GA.

## Browser-target invariants

For the **embedded ND browser**, the browser visible to the user is the browser
controlled by the agent. It is an ND-owned persistent Chromium session composed
of real sandboxed `WebContentsView` tabs. ND asks the active tab's debugger for
its exact CDP `targetId`, then binds agent-browser to that target. The CLI and MCP
integration share the same generated agent-browser config/session so an agent
cannot silently create a second hidden browser.

Built-in browser extensions belong to that same ND browser profile. The extension
manager may load only the compatibility subset supported by the selected runtime;
ND must not claim arbitrary Chrome Web Store parity without evidence. The target
architecture keeps supported extension action UI (for example `action.default_popup`)
inside the ND desktop window on the same browser session rather than delegating
execution to external Chrome.

The product browser starts at `about:blank`; localhost development pages are
opened only when explicitly requested.

The **Browser Companion** is a separate, explicit target for an existing
Chrome/Chromium profile. It is optional and does not weaken or replace the
embedded same-browser invariant. A user installs the MV3 extension, registers the
Native Messaging host, and grants per-origin site access. The companion controls
the selected real external tab through a semantic content driver; no hidden
automation browser is launched.

The companion's Rust host is transport-only. Electron main owns connection state
and one-writer tab leases, while engine access reuses the universal extension
router. Page content is untrusted application data. Password values and cookies
are not exported. Company-level normalized browser action policy remains required
before enterprise policy-completeness claims.

## Renderer trust boundary

- Node integration: off.
- Context isolation: on.
- Renderer sandbox: on.
- Web security: on.
- Main-process IPC: trusted main frame only with bounded inputs.
- Browser permissions: denied by default.
- Browser extension packages do not gain ND host privileges; ND Extensions and Browser Extensions remain separate trust domains.
- External URLs: HTTP/HTTPS only.
- Workspace reads: root-contained with realpath/symlink protections.
- Existing provider credentials: never returned to React; only existence/replacement/clear operations are exposed.

If the trusted preload or organization bridge is unavailable, the renderer fails closed with a runtime-unavailable screen. It does not create demo companies, fake sessions, mock workspaces, or localStorage product state.

## Coding-engine capability posture

ND advertises only capabilities it actually wires.

### ND Harness

- durable sessions and streaming
- filesystem and shell
- visible browser
- ND skills and MCP
- provider-neutral model routing
- human approvals/questions

### Workspace-capable direct engines

Codex CLI, ZCode CLI, Claude Code CLI, Cursor CLI, Antigravity CLI and Pi CLI use the common direct-engine session contract when installed. OpenCode, Goose, JCode and Hermes are additional registered CLI adapters. ND binds organization sessions to the task workspace selected by the control plane; a direct adapter cannot silently re-root that session to another checkout.

### Delegated Codex fallback

Delegated Codex remains a one-shot Harness-backed route. ND does not claim browser/MCP/skill or persistent-thread capabilities that the delegated route does not provide. Native engine authentication, provider/model and project configuration remain authoritative.

## Failure behavior

- Missing/unbuilt Harness: engine is unavailable and a run is rejected before a false run receipt is created.
- Missing/unbuilt Codex adapter: employees cannot be newly assigned to Codex and existing Codex-routed work is rejected before starting.
- Codex auth/trust failure: task remains a visible failure/blocker; ND does not invent completion.
- Missing provider credential: the active route reports its real model error; provider metadata never substitutes a fake result.
- Secure credential store unavailable: key remains memory-only instead of being persisted insecurely.
- Embedded browser bridge unavailable: the visible embedded browser remains manual; agent-browser reports unavailable.
- Browser Companion unavailable or disconnected: the embedded browser remains usable and companion calls fail closed rather than blocking desktop startup.
- Approval policy gate failure: request falls back to human `ASK`, never implicit allow.
- App restart mid-run: stale organization run is reconciled as interrupted/failed.

## Public-beta release gates

A private Windows portable build can bundle the Harness runtime, agent-browser, ND Core, and third-party notices. That build is not a public release. Before publishing installers, ND still needs:

- macOS signing/notarization and Windows signing
- an installer with uninstall behavior, an app icon, and an update channel that preserves user state
- installed-app E2E on a clean machine, not only a developer checkout
- Codex authentication/health onboarding UX
- normalized action metadata for policy enforcement beyond Harness approval frames
- runner-attested release evidence (GitHub Actions is parked) and a crash provenance policy

These are release engineering and policy-completeness gates, not mock functionality; the product runtime used by the desktop is real.
