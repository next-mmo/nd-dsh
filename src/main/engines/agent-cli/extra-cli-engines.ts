import { execFile, execFileSync, spawn } from 'node:child_process'
import type { EngineModelOption } from '../../../shared/contracts.js'
import {
  GOOSE_CLI_ENGINE_ID,
  HERMES_CLI_ENGINE_ID,
  JCODE_CLI_ENGINE_ID,
  MINIMAX_CLI_ENGINE_ID,
  OPENCODE_CLI_ENGINE_ID,
} from '../../../shared/extra-coding-engines.js'
import { gooseBinPath, hermesBinPath, jcodeBinPath, opencodeBinPath } from './extra-cli-paths.js'
import { MiniMaxCliEngine } from './minimax-cli-engine.js'
import { StructuredCliEngine, type StructuredCliAdapter, type StructuredCliEvent } from './structured-cli-engine.js'

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value
  const error = recordValue(value)
  const data = recordValue(error?.data)
  return stringValue(data?.message)
    ?? stringValue(error?.message)
    ?? stringValue(error?.name)
    ?? fallback
}

const opencodeStandalone = new Map<string, boolean>()

/**
 * OpenCode v2 `run` attaches to a shared background service by default, which
 * keeps the first caller's project directory and config. ND needs every turn in
 * its own workspace, so it runs v2 standalone (v1 has no such mode).
 */
function opencodeSupportsStandalone(bin: string): boolean {
  const cached = opencodeStandalone.get(bin)
  if (cached !== undefined) return cached
  const read = (command: string, args: string[]): string => execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  let supported = false
  try {
    supported = /--standalone\b/.test(read(bin, ['run', '--help']))
  } catch {
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
      try {
        supported = /--standalone\b/.test(read(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${bin}" run --help`]))
      } catch {}
    }
  }
  opencodeStandalone.set(bin, supported)
  return supported
}

/**
 * Picker rows from `opencode models`: one provider/model slug per line.
 * Free models lead the list so the no-cost routes are reachable without
 * scrolling through every paid model first.
 */
export function parseOpencodeModelList(stdout: string): EngineModelOption[] {
  const seen = new Set<string>()
  const free: EngineModelOption[] = []
  const paid: EngineModelOption[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const id = line.trim()
    if (!id || /\s/.test(id) || !id.includes('/') || seen.has(id)) continue
    seen.add(id)
    const model = { id }
    if (/-free$/i.test(id)) free.push(model)
    else paid.push(model)
  }
  return [...free, ...paid]
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolveText, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) reject(error)
      else resolveText(stdout)
    })
  })
}

let opencodeModelCache: { bin: string; at: number; models: EngineModelOption[] } | undefined

async function loadOpencodeModels(bin: string): Promise<EngineModelOption[]> {
  const cached = opencodeModelCache
  if (cached && cached.bin === bin && Date.now() - cached.at < 60_000) return cached.models
  const args = ['models']
  if (opencodeSupportsStandalone(bin)) args.push('--standalone')
  let stdout: string
  try {
    stdout = await execFileText(bin, args)
  } catch {
    if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return []
    try {
      stdout = await execFileText(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${bin}" ${args.join(' ')}`])
    } catch {
      return []
    }
  }
  const models = parseOpencodeModelList(stdout)
  opencodeModelCache = { bin, at: Date.now(), models }
  return models
}

export const opencodeAdapter: StructuredCliAdapter = {
  id: OPENCODE_CLI_ENGINE_ID,
  label: 'OpenCode',
  sessionPrefix: 'opencode',
  binary: opencodeBinPath,
  unavailableMessage: 'The OpenCode CLI is not installed. Install the OpenCode CLI or the OpenCode Desktop app, or set ND_DSH_OPENCODE_BINARY.',
  listModels: async () => {
    const bin = opencodeBinPath()
    return bin ? loadOpencodeModels(bin) : []
  },
  buildArgs: ({ prompt, model, nativeSessionId }) => {
    const args = ['run', '--format', 'json']
    const bin = opencodeBinPath()
    if (bin && opencodeSupportsStandalone(bin)) args.push('--standalone')
    if (nativeSessionId) args.push('--session', nativeSessionId)
    if (model) args.push('--model', model)
    args.push(prompt)
    return args
  },
  parse: (wire) => {
    const events: StructuredCliEvent[] = []
    const nativeSessionId = stringValue(wire.sessionID) ?? stringValue(wire.session_id)
    if (nativeSessionId) events.push({ kind: 'session', sessionId: nativeSessionId })
    const type = stringValue(wire.type)
    const part = recordValue(wire.part)
    if (type === 'text' && part) {
      const text = stringValue(part.text)
      if (text) events.push({ kind: 'text', text })
    }
    if ((type === 'tool_use' || type === 'tool') && part) {
      const name = stringValue(part.tool) ?? stringValue(part.name) ?? 'tool'
      const state = recordValue(part.state)
      const callId = stringValue(part.callID) ?? stringValue(part.callId) ?? stringValue(part.id)
      const status = stringValue(state?.status)
      if (status === 'running' || status === 'pending') {
        events.push({ kind: 'tool-start', ...(callId ? { callId } : {}), name, input: state?.input ?? part.input ?? null })
      } else if (status === 'completed' || status === 'error') {
        events.push({
          kind: 'tool-result',
          ...(callId ? { callId } : {}),
          name,
          output: state?.output ?? state?.error ?? part.output ?? null,
          ...(status === 'error' ? { isError: true } : {}),
        })
      }
    }
    // OpenCode emits step_finish for every model call inside a run, with the
    // tokens that call used. Reporting it is what lets ND count a turn's model
    // round trips; the reusable engine still settles this adapter only when the
    // CLI exits.
    if (type === 'step_finish') {
      const tokens = recordValue(part?.tokens)
      const inputTokens = numberValue(tokens?.input) ?? numberValue(tokens?.inputTokens)
      const outputTokens = numberValue(tokens?.output) ?? numberValue(tokens?.outputTokens)
      events.push({
        kind: 'step',
        ...(inputTokens === undefined && outputTokens === undefined
          ? {}
          : { usage: { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) } }),
      })
    }
    if (type === 'error') events.push({ kind: 'error', message: errorMessage(wire.error ?? wire.message, 'OpenCode reported an error') })
    return events
  },
}

export const gooseAdapter: StructuredCliAdapter = {
  id: GOOSE_CLI_ENGINE_ID,
  label: 'Goose',
  sessionPrefix: 'goose',
  binary: gooseBinPath,
  unavailableMessage: 'The goose CLI is not installed. Install goose or set ND_DSH_GOOSE_BINARY.',
  buildArgs: ({ prompt, model, sessionId, isContinuation }) => {
    const args = ['run', '--quiet', '--output-format', 'stream-json', '--with-builtin', 'developer', '--name', sessionId]
    if (isContinuation) args.push('--resume')
    if (model) args.push('--model', model)
    args.push('-t', prompt)
    return args
  },
  parse: (wire) => {
    const events: StructuredCliEvent[] = []
    const nativeSessionId = stringValue(wire.session_id) ?? stringValue(wire.sessionId)
    if (nativeSessionId) events.push({ kind: 'session', sessionId: nativeSessionId })
    const type = stringValue(wire.type)
    if (type === 'message') {
      const message = recordValue(wire.message)
      for (const blockValue of arrayValue(message?.content)) {
        const block = recordValue(blockValue)
        if (!block) continue
        const blockType = stringValue(block.type)
        const text = stringValue(block.text)
        if (text && (blockType === 'text' || blockType === undefined)) events.push({ kind: 'text', text })
        if (blockType === 'toolRequest' || blockType === 'tool_use' || blockType === 'toolUse') {
          const wrapper = recordValue(block.toolCall) ?? recordValue(block.tool_call)
          const toolCall = recordValue(wrapper?.value) ?? wrapper ?? block
          const callId = stringValue(block.id) ?? stringValue(toolCall.id)
          const name = stringValue(toolCall.name) ?? 'tool'
          const status = stringValue(wrapper?.status)
          events.push({ kind: 'tool-start', ...(callId ? { callId } : {}), name, input: toolCall.arguments ?? toolCall.input ?? null })
          if (status === 'error') {
            events.push({
              kind: 'tool-result',
              ...(callId ? { callId } : {}),
              name,
              output: stringValue(wrapper?.error) ?? 'Goose tool request failed',
              isError: true,
            })
          }
        }
        if (blockType === 'toolResponse' || blockType === 'tool_result' || blockType === 'toolResult') {
          const wrapper = recordValue(block.toolResult) ?? recordValue(block.tool_result)
          const toolResult = recordValue(wrapper?.value) ?? wrapper ?? block
          const callId = stringValue(block.id) ?? stringValue(toolResult.id) ?? stringValue(toolResult.toolCallId)
          const status = stringValue(wrapper?.status)
          events.push({
            kind: 'tool-result',
            ...(callId ? { callId } : {}),
            output: status === 'error'
              ? stringValue(wrapper?.error) ?? 'Goose tool failed'
              : wrapper?.value ?? toolResult.result ?? toolResult.output ?? toolResult.text ?? null,
            ...(status === 'error' ? { isError: true } : {}),
          })
        }
      }
    }
    if (type === 'complete') {
      const text = stringValue(wire.text)
      events.push({ kind: 'done', ...(text ? { text } : {}) })
    }
    if (type === 'error') events.push({ kind: 'error', message: stringValue(wire.message) ?? stringValue(wire.error) ?? 'Goose reported an error' })
    return events
  },
}

export const jcodeAdapter: StructuredCliAdapter = {
  id: JCODE_CLI_ENGINE_ID,
  label: 'JCode',
  sessionPrefix: 'jcode',
  binary: jcodeBinPath,
  unavailableMessage: 'The JCode CLI is not installed. Install it from https://jcode.sh or set ND_DSH_JCODE_BINARY.',
  buildArgs: ({ prompt, model }) => {
    const args = ['--quiet', '--no-update', '--no-selfdev']
    if (model) args.push('--model', model)
    args.push('run', '--ndjson', prompt)
    return args
  },
  parse: (wire) => {
    const events: StructuredCliEvent[] = []
    const nativeSessionId = stringValue(wire.session_id) ?? stringValue(wire.sessionId)
    if (nativeSessionId) events.push({ kind: 'session', sessionId: nativeSessionId })
    const type = stringValue(wire.type)
    if (type === 'text_delta') {
      const text = stringValue(wire.delta) ?? stringValue(wire.text)
      if (text) events.push({ kind: 'text', text })
    }
    if (type === 'text_replace') {
      const text = stringValue(wire.text)
      if (text !== undefined) events.push({ kind: 'text-replace', text })
    }
    if (type === 'tool_start' || type === 'tool_exec') {
      const callId = stringValue(wire.id) ?? stringValue(wire.call_id)
      events.push({
        kind: 'tool-start',
        ...(callId ? { callId } : {}),
        name: stringValue(wire.name) ?? stringValue(wire.tool) ?? 'tool',
        input: wire.input ?? wire.arguments ?? null,
      })
    }
    if (type === 'tool_done') {
      const callId = stringValue(wire.id) ?? stringValue(wire.call_id)
      const name = stringValue(wire.name) ?? stringValue(wire.tool)
      const error = stringValue(wire.error)
      events.push({
        kind: 'tool-result',
        ...(callId ? { callId } : {}),
        ...(name ? { name } : {}),
        output: wire.output ?? wire.result ?? error ?? null,
        ...(error ? { isError: true } : {}),
      })
    }
    if (type === 'done') {
      const text = stringValue(wire.text)
      events.push({ kind: 'done', ...(text ? { text } : {}) })
    }
    if (type === 'error') events.push({ kind: 'error', message: stringValue(wire.message) ?? stringValue(wire.error) ?? 'JCode reported an error' })
    return events
  },
}

export const hermesAdapter: StructuredCliAdapter = {
  id: HERMES_CLI_ENGINE_ID,
  label: 'Hermes',
  sessionPrefix: 'hermes',
  binary: hermesBinPath,
  unavailableMessage: 'The Hermes Agent CLI is not installed. Install Hermes Agent or set ND_DSH_HERMES_BINARY.',
  buildArgs: ({ prompt, model, nativeSessionId }) => {
    const args = ['chat', '--format', 'stream-json', '--source', 'tool']
    if (nativeSessionId) args.push('--resume', nativeSessionId, '--no-restore-cwd')
    if (model) args.push('--model', model)
    args.push('-q', prompt)
    return args
  },
  parse: (wire) => {
    const events: StructuredCliEvent[] = []
    const nativeSessionId = stringValue(wire.session_id) ?? stringValue(wire.sessionId)
    if (nativeSessionId) events.push({ kind: 'session', sessionId: nativeSessionId })
    const type = stringValue(wire.type)
    if (type === 'text') {
      const text = stringValue(wire.text)
      if (text) events.push({ kind: 'text', text })
    }
    if (type === 'tool_use') {
      const callId = stringValue(wire.id) ?? stringValue(wire.call_id)
      events.push({ kind: 'tool-start', ...(callId ? { callId } : {}), name: stringValue(wire.name) ?? 'tool', input: wire.input ?? null })
    }
    if (type === 'tool_result') {
      const callId = stringValue(wire.id) ?? stringValue(wire.call_id)
      const name = stringValue(wire.name)
      events.push({
        kind: 'tool-result',
        ...(callId ? { callId } : {}),
        ...(name ? { name } : {}),
        output: wire.output ?? null,
        ...(wire.is_error === true ? { isError: true } : {}),
      })
    }
    if (type === 'result') {
      const exitCode = typeof wire.exit_code === 'number' ? wire.exit_code : 0
      const text = stringValue(wire.text)
      events.push({
        kind: 'done',
        ...(text ? { text } : {}),
        ...(exitCode !== 0 ? { failed: true, message: stringValue(wire.error) ?? `Hermes exited with code ${exitCode}` } : {}),
      })
    }
    return events
  },
}

export type ExtraCliEngine = StructuredCliEngine | MiniMaxCliEngine

export function createExtraCliEngines(log?: (line: string) => void, spawnProcess: typeof spawn = spawn): Array<[string, ExtraCliEngine]> {
  const structured = [opencodeAdapter, gooseAdapter, jcodeAdapter, hermesAdapter].map<[string, ExtraCliEngine]>((adapter) => [
    adapter.id,
    new StructuredCliEngine(adapter, { ...(log ? { log } : {}), spawnProcess }),
  ])
  return [
    ...structured,
    [MINIMAX_CLI_ENGINE_ID, new MiniMaxCliEngine(log, spawnProcess)],
  ]
}
