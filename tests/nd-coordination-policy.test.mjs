import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'
import { zstdCompressSync } from 'node:zlib'
import { decodeChildJournal, childOverlap } from '../benchmarks/coordination-policy/child-evidence.mjs'
import { comparePairs, summarizeEvents } from '../benchmarks/coordination-policy/metrics.mjs'

const url = new URL('../configs/dsh/agent-presets/nd-dsh/agent.cordis.yml', import.meta.url)
const document = parseDocument(await readFile(url, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: source => source }] })
if (document.errors.length) throw document.errors[0]
const expression = document.toJS()[0].config.prefix
const render = mode => new Function('process', 'baseUrl', `return ${expression}`)({ env: { ND_DSH_WORKSPACE_CONTEXT: 'test context', ND_DSH_COORDINATION_POLICY: mode }, getBuiltinModule: process.getBuiltinModule }, url.href)
const verified = (duration, polls = 0) => ({ outcome: 'completed', totalWallMs: duration, inputSnapshotSha256: 'same-inputs', promptSha256: 'same-prompt', route: { model: 'same-model', provider: 'same-provider' }, verification: { passed: true }, metrics: { statusPolls: polls }, childExecutionOverlapVerified: true })
const pairs = () => Array.from({ length: 5 }, (_, index) => ({ pair: index + 1, baseline: verified(1000), candidate: verified(750, 4) }))
const call = (id, start, name = 'subagent') => ({ type: 'tool/call', time: start, data: { callId: id, name } })
const result = (id, end, text = 'child completed') => ({ type: 'tool/result', time: end, data: { message: { source: { callId: id }, content: [{ content: [{ text }] }] } } })

describe('ND coordination opt-in', () => {
  it('keeps the disabled persona byte-identical to the pre-policy default', () => {
    expect(createHash('sha256').update(render(undefined)).digest('hex')).toBe('f06fc55a72d9f3dad7a3d4013f2a980a05adf3df74162f3f6d5e49bd6d541a98')
    expect(render('false')).toBe(render(undefined))
    expect(render('unrecognized')).toBe(render(undefined))
  })
  it('loads the policy through the same expression used by the runtime', () => {
    const enabled = render('foreground-v1')
    expect(enabled.startsWith(render(undefined))).toBe(true)
    expect(enabled).toContain('<nd-coordination-policy version="foreground-v1">')
    expect(enabled).toContain('run_in_background: false')
    expect(enabled).toContain('two routine diagnostic status checks per child')
    expect(enabled).toContain('Cancel outstanding child work')
  })
})

describe('coordination acceptance receipts', () => {
  it('requires five verified pairs, polling budget and observed child execution overlap', () => {
    const summary = comparePairs(pairs())
    expect(summary).toMatchObject({ passed: true, eligiblePairs: 5, relativeImprovement: 0.25, promoteDefault: false })
  })
  it.each(['failed', 'canceled', 'timeout', 'blocked', 'running', 'ownership-conflict'])('never ranks an early %s run as faster', outcome => {
    const values = pairs()
    values[0].candidate.outcome = outcome
    values[0].candidate.totalWallMs = 1
    expect(comparePairs(values)).toMatchObject({ eligiblePairs: 4, passed: false, status: 'inconclusive' })
  })
  it('excludes unsuccessful and environmentally unverified checks', () => {
    const values = pairs()
    values[0].candidate.verification.passed = false
    values[1].baseline.verification = { passed: false, reason: 'symlink unavailable' }
    expect(comparePairs(values)).toMatchObject({ eligiblePairs: 3, passed: false })
  })
  it('does not fabricate timings or verified child overlap', () => {
    const values = pairs()
    values[0].candidate.childExecutionOverlapVerified = false
    expect(comparePairs(values)).toMatchObject({ overlapPassed: false, passed: false })
    values[0].candidate.totalWallMs = null
    expect(comparePairs(values).eligiblePairs).toBe(4)
    expect(comparePairs([])).toMatchObject({ relativeImprovement: null, baselineMedianMs: null })
  })
  it('rejects a slower candidate and excess parent polling', () => {
    const slow = pairs()
    slow.forEach(pair => { pair.candidate.totalWallMs = 900 })
    expect(comparePairs(slow).passed).toBe(false)
    const polling = pairs()
    polling[0].candidate.metrics.statusPolls = 5
    expect(comparePairs(polling)).toMatchObject({ pollingPassed: false, passed: false })
  })
  it('does not count unknown polling or unfinished pairs as completed', () => {
    const values = pairs()
    values[0].candidate.metrics.statusPolls = null
    expect(comparePairs(values)).toMatchObject({ pollingPassed: false, completedPairs: 0 })
  })
  it.each(['inputSnapshotSha256', 'promptSha256'])('excludes mismatched or missing %s', field => {
    const values = pairs()
    values[0].candidate[field] = 'different'
    expect(comparePairs(values).eligiblePairs).toBe(4)
    delete values[0].baseline[field]
    expect(comparePairs(values).eligiblePairs).toBe(4)
  })
  it('excludes a changed model route', () => {
    const values = pairs()
    values[0].candidate.route = { model: 'other-model', provider: 'same-provider' }
    expect(comparePairs(values).eligiblePairs).toBe(4)
  })
})

describe('actual parent event accounting', () => {
  it('measures overlapping foreground calls without claiming exact child execution', () => {
    const summary = summarizeEvents([call('a', 100), call('b', 110), result('a', 200), result('b', 220), { type: 'turn/end', time: 300 }])
    expect(summary).toMatchObject({ parentToolCalls: 2, peakDelegationCalls: 2, integrationWallMs: 80, exactChildExecutionIntervals: null, childModelCalls: null })
  })
  it('does not confuse background dispatch acknowledgments with child completion', () => {
    expect(summarizeEvents([call('a', 100), result('a', 110, 'started subagent abc')])).toMatchObject({ peakDelegationCalls: null, integrationWallMs: null })
  })
  it('treats touching intervals as sequential and leaves unfinished children unknown', () => {
    expect(summarizeEvents([call('a', 100), result('a', 200), call('b', 200), result('b', 300)]).peakDelegationCalls).toBe(1)
    expect(summarizeEvents([call('a', 100)]).integrationWallMs).toBe(null)
  })
})

describe('durable child lifecycle evidence', () => {
  const binding = { workspace: process.cwd(), parentSessionId: 'parent', createdAt: 100 }
  const header = { type: 'session', origin: 'subagent', parentSession: 'parent', cwd: process.cwd() }
  const frame = entry => zstdCompressSync(Buffer.from(JSON.stringify(entry) + '\n'))
  const journal = reason => Buffer.concat([frame(header), frame({ type: 'assistant/message', time: 50 }), frame({ type: 'turn/start', time: 110 }), frame({ type: 'assistant/message', time: 120 }), frame({ type: 'turn/end', time: 200, data: { reason: { kind: reason } } })])
  it.each(['completed', 'failed', 'canceled'])('reads concatenated frames and retains %s child outcomes', reason => {
    const value = decodeChildJournal(journal(reason), binding)
    expect(value).toMatchObject({ terminalOutcomes: [reason], modelMessages: 1, unfinished: false, intervals: [{ startedAt: 110, finishedAt: 200 }] })
  })
  it('rejects another parent/workspace and truncated frames', () => {
    expect(() => decodeChildJournal(journal('completed'), { ...binding, parentSessionId: 'other-parent' })).toThrow()
    expect(() => decodeChildJournal(journal('completed'), { ...binding, workspace: '/another-workspace' })).toThrow()
    expect(() => decodeChildJournal(journal('completed').subarray(0, 10), binding)).toThrow()
  })
  it('does not establish overlap from missing, unfinished or sequential evidence', () => {
    const child = { available: true, unfinished: false, intervals: [{ startedAt: 10, finishedAt: 20 }] }
    expect(childOverlap([child, { ...child, available: false }]).verified).toBe(false)
    expect(childOverlap([child, { ...child, unfinished: true }]).verified).toBe(false)
    expect(childOverlap([child, { ...child, intervals: [{ startedAt: 20, finishedAt: 30 }] }])).toEqual({ verified: false, peakConcurrency: 1 })
    expect(childOverlap([child, { ...child, intervals: [{ startedAt: 15, finishedAt: 25 }] }])).toEqual({ verified: true, peakConcurrency: 2 })
  })
})
