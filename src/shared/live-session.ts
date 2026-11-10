import { asNdContext, type NdContext } from './nd-context.js'

export const LIVE_IPC = {
  open: 'live:open',
} as const

export const LIVE_MODELS = ['gemini-3.8-live', 'gemini-3.8-live-extended-thinking'] as const
export type LiveModelId = (typeof LIVE_MODELS)[number]

export const DEFAULT_LIVE_MODEL: LiveModelId = 'gemini-3.8-live'
export const LIVE_VOICES = ['Aoede', 'Charon', 'Fenrir', 'Kore', 'Puck', 'Umbriel'] as const

export const LIVE_MAX_LESSON_CONTEXT_CHARS = 8_192
export const LIVE_MAX_TOOLS = 8
export const LIVE_MAX_TOOL_DESC_CHARS = 512
export const LIVE_MAX_TOOL_PARAMS_CHARS = 2_048

const TOOL_NAME_PATTERN = /^[a-z_]{1,48}$/
const VOICE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/

export interface LiveToolDeclaration {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

export interface LiveOpenInput {
  extensionId: string
  viewId: string
  context: NdContext
  lessonContext: string
  language?: 'en' | 'km'
  model?: string
  voice?: string
  tools?: LiveToolDeclaration[]
}

export interface LiveOpenResult {
  wsUrl: string
  ticket: string
  model: string
  expiresAtMs: number
  providerId: string
  providerName: string
}

export interface LiveDesktopApi {
  open(input: LiveOpenInput): Promise<LiveOpenResult>
}

export function isLiveModelId(value: unknown): value is LiveModelId {
  return typeof value === 'string' && (LIVE_MODELS as readonly string[]).includes(value)
}

export function validateLiveOpenInput(raw: unknown): LiveOpenInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Live session input must be an object')
  }
  const record = raw as Record<string, unknown>

  const extensionId = typeof record.extensionId === 'string' ? record.extensionId.trim() : ''
  if (!ID_PATTERN.test(extensionId)) {
    throw new Error('Invalid extensionId for live session')
  }
  const viewId = typeof record.viewId === 'string' ? record.viewId.trim() : ''
  if (!ID_PATTERN.test(viewId)) {
    throw new Error('Invalid viewId for live session')
  }

  const context = asNdContext(record.context)

  if (typeof record.lessonContext !== 'string') {
    throw new Error('lessonContext must be a string')
  }
  const lessonContext = record.lessonContext.trim()
  if (lessonContext.length > LIVE_MAX_LESSON_CONTEXT_CHARS) {
    throw new Error(`lessonContext exceeds ${LIVE_MAX_LESSON_CONTEXT_CHARS} characters`)
  }

  let language: 'en' | 'km' = 'en'
  if (record.language !== undefined) {
    if (record.language !== 'en' && record.language !== 'km') {
      throw new Error('language must be "en" or "km"')
    }
    language = record.language
  }

  let model: string | undefined
  if (record.model !== undefined && record.model !== '') {
    if (typeof record.model !== 'string' || !isLiveModelId(record.model.trim())) {
      throw new Error(`Unsupported live model: ${String(record.model)}`)
    }
    model = record.model.trim()
  }

  let voice: string | undefined
  if (record.voice !== undefined && record.voice !== '') {
    if (typeof record.voice !== 'string' || !VOICE_PATTERN.test(record.voice.trim())) {
      throw new Error('Invalid live voice identifier')
    }
    voice = record.voice.trim()
  }

  let tools: LiveToolDeclaration[] | undefined
  if (record.tools !== undefined) {
    if (!Array.isArray(record.tools)) {
      throw new Error('tools must be an array')
    }
    if (record.tools.length > LIVE_MAX_TOOLS) {
      throw new Error(`At most ${LIVE_MAX_TOOLS} live tools are permitted`)
    }
    tools = record.tools.map((item, idx) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`tools[${idx}] must be an object`)
      }
      const entry = item as Record<string, unknown>
      const name = typeof entry.name === 'string' ? entry.name.trim() : ''
      if (!TOOL_NAME_PATTERN.test(name)) {
        throw new Error(`Invalid live tool name at tools[${idx}]`)
      }
      const description = typeof entry.description === 'string' ? entry.description.trim() : ''
      if (!description || description.length > LIVE_MAX_TOOL_DESC_CHARS) {
        throw new Error(`Invalid description for live tool "${name}"`)
      }
      let parameters: Record<string, unknown> | undefined
      if (entry.parameters !== undefined) {
        if (!entry.parameters || typeof entry.parameters !== 'object' || Array.isArray(entry.parameters)) {
          throw new Error(`parameters for live tool "${name}" must be an object`)
        }
        const serialized = JSON.stringify(entry.parameters)
        if (serialized.length > LIVE_MAX_TOOL_PARAMS_CHARS) {
          throw new Error(`parameters for live tool "${name}" exceeds size limit`)
        }
        parameters = entry.parameters as Record<string, unknown>
      }
      return {
        name,
        description,
        ...(parameters ? { parameters } : {}),
      }
    })
  }

  return {
    extensionId,
    viewId,
    context,
    lessonContext,
    language,
    ...(model ? { model } : {}),
    ...(voice ? { voice } : {}),
    ...(tools ? { tools } : {}),
  }
}

export function downsampleFloat32(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= 0 || toRate <= 0 || Math.abs(fromRate - toRate) < 1) {
    return input
  }
  const ratio = fromRate / toRate
  const length = Math.max(1, Math.floor(input.length / ratio))
  const output = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const next = Math.min(idx + 1, input.length - 1)
    const frac = pos - idx
    output[i] = (input[idx] ?? 0) * (1 - frac) + (input[next] ?? 0) * frac
  }
  return output
}
