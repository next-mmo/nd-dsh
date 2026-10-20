import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { CodexAppServerWire, pickDecision, type JsonObject } from '../src/main/engines/codex/codex-wire.js'

interface Harness {
  wire: CodexAppServerWire
  /** Frames the ND side wrote to the app-server. */
  sent: JsonObject[]
  notifications: Array<{ method: string; params: JsonObject }>
  protocolErrors: Error[]
  respondToServer(handler: (method: string, params: JsonObject) => Promise<unknown>): void
  /** Simulate one frame coming from the app-server process. */
  receive(frame: JsonObject): void
}

function setup(options: { onAuthUrl?: (url: string) => Promise<void> } = {}): Harness {
  const input = new PassThrough() // app-server stdout (ND reads)
  const output = new PassThrough() // app-server stdin (ND writes)
  const sent: JsonObject[] = []
  let buffered = ''
  output.on('data', (chunk: string) => {
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (line) sent.push(JSON.parse(line) as JsonObject)
      newline = buffered.indexOf('\n')
    }
  })
  const notifications: Array<{ method: string; params: JsonObject }> = []
  const protocolErrors: Error[] = []
  let serverHandler: (method: string, params: JsonObject) => Promise<unknown> = () => Promise.resolve({})
  const wire = new CodexAppServerWire(input, output, {
    onNotification: (method, params) => notifications.push({ method, params }),
    onServerRequest: (method, params) => serverHandler(method, params),
    onProtocolError: (error) => protocolErrors.push(error),
    ...(options.onAuthUrl ? { onAuthUrl: options.onAuthUrl } : {}),
  })
  return {
    wire,
    sent,
    notifications,
    protocolErrors,
    respondToServer: (handler) => { serverHandler = handler },
    receive: (frame) => input.write(`${JSON.stringify(frame)}\n`),
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function flush(_harness: Harness): Promise<void> {
  await tick()
  await tick()
}

function latestRequest(harness: Harness, method: string): JsonObject {
  const request = [...harness.sent].reverse().find((frame) => frame.method === method)
  if (!request) throw new Error(`Expected ${method} request`)
  return request
}

/** Complete initialize plus the normal already-authenticated account check. */
async function handshake(harness: Harness): Promise<number> {
  const started = harness.wire.start()
  await flush(harness)
  const initializeRequest = harness.sent[0]
  expect(initializeRequest?.method).toBe('initialize')
  const id = initializeRequest?.id as number
  harness.receive({ id, result: {} })
  await flush(harness)
  expect(harness.sent.some((frame) => frame.method === 'initialized')).toBe(true)
  const accountRead = latestRequest(harness, 'account/read')
  expect(accountRead.params).toEqual({})
  harness.receive({
    id: accountRead.id,
    result: {
      account: { type: 'chatgpt', email: 'dev@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    },
  })
  await started
  return id
}

describe('CodexAppServerWire', () => {
  it('loads all visible catalog pages using model slugs rather than entry ids', async () => {
    const harness = setup()
    await handshake(harness)
    const pending = harness.wire.listModels()
    await flush(harness)
    const first = harness.sent.at(-1)!
    expect(first.method).toBe('model/list')
    expect(first.params).toEqual({ limit: 100, includeHidden: false })
    harness.receive({ id: first.id, result: { data: [
      { id: 'catalog-a', model: 'model-a', displayName: 'Model A' },
      { id: 'hidden', model: 'hidden-model', hidden: true },
    ], nextCursor: 'page-2' } })
    await flush(harness)
    const second = harness.sent.at(-1)!
    expect(second.params).toMatchObject({ cursor: 'page-2' })
    harness.receive({ id: second.id, result: { data: [{ id: 'catalog-b', model: 'model-b', displayName: 'Model B' }], nextCursor: null } })
    await expect(pending).resolves.toEqual([{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }])
    harness.wire.close()
  })

  it('forwards the selected model and restores the thread native default', async () => {
    const harness = setup()
    await handshake(harness)
    const started = harness.wire.startThread({ cwd: '/workspace', approvalPolicy: 'never' })
    await flush(harness)
    harness.receive({ id: harness.sent.at(-1)!.id, result: { thread: { id: 'thr-42' }, model: 'native-model' } })
    await started
    for (const model of ['selected-model', undefined]) {
      const turn = harness.wire.startTurn('thr-42', ['hello'], model)
      await flush(harness)
      const request = harness.sent.at(-1)!
      expect(request.params).toMatchObject({ model: model ?? 'native-model' })
      harness.receive({ id: request.id, result: { turn: { id: 'turn-1' } } })
      await turn
    }
    harness.wire.close()
  })

  it('performs the initialize handshake before any authenticated request', async () => {
    const harness = setup()
    await handshake(harness)
    expect(harness.sent[0]?.method).toBe('initialize')
    const params = harness.sent[0]?.params as JsonObject
    expect(params.clientInfo).toEqual({ name: 'nd-dsh', title: 'ND-DSH', version: '0.0.1' })
    const initializedIndex = harness.sent.findIndex((frame) => frame.method === 'initialized')
    const accountReadIndex = harness.sent.findIndex((frame) => frame.method === 'account/read')
    expect(initializedIndex).toBeGreaterThan(0)
    expect(accountReadIndex).toBeGreaterThan(initializedIndex)
    expect(harness.protocolErrors).toHaveLength(0)
    harness.wire.close()
  })

  it('starts official ChatGPT OAuth when Codex has no authenticated account', async () => {
    const opened: string[] = []
    const harness = setup({ onAuthUrl: async (url) => { opened.push(url) } })
    const started = harness.wire.start()
    await flush(harness)

    const initialize = latestRequest(harness, 'initialize')
    harness.receive({ id: initialize.id, result: {} })
    await flush(harness)

    const firstAccountRead = latestRequest(harness, 'account/read')
    expect(firstAccountRead.params).toEqual({})
    harness.receive({ id: firstAccountRead.id, result: { account: null, requiresOpenaiAuth: true } })
    await flush(harness)

    const login = latestRequest(harness, 'account/login/start')
    expect(login.params).toEqual({
      type: 'chatgpt',
      appBrand: 'chatgpt',
      codexStreamlinedLogin: true,
      useHostedLoginSuccessPage: true,
    })
    harness.receive({
      id: login.id,
      result: {
        type: 'chatgpt',
        loginId: 'login-1',
        authUrl: 'https://auth.openai.com/oauth/authorize?client_id=nd-test',
      },
    })
    await flush(harness)
    expect(opened).toEqual(['https://auth.openai.com/oauth/authorize?client_id=nd-test'])

    harness.receive({ method: 'account/login/completed', params: { loginId: 'login-1', success: true } })
    await flush(harness)
    expect(harness.notifications.at(-1)).toEqual({
      method: 'account/login/completed',
      params: { loginId: 'login-1', success: true },
    })

    const accountReads = harness.sent.filter((frame) => frame.method === 'account/read')
    expect(accountReads).toHaveLength(2)
    const secondAccountRead = accountReads[1]!
    expect(secondAccountRead.params).toEqual({})
    harness.receive({
      id: secondAccountRead.id,
      result: {
        account: { type: 'chatgpt', email: 'dev@example.com', planType: 'plus' },
        requiresOpenaiAuth: true,
      },
    })
    await expect(started).resolves.toBeUndefined()
    harness.wire.close()
  })

  it('does not start OAuth when this Codex configuration does not require OpenAI auth', async () => {
    const opened: string[] = []
    const harness = setup({ onAuthUrl: async (url) => { opened.push(url) } })
    const started = harness.wire.start()
    await flush(harness)
    const initialize = latestRequest(harness, 'initialize')
    harness.receive({ id: initialize.id, result: {} })
    await flush(harness)
    const accountRead = latestRequest(harness, 'account/read')
    harness.receive({ id: accountRead.id, result: { account: null, requiresOpenaiAuth: false } })
    await expect(started).resolves.toBeUndefined()
    expect(opened).toEqual([])
    expect(harness.sent.some((frame) => frame.method === 'account/login/start')).toBe(false)
    harness.wire.close()
  })

  it('rejects failed ChatGPT sign-in without attempting an authenticated account read', async () => {
    const harness = setup({ onAuthUrl: async () => {} })
    const started = harness.wire.start()
    await flush(harness)
    const initialize = latestRequest(harness, 'initialize')
    harness.receive({ id: initialize.id, result: {} })
    await flush(harness)
    const accountRead = latestRequest(harness, 'account/read')
    harness.receive({ id: accountRead.id, result: { account: null, requiresOpenaiAuth: true } })
    await flush(harness)
    const login = latestRequest(harness, 'account/login/start')
    harness.receive({ id: login.id, result: { type: 'chatgpt', loginId: 'login-failed', authUrl: 'https://auth.openai.com/oauth/authorize' } })
    await flush(harness)
    harness.receive({ method: 'account/login/completed', params: { loginId: 'login-failed', success: false, error: 'access denied' } })
    await expect(started).rejects.toThrow(/access denied/i)
    expect(harness.sent.filter((frame) => frame.method === 'account/read')).toHaveLength(1)
    harness.wire.close()
  })

  it('rejects a non-HTTPS auth URL and cancels the native login', async () => {
    const opened: string[] = []
    const harness = setup({ onAuthUrl: async (url) => { opened.push(url) } })
    const started = harness.wire.start()
    await flush(harness)
    const initialize = latestRequest(harness, 'initialize')
    harness.receive({ id: initialize.id, result: {} })
    await flush(harness)
    const accountRead = latestRequest(harness, 'account/read')
    harness.receive({ id: accountRead.id, result: { account: null, requiresOpenaiAuth: true } })
    await flush(harness)
    const login = latestRequest(harness, 'account/login/start')
    harness.receive({ id: login.id, result: { type: 'chatgpt', loginId: 'login-insecure', authUrl: 'http://auth.openai.com/oauth/authorize' } })
    await expect(started).rejects.toThrow(/HTTPS/i)
    await flush(harness)
    expect(opened).toEqual([])
    const cancel = latestRequest(harness, 'account/login/cancel')
    expect(cancel.params).toEqual({ loginId: 'login-insecure' })
    harness.receive({ id: cancel.id, result: {} })
    harness.wire.close()
  })

  it('cancels the native login when opening the system browser fails', async () => {
    const harness = setup({ onAuthUrl: async () => { throw new Error('browser unavailable') } })
    const started = harness.wire.start()
    await flush(harness)
    const initialize = latestRequest(harness, 'initialize')
    harness.receive({ id: initialize.id, result: {} })
    await flush(harness)
    const accountRead = latestRequest(harness, 'account/read')
    harness.receive({ id: accountRead.id, result: { account: null, requiresOpenaiAuth: true } })
    await flush(harness)
    const login = latestRequest(harness, 'account/login/start')
    harness.receive({ id: login.id, result: { type: 'chatgpt', loginId: 'login-browser', authUrl: 'https://auth.openai.com/oauth/authorize' } })
    await expect(started).rejects.toThrow(/browser unavailable/i)
    await flush(harness)
    const cancel = latestRequest(harness, 'account/login/cancel')
    expect(cancel.params).toEqual({ loginId: 'login-browser' })
    harness.receive({ id: cancel.id, result: {} })
    harness.wire.close()
  })

  it('does not expose or copy OAuth credentials when an existing Codex account is available', async () => {
    const opened: string[] = []
    const harness = setup({ onAuthUrl: async (url) => { opened.push(url) } })
    await handshake(harness)
    expect(opened).toEqual([])
    expect(harness.sent.some((frame) => frame.method === 'account/login/start')).toBe(false)
    expect(JSON.stringify(harness.sent)).not.toContain('accessToken')
    expect(JSON.stringify(harness.sent)).not.toContain('refreshToken')
    harness.wire.close()
  })

  it('creates threads with the requested policy and returns the thread id', async () => {
    const harness = setup()
    await handshake(harness)
    const pending = harness.wire.startThread({ cwd: '/workspace', approvalPolicy: 'never' })
    await flush(harness)
    const request = harness.sent.at(-1)
    expect(request?.method).toBe('thread/start')
    const params = (request?.params ?? {}) as Record<string, unknown>
    expect(params.cwd).toBe('/workspace')
    expect(params.approvalPolicy).toBe('never')
    harness.receive({ id: request?.id, result: { thread: { id: 'thr-42', ephemeral: false } } })
    await expect(pending).resolves.toBe('thr-42')
    harness.wire.close()
  })

  it('starts turns with text input items and forwards product notifications', async () => {
    const harness = setup()
    await handshake(harness)
    const pending = harness.wire.startTurn('thr-42', ['do the thing'])
    await flush(harness)
    const request = harness.sent.at(-1)
    expect(request?.method).toBe('turn/start')
    const params = (request?.params ?? {}) as Record<string, unknown>
    expect(params.threadId).toBe('thr-42')
    expect(params.input).toEqual([{ type: 'text', text: 'do the thing', text_elements: [] }])
    harness.receive({ id: request?.id, result: { turn: { id: 'turn-1' } } })
    await expect(pending).resolves.toBe('turn-1')

    harness.receive({ method: 'item/completed', params: { threadId: 'thr-42', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'done' } } })
    await flush(harness)
    expect(harness.notifications.at(-1)?.method).toBe('item/completed')
    harness.wire.close()
  })

  it('adds localImage input items for attached images', async () => {
    const harness = setup()
    await handshake(harness)
    const pending = harness.wire.startTurn('thr-42', ['look at this'], undefined, ['C:/tmp/shot.png'])
    await flush(harness)
    const request = harness.sent.at(-1)
    expect(request?.method).toBe('turn/start')
    const params = (request?.params ?? {}) as Record<string, unknown>
    expect(params.input).toEqual([
      { type: 'text', text: 'look at this', text_elements: [] },
      { type: 'localImage', path: 'C:/tmp/shot.png' },
    ])
    harness.receive({ id: request?.id, result: { turn: { id: 'turn-images' } } })
    await expect(pending).resolves.toBe('turn-images')
    harness.wire.close()
  })

  it('correlates answers to server-initiated approval requests', async () => {
    const harness = setup()
    await handshake(harness)
    let releaseApproval: ((value: unknown) => void) | undefined
    harness.respondToServer(() => new Promise((resolve) => { releaseApproval = resolve }))
    harness.receive({ id: 91, method: 'item/commandExecution/requestApproval', params: { threadId: 'thr-42', turnId: 'turn-1', availableDecisions: ['accepted', 'declined'] } })
    await flush(harness)
    // No answer yet: the request must stay unanswered.
    expect(harness.sent.some((frame) => frame.id === 91)).toBe(false)

    releaseApproval?.({ decision: 'accepted' })
    await flush(harness)
    const answer = harness.sent.find((frame) => frame.id === 91)
    expect(answer?.result).toEqual({ decision: 'accepted' })

    harness.respondToServer(() => Promise.reject(new Error('no')))
    harness.receive({ id: 92, method: 'item/tool/requestUserInput', params: {} })
    await flush(harness)
    const rejected = harness.sent.find((frame) => frame.id === 92)
    expect(rejected?.error).toBeDefined()
    harness.wire.close()
  })

  it('interrupts the active turn without failing the connection', async () => {
    const harness = setup()
    await handshake(harness)
    harness.wire.interrupt('thr-42', 'turn-1')
    await flush(harness)
    expect(harness.sent.at(-1)?.method).toBe('turn/interrupt')
    expect(harness.protocolErrors).toHaveLength(0)
    harness.wire.close()
  })

  it('rejects outstanding requests and reports a fatal error when the stream closes', async () => {
    const harness = setup()
    await handshake(harness)
    const pending = harness.wire.startTurn('thr-42', ['work'])
    await flush(harness)
    ;(harness.wire as unknown as { input: PassThrough }).input.end()
    await expect(pending).rejects.toThrow(/closed/i)
    expect(harness.protocolErrors).toHaveLength(1)

    // After close, further requests fail fast instead of hanging.
    await expect(harness.wire.startThread({ cwd: '/w', approvalPolicy: 'never' })).rejects.toThrow(/closed/i)
  })
})

describe('pickDecision', () => {
  it('maps allow/deny intent onto the decisions the server actually offered', () => {
    expect(pickDecision(['accepted', 'declined'], true)).toBe('accepted')
    expect(pickDecision(['accepted', 'declined'], false)).toBe('declined')
    expect(pickDecision(['cancel', 'decline'], false)).toBe('decline')
  })

  it('falls back safely when the offer is missing or unrecognized', () => {
    expect(pickDecision(undefined, false)).toBe('decline')
    expect(pickDecision(['weird'], true)).toBe('weird')
    expect(pickDecision([], false)).toBe('decline')
  })
})
