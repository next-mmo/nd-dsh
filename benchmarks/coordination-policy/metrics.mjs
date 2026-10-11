export const POLICY_MODE = 'foreground-v1'
export const EXPECTED_PAIRS = 5
export const median = values => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Count observed parent events only; child usage and missing timings stay unknown. */
export function summarizeEvents(events) {
  const calls = new Map()
  const children = new Map()
  const intervals = []
  let modelMessages = 0
  let integrationStartedAt = null
  let terminalAt = null
  for (const event of events) {
    const time = Number.isFinite(event.time) ? event.time : event.receivedAt
    const data = event.data ?? {}
    if (event.type === 'assistant/message') modelMessages++
    if (event.type === 'tool/call') calls.set(data.callId, { name: data.name, startedAt: time })
    if (event.type === 'subagent/catalog' && typeof data.childId === 'string') children.set(data.childId, { createdAt: data.childCreatedAt, label: data.label })
    if (event.type === 'tool/result') {
      const call = calls.get(data.message?.source?.callId)
      if (call?.name === 'subagent' || call?.name === 'subagent_fork') {
        const content = data.message?.content ?? []
        const text = content.flatMap(part => part.content ?? []).map(part => part.text ?? '').join('\n')
        const background = /started (subagent|background subagent job) /.test(text)
        if (!background && Number.isFinite(call.startedAt) && Number.isFinite(time) && time >= call.startedAt) {
          intervals.push({ startedAt: call.startedAt, finishedAt: time })
          integrationStartedAt = Math.max(integrationStartedAt ?? time, time)
        }
      }
    }
    if (event.type === 'turn/end') terminalAt = time
  }
  const counts = {}
  for (const call of calls.values()) counts[call.name] = (counts[call.name] ?? 0) + 1
  const timeline = intervals.flatMap(interval => [[interval.startedAt, 1], [interval.finishedAt, -1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let active = 0
  let peakDelegationCalls = 0
  for (const [, delta] of timeline) { active += delta; peakDelegationCalls = Math.max(peakDelegationCalls, active) }
  return {
    parentModelMessages: modelMessages, parentToolCalls: calls.size, toolCounts: counts,
    statusPolls: (counts.list_agents ?? 0) + (counts.job_list ?? 0), childCount: children.size,
    foregroundDelegationSpans: intervals, peakDelegationCalls: intervals.length ? peakDelegationCalls : null,
    exactChildExecutionIntervals: null, childModelCalls: null,
    integrationWallMs: integrationStartedAt !== null && terminalAt !== null && terminalAt >= integrationStartedAt ? terminalAt - integrationStartedAt : null,
    integrationTimingBasis: integrationStartedAt === null ? 'unavailable' : 'last foreground delegation result to parent terminal; includes final review and tests',
    overlapBasis: 'observed foreground tool occupancy; exact child execution intervals unavailable',
  }
}

export function comparePairs(pairs) {
  const eligible = pairs.filter(pair => pair.baseline?.outcome === 'completed' && pair.candidate?.outcome === 'completed'
    && typeof pair.baseline.inputSnapshotSha256 === 'string' && pair.baseline.inputSnapshotSha256.length > 0
    && pair.baseline.inputSnapshotSha256 === pair.candidate.inputSnapshotSha256
    && typeof pair.baseline.promptSha256 === 'string' && pair.baseline.promptSha256 === pair.candidate.promptSha256
    && pair.baseline.route?.model && pair.baseline.route.model === pair.candidate.route?.model
    && pair.baseline.route?.provider && pair.baseline.route.provider === pair.candidate.route?.provider
    && pair.baseline.verification?.passed === true && pair.candidate.verification?.passed === true
    && Number.isFinite(pair.baseline.totalWallMs) && Number.isFinite(pair.candidate.totalWallMs)
    && pair.baseline.totalWallMs > 0 && pair.candidate.totalWallMs > 0)
  const baselineMedianMs = median(eligible.map(pair => pair.baseline.totalWallMs))
  const candidateMedianMs = median(eligible.map(pair => pair.candidate.totalWallMs))
  const improvement = baselineMedianMs === null ? null : 1 - candidateMedianMs / baselineMedianMs
  const pollingPassed = eligible.length > 0 && eligible.every(pair => Number.isInteger(pair.candidate.metrics?.statusPolls) && pair.candidate.metrics.statusPolls >= 0 && pair.candidate.metrics.statusPolls <= 4)
  // Tool spans alone do not establish actual simultaneous child execution.
  const overlapPassed = eligible.length > 0 && eligible.every(pair => pair.candidate.childExecutionOverlapVerified === true)
  const qualityPassed = pairs.length === EXPECTED_PAIRS && eligible.length === EXPECTED_PAIRS
  const passed = qualityPassed && improvement >= 0.2 && pollingPassed && overlapPassed
  const completedPairs = pairs.filter(pair => pair.baseline?.finishedAt && pair.candidate?.finishedAt).length
  return { status: passed ? 'passed' : qualityPassed ? 'failed' : 'inconclusive', completedPairs,
    eligiblePairs: eligible.length, baselineMedianMs, candidateMedianMs, relativeImprovement: improvement,
    qualityPassed, pollingPassed, overlapPassed, passed, promoteDefault: false,
    reason: eligible.length < EXPECTED_PAIRS ? 'Five fully verified pairs with matching input hashes, prompt and route required; blocked/unverified/unmatched runs are excluded.'
      : !overlapPassed ? 'Actual child execution overlap was not verified.' : passed ? 'Acceptance targets passed; default promotion requires separate review.' : 'Speed or polling target missed.' }
}
