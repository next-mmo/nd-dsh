import { open, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAX_COMPRESSED = 16 * 1024 * 1024
const MAX_EXPANDED = 64 * 1024 * 1024
const sameRoot = (a, b) => {
  const normalize = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
  return typeof a === 'string' && typeof b === 'string' && normalize(a) === normalize(b)
}

/** Read concatenated upstream journal frames, returning only lifecycle counters. */
export function decodeChildJournal(buffer, { parentSessionId, workspace, createdAt }) {
  if (buffer.length > MAX_COMPRESSED) throw new Error('Child journal exceeds compressed limit')
  let offset = 0, expanded = 0, header
  const events = []
  while (offset < buffer.length) {
    const frame = zstdDecompressSync(buffer.subarray(offset), { info: true, maxOutputLength: MAX_EXPANDED - expanded })
    if (!frame.engine.bytesWritten) throw new Error('Child journal frame made no progress')
    offset += frame.engine.bytesWritten
    expanded += frame.buffer.length
    for (const line of frame.buffer.toString('utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line)
      if (!header) header = entry
      else if (Number.isFinite(entry.time) && entry.time >= createdAt) events.push(entry)
    }
  }
  if (header?.type !== 'session' || header.origin !== 'subagent' || header.parentSession !== parentSessionId || !sameRoot(header.cwd, workspace)) throw new Error('Child journal does not belong to this parent workspace')
  const intervals = []
  let start = null
  const outcomes = []
  for (const event of events) {
    if (event.type === 'turn/start') { if (start !== null) throw new Error('Child journal contains nested active turns'); start = event.time }
    if (event.type === 'turn/end') {
      outcomes.push(event.data?.reason?.kind ?? 'unknown')
      if (start !== null && event.time > start) intervals.push({ startedAt: start, finishedAt: event.time })
      start = null
    }
  }
  return { intervals, unfinished: start !== null, terminalOutcomes: outcomes,
    modelMessages: events.filter(event => event.type === 'assistant/message').length,
    toolCalls: events.filter(event => event.type === 'tool/call').length }
}

export function childOverlap(children) {
  if (children.length < 2 || children.some(child => !child.available || child.unfinished || !child.intervals.length)) return { verified: false, peakConcurrency: null }
  const events = children.flatMap(child => child.intervals.flatMap(interval => [[interval.startedAt, 1], [interval.finishedAt, -1]]))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let active = 0, peak = 0
  for (const [, delta] of events) { active += delta; peak = Math.max(peak, active) }
  return { verified: peak >= 2, peakConcurrency: peak }
}

export async function readChildEvidence(profile, workspace, parentSessionId, parentEvents) {
  const catalogs = [...new Map(parentEvents.filter(event => event.type === 'subagent/catalog' && /^[a-f0-9-]{36}$/.test(event.data?.childId))
    .map(event => [event.data.childId, event.data])).values()]
  const root = join(profile, 'dsh-home/sessions')
  const directories = await readdir(root, { withFileTypes: true })
  const children = []
  for (const [index, catalog] of catalogs.entries()) {
    let value = { child: index + 1, available: false, reason: 'Journal unavailable' }
    for (const directory of directories.filter(entry => entry.isDirectory())) {
      let file
      try {
        file = await open(join(root, directory.name, catalog.childId, 'session.v3.jsonl.zstd'), 'r')
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > MAX_COMPRESSED) throw new Error('Journal size limit')
        const buffer = Buffer.alloc(MAX_COMPRESSED + 1)
        let used = 0
        while (used < buffer.length) { const { bytesRead } = await file.read(buffer, used, buffer.length - used, used); if (!bytesRead) break; used += bytesRead }
        value = { child: index + 1, available: true, ...decodeChildJournal(buffer.subarray(0, used), { parentSessionId, workspace, createdAt: catalog.childCreatedAt }) }
        break
      } catch (error) {
        if (error.code !== 'ENOENT') { value.reason = 'Child journal could not be verified'; break }
      } finally { await file?.close() }
    }
    children.push(value)
  }
  return { children, ...childOverlap(children), basis: 'workspace- and parent-attributed child turn/start and turn/end events in durable journals' }
}
