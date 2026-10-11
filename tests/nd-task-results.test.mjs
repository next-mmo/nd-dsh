import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  DEFAULT_RESULTS_PATH, MAX_RESULTS_BYTES, formatMarkdown, handleRequest, readResults, summarizeResults,
} from '../extensions/nd-task-results/mcp-server.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baseline = JSON.parse(await readFile(join(repository, 'benchmarks/baselines/agent-task-normal-loop.json'), 'utf8'))
const temporary = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'nd-task-results-test-'))
  temporary.push(root)
  return root
}

function sample(overrides = {}) {
  return {
    runId: 'run-1', taskId: 'task-1', sessionId: 'session-1', kind: 'task-execution',
    startedAt: 100, finishedAt: 200, totalWallMs: 100, finished: true,
    outcome: 'completed', verification: 'passed', completedTask: true,
    modelRoundTrips: 2, toolCalls: 3, ipcCrossings: 5, bytesToModel: 100,
    tokensToModel: 20, outputTokens: 10, escalations: 0, engineId: 'nd-native', roundTripSource: 'harness-events',
    ...overrides,
  }
}

function receipt(samples = [sample()]) {
  return { ...structuredClone(baseline), samples, passes: [], summary: { tasks: 999, completedTasks: 999 } }
}

async function save(root, data = receipt(), path = DEFAULT_RESULTS_PATH) {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(data))
  return target
}

function childClient(root) {
  const child = spawn(process.execPath, [join(repository, 'extensions/nd-task-results/mcp-server.mjs')], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  let nextId = 0
  const pending = new Map()
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    const waiter = pending.get(message.id)
    if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message) }
  })
  child.on('error', error => { for (const waiter of pending.values()) waiter.reject(error) })
  child.on('exit', code => {
    for (const waiter of pending.values()) waiter.reject(new Error(`MCP exited ${code}: ${stderr}`))
  })
  return {
    async request(method, params = {}) {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}; ${stderr}`)) }, 5000)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    async close() {
      lines.close()
      if (child.exitCode !== null) return
      await new Promise(resolve => { child.once('exit', resolve); child.stdin.end(); setTimeout(() => child.kill(), 1000).unref() })
    },
  }
}

describe('ND Task Results workspace read boundary', () => {
  it('loads the saved production receipt from its default relative path', async () => {
    const result = await readResults(repository)
    expect(JSON.stringify(result)).toContain('offline-fixture')
  })

  it('reports missing and invalid JSON rather than returning a fake success', async () => {
    const root = await workspace()
    await expect(readResults(root)).rejects.toThrow()
    const target = await save(root)
    await writeFile(target, '{ invalid json')
    await expect(readResults(root)).rejects.toThrow()
  })

  it('rejects traversal, absolute input, and workspace-root override arguments', async () => {
    const root = await workspace()
    const outside = await workspace()
    const target = await save(outside)
    for (const path of ['../outside.json', '..\\outside.json', target]) {
      await expect(readResults(root, path)).rejects.toThrow()
    }
    const result = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'task_results', arguments: { workspaceRoot: outside },
    } }, root)
    expect(result.error || result.result?.isError).toBeTruthy()
  })

  it('rejects a directory junction escaping the workspace', async () => {
    const root = await workspace()
    const outside = await workspace()
    await save(outside, receipt(), 'result.json')
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(readResults(root, 'escape/result.json')).rejects.toThrow()
  })

  it('refuses oversized input before parsing it', async () => {
    const root = await workspace()
    const target = await save(root)
    await writeFile(target, ' '.repeat(MAX_RESULTS_BYTES + 1))
    await expect(readResults(root)).rejects.toThrow(/size|large|limit|bytes|at most/i)
  })
})

describe('ND Task Results evidence accounting', () => {
  it('recomputes the real saved receipt rather than trusting stored summary', () => {
    const source = structuredClone(baseline)
    source.summary = { tasks: 999, completedTasks: 999 }
    const summary = summarizeResults(source)
    expect(summary.totals).toMatchObject({ samples: 22, executionTasks: 22, verifiedCompleted: 19, failed: 2, canceled: 1 })
    expect(summary.counters.modelRoundTrips.total).toBe(55)
    expect(summary.counters.toolCalls.total).toBe(59)
    const sequential = summary.passes.find(p => p.name === 'sequential-4x')
    const parallel = summary.passes.find(p => p.name === 'parallel-4x')
    expect(sequential.overlap.peakConcurrency).toBe(1)
    expect(parallel.overlap.peakConcurrency).toBe(4)
    expect(parallel.overlap.spanMs).toBeLessThan(sequential.overlap.spanMs)
    expect(summary.evidence).toMatchObject({ runMode: 'offline-fixture', subagentEvidence: 'not-recorded' })
  })

  it('excludes planning and review from execution counts, counters and overlap', () => {
    const summary = summarizeResults(receipt([
      sample(), sample({ runId: 'plan', kind: 'pm-plan', modelRoundTrips: 100 }),
      sample({ runId: 'review', kind: 'task-review', modelRoundTrips: 100 }),
    ]))
    expect(summary.totals).toMatchObject({ samples: 3, executionTasks: 1, verifiedCompleted: 1 })
    expect(summary.counters.modelRoundTrips.total).toBe(2)
    expect(summary.overlap.peakConcurrency).toBe(1)
  })

  it('requires all machine completion gates and retains failed and unfinished attempts', () => {
    const changes = [
      {}, { outcome: 'failed' }, { outcome: 'canceled', verification: 'not-run' },
      { outcome: 'interrupted', verification: 'not-run' }, { verification: 'failed' },
      { completedTask: false }, { finished: false },
    ]
    const summary = summarizeResults(receipt(changes.map((value, index) => sample({ ...value, runId: `run-${index}`, taskId: `task-${index}` }))))
    expect(summary.totals).toMatchObject({ executionTasks: 7, verifiedCompleted: 1, failed: 1, canceled: 1, interrupted: 1, unverified: 3, unfinished: 1 })
    expect(summary.totals.completionRate).toBeCloseTo(1 / 7)
    expect(summary.verifiedDurations.measured).toBe(1)
  })

  it('counts only real interval overlap, applying end before start on timestamp ties', () => {
    const summary = summarizeResults(receipt([
      sample(), sample({ runId: 'run-2', taskId: 'task-2', startedAt: 200, finishedAt: 300 }),
      sample({ runId: 'zero', taskId: 'zero', startedAt: 150, finishedAt: 150, totalWallMs: 0 }),
    ]))
    expect(summary.overlap).toEqual({ measuredIntervals: 2, excludedIntervals: 1, peakConcurrency: 1, overlappingMs: 0, spanMs: 200, sumIntervalMs: 200, overlapFactor: 1 })
    const overlap = summarizeResults(receipt([sample(), sample({ runId: 'run-2', taskId: 'task-2', startedAt: 150, finishedAt: 250 })])).overlap
    expect(overlap).toMatchObject({ peakConcurrency: 2, overlappingMs: 50, spanMs: 150, sumIntervalMs: 200 })
    expect(overlap.overlapFactor).toBeCloseTo(4 / 3)
  })

  it.each([
    null, {}, { ...receipt(), schemaVersion: 2 }, { ...receipt(), samples: 'invalid' },
    receipt([sample({ totalWallMs: -1 })]), receipt([sample({ finishedAt: 99 })]),
    receipt([sample({ toolCalls: 1.5 })]), receipt([sample({ verification: 'invented' })]),
    receipt([sample({ taskId: undefined })]),
  ])('rejects malformed or unsupported receipt %#', value => {
    expect(() => summarizeResults(value)).toThrow()
  })

  it('rejects duplicate execution receipts and unsupported pass membership', () => {
    expect(() => summarizeResults(receipt([sample(), sample()]))).toThrow()
    for (const tasks of [[{ runId: 'missing' }], [{}], [{ runId: 'run-1' }, { runId: 'run-1' }]]) {
      const source = receipt()
      source.passes = [{ name: 'verified', tasks }]
      expect(() => summarizeResults(source)).toThrow()
    }
  })

  it('keeps unfinished sentinel timestamps out of duration and overlap claims', () => {
    const summary = summarizeResults(receipt([sample({ finished: false, finishedAt: 0 })]))
    expect(summary.totals).toMatchObject({ unfinished: 1, verifiedCompleted: 0, unverified: 1 })
    expect(summary.durations.measured).toBe(0)
    expect(summary.overlap).toMatchObject({ measuredIntervals: 0, excludedIntervals: 1, peakConcurrency: 0 })
  })

  it.each(['modelRoundTrips', 'toolCalls', 'ipcCrossings', 'bytesToModel', 'tokensToModel', 'escalations'])('rejects missing execution counter %s instead of assuming zero', key => {
    const source = receipt()
    delete source.samples[0][key]
    expect(() => summarizeResults(source)).toThrow()
  })

  it('marks per-completion cost unmeasured when attempts have no verified completions', () => {
    const summary = summarizeResults(receipt([
      sample({ outcome: 'failed', verification: 'failed', completedTask: false }),
    ]))
    expect(summary.totals.verifiedCompleted).toBe(0)
    expect(summary.counters.modelRoundTrips.total).toBe(2)
    expect(summary.counters.toolCalls.total).toBe(3)
    expect(Object.values(summary.counters).every(counter => counter.perVerifiedCompletion === null)).toBe(true)
  })

  it('exports bounded aggregate fields without raw secrets or private paths', () => {
    const source = receipt([sample({ prompt: 'sk-test-placeholder', sessionId: 'private-session-token' })])
    source.notes = ['sk-test-placeholder']
    source.ndCore.path = 'C:/private/person/workspace'
    source.passes = [{ name: 'sk-test-placeholder', workspaceRoot: 'C:/private/person/workspace', tasks: [{ runId: 'run-1' }] }]
    const summary = summarizeResults(source)
    const markdown = formatMarkdown(summary)
    const exported = JSON.stringify(summary) + markdown
    expect(exported).not.toMatch(/sk-test-placeholder|private-session-token|private\/person/)
    expect(markdown).toContain('Verified completions: 1/1')
    expect(markdown).toMatch(/excludes real model latency|overhead-only/i)
    expect(markdown).toContain('Child subagent evidence: not recorded')
  })
})

describe('ND Task Results real MCP stdio', () => {
  it('returns explicit protocol errors and does not respond to notifications', async () => {
    const root = await workspace()
    expect((await handleRequest({ jsonrpc: '2.0', id: 1, method: 'unsupported' }, root)).error.code).toBe(-32601)
    expect((await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'unknown' } }, root)).error.code).toBe(-32602)
    expect((await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_results' } }, root)).error.code).toBe(-32602)
    expect((await handleRequest({ id: 1 }, root)).error.code).toBe(-32600)
    expect(await handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, root)).toBeNull()
  })

  it('initializes, discovers and calls JSON and Markdown tools in its startup workspace', async () => {
    const root = await workspace()
    await save(root)
    const client = childClient(root)
    try {
      const initialized = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      expect(initialized.result.serverInfo.name).toBe('nd-task-results')
      const listed = await client.request('tools/list')
      expect(listed.result.tools.map(tool => tool.name)).toEqual(['task_results', 'task_results_export'])
      expect(listed.result.tools.every(tool => tool.annotations.readOnlyHint)).toBe(true)
      const result = await client.request('tools/call', { name: 'task_results', arguments: {} })
      expect(JSON.parse(result.result.content[0].text).totals.verifiedCompleted).toBe(1)
      const exported = await client.request('tools/call', { name: 'task_results_export', arguments: {} })
      expect(exported.result.content[0].text).toContain('# ND Task Results')
      const denied = await client.request('tools/call', { name: 'task_results', arguments: { resultsPath: '../outside.json' } })
      expect(denied.error.code).toBe(-32602)
    } finally { await client.close() }
  })
})
