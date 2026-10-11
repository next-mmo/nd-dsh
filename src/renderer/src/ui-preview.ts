import type {
  BrowserState,
  DesktopApi,
  DshEventFrame,
  GitStatusSnapshot,
  HarnessStatus,
  ModelProvider,
  QaState,
  ThemeState,
  WorkspaceState,
} from '../../shared/contracts'
import { buildCodingEngineCatalog } from '../../shared/coding-engines'
import type { BrowserCompanionState, BrowserTabLease } from '../../shared/browser-companion'
import type { BrowserPlatformState, BrowserTabDescriptor } from '../../shared/browser-platform'
import type {
  CapabilityAssignmentSnapshot,
  CapabilityDescriptor,
  CapabilityKind,
  CapabilityProviderStatus,
  CapabilitySubjectType,
} from '../../shared/capabilities'
import {
  DEFAULT_CAPABILITY_PROVIDER,
  GRAPHIFY_CONTEXT_ID,
  ND_CODEX_CLI_CAPABILITY_ID,
  ND_HARNESS_CAPABILITY_ID,
  ND_MEMORY_MCP_ID,
  ND_ORG_MEMORY_ID,
  ND_SESSION_RECALL_ID,
  ND_WORKSPACE_CONTEXT_ID,
  OPENVIKING_MEMORY_ID,
} from '../../shared/capabilities'
import type { DesignDesktopApi, DesignFreeformState, DesignProjectState } from '../../shared/design'
import type { OrganizationDesktopApi, OrganizationMutation, OrganizationSnapshot } from '../../shared/organization'
import type { WorkflowPluginsDesktopApi } from '../../shared/workflow-plugins'
import type { WorkspaceProfile } from '../../shared/workspace-profile'

type Listener<T> = (value: T) => void

function signal<T>() {
  const listeners = new Set<Listener<T>>()
  return {
    emit(value: T): void { for (const listener of listeners) listener(value) },
    on(listener: Listener<T>): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const now = Date.now()
const workspaceEvents = signal<WorkspaceState>()
const browserEvents = signal<BrowserState>()
const browserCompanionEvents = signal<BrowserCompanionState>()
const browserPlatformEvents = signal<BrowserPlatformState>()
const harnessEvents = signal<HarnessStatus>()
const dshEvents = signal<DshEventFrame>()
const themeEvents = signal<ThemeState>()
const gitEvents = signal<GitStatusSnapshot>()
const qaEvents = signal<QaState>()
const organizationEvents = signal<OrganizationSnapshot>()
const freeformEvents = signal<DesignFreeformState>()

let workspace: WorkspaceState = {
  root: 'C:/workspace/nd-product',
  name: 'nd-product',
  binding: 'project',
  companyId: 'company-nd',
  companyName: 'Northstar Digital',
  projectId: 'project-console',
  projectName: 'Agent Console',
  projectWorkspacePath: 'C:/workspace/nd-product',
}

let previewBuiltinTabs: BrowserTabDescriptor[] = [{
  id: 'preview-builtin-tab',
  targetId: 'builtin',
  profileId: 'builtin:default',
  title: 'Agent Console',
  url: 'http://localhost:3000/',
  origin: 'http://localhost:3000',
  active: true,
  visible: false,
  loading: false,
  canGoBack: true,
  canGoForward: false,
}]

let browser: BrowserState = {
  url: 'http://localhost:3000/',
  title: 'Agent Console',
  loading: false,
  canGoBack: true,
  canGoForward: false,
  visible: false,
  cdpPort: 0,
  profileId: 'builtin:default',
  activeTabId: 'preview-builtin-tab',
  tabs: previewBuiltinTabs,
  downloads: [],
  agentBrowser: 'ready',
}

let harness: HarnessStatus = {
  state: 'ready',
  sourceReady: true,
  apiKeyPresent: true,
  apiKeyRequired: true,
  provider: 'openai-prod',
  model: 'gpt-5.6',
  sessionId: 'preview-session',
}

let browserCompanion: BrowserCompanionState = {
  connections: [
    {
      id: 'preview-connection',
      installationId: 'preview-installation',
      browser: 'chrome',
      profileLabel: 'Default profile',
      extensionVersion: '0.1.0',
      connected: true,
      connectedAt: now - 3_600_000,
      lastSeenAt: now,
    },
  ],
  leases: [],
  discoveryPath: 'C:/Users/preview/.nd-dsh/browser-companion.json',
}

let browserPlatform: BrowserPlatformState = {
  targets: [
    {
      id: 'builtin',
      kind: 'builtin',
      label: 'ND Browser',
      profileId: 'builtin:default',
      profileLabel: 'ND Browser',
      connected: true,
      visible: false,
      capabilities: {
        tabs: true,
        semanticDom: true,
        screenshots: true,
        downloads: true,
        uploads: false,
        history: true,
        credentials: true,
        extensions: true,
        siteTools: true,
        backgroundControl: true,
      },
    },
    {
      id: 'companion:preview-connection',
      kind: 'companion',
      label: 'Default profile',
      profileId: 'companion-profile:preview-connection',
      profileLabel: 'Default profile',
      connected: true,
      visible: false,
      capabilities: {
        tabs: true,
        semanticDom: true,
        screenshots: true,
        downloads: false,
        uploads: false,
        history: false,
        credentials: false,
        extensions: false,
        siteTools: false,
        backgroundControl: true,
      },
    },
  ],
  tabs: [
    ...previewBuiltinTabs,
    {
      id: '77',
      nativeTabId: 77,
      targetId: 'companion:preview-connection',
      profileId: 'companion-profile:preview-connection',
      title: 'GitHub',
      url: 'https://github.com/',
      origin: 'https://github.com',
      active: true,
      visible: true,
    },
  ],
  selection: { mode: 'auto' },
  leases: [],
  downloads: [],
  extensions: [],
  extensionCatalog: [
    {
      id: 'nd-browser-tools',
      name: 'ND Browser Tools',
      publisher: 'ND',
      description: 'First-party browser tools that run entirely inside the ND built-in Chromium profile.',
      packagePolicy: 'bundled',
      compatibility: 'compatible',
      bundleAvailable: true,
      installed: false,
      note: 'UI preview only.',
    },
    {
      id: 'openai-chatgpt',
      name: 'ChatGPT',
      publisher: 'OpenAI',
      description: 'Compatibility reference for the official standalone-Chrome extension, not the ND Method 2 runtime.',
      storeId: 'hehggadaopoacecdllhhajmbjkdcmajg',
      storeUrl: 'https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg?hl=en',
      packagePolicy: 'reference-only',
      compatibility: 'experimental',
      bundleAvailable: false,
      installed: false,
      note: 'UI preview only.',
    },
  ],
  browserUseEnabled: true,
  developerMode: false,
  credentials: [],
  sitePermissions: [],
  approvals: [],
  receipts: [],
}

let theme: ThemeState = { mode: 'system', effective: matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark' }
let workspaceProfile: WorkspaceProfile = 'general'

let providers: ModelProvider[] = [
  { id: 'openai-prod', name: 'OpenAI', enabled: true, baseUrl: 'https://api.openai.com/v1', apiFormat: 'openai-responses', apiKey: '', hasApiKey: true, models: [{ id: 'gpt-5.6', context: '256k' }] },
  { id: 'deepseek-official', name: 'DeepSeek', enabled: false, baseUrl: 'https://api.deepseek.com', apiFormat: 'openai-completions', apiKey: '', hasApiKey: true, models: [{ id: 'deepseek-v4-flash', context: '128k' }] },
  { id: 'local-lab', name: 'Local Lab', enabled: false, baseUrl: 'http://127.0.0.1:11434/v1', apiFormat: 'openai-completions', apiKey: '', hasApiKey: false, models: [{ id: 'company-code-model', context: '32k' }] },
]

const engines = buildCodingEngineCatalog({ harnessReady: true, codexReady: true, codexCliReady: true, antigravityReady: true, zcodeCliReady: true, piCodingReady: true, cursorCliReady: true, claudeCodeCliReady: true })
let assignments: Record<string, string> = { 'agent-pm': 'nd-harness', 'agent-builder': 'codex-cli', 'agent-reviewer': 'nd-harness' }

const ADAPTER_SLOT_NOTE = 'Adapter slot reserved. The integration ships in an upcoming ND release; built-ins stay active meanwhile.'

/** Mirrors the main-process registry catalog so preview settings and dashboards render real shapes. */
const capabilityProviders: CapabilityDescriptor[] = [
  ...engines.map((engine): CapabilityDescriptor => ({
    id: engine.id,
    kind: 'engine',
    name: engine.name,
    integration: engine.id === ND_HARNESS_CAPABILITY_ID ? 'builtin' : 'adapter',
    available: engine.available,
    description: engine.description,
    ...(engine.unavailableReason !== undefined ? { unavailableReason: engine.unavailableReason } : {}),
  })),
  {
    id: ND_ORG_MEMORY_ID,
    kind: 'memory',
    name: 'ND Organization Memory',
    integration: 'builtin',
    available: true,
    description: 'Company/project-scoped durable memory owned by the organization store; injected into PM, worker, and review prompts.',
  },
  {
    id: OPENVIKING_MEMORY_ID,
    kind: 'memory',
    name: 'OpenViking Memory',
    integration: 'adapter',
    available: true,
    description: 'External context-database adapter for long-horizon checkpointed recall across parallel workers.',
    setup: {
      mode: 'approved-package',
      sourceLabel: 'OpenViking Context Database',
      sourceUrl: 'https://github.com/openviking/openviking',
      packageId: 'openviking',
      version: '0.1.0',
      integrity: 'sha256-openviking010hashplaceholder64chars000000000000000000000000000=',
      prerequisites: ['Node.js 24 or newer'],
      fields: [
        { id: 'endpoint', label: 'Server endpoint URL', placeholder: 'http://localhost:8000', required: true },
        { id: 'api_key', label: 'API Key', required: false, sensitive: true },
      ],
    },
  },
  {
    id: ND_MEMORY_MCP_ID,
    kind: 'memory',
    name: 'ND Memory MCP',
    integration: 'adapter',
    available: true,
    description: 'ND organization memory exposed as live in-loop worker tools inside harness sessions via a patch-row MCP plugin.',
    setup: {
      mode: 'source-runtime',
      sourceLabel: 'DeepSeek Harness source checkout',
      sourceUrl: 'https://github.com/deepseek-ai/deepseek-harness',
      runtimeId: 'DeepSeek Harness runtime',
      version: '0.2.0',
      prerequisites: ['Node.js 24 or newer', 'Corepack'],
      fields: [],
    },
  },
  {
    id: ND_WORKSPACE_CONTEXT_ID,
    kind: 'context',
    name: 'ND Workspace Context',
    integration: 'builtin',
    available: true,
    description: 'Workspace files, git state, live browser UI targets, annotations, and screenshots attached to prompts by the ND runtime.',
  },
  {
    id: ND_SESSION_RECALL_ID,
    kind: 'context',
    name: 'Harness Session Recall',
    integration: 'adapter',
    available: true,
    description: 'Mounts the harness session-search index as worker tools for recall over past coding sessions.',
    setup: {
      mode: 'source-runtime',
      sourceLabel: 'DeepSeek Harness source checkout',
      sourceUrl: 'https://github.com/deepseek-ai/deepseek-harness',
      runtimeId: 'DeepSeek Harness runtime',
      version: '0.2.0',
      prerequisites: ['Node.js 24 or newer', 'Corepack'],
      fields: [],
    },
  },
  {
    id: GRAPHIFY_CONTEXT_ID,
    kind: 'context',
    name: 'Graphify Repo Map',
    integration: 'adapter',
    available: true,
    description: 'Local AST code-graph adapter for blast-radius analysis and token-cheap repo mapping inside workers.',
    setup: {
      mode: 'approved-package',
      sourceLabel: 'Graphify Repo Map',
      sourceUrl: 'https://github.com/Graphify-Labs/graphify',
      packageId: 'graphify',
      version: '1.0.0',
      integrity: 'sha256-graphify100hashplaceholder64chars000000000000000000000000000000=',
      prerequisites: ['Node.js 24 or newer'],
      fields: [
        { id: 'workspace_token', label: 'Workspace Token', required: true, sensitive: true },
      ],
    },
  },
]

let capabilityAssignments: CapabilityAssignmentSnapshot = {
  version: 1,
  agents: { 'agent-pm': { engine: ND_HARNESS_CAPABILITY_ID }, 'agent-builder': { engine: ND_CODEX_CLI_CAPABILITY_ID }, 'agent-reviewer': { engine: ND_HARNESS_CAPABILITY_ID } },
  roles: {},
  teams: {},
}

const capabilityStatusOverrides: Record<string, CapabilityProviderStatus> = {}

function previewCapabilityStatus(providerId: string): CapabilityProviderStatus {
  const override = capabilityStatusOverrides[providerId]
  if (override) return override
  const builtin = capabilityProviders.find((item) => item.id === providerId)?.integration === 'builtin'
  return {
    providerId,
    enabled: builtin,
    ...(builtin ? { lastVerifiedAt: now } : {}),
  }
}

function capabilityStatusesView(): Record<string, CapabilityProviderStatus> {
  const view: Record<string, CapabilityProviderStatus> = {}
  for (const descriptor of capabilityProviders) view[descriptor.id] = previewCapabilityStatus(descriptor.id)
  return view
}

let git: GitStatusSnapshot = {
  root: workspace.root,
  repoRoot: workspace.root,
  branch: 'codex/ui-refresh',
  ahead: 2,
  behind: 0,
  heads: [{ hash: '6c1f8a94', message: 'Refine agent workspace shell', authorName: 'ND Team', authorEmail: 'dev@example.com', date: new Date(now - 3_600_000).toISOString() }],
  branches: [
    { name: 'codex/ui-refresh', current: true, upstream: 'origin/codex/ui-refresh', ahead: 2, behind: 0 },
    { name: 'main', current: false, upstream: 'origin/main', ahead: 0, behind: 0 },
  ],
  staged: [{ path: 'src/components/AgentCard.tsx', x: 'M', y: ' ' }],
  unstaged: [{ path: 'src/App.tsx', x: ' ', y: 'M' }, { path: 'src/styles/theme.css', x: ' ', y: 'M' }],
  untracked: [{ path: 'src/components/RunBadge.tsx', x: '?', y: '?' }],
  conflicts: [],
  remotes: ['origin'],
  timestamp: now,
}

let qa: QaState = {
  activeRun: null,
  suites: [
    { id: 'unit', kind: 'internal', label: 'Unit tests', description: 'Runs the Vitest unit suite for this repository.', runner: 'Vitest', command: 'pnpm test', status: 'passed', lastExitCode: 0, lastDurationMs: 2540, lastFinishedAt: now - 240_000 },
    { id: 'e2e', kind: 'internal', label: 'Desktop E2E', description: 'Drives the built desktop app end to end with Playwright.', runner: 'Playwright', command: 'pnpm e2e', status: 'passed', lastExitCode: 0, lastDurationMs: 18_420, lastFinishedAt: now - 86_400_000 },
  ],
}

let organization: OrganizationSnapshot = {
  version: 1,
  activeCompanyId: 'company-nd',
  activeProjectId: 'project-console',
  companies: [{ id: 'company-nd', name: 'Northstar Digital', mission: 'Build reliable AI-native software teams.', autonomyLevel: 3, status: 'active', createdAt: now - 30 * 86_400_000, updatedAt: now - 60_000 }],
  projects: [{ id: 'project-console', companyId: 'company-nd', name: 'Agent Console', objective: 'Ship a polished control plane for autonomous software delivery.', status: 'active', workspacePath: workspace.root, repoUrls: ['https://github.com/example/agent-console'], teamIds: ['team-product'], progress: 68, createdAt: now - 20 * 86_400_000, updatedAt: now - 60_000 }],
  roles: [
    { id: 'role-pm', companyId: 'company-nd', name: 'Product Manager', responsibility: 'Plans outcomes and coordinates delivery.', systemPrompt: 'Plan clear, verifiable work.', skillIds: ['skill-planning'] },
    { id: 'role-builder', companyId: 'company-nd', name: 'Product Engineer', responsibility: 'Implements production changes.', systemPrompt: 'Build and verify real source.', skillIds: ['skill-code'] },
    { id: 'role-reviewer', companyId: 'company-nd', name: 'Independent Reviewer', responsibility: 'Reviews evidence and acceptance criteria.', systemPrompt: 'Review independently.', skillIds: ['skill-review'] },
  ],
  teams: [{ id: 'team-product', companyId: 'company-nd', name: 'Product Delivery', purpose: 'Plan, build, and review the product.', roleIds: ['role-pm', 'role-builder', 'role-reviewer'], skillIds: ['skill-code'] }],
  agents: [
    { id: 'agent-pm', companyId: 'company-nd', name: 'Nova', roleId: 'role-pm', teamId: 'team-product', status: 'idle', skillIds: ['skill-planning'], lastSessionId: 'preview-session' },
    { id: 'agent-builder', companyId: 'company-nd', name: 'Atlas', roleId: 'role-builder', teamId: 'team-product', status: 'working', skillIds: ['skill-code'], currentTaskId: 'task-shell' },
    { id: 'agent-reviewer', companyId: 'company-nd', name: 'Iris', roleId: 'role-reviewer', teamId: 'team-product', status: 'idle', skillIds: ['skill-review'] },
  ],
  skills: [
    { id: 'skill-planning', scope: 'company', companyId: 'company-nd', name: 'product-planning', description: 'Dependency-aware product planning.', instructions: 'Create testable milestones.' },
    { id: 'skill-code', scope: 'project', companyId: 'company-nd', projectId: 'project-console', name: 'production-code', description: 'Implementation in the real workspace.', instructions: 'Inspect, edit, and verify.' },
    { id: 'skill-review', scope: 'company', companyId: 'company-nd', name: 'independent-review', description: 'Evidence-based review.', instructions: 'Verify acceptance criteria independently.' },
  ],
  workflows: [{ id: 'workflow-delivery', name: 'Software delivery', scope: 'project', companyId: 'company-nd', projectId: 'project-console', steps: [{ id: 'plan', name: 'Plan', kind: 'plan' }, { id: 'build', name: 'Build', kind: 'execute' }, { id: 'review', name: 'Review', kind: 'review' }] }],
  goals: [{ id: 'goal-beta', companyId: 'company-nd', projectId: 'project-console', title: 'Private beta workbench', description: 'Complete the coding-first product loop.', status: 'active', progress: 68, createdAt: now - 14 * 86_400_000 }],
  milestones: [
    { id: 'milestone-shell', companyId: 'company-nd', projectId: 'project-console', goalId: 'goal-beta', title: 'Product shell', description: 'Polished desktop workbench.', status: 'active', order: 1 },
    { id: 'milestone-release', companyId: 'company-nd', projectId: 'project-console', goalId: 'goal-beta', title: 'Release readiness', description: 'Packaging and installed-app validation.', status: 'pending', order: 2 },
  ],
  tasks: [
    { id: 'task-contracts', companyId: 'company-nd', projectId: 'project-console', goalId: 'goal-beta', milestoneId: 'milestone-shell', title: 'Normalize runtime contracts', description: 'Keep engine-specific behavior behind adapters.', acceptanceCriteria: ['Organization state contains no engine branching.'], priority: 'high', status: 'completed', dependsOn: [], assignedAgentId: 'agent-builder', resultSummary: 'Runtime contracts normalized and verified.', reviewSummary: 'Passed independent review.', createdAt: now - 7 * 86_400_000, updatedAt: now - 2 * 86_400_000 },
    { id: 'task-shell', companyId: 'company-nd', projectId: 'project-console', goalId: 'goal-beta', milestoneId: 'milestone-shell', title: 'Polish the workbench shell', description: 'Improve hierarchy, density, and navigation.', acceptanceCriteria: ['All five product surfaces remain accessible.', 'Typecheck and tests pass.'], priority: 'critical', status: 'in_progress', dependsOn: ['task-contracts'], assignedAgentId: 'agent-builder', executionSessionId: 'preview-session', createdAt: now - 2 * 86_400_000, updatedAt: now - 60_000 },
    { id: 'task-installer', companyId: 'company-nd', projectId: 'project-console', goalId: 'goal-beta', milestoneId: 'milestone-release', title: 'Package the desktop runtime', description: 'Create signed installable artifacts.', acceptanceCriteria: ['Clean machine can launch without developer tooling.'], priority: 'high', status: 'backlog', dependsOn: ['task-shell'], createdAt: now - 86_400_000, updatedAt: now - 86_400_000 },
  ],
  memory: [{ id: 'memory-boundary', companyId: 'company-nd', projectId: 'project-console', title: 'Product boundary', content: 'ND owns company state and policies; providers and coding engines remain replaceable adapters.', tags: ['architecture', 'control-plane'], source: 'human', createdAt: now - 10 * 86_400_000, updatedAt: now - 10 * 86_400_000 }],
  policies: [
    { id: 'policy-deploy', companyId: 'company-nd', action: 'production.deploy', effect: 'ask', description: 'Require approval before production deployment.' },
    { id: 'policy-delete', companyId: 'company-nd', action: 'data.destructive', effect: 'deny', description: 'Deny destructive data operations.' },
  ],
  activity: [{ id: 'activity-review', companyId: 'company-nd', projectId: 'project-console', type: 'review.completed', message: 'Runtime contract review passed.', createdAt: now - 2 * 86_400_000 }],
  runs: [{ id: 'run-shell', companyId: 'company-nd', projectId: 'project-console', taskId: 'task-shell', goalId: 'goal-beta', kind: 'task-execution', status: 'running', sessionId: 'preview-session', startedAt: now - 180_000 }],
  coordination: [],
}

let freeform: DesignFreeformState = { engine: 'nd-pencil', status: 'ready', available: true, visible: false, dirty: false, documentPath: '.nd/design/home.op', documentName: 'home.op', version: '0.8.4' }
const designProject: DesignProjectState = {
  root: workspace.root,
  kind: 'shadcn',
  frameworks: ['React', 'Vite'],
  packageManager: 'pnpm',
  devCommand: 'pnpm dev',
  templates: [{ path: 'index.html', name: 'Application shell', kind: 'html', previewable: true, entry: true }],
  shadcn: { detected: true, configPath: 'components.json', style: 'new-york', baseColor: 'neutral', cssVariables: true, components: [{ name: 'Button', path: 'src/components/ui/button.tsx', kind: 'shadcn' }, { name: 'Dialog', path: 'src/components/ui/dialog.tsx', kind: 'shadcn' }, { name: 'Tabs', path: 'src/components/ui/tabs.tsx', kind: 'shadcn' }] },
  freeform: { documents: [{ path: '.nd/design/home.op', name: 'home.op' }] },
  capabilities: { liveApp: true, htmlTemplates: true, shadcn: true, canvas: true, freeform: true },
  preview: { kind: 'dev-server', root: workspace.root, url: 'http://localhost:3000/', command: 'pnpm dev' },
}

const sessionHistory = [
  { event: { type: 'user/message', seq: 1, time: now - 180_000, data: { message: { content: 'Polish the workbench shell and keep every product surface accessible.' } } } },
  { event: { type: 'assistant/message', seq: 2, time: now - 170_000, data: { message: { content: 'I mapped the shell, consolidated the visual primitives, and am validating the five navigation surfaces now.' } } } },
  { event: { type: 'tool/call', seq: 3, time: now - 160_000, data: { callId: 'preview-tool', name: 'workspace.inspect', arguments: { path: 'src/renderer' } } } },
  { event: { type: 'tool/result', seq: 4, time: now - 155_000, data: { message: { content: 'Renderer structure inspected successfully.' } } } },
]

const archivedPreviewSessions = new Set<string>()

const desktopApi: DesktopApi = {
  skills: { detail: async () => { throw new Error('ND skills require the trusted desktop main process') }, catalog: async () => { throw new Error('ND skills require the trusted desktop main process') } },
  app: {
    info: async () => ({ name: 'ND-DSH', version: '0.1.0-dev-preview', platform: 'web-preview', projectRoot: workspace.root }),
    restart: async () => undefined,
  },
  capabilities: {
    providers: async () => capabilityProviders,
    assignments: async () => capabilityAssignments,
    assign: async (subjectType: CapabilitySubjectType, subjectId, kind, providerId) => {
      const mapKey = subjectType === 'agent' ? 'agents' as const : subjectType === 'role' ? 'roles' as const : 'teams' as const
      const map = { ...capabilityAssignments[mapKey] }
      if (providerId === DEFAULT_CAPABILITY_PROVIDER[kind]) {
        // Mirrors the durable store: re-assigning the default deletes the sparse key.
        const entry = map[subjectId]
        if (entry) {
          const { [kind]: _defaulted, ...rest } = entry
          if (Object.keys(rest).length > 0) map[subjectId] = rest
          else delete map[subjectId]
        }
      } else {
        map[subjectId] = { ...map[subjectId], [kind]: providerId }
      }
      capabilityAssignments = { ...capabilityAssignments, [mapKey]: map }
      return capabilityAssignments
    },
    onChanged: () => () => {},
    statuses: async () => capabilityStatusesView(),
    checkSetup: async (providerId) => ({ providerId, ready: true, prerequisites: [] }),
    setup: async (providerId) => {
      capabilityStatusOverrides[providerId] = {
        ...previewCapabilityStatus(providerId),
        enabled: false,
        setupState: 'installed',
        setupProgress: 100,
        setupMessage: 'Setup complete. Verify before enabling.',
      }
      return capabilityStatusesView()
    },
    verify: async (providerId) => {
      // Success marks the provider verified but never enables it implicitly.
      capabilityStatusOverrides[providerId] = { ...previewCapabilityStatus(providerId), lastProbeAt: Date.now(), lastVerifiedAt: Date.now() }
      return capabilityStatusesView()
    },
    setEnabled: async (providerId, enabled) => {
      capabilityStatusOverrides[providerId] = { ...previewCapabilityStatus(providerId), enabled }
      return capabilityStatusesView()
    },
    onStatusChanged: () => () => {},
  },
  providers: {
    list: async () => providers,
    save: async (value) => (providers = value.map((provider) => ({ ...provider, apiKey: '' }))),
    setApiKey: async (providerId) => (providers = providers.map((provider) => provider.id === providerId ? { ...provider, hasApiKey: true, apiKey: '' } : provider)),
    clearApiKey: async (providerId) => (providers = providers.map((provider) => provider.id === providerId ? { ...provider, hasApiKey: false, apiKey: '' } : provider)),
    ping: async (providerId) => ({ providerId, state: 'ok', latencyMs: 84, status: 200, hasApiKey: Boolean(providers.find((provider) => provider.id === providerId)?.hasApiKey), at: Date.now() }),
    testCompletion: async (providerId) => ({ providerId, state: 'ok', latencyMs: 640, status: 200, hasApiKey: Boolean(providers.find((provider) => provider.id === providerId)?.hasApiKey), at: Date.now() }),
    onChanged: () => () => {},
  },
  engines: {
    list: async () => engines,
    assignments: async () => assignments,
    assign: async (agentId, engineId) => (assignments = { ...assignments, [agentId]: engineId }),
    sessions: async () => [],
    transcript: async (sessionId) => ({ sessionId, engineId: 'codex-cli', events: [] }),
    models: async () => [
      { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' },
      { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
    ],
  },
  zcodeConfig: {
    read: async () => ({
      path: '~/.zcode/cli/config.json',
      exists: true,
      mainModel: 'zai/glm-5.3',
      providers: [
        {
          id: 'zai',
          kind: 'anthropic' as const,
          name: 'Z.ai',
          baseURL: 'https://api.z.ai/api/anthropic',
          apiKeySet: true,
          apiKeyHint: 'sk-…f4a2',
          models: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 200_000 }],
        },
        {
          id: 'deepseek',
          kind: 'openai-compatible' as const,
          name: 'DeepSeek',
          baseURL: 'https://api.deepseek.com',
          apiKeySet: false,
          models: [{ id: 'deepseek-chat' }],
        },
      ],
    }),
    write: async (update) => ({
      path: '~/.zcode/cli/config.json',
      exists: true,
      ...(update.mainModel !== undefined ? { mainModel: update.mainModel } : {}),
      providers: update.providers.map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        ...(provider.name !== undefined ? { name: provider.name } : {}),
        ...(provider.baseURL !== undefined ? { baseURL: provider.baseURL } : {}),
        apiKeySet: provider.apiKey !== undefined,
        models: provider.models,
      })),
    }),
  },
  sessions: {
    setArchived: async (sessionId, archived) => {
      if (archived) archivedPreviewSessions.add(sessionId)
      else archivedPreviewSessions.delete(sessionId)
      return [...archivedPreviewSessions]
    },
    setArchivedMany: async (sessionIds, archived) => {
      for (const sessionId of sessionIds) {
        if (archived) archivedPreviewSessions.add(sessionId)
        else archivedPreviewSessions.delete(sessionId)
      }
      return [...archivedPreviewSessions]
    },
  },
  capture: {
    inspectApp: async (_copy, _scope, options) => ({
      sessionId: 'preview-session',
      copiedToClipboard: false,
      width: Math.round(options?.rect?.width ?? innerWidth),
      height: Math.round(options?.rect?.height ?? innerHeight),
      displayLabel: options?.rect ? `${Math.round(options.rect.width)}x${Math.round(options.rect.height)}` : 'UI preview',
      mode: options?.mode ?? 'full',
    }),
    forComposer: async (_scope, options) => ({
      data: '',
      mediaType: 'image/png' as const,
      width: Math.round(options?.rect?.width ?? innerWidth),
      height: Math.round(options?.rect?.height ?? innerHeight),
      displayLabel: options?.rect ? `${Math.round(options.rect.width)}x${Math.round(options.rect.height)}` : 'UI preview',
      mode: options?.mode ?? 'full',
      copiedToClipboard: false,
    }),
    inspectElement: async () => ({ outcome: 'unreachable', message: 'Element inspection is available in Electron.' }),
    stageElement: async () => [],
    elementAttachments: async () => [],
    removeElement: async () => [],
    copyElementContext: async () => false,
    copyElementShot: async () => false,
  },
  browser: {
    state: async () => browser,
    setBounds: async () => undefined,
    setVisible: async (visible) => { browser = { ...browser, visible }; browserEvents.emit(browser) },
    navigate: async (url) => { browser = { ...browser, url, title: url, loading: false, canGoBack: true }; browserEvents.emit(browser); return browser },
    back: async () => browser,
    forward: async () => browser,
    reload: async () => browser,
    snapshot: async () => ({ preview: true, url: browser.url }),
    openExternal: async (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
    onState: browserEvents.on,
  },
  ndExtensions: {
    state: async () => ({ packages: [], activations: [], grants: [], audit: [], pendingApprovals: [] }),
    installLocal: async () => null,
    installFromPath: async () => previewExtensionsState(),
    installAvailable: async () => previewExtensionsState(),
    exportStarterKit: async () => null,
    update: async () => previewExtensionsState(),
    rollback: async () => previewExtensionsState(),
    uninstall: async () => previewExtensionsState(),
    setActivation: async () => previewExtensionsState(),
    setSetting: async () => previewExtensionsState(),
    revokeGrant: async () => previewExtensionsState(),
    commands: async () => [],
    invoke: async () => ({ ok: false, error: { code: 'unavailable' as const, message: 'Extension actions are unavailable in preview mode.' } }),
    loadView: async (extensionId, viewId, context) => ({ extensionId, viewId, title: 'Preview view', kind: 'list' as const, context, rows: [], actions: [] }),
    closeWebView: async () => undefined,
    approve: async () => ({ ok: false, error: { code: 'unavailable' as const, message: 'Extension actions are unavailable in preview mode.' } }),
    deny: async () => undefined,
    onChanged: () => () => undefined,
    onBrowserFocus: () => () => undefined,
  },
  home: {
    state: async () => previewHomeState(),
    createNote: async () => previewHomeState(),
    updateNote: async () => previewHomeState(),
    deleteNote: async () => previewHomeState(),
    searchNotes: async () => [],
    captureScreen: async () => ({ captureId: 'preview-capture', width: 0, height: 0, displayLabel: '0×0', data: '' }),
    captureArea: async () => null,
    readCapture: async () => null,
    deleteCapture: async () => previewHomeState(),
    attachCapture: async () => previewHomeState(),
    ensureChat: async (context) => ({
      chatId: 'preview-chat',
      title: 'Personal chat',
      context,
      workDir: '/preview/nd-home/chats/preview-chat/work',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
    bindChat: async (chatId, sessionId) => ({
      chatId,
      sessionId,
      title: 'Personal chat',
      context: { kind: 'personal' as const },
      workDir: `/preview/nd-home/chats/${chatId}/work`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
    setChatTitle: async () => previewHomeState(),
    saveLink: async () => previewHomeState(),
    removeLink: async () => previewHomeState(),
    revealStorage: async () => undefined,
    onChanged: () => () => undefined,
  },
  browserCompanion: {
    state: async () => browserCompanion,    acquireLease: async (connectionId, tabId, ownerId, scope) => {
      const lease: BrowserTabLease = { id: `preview-lease-${tabId}`, connectionId, tabId, ownerId, ...(scope ? { scope } : {}), acquiredAt: Date.now() }
      browserCompanion = { ...browserCompanion, leases: [...browserCompanion.leases, lease] }
      browserCompanionEvents.emit(browserCompanion)
      return lease
    },
    releaseLease: async (leaseId) => {
      const leases = browserCompanion.leases.filter((lease) => lease.id !== leaseId)
      const released = leases.length !== browserCompanion.leases.length
      browserCompanion = { ...browserCompanion, leases }
      browserCompanionEvents.emit(browserCompanion)
      return released
    },
    onChanged: browserCompanionEvents.on,
  },
  browserPlatform: {
    state: async () => browserPlatform,
    select: async (selection) => {
      browserPlatform = { ...browserPlatform, selection }
      browserPlatformEvents.emit(browserPlatform)
      return browserPlatform
    },
    createTab: async (targetId = 'builtin', url = 'about:blank') => {
      const tab: BrowserTabDescriptor = {
        id: `preview-tab-${Date.now()}`,
        targetId,
        profileId: targetId === 'builtin' ? 'builtin:default' : 'companion-profile:preview-connection',
        title: 'Browser',
        url,
        active: true,
        visible: targetId === 'builtin' ? browser.visible : true,
      }
      if (targetId === 'builtin') {
        previewBuiltinTabs = previewBuiltinTabs.map((item) => ({ ...item, active: false, visible: false })).concat(tab)
        browser = { ...browser, activeTabId: tab.id, tabs: previewBuiltinTabs, url, title: 'Browser' }
        browserEvents.emit(browser)
      }
      browserPlatform = { ...browserPlatform, tabs: [...browserPlatform.tabs.filter((item) => item.targetId !== targetId || targetId !== 'builtin'), ...(targetId === 'builtin' ? previewBuiltinTabs : [tab])] }
      browserPlatformEvents.emit(browserPlatform)
      return tab
    },
    activateTab: async (targetId, tabId) => {
      const tab = browserPlatform.tabs.find((item) => item.targetId === targetId && item.id === tabId)
      if (!tab) throw new Error('Preview browser tab not found')
      if (targetId === 'builtin') {
        previewBuiltinTabs = previewBuiltinTabs.map((item) => ({ ...item, active: item.id === tabId, visible: item.id === tabId && browser.visible }))
        const active = previewBuiltinTabs.find((item) => item.id === tabId)!
        browser = { ...browser, activeTabId: tabId, tabs: previewBuiltinTabs, url: active.url, title: active.title }
        browserEvents.emit(browser)
      }
      browserPlatform = { ...browserPlatform, selection: { mode: 'tab', targetId, tabId }, tabs: browserPlatform.tabs.map((item) => item.targetId === targetId ? { ...item, active: item.id === tabId } : item) }
      browserPlatformEvents.emit(browserPlatform)
      return { ...tab, active: true }
    },
    closeTab: async (targetId, tabId) => {
      browserPlatform = { ...browserPlatform, tabs: browserPlatform.tabs.filter((item) => !(item.targetId === targetId && item.id === tabId)) }
      if (targetId === 'builtin') {
        previewBuiltinTabs = previewBuiltinTabs.filter((item) => item.id !== tabId)
        if (!previewBuiltinTabs.length) {
          previewBuiltinTabs = [{ id: `preview-tab-${Date.now()}`, targetId: 'builtin', profileId: 'builtin:default', title: 'Browser', url: 'about:blank', active: true, visible: browser.visible }]
        }
        const active = previewBuiltinTabs.find((item) => item.active) ?? previewBuiltinTabs[0]!
        previewBuiltinTabs = previewBuiltinTabs.map((item) => ({ ...item, active: item.id === active.id }))
        browser = { ...browser, activeTabId: active.id, tabs: previewBuiltinTabs, url: active.url, title: active.title }
        browserEvents.emit(browser)
      }
      browserPlatformEvents.emit(browserPlatform)
      return true
    },
    history: async () => [],
    clearBrowserData: async () => undefined,
    cancelDownload: async () => false,
    openDownload: async () => false,
    revealDownload: async () => false,
    installExtension: async () => null,
    setExtensionEnabled: async () => browserPlatform.extensions,
    removeExtension: async () => browserPlatform.extensions,
    reloadExtensions: async () => browserPlatform.extensions,
    setDeveloperMode: async (enabled) => {
      browserPlatform = { ...browserPlatform, developerMode: enabled }
      browserPlatformEvents.emit(browserPlatform)
      return browserPlatform
    },
    setBrowserUseEnabled: async (enabled) => {
      browserPlatform = { ...browserPlatform, browserUseEnabled: enabled }
      browserPlatformEvents.emit(browserPlatform)
      return browserPlatform
    },
    installCatalogExtension: async () => null,
    openCatalogExtension: async (catalogId) => {
      const item = browserPlatform.extensionCatalog.find((candidate) => candidate.id === catalogId)
      if (!item) throw new Error('Preview browser extension catalog item not found')
      if (!item.storeUrl) throw new Error('This built-in extension does not have an external catalog listing')
      return desktopApi.browserPlatform.createTab('builtin', item.storeUrl)
    },
    showExtensionPopup: async (extensionId) => {
      browserPlatform = { ...browserPlatform, extensionPopupId: extensionId }
      browserPlatformEvents.emit(browserPlatform)
      return browserPlatform
    },
    closeExtensionPopup: async () => {
      browserPlatform = { ...browserPlatform, extensionPopupId: undefined }
      browserPlatformEvents.emit(browserPlatform)
      return browserPlatform
    },
    saveCredential: async (input) => {
      const record = { id: `preview-credential-${Date.now()}`, origin: new URL(input.origin).origin, username: input.username, ...(input.label ? { label: input.label } : {}), createdAt: Date.now(), updatedAt: Date.now() }
      browserPlatform = { ...browserPlatform, credentials: [record, ...browserPlatform.credentials] }
      browserPlatformEvents.emit(browserPlatform)
      return record
    },
    removeCredential: async (credentialId) => {
      const next = browserPlatform.credentials.filter((item) => item.id !== credentialId)
      const removed = next.length !== browserPlatform.credentials.length
      browserPlatform = { ...browserPlatform, credentials: next }
      browserPlatformEvents.emit(browserPlatform)
      return removed
    },
    autofillCredential: async (credentialId) => {
      const credential = browserPlatform.credentials.find((item) => item.id === credentialId)
      if (!credential) throw new Error('Preview credential not found')
      return { ok: true, credentialId, username: credential.username }
    },
    siteTools: async () => [{
      name: 'preview.echo',
      title: 'Preview echo',
      description: 'UI-preview WebMCP fixture.',
      inputSchema: { type: 'object' },
      origin: 'http://localhost:3000',
      annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true },
    }],
    setSitePermission: async (origin, permission, effect) => {
      const record = { origin: new URL(origin).origin, permission, effect, updatedAt: Date.now() }
      browserPlatform = { ...browserPlatform, sitePermissions: [record, ...browserPlatform.sitePermissions.filter((item) => item.origin !== record.origin || item.permission !== permission)] }
      browserPlatformEvents.emit(browserPlatform)
      return record
    },
    resolveApproval: async () => true,
    clearFinishedDownloads: async () => 0,
    onChanged: browserPlatformEvents.on,
  },
  workspace: {
    state: async () => workspace,
    pick: async () => workspace,
    pickPath: async () => null,
    setRoot: async (root) => { workspace = { ...workspace, root, name: root.split(/[\\/]/).at(-1) || 'workspace' }; workspaceEvents.emit(workspace); return workspace },
    list: async (path = '.') => path === '.' ? [
      { name: 'src', relativePath: 'src', kind: 'directory' },
      { name: 'docs', relativePath: 'docs', kind: 'directory' },
      { name: 'package.json', relativePath: 'package.json', kind: 'file' },
      { name: 'README.md', relativePath: 'README.md', kind: 'file' },
    ] : path === 'src' ? [
      { name: 'App.tsx', relativePath: 'src/App.tsx', kind: 'file' },
      { name: 'components', relativePath: 'src/components', kind: 'directory' },
      { name: 'styles', relativePath: 'src/styles', kind: 'directory' },
    ] : [],
    read: async (relativePath) => ({ relativePath, truncated: false, content: previewFile(relativePath) }),
    suggest: async (query) => ['src/App.tsx', 'src/components/AgentCard.tsx', 'src/styles/theme.css'].filter((path) => path.toLowerCase().includes(query.toLowerCase())).map((relativePath) => ({ relativePath, kind: 'file' as const })),
    onState: workspaceEvents.on,
    registry: async () => ({ version: 1, activeId: 'preview-workspace', items: [{ id: 'preview-workspace', root: workspace.root, name: workspace.name, addedAt: now - 86_400_000, lastOpenedAt: now }] }),
    addSaved: async () => ({ version: 1, activeId: 'preview-workspace', items: [{ id: 'preview-workspace', root: workspace.root, name: workspace.name, addedAt: now - 86_400_000, lastOpenedAt: now }] }),
    removeSaved: async () => ({ version: 1, items: [] }),
    openSaved: async () => ({ state: workspace, registry: { version: 1, activeId: 'preview-workspace', items: [{ id: 'preview-workspace', root: workspace.root, name: workspace.name, addedAt: now - 86_400_000, lastOpenedAt: now }] } }),
  },
  harness: {
    status: async () => harness,
    run: async (_prompt, options) => {
      const sessionId = options?.sessionId ?? 'preview-session'
      dshEvents.emit({ kind: 'session-event', sessionId, event: { type: 'assistant/message', seq: Date.now(), time: Date.now(), data: { message: { content: 'UI preview only — launch Electron to execute this request.' } } } })
      return { sessionId }
    },
    stop: async () => harness,
    stopSession: async () => undefined,
    getPermissionMode: async () => 'ask',
    setPermissionMode: async (mode) => mode,
    onStatus: harnessEvents.on,
  },
  dsh: {
    rpc: async (method) => gatewayPreview(method),
    respond: async () => undefined,
    onEvent: dshEvents.on,
  },
  surface: {
    state: async () => ({ surface: 'workbench', view: { ready: false, loading: false, title: 'UI preview', visible: false } }),
    set: async (surface) => ({ surface, view: { ready: false, loading: false, title: 'UI preview', visible: false } }),
    onChanged: () => () => undefined,
  },
  workspaceProfile: {
    get: async () => workspaceProfile,
    set: async (profile) => { workspaceProfile = profile; return workspaceProfile },
  },
  dshView: {
    setBounds: async () => undefined,
    setVisible: async () => undefined,
    reload: async () => undefined,
    onState: () => () => undefined,
  },
  theme: {
    state: async () => theme,
    set: async (mode) => {
      const effective = mode === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : mode
      theme = { mode, effective }
      themeEvents.emit(theme)
      return theme
    },
    onChanged: themeEvents.on,
  },
  git: {
    connectGitHub: async () => { throw new Error('GitHub OAuth is available in the desktop app.') },
    configureRemote: async (_root, name) => { git = { ...git, remotes: [...new Set([...git.remotes, name])] }; gitEvents.emit(git); return git },
    state: async () => git,
    refresh: async () => git,
    stage: async (paths) => { git = moveGit(paths, 'staged'); gitEvents.emit(git); return git },
    unstage: async (paths) => { git = moveGit(paths, 'unstaged'); gitEvents.emit(git); return git },
    discard: async (paths) => { git = { ...git, unstaged: git.unstaged.filter((item) => !paths.includes(item.path)), untracked: git.untracked.filter((item) => !paths.includes(item.path)), timestamp: Date.now() }; gitEvents.emit(git); return git },
    commit: async () => { git = { ...git, staged: [], ahead: git.ahead + 1, timestamp: Date.now() }; gitEvents.emit(git); return git },
    diff: async (path, staged) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,4 @@\n export function View() {\n+  // UI preview change\n   return <main />\n }\n${staged ? '' : ''}`,
    checkout: async (branch) => { git = { ...git, branch, branches: git.branches.map((item) => ({ ...item, current: item.name === branch })) }; gitEvents.emit(git); return git },
    createBranch: async (branch) => { git = { ...git, branch, branches: [{ name: branch, current: true }, ...git.branches.map((item) => ({ ...item, current: false }))] }; gitEvents.emit(git); return git },
    push: async () => { git = { ...git, ahead: 0 }; gitEvents.emit(git); return git },
    pull: async () => git,
    fetch: async () => git,
    onState: gitEvents.on,
  },
  qa: {
    state: async () => qa,
    run: async (suite) => { qa = { ...qa, activeRun: null, suites: qa.suites.map((item) => item.id === suite ? { ...item, status: 'passed', lastExitCode: 0, lastDurationMs: 1240, lastFinishedAt: Date.now() } : item) }; qaEvents.emit(qa); return qa },
    stop: async () => qa,
    onState: qaEvents.on,
    onOutput: () => () => undefined,
  },
  chatGptWeb: {
    getProjectBinding: async () => null,
    setProjectBinding: async (workspaceRoot, input) => ({
      workspaceRoot,
      projectName: 'Preview Project',
      chatGptProjectRef: input.trim(),
      chatGptProjectId: input.trim(),
      chatGptProjectUrl: `https://chatgpt.com/g/${input.trim()}/project`,
      source: 'manual',
      updatedAt: Date.now(),
    }),
    clearProjectBinding: async () => undefined,
  },
  window: {
    setFloatMode: async () => ({ float: false }),
    resizeFloatWindow: async () => undefined,
    moveFloatWindow: async () => undefined,
    setCaptureOverlay: async () => ({ width: window.innerWidth, height: window.innerHeight }),
    onFloatMode: () => () => undefined,
  },
}

const designApi: DesignDesktopApi = {
  state: async () => designProject,
  refresh: async () => designProject,
  previewHtml: async () => designProject.preview!,
  startDevPreview: async () => designProject.preview!,
  stopPreview: async () => undefined,
  freeformState: async () => freeform,
  freeformInitialize: async () => freeform,
  freeformSetup: async () => freeform,
  freeformSetBounds: async () => undefined,
  freeformSetVisible: async (visible) => { freeform = { ...freeform, visible }; freeformEvents.emit(freeform); return freeform },
  freeformOpen: async (path) => { freeform = { ...freeform, status: 'ready', available: true, documentPath: path, documentName: previewDocumentName(path), visible: true }; freeformEvents.emit(freeform); return freeform },
  freeformCreate: async (path) => { freeform = { ...freeform, status: 'ready', available: true, documentPath: path, documentName: previewDocumentName(path), visible: true, dirty: true }; freeformEvents.emit(freeform); return freeform },
  freeformSave: async () => { freeform = { ...freeform, dirty: false }; freeformEvents.emit(freeform); return freeform },
  freeformClose: async () => { const { documentPath: _closedPath, documentName: _closedName, ...openFreeform } = freeform; freeform = { ...openFreeform, visible: false, dirty: false }; freeformEvents.emit(freeform); return freeform },
  onFreeformState: freeformEvents.on,
}

const organizationApi: OrganizationDesktopApi = {
  state: async () => organization,
  mutate: async (mutation) => mutateOrganization(mutation),
  planProject: async (projectId) => ({ runId: 'preview-plan', sessionId: 'preview-session', projectId, kind: 'pm-plan' }),
  runTask: async (taskId) => ({ runId: 'preview-task', sessionId: 'preview-session', projectId: organization.activeProjectId!, taskId, kind: 'task-execution' }),
  reviewTask: async (taskId) => ({ runId: 'preview-review', sessionId: 'preview-session', projectId: organization.activeProjectId!, taskId, kind: 'task-review' }),
  runNext: async (projectId) => ({ runId: 'preview-next', sessionId: 'preview-session', projectId: projectId ?? organization.activeProjectId!, kind: 'task-execution' }),
  cancelRun: async (runId) => {
    organization = {
      ...organization,
      runs: organization.runs.map((run) => run.id === runId ? { ...run, status: 'failed', error: 'Canceled in UI preview.', completedAt: Date.now() } : run),
    }
    organizationEvents.emit(organization)
  },
  onChanged: organizationEvents.on,
  projectRuntime: async (projectId) => ({ projectId, state: 'ready', targetUrl: 'http://localhost:3000/', port: 3000, checkedAt: now }),
  startProjectRuntime: async (projectId) => ({ projectId, state: 'starting', targetUrl: 'http://localhost:3000/', port: 3000 }),
  stopProjectRuntime: async (projectId) => ({ projectId, state: 'stopped', targetUrl: 'http://localhost:3000/', port: 3000 }),
  onRuntimeChanged: () => () => undefined,
}

const workflowPluginsApi: WorkflowPluginsDesktopApi = {
  list: async () => ({ version: 1, plugins: [], bindings: [], snapshots: [] }),
  install: async () => ({ version: 1, plugins: [], bindings: [], snapshots: [] }),
  remove: async () => ({ version: 1, plugins: [], bindings: [], snapshots: [] }),
  detect: async () => [],
  enable: async () => ({ version: 1, plugins: [], bindings: [], snapshots: [] }),
  disable: async () => ({ version: 1, plugins: [], bindings: [], snapshots: [] }),
  refresh: async () => ({ version: 1, plugins: [], bindings: [], snapshots: [] }),
  snapshot: async () => ({}),
  onChanged: () => () => undefined,
}

export function installDevelopmentUiPreview(): void {
  window.ndDsh = desktopApi
  window.ndDshDesign = designApi
  window.ndDshOrganization = organizationApi
  window.ndDshWorkflowPlugins = workflowPluginsApi
  window.ndDshRuntimeMode = 'ui-preview'
}

function gatewayPreview(method: string) {
  if (method === 'session.list') return Promise.resolve({ ok: true, value: { items: [{ sessionId: 'preview-session', updatedAt: now, running: false, blank: false, cwd: workspace.root, agentPreset: 'nd-dsh' }] } })
  if (method === 'session.history') return Promise.resolve({ ok: true, value: { events: sessionHistory } })
  if (method === 'session.create') return Promise.resolve({ ok: true, value: { sessionId: `preview-${Date.now()}` } })
  if (method === 'session.models') return Promise.resolve({ ok: true, value: { current: { provider: 'openai-prod', model: 'gpt-5.6', reasoningEffort: 'high' }, routable: true, groups: [{ id: 'openai-prod', name: 'OpenAI', models: [{ id: 'gpt-5.6', name: 'GPT-5.6', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }] }], failures: [] } })
  if (method === 'skill.list') return Promise.resolve({ ok: true, value: { skills: [{ name: 'live-browser', description: 'Inspect and verify the visible application.' }, { name: 'product-review', description: 'Review product changes against acceptance criteria.' }] } })
  if (method === 'agentPreset.list') return Promise.resolve({ ok: true, value: { presets: [{ id: 'nd-dsh', name: 'ND-DSH', description: 'Full product delivery agent', trust: 'user', isDefault: true }, { id: 'code', name: 'Code', description: 'Plan, tool, check coding mode', trust: 'system' }, { id: 'cordis', name: 'Creator', description: 'Create and refine agent presets', trust: 'system', blocked: true, blockedReason: 'Creator mode (cordis) is unavailable in this build: its tool schemas trip a model-provider route defect (HTTP 502).' }] } })
  return Promise.resolve({ ok: true, value: {} })
}

function previewFile(path: string): string {
  if (path.endsWith('.json')) return '{\n  "name": "nd-product",\n  "private": true,\n  "scripts": { "dev": "vite" }\n}\n'
  if (path.endsWith('.md')) return '# Agent Console\n\nAI company control plane and coding workbench.\n'
  return `export function App() {\n  return <main className="agent-console">Agent Console</main>\n}\n`
}

function moveGit(paths: string[], target: 'staged' | 'unstaged'): GitStatusSnapshot {
  const all = [...git.staged, ...git.unstaged, ...git.untracked]
  const moved = all.filter((item) => paths.includes(item.path)).map((item) => target === 'staged' ? { ...item, x: item.x === '?' ? 'A' : 'M', y: ' ' } : { ...item, x: ' ', y: 'M' })
  const remaining = all.filter((item) => !paths.includes(item.path))
  return { ...git, staged: target === 'staged' ? [...git.staged.filter((item) => !paths.includes(item.path)), ...moved] : remaining.filter((item) => item.x !== ' ' && item.x !== '?'), unstaged: target === 'unstaged' ? [...git.unstaged.filter((item) => !paths.includes(item.path)), ...moved] : remaining.filter((item) => item.x === ' '), untracked: remaining.filter((item) => item.x === '?'), timestamp: Date.now() }
}

function previewDocumentName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path
}

function mutateOrganization(mutation: OrganizationMutation): OrganizationSnapshot {
  const id = `${mutation.type.replace('.', '-')}-${Date.now()}`
  if (mutation.type === 'company.create') {
    const company = { id, name: mutation.name, mission: mutation.mission, autonomyLevel: 0 as const, status: 'active' as const, createdAt: Date.now(), updatedAt: Date.now() }
    const { activeProjectId: _clearedProjectId, ...withoutActiveProject } = organization
    organization = { ...withoutActiveProject, activeCompanyId: id, companies: [...organization.companies, company] }
  } else if (mutation.type === 'company.activate') organization = { ...organization, activeCompanyId: mutation.id }
  else if (mutation.type === 'company.update') organization = { ...organization, companies: organization.companies.map((item) => item.id === mutation.id ? { ...item, ...mutation.patch, updatedAt: Date.now() } : item) }
  else if (mutation.type === 'project.create') {
    const project = { id, companyId: mutation.companyId, name: mutation.name, objective: mutation.objective, status: 'planning' as const, ...(mutation.workspacePath ? { workspacePath: mutation.workspacePath } : {}), repoUrls: mutation.repoUrls ?? [], teamIds: [], progress: 0, createdAt: Date.now(), updatedAt: Date.now() }
    organization = { ...organization, activeProjectId: id, projects: [...organization.projects, project] }
  } else if (mutation.type === 'project.activate') organization = { ...organization, activeProjectId: mutation.id }
  else if (mutation.type === 'project.update') organization = { ...organization, projects: organization.projects.map((item) => item.id === mutation.id ? { ...item, ...mutation.patch, updatedAt: Date.now() } : item) }
  else if (mutation.type === 'task.create') organization = { ...organization, tasks: [...organization.tasks, { id, companyId: mutation.companyId, projectId: mutation.projectId, ...(mutation.goalId ? { goalId: mutation.goalId } : {}), ...(mutation.milestoneId ? { milestoneId: mutation.milestoneId } : {}), title: mutation.title, description: mutation.description, acceptanceCriteria: mutation.acceptanceCriteria ?? [], priority: mutation.priority ?? 'medium', status: 'backlog', dependsOn: mutation.dependsOn ?? [], ...(mutation.assignedAgentId ? { assignedAgentId: mutation.assignedAgentId } : {}), ...(mutation.assignedMemberId ? { assignedMemberId: mutation.assignedMemberId } : {}), assigneeKind: mutation.assigneeKind ?? (mutation.assignedMemberId ? 'human' : 'agent'), createdAt: Date.now(), updatedAt: Date.now() }] }
  else if (mutation.type === 'task.update') organization = { ...organization, tasks: organization.tasks.map((item) => item.id === mutation.id ? { ...item, ...mutation.patch, updatedAt: Date.now() } : item) }
  else if (mutation.type === 'role.update') organization = { ...organization, roles: organization.roles.map((item) => item.id === mutation.id ? { ...item, ...mutation.patch } : item) }
  else if (mutation.type === 'agent.update') organization = { ...organization, agents: organization.agents.map((item) => item.id === mutation.id ? { ...item, ...mutation.patch } : item) }
  else if (mutation.type === 'memory.add') organization = { ...organization, memory: [...organization.memory, { id, companyId: mutation.companyId, ...(mutation.projectId ? { projectId: mutation.projectId } : {}), title: mutation.title, content: mutation.content, tags: mutation.tags ?? [], source: 'human', createdAt: Date.now(), updatedAt: Date.now() }] }
  else if (mutation.type === 'policy.set') organization = { ...organization, policies: [...organization.policies.filter((item) => item.companyId !== mutation.companyId || item.action !== mutation.action), { id, companyId: mutation.companyId, action: mutation.action, effect: mutation.effect, description: mutation.description ?? '' }] }
  organizationEvents.emit(organization)
  return organization
}

function previewExtensionsState() {
  return { packages: [], activations: [], grants: [], audit: [], pendingApprovals: [] }
}

function previewHomeState() {
  return {
    storageRoot: '/preview/nd-home',
    notes: [],
    captures: [],
    chats: [],
    links: [],
  }
}
