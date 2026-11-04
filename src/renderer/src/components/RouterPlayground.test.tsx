import type { ReactElement, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPlatformState } from '../../../shared/browser-platform'
import type { RouterState } from '../../../shared/router'

const hooks = vi.hoisted(() => ({
  stack: [] as string[],
  local: new Map<string, number>(),
  store: new Map<string, unknown>(),
  mounted: new Set<string>(),
  effects: new Map<string, () => void>(),
  generation: 1,
  slot(instance: string, allocate = true): { key: string; index: number } {
    const index = this.local.get(instance) ?? 0
    if (allocate) this.local.set(instance, index + 1)
    return { key: `${this.generation}:${instance}:${index}`, index }
  },
  enter(instance: string): void {
    this.stack.push(instance)
    this.local.set(instance, 0)
  },
  exit(): void {
    this.stack.pop()
  },
  reset(): void {
    this.generation += 1
    this.store.clear()
    this.mounted.clear()
    this.effects.clear()
    this.local.clear()
    this.stack = []
  },
}))

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const { key } = hooks.slot(hooks.stack[hooks.stack.length - 1] ?? 'root')
    if (!hooks.store.has(key)) hooks.store.set(key, typeof initial === 'function' ? (initial as () => unknown)() : initial)
    return [hooks.store.get(key), (next: unknown) => {
      hooks.store.set(key, typeof next === 'function' ? (next as (prev: unknown) => unknown)(hooks.store.get(key)) : next)
    }]
  },
  useRef: (initial: unknown) => {
    const { key } = hooks.slot(hooks.stack[hooks.stack.length - 1] ?? 'root')
    if (!hooks.store.has(key)) hooks.store.set(key, { current: initial })
    return hooks.store.get(key)
  },
  useMemo: (factory: () => unknown) => {
    return factory()
  },
  useEffect: (effect: () => (() => void) | void) => {
    const { key } = hooks.slot(hooks.stack[hooks.stack.length - 1] ?? 'root')
    if (hooks.mounted.has(key)) return
    hooks.mounted.add(key)
    const cleanupFn = effect()
    if (typeof cleanupFn === 'function') hooks.effects.set(key, cleanupFn)
  },
}))

import { detectPlaygroundMention, RouterPlayground } from './RouterPlayground'

type TestElement = ReactElement<Record<string, unknown>>

function elements(node: ReactNode, path = 'root'): TestElement[] {
  if (Array.isArray(node)) return node.flatMap((child, index) => elements(child, `${path}.${index}`))
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const item = node as TestElement
  const type = item.type as unknown
  const identity = typeof item.key === 'string' && item.key ? `${path}@${item.key}` : path
  if (typeof type === 'function') {
    hooks.enter(identity)
    let rendered: ReactNode
    try {
      rendered = (type as (props: Record<string, unknown>) => ReactNode)(item.props)
    } finally {
      hooks.exit()
    }
    return [item, ...elements(rendered, identity)]
  }
  return [item, ...elements(item.props.children as ReactNode, identity)]
}

function render(props: {
  state: RouterState
  onError: (msg: string) => void
  agyState?: import('../../../shared/router').RouterAgyState | null
}): TestElement {
  hooks.enter('root')
  try {
    return RouterPlayground(props) as TestElement
  } finally {
    hooks.exit()
  }
}

function findSelectByAriaLabel(root: ReactNode, label: string): TestElement | undefined {
  return elements(root).find(
    (el) => el.type === 'select' && el.props['aria-label'] === label
  )
}

function getOptions(selectEl: TestElement): Array<{ value: string; label: string }> {
  const children = elements(selectEl.props.children as ReactNode)
  return children
    .filter((el) => el.type === 'option')
    .map((el) => ({
      value: String(el.props.value ?? ''),
      label: Array.isArray(el.props.children) ? el.props.children.join('') : String(el.props.children ?? ''),
    }))
}

describe('RouterPlayground', () => {
  let mockState: RouterState
  let selectProfileMock: ReturnType<typeof vi.fn>
  let browserPlatformState: BrowserPlatformState

  let playgroundListener: ((event: import('../../../shared/router').RouterPlaygroundEvent) => void) | undefined

  beforeEach(() => {
    hooks.reset()
    playgroundListener = undefined

    mockState = {
      providers: [
        {
          id: 'chatgpt-web',
          kind: 'chatgpt-web',
          name: 'ChatGPT Web',
          baseUrl: '',
          models: ['default'],
          isActive: true,
          priority: 1,
          hasSecret: false,
          accounts: [],
        },
        {
          id: 'gemini-web',
          kind: 'gemini-web',
          name: 'Gemini Web',
          baseUrl: '',
          models: ['3.5 Flash-Lite', '3.8 Flash'],
          isActive: true,
          priority: 2,
          hasSecret: false,
          accounts: [],
        },
        {
          id: 'agy-1',
          kind: 'antigravity',
          name: 'Agy1',
          baseUrl: '',
          models: ['gemini-3.8-flash-low'],
          isActive: true,
          priority: 3,
          hasSecret: true,
          accounts: [],
        },
      ],
      combos: [
        {
          id: 'combo-1',
          name: 'web-private',
          strategy: 'priority',
          models: [{ providerId: 'gemini-web', model: '3.8 Flash' }],
          hiddenFromChat: true,
        },
        {
          id: 'combo-2',
          name: 'api-combo',
          strategy: 'priority',
          models: [{ providerId: 'agy-1', model: 'gemini-3.8-flash-low' }],
          hiddenFromChat: false,
        },
      ],
      counters: { requests: 0, ok: 0, failed: 0, lastError: null },
    }

    browserPlatformState = {
      targets: [],
      profiles: [
        {
          id: 'default',
          name: 'Default',
          color: '#4f7cff',
          createdAt: 1,
          updatedAt: 1,
          isDefault: true,
          active: true,
          tabCount: 1,
        },
        {
          id: 'work-profile',
          name: 'Work',
          color: '#12a594',
          createdAt: 2,
          updatedAt: 2,
          isDefault: false,
          active: false,
          tabCount: 0,
        },
      ],
      tabs: [],
      selection: { mode: 'auto' },
      leases: [],
      downloads: [],
      extensions: [],
      extensionCatalog: [],
      browserUseEnabled: true,
      safeModeEnabled: false,
      developerMode: false,
      credentials: [],
      sitePermissions: [],
      approvals: [],
      receipts: [],
    }

    selectProfileMock = vi.fn().mockResolvedValue(browserPlatformState)

    vi.stubGlobal('window', {
      ndDsh: {
        browserPlatform: {
          state: vi.fn().mockResolvedValue(browserPlatformState),
          onChanged: vi.fn().mockReturnValue(() => undefined),
          selectProfile: selectProfileMock,
        },
        skills: {
          catalog: vi.fn().mockResolvedValue({
            scope: 'mock-scope',
            skills: [
              { name: 'frontend-design', description: 'Design frontend UI', selectionId: 'sel-fe' },
              { name: 'git-worktree', description: 'Manage git worktrees', selectionId: 'sel-gw' },
              { name: 'dubbing-speaker-translate', description: 'Translate SRT subtitles, dialogue transcripts, and video captions into natural Khmer', selectionId: 'sel-dst' },
              { name: 'translate', description: 'Language translation: Translate text, documents, transcripts, dialogue, or code comments', selectionId: 'sel-tr' },
            ],
          }),
          detail: vi.fn().mockResolvedValue({
            skill: { name: 'frontend-design', description: 'Design frontend UI', selectionId: 'sel-fe' },
            markdown: 'Follow frontend design guidelines carefully.',
          }),
        },
      },
      ndDshRouter: {
        onPlaygroundEvent: vi.fn().mockImplementation((listener) => {
          playgroundListener = listener
          return () => { playgroundListener = undefined }
        }),
        playgroundStart: vi.fn().mockResolvedValue(undefined),
        playgroundStop: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders provider filter and route select with all options initially', () => {
    const onError = vi.fn()
    const tree = render({ state: mockState, onError })

    const providerSelect = findSelectByAriaLabel(tree, 'Filter provider')
    expect(providerSelect).toBeDefined()
    const providerOptions = getOptions(providerSelect!)
    expect(providerOptions).toEqual([
      { value: 'all', label: 'All providers' },
      { value: 'combos', label: 'Route combos' },
      { value: 'provider:chatgpt-web', label: 'ChatGPT Web · Web' },
      { value: 'provider:gemini-web', label: 'Gemini Web · Web' },
      { value: 'provider:agy-1', label: 'Agy1' },
    ])

    const routeSelect = findSelectByAriaLabel(tree, 'Playground route')
    expect(routeSelect).toBeDefined()
    const routeOptions = getOptions(routeSelect!)
    expect(routeOptions.map((o) => o.value)).toEqual([
      'combo:web-private',
      'combo:api-combo',
      'model:chatgpt-web/default',
      'model:gemini-web/3.5 Flash-Lite',
      'model:gemini-web/3.8 Flash',
      'model:agy-1/gemini-3.8-flash-low',
    ])
  })

  it('renders trae-cli provider models in the route select', () => {
    const onError = vi.fn()
    const stateWithTrae: RouterState = {
      ...mockState,
      providers: [
        ...mockState.providers,
        {
          id: 'trae',
          kind: 'trae-cli',
          name: 'Trae CLI',
          baseUrl: '',
          models: ['default', 'agent', 'ask', 'edit'],
          isActive: true,
          priority: 3,
          hasSecret: false,
          accounts: [],
        },
      ],
    }
    const tree = render({ state: stateWithTrae, onError })
    const routeSelect = findSelectByAriaLabel(tree, 'Playground route')!
    const routeOptions = getOptions(routeSelect)
    expect(routeOptions.some((o) => o.value === 'model:trae/agent')).toBe(true)
    expect(routeOptions.some((o) => o.value === 'model:trae/ask')).toBe(true)
    expect(routeOptions.some((o) => o.value === 'model:trae/edit')).toBe(true)
  })

  it('excludes disabled (isActive: false) providers from provider list and route options', () => {
    const onError = vi.fn()
    const stateWithDisabled: RouterState = {
      ...mockState,
      providers: [
        ...mockState.providers,
        {
          id: 'disabled-provider',
          kind: 'codex-cli',
          name: 'Codex CLI',
          baseUrl: '',
          models: ['o3-mini'],
          isActive: false,
          priority: 4,
          hasSecret: false,
          accounts: [],
        },
      ],
    }
    const tree = render({ state: stateWithDisabled, onError })
    const providerSelect = findSelectByAriaLabel(tree, 'Filter provider')!
    const providerOptions = getOptions(providerSelect)
    expect(providerOptions.some((o) => o.value === 'provider:disabled-provider')).toBe(false)

    const routeSelect = findSelectByAriaLabel(tree, 'Playground route')!
    const routeOptions = getOptions(routeSelect)
    expect(routeOptions.some((o) => o.value.includes('disabled-provider'))).toBe(false)
  })

  it('excludes Antigravity provider when Antigravity lane is disabled', () => {
    const onError = vi.fn()
    const disabledAgy: import('../../../shared/router').RouterAgyState = {
      policy: {
        enabled: false,
        manualApprovalRequired: true,
        maxConcurrentJobs: 1,
        maxJobsPerHour: 2,
        maxJobsPerDay: 10,
        maxTokensPerDay: 200000,
        approvalTtlSecs: 600,
        maxRetries: 0,
        maxTimeoutSecs: 300,
      },
      locked: false,
      lockReason: null,
      window: { startMs: 0, jobs: 0, limit: 2 },
      day: { startMs: 0, jobs: 0, jobsLimit: 10, tokens: 0, tokensLimit: 200000 },
      pendingApprovals: 0,
    }
    const tree = render({ state: mockState, onError, agyState: disabledAgy })
    const providerSelect = findSelectByAriaLabel(tree, 'Filter provider')!
    const providerOptions = getOptions(providerSelect)
    expect(providerOptions.some((o) => o.value === 'provider:agy-1')).toBe(false)

    const routeSelect = findSelectByAriaLabel(tree, 'Playground route')!
    const routeOptions = getOptions(routeSelect)
    expect(routeOptions.some((o) => o.value === 'model:agy-1/gemini-3.8-flash-low')).toBe(false)
  })

  it('excludes Antigravity provider when Antigravity lane is locked', () => {
    const onError = vi.fn()
    const lockedAgy: import('../../../shared/router').RouterAgyState = {
      policy: {
        enabled: true,
        manualApprovalRequired: true,
        maxConcurrentJobs: 1,
        maxJobsPerHour: 2,
        maxJobsPerDay: 10,
        maxTokensPerDay: 200000,
        approvalTtlSecs: 600,
        maxRetries: 0,
        maxTimeoutSecs: 300,
      },
      locked: true,
      lockReason: 'kill switch',
      window: { startMs: 0, jobs: 0, limit: 2 },
      day: { startMs: 0, jobs: 0, jobsLimit: 10, tokens: 0, tokensLimit: 200000 },
      pendingApprovals: 0,
    }
    const tree = render({ state: mockState, onError, agyState: lockedAgy })
    const providerSelect = findSelectByAriaLabel(tree, 'Filter provider')!
    const providerOptions = getOptions(providerSelect)
    expect(providerOptions.some((o) => o.value === 'provider:agy-1')).toBe(false)
  })

  it('includes Antigravity provider when Antigravity lane is enabled and unlocked', () => {
    const onError = vi.fn()
    const enabledAgy: import('../../../shared/router').RouterAgyState = {
      policy: {
        enabled: true,
        manualApprovalRequired: true,
        maxConcurrentJobs: 1,
        maxJobsPerHour: 2,
        maxJobsPerDay: 10,
        maxTokensPerDay: 200000,
        approvalTtlSecs: 600,
        maxRetries: 0,
        maxTimeoutSecs: 300,
      },
      locked: false,
      lockReason: null,
      window: { startMs: 0, jobs: 0, limit: 2 },
      day: { startMs: 0, jobs: 0, jobsLimit: 10, tokens: 0, tokensLimit: 200000 },
      pendingApprovals: 0,
    }
    const tree = render({ state: mockState, onError, agyState: enabledAgy })
    const providerSelect = findSelectByAriaLabel(tree, 'Filter provider')!
    const providerOptions = getOptions(providerSelect)
    expect(providerOptions.some((o) => o.value === 'provider:agy-1')).toBe(true)

    const routeSelect = findSelectByAriaLabel(tree, 'Playground route')!
    const routeOptions = getOptions(routeSelect)
    expect(routeOptions.some((o) => o.value === 'model:agy-1/gemini-3.8-flash-low')).toBe(true)
  })

  it('filters routes when a specific provider is selected', () => {
    const onError = vi.fn()
    let tree = render({ state: mockState, onError })

    const providerSelect = findSelectByAriaLabel(tree, 'Filter provider')!
    ;(providerSelect.props.onChange as (e: unknown) => void)({
      target: { value: 'provider:gemini-web' },
    })

    tree = render({ state: mockState, onError })
    const routeSelect = findSelectByAriaLabel(tree, 'Playground route')!
    const routeOptions = getOptions(routeSelect)
    expect(routeOptions).toEqual([
      { value: 'model:gemini-web/3.5 Flash-Lite', label: '3.5 Flash-Lite' },
      { value: 'model:gemini-web/3.8 Flash', label: '3.8 Flash' },
    ])
  })

  it('filters routes to only combos when Route combos is selected', () => {
    const onError = vi.fn()
    let tree = render({ state: mockState, onError })

    const providerSelect = findSelectByAriaLabel(tree, 'Filter provider')!
    ;(providerSelect.props.onChange as (e: unknown) => void)({
      target: { value: 'combos' },
    })

    tree = render({ state: mockState, onError })
    const routeSelect = findSelectByAriaLabel(tree, 'Playground route')!
    const routeOptions = getOptions(routeSelect)
    expect(routeOptions).toEqual([
      { value: 'combo:web-private', label: 'web-private · Private' },
      { value: 'combo:api-combo', label: 'api-combo' },
    ])
  })

  it('renders browser profile selector for web routes and allows changing profile', async () => {
    const onError = vi.fn()
    let tree = render({ state: mockState, onError })
    await Promise.resolve()
    await Promise.resolve()
    tree = render({ state: mockState, onError })

    // Initially route defaults to combo:web-private (which routes to gemini-web, so web-related)
    let profileSelect = findSelectByAriaLabel(tree, 'Browser profile')
    expect(profileSelect).toBeDefined()
    const profileOptions = getOptions(profileSelect!)
    expect(profileOptions).toEqual([
      { value: 'default', label: 'Default (Default)' },
      { value: 'work-profile', label: 'Work' },
    ])

    // Change profile
    await (profileSelect!.props.onChange as (e: unknown) => Promise<void>)({
      target: { value: 'work-profile' },
    })
    expect(selectProfileMock).toHaveBeenCalledWith('work-profile')

    // Switch provider filter to non-web provider: agy-1
    const providerSelect = findSelectByAriaLabel(tree, 'Filter provider')!
    ;(providerSelect.props.onChange as (e: unknown) => void)({
      target: { value: 'provider:agy-1' },
    })

    tree = render({ state: mockState, onError })
    profileSelect = findSelectByAriaLabel(tree, 'Browser profile')
    expect(profileSelect).toBeUndefined()
  })

  it('shows browser profile selector when individual web model is selected under All providers', async () => {
    const onError = vi.fn()
    let tree = render({ state: mockState, onError })
    await Promise.resolve()
    await Promise.resolve()
    tree = render({ state: mockState, onError })

    // Select non-web combo first
    const routeSelect = findSelectByAriaLabel(tree, 'Playground route')!
    ;(routeSelect.props.onChange as (e: unknown) => void)({
      target: { value: 'combo:api-combo' },
    })

    tree = render({ state: mockState, onError })
    let profileSelect = findSelectByAriaLabel(tree, 'Browser profile')
    expect(profileSelect).toBeUndefined()

    // Switch to web model under All providers
    ;(routeSelect.props.onChange as (e: unknown) => void)({
      target: { value: 'model:chatgpt-web/default' },
    })

    tree = render({ state: mockState, onError })
    profileSelect = findSelectByAriaLabel(tree, 'Browser profile')
    expect(profileSelect).toBeDefined()
  })

  it('supports preview and raw view modes like ND chat', async () => {
    const onError = vi.fn()
    let tree = render({ state: mockState, onError })

    // Check preview and raw mode toggle buttons exist
    const previewBtn = elements(tree).find((el) => el.type === 'button' && el.props['aria-label'] === 'Preview mode')
    const rawBtn = elements(tree).find((el) => el.type === 'button' && el.props['aria-label'] === 'Raw mode')
    expect(previewBtn).toBeDefined()
    expect(rawBtn).toBeDefined()

    // Send a message
    const textarea = elements(tree).find((el) => el.type === 'textarea')!
    ;(textarea.props.onChange as (e: unknown) => void)({
      target: { value: 'Hello assistant' },
    })
    tree = render({ state: mockState, onError })
    const sendBtn = elements(tree).find((el) => el.type === 'button' && (el.props['aria-label'] === 'Send prompt' || el.props.children === 'Send'))!
    await (sendBtn.props.onClick as () => Promise<void>)()

    // Deliver assistant response with reasoning and markdown
    const startCall = vi.mocked(window.ndDshRouter.playgroundStart).mock.calls[0]?.[0]
    expect(startCall).toBeDefined()
    expect(playgroundListener).toBeDefined()

    playgroundListener!({
      requestId: startCall!.requestId,
      type: 'done',
      text: '<think>Let me reason</think>\n\n### Formatted Answer\n\nHere is code:\n```js\nconsole.log(42)\n```',
    })

    // Re-render in Preview mode (default)
    tree = render({ state: mockState, onError })

    // Check that user message bubble is rendered
    const userText = elements(tree).find((el) => el.props.className?.toString().includes('bg-info/'))
    expect(userText).toBeDefined()

    // Check that assistant turn renders reasoning block and markdown
    const reasoningNode = elements(tree).find((el) => el.props.children === 'Reasoning' || el.props.children === 'Thinking')
    expect(reasoningNode).toBeDefined()

    // Switch to Raw mode
    const currentRawBtn = elements(tree).find((el) => el.type === 'button' && el.props['aria-label'] === 'Raw mode')!
    ;(currentRawBtn.props.onClick as () => void)()
    tree = render({ state: mockState, onError })

    // In raw mode, raw monospace text is shown with original tags
    const rawSpan = elements(tree).find((el) =>
      typeof el.props.children === 'string' && el.props.children.includes('<think>Let me reason</think>')
    )
    expect(rawSpan).toBeDefined()

    // Switch back to Preview mode
    const currentPreviewBtn = elements(tree).find((el) => el.type === 'button' && el.props['aria-label'] === 'Preview mode')!
    ;(currentPreviewBtn.props.onClick as () => void)()
    tree = render({ state: mockState, onError })
    const reasoningNodeAgain = elements(tree).find((el) => el.props.children === 'Reasoning' || el.props.children === 'Thinking')
    expect(reasoningNodeAgain).toBeDefined()
  })

  it('renders process logs drawer button near clear button and toggles logs drawer', async () => {
    const onError = vi.fn()
    let tree = render({ state: mockState, onError })

    // Find the Logs toggle button
    const logsBtn = elements(tree).find((el) => el.type === 'button' && el.props['aria-label'] === 'Toggle process logs drawer')
    expect(logsBtn).toBeDefined()
    expect(logsBtn!.props['aria-pressed']).toBe(false)

    // Clear button also exists near it
    const clearBtn = elements(tree).find((el) => el.type === 'button' && el.props['aria-label'] === 'Clear conversation')
    expect(clearBtn).toBeDefined()

    // Click logs button to open drawer
    ;(logsBtn!.props.onClick as () => void)()
    tree = render({ state: mockState, onError })

    const updatedLogsBtn = elements(tree).find((el) => el.type === 'button' && el.props['aria-label'] === 'Toggle process logs drawer')
    expect(updatedLogsBtn!.props['aria-pressed']).toBe(true)

    // Check that drawer is rendered
    const drawer = elements(tree).find((el) => el.type === 'aside' && el.props['aria-label'] === 'Process logs drawer')
    expect(drawer).toBeDefined()
  })

  it('supports injecting ND skills into the prompt and removes system prompt input', async () => {
    const onError = vi.fn()
    let tree = render({ state: mockState, onError })

    // Verify there is no separate system instruction input
    const systemInput = elements(tree).find((el) => el.props['aria-label'] === 'Playground system instruction')
    expect(systemInput).toBeUndefined()

    // Verify the Skills button exists
    const skillsBtn = elements(tree).find((el) => el.type === 'button' && el.props['aria-label'] === 'Inject skill')
    expect(skillsBtn).toBeDefined()

    // Trigger skills button to open picker
    ;(skillsBtn!.props.onClick as () => void)()
    tree = render({ state: mockState, onError })

    // Typing a skill invocation
    const textarea = elements(tree).find((el) => el.type === 'textarea')!
    ;(textarea.props.onChange as (e: unknown) => void)({
      target: { value: '/frontend-design Build a dashboard widget' },
    })
    tree = render({ state: mockState, onError })

    // Send the prompt with the skill
    const sendBtn = elements(tree).find((el) => el.type === 'button' && el.props['aria-label'] === 'Send prompt')!
    await (sendBtn.props.onClick as () => Promise<void>)()

    // Verify playgroundStart was called with the injected skill instructions
    const startCalls = vi.mocked(window.ndDshRouter.playgroundStart).mock.calls
    const lastStartCall = startCalls[startCalls.length - 1]?.[0]
    expect(lastStartCall).toBeDefined()
    const lastMessage = lastStartCall!.messages[lastStartCall!.messages.length - 1]
    expect(lastMessage).toBeDefined()
    expect(lastMessage!.role).toBe('user')
    expect(lastMessage!.content).toContain('Follow frontend design guidelines carefully.')
    expect(lastMessage!.content).toContain('Build a dashboard widget')
  })

  it('supports @ skill mentions and injects skill markdown instructions', async () => {
    const onError = vi.fn()
    let tree = render({ state: mockState, onError })
    await Promise.resolve()
    await Promise.resolve()
    tree = render({ state: mockState, onError })

    // Type a prompt containing @frontend-design mention
    const textarea = elements(tree).find((el) => el.type === 'textarea')!
    ;(textarea.props.onChange as (e: unknown) => void)({
      target: { value: 'Create a header with @frontend-design please' },
    })
    tree = render({ state: mockState, onError })

    // Active skill chip should be present
    const activeChip = elements(tree).find((el) => {
      const text = typeof el.props.children === 'string'
        ? el.props.children
        : Array.isArray(el.props.children)
          ? el.props.children.join('')
          : ''
      return text.includes('/frontend-design')
    })
    expect(activeChip).toBeDefined()

    // Send the prompt
    const sendBtn = elements(tree).find((el) => el.type === 'button' && el.props['aria-label'] === 'Send prompt')!
    await (sendBtn.props.onClick as () => Promise<void>)()

    // Verify injected skill instructions
    const startCalls = vi.mocked(window.ndDshRouter.playgroundStart).mock.calls
    const lastStartCall = startCalls[startCalls.length - 1]?.[0]
    expect(lastStartCall).toBeDefined()
    const lastMessage = lastStartCall!.messages[lastStartCall!.messages.length - 1]
    expect(lastMessage!.content).toContain('Follow frontend design guidelines carefully.')
    expect(lastMessage!.content).toContain('Create a header with please')
  })

  it('renders skills mention popup when typing / or @ and handles selection', async () => {
    const onError = vi.fn()
    let tree = render({ state: mockState, onError })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    tree = render({ state: mockState, onError })

    // Typing @
    const textarea = elements(tree).find((el) => el.type === 'textarea')!
    ;(textarea.props.onChange as (e: unknown) => void)({
      target: { value: '@', selectionStart: 1 },
    })
    tree = render({ state: mockState, onError })

    // Popup should show skills with @ prefix
    const popupTitle = elements(tree).find((el) => el.props.children === 'Inject Skill')
    expect(popupTitle).toBeDefined()

    const skillItem = elements(tree).find((el) => {
      const text = typeof el.props.children === 'string'
        ? el.props.children
        : Array.isArray(el.props.children)
          ? el.props.children.join('')
          : ''
      return text.includes('@frontend-design')
    })
    expect(skillItem).toBeDefined()

    // Typing non-matching query
    const currentTextarea = elements(tree).find((el) => el.type === 'textarea')!
    ;(currentTextarea.props.onChange as (e: unknown) => void)({
      target: { value: '@nonexistent', selectionStart: 12 },
    })
    tree = render({ state: mockState, onError })

    const match = elements(tree).find((el) => {
      if (typeof el.props.children === 'string') return el.props.children.includes('No skills found')
      if (Array.isArray(el.props.children)) {
        return el.props.children.some((c) => typeof c === 'string' && c.includes('No skills found'))
      }
      return false
    })
    expect(match).toBeDefined()
  })

  it('clicking the Skills button opens the skills picker dropdown and selecting a skill inserts it', async () => {
    const onError = vi.fn()
    let tree = render({ state: mockState, onError })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    tree = render({ state: mockState, onError })

    // Click Skills button
    const skillsBtn = elements(tree).find((el) => el.type === 'button' && el.props['aria-label'] === 'Inject skill')!
    expect(skillsBtn).toBeDefined()
    ;(skillsBtn.props.onClick as () => void)()

    tree = render({ state: mockState, onError })

    // Mentions popup is visible
    const popupTitle = elements(tree).find((el) => el.props.children === 'Inject Skill')
    expect(popupTitle).toBeDefined()

    // Find and select the frontend-design skill button
    const skillBtn = elements(tree).find((el) => {
      if (el.type !== 'button') return false
      const span = elements(el).find((c) => {
        const text = typeof c.props.children === 'string'
          ? c.props.children
          : Array.isArray(c.props.children)
            ? c.props.children.join('')
            : ''
        return text.includes('/frontend-design')
      })
      return !!span
    })
    expect(skillBtn).toBeDefined()

    // Select the skill
    ;(skillBtn!.props.onMouseDown as (e: { preventDefault: () => void }) => void)({ preventDefault: () => undefined })

    tree = render({ state: mockState, onError })

    // Active skill chip appears
    const activeChip = elements(tree).find((el) => {
      const text = typeof el.props.children === 'string'
        ? el.props.children
        : Array.isArray(el.props.children)
          ? el.props.children.join('')
          : ''
      return text.includes('/frontend-design')
    })
    expect(activeChip).toBeDefined()
  })

  it('filters skills by description keyword such as transcript or translate', async () => {
    const onError = vi.fn()
    let tree = render({ state: mockState, onError })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    tree = render({ state: mockState, onError })

    // Simulate typing /transcript into the composer
    const textarea = elements(tree).find((el) => el.type === 'textarea')!
    expect(textarea).toBeDefined()
    ;(textarea.props.onChange as (e: { target: { value: string; selectionStart: number } }) => void)({
      target: { value: '/transcript', selectionStart: 11 },
    })

    tree = render({ state: mockState, onError })

    // Mentions popup is visible
    const popupTitle = elements(tree).find((el) => el.props.children === 'Inject Skill')
    expect(popupTitle).toBeDefined()

    // Matching skills should include dubbing-speaker-translate and translate
    const matchingBtns = elements(tree).filter((el) => {
      if (el.type !== 'button') return false
      const span = elements(el).find((c) => {
        const text = typeof c.props.children === 'string'
          ? c.props.children
          : Array.isArray(c.props.children)
            ? c.props.children.join('')
            : ''
        return text.includes('/dubbing-speaker-translate') || text.includes('/translate')
      })
      return !!span
    })
    expect(matchingBtns.length).toBe(2)
  })
})

describe('detectPlaygroundMention', () => {
  it('detects slash mentions at start and mid-sentence', () => {
    expect(detectPlaygroundMention('/', 1)).toEqual({
      query: '',
      start: 0,
      end: 1,
      prefix: '/',
    })
    expect(detectPlaygroundMention('/git', 4)).toEqual({
      query: 'git',
      start: 0,
      end: 4,
      prefix: '/',
    })
    expect(detectPlaygroundMention('use /git please', 8)).toEqual({
      query: 'git',
      start: 4,
      end: 8,
      prefix: '/',
    })
  })

  it('detects @ mentions at start and mid-sentence', () => {
    expect(detectPlaygroundMention('@', 1)).toEqual({
      query: '',
      start: 0,
      end: 1,
      prefix: '@',
    })
    expect(detectPlaygroundMention('@frontend', 9)).toEqual({
      query: 'frontend',
      start: 0,
      end: 9,
      prefix: '@',
    })
    expect(detectPlaygroundMention('help with @frontend now', 19)).toEqual({
      query: 'frontend',
      start: 10,
      end: 19,
      prefix: '@',
    })
  })

  it('ignores non-mention text like emails and file paths', () => {
    expect(detectPlaygroundMention('user@domain.com', 10)).toBeNull()
    expect(detectPlaygroundMention('folder/file.ts', 8)).toBeNull()
    expect(detectPlaygroundMention('', 0)).toBeNull()
  })
})
