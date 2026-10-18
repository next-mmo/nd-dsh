export interface SrtBlock {
  index: number
  timecode: string
  text: string
  speakerTag?: string | undefined
}

export interface SrtTranslateRequest {
  srt?: string | undefined
  filePath?: string | undefined
  targetLanguage?: string | undefined
  batchSize?: number | undefined
  engine?: string | undefined
  engineId?: string | undefined
  sessionId?: string | undefined
  outputPath?: string | undefined
  instructions?: string | undefined
  cwd?: string | undefined
}

export interface SrtTranslateResponse {
  ok: boolean
  targetLanguage: string
  totalBlocks: number
  batches: number
  engineId: string
  sessionId: string
  srt: string
  outputPath?: string | undefined
  error?: string | undefined
}

export interface RestApiRunRequest {
  prompt: string
  engine?: string | undefined
  engineId?: string | undefined
  sessionId?: string | undefined
  cwd?: string | undefined
  permissionMode?: string | undefined
}

export interface RestApiRunResponse {
  ok: boolean
  engineId: string
  sessionId: string
  response: string
  error?: string | undefined
}

export interface RestApiStatusResponse {
  ok: boolean
  status: string
  port: number
  endpoint: string
  defaultEngine: string
  availableEngines: string[]
  workspace: string
}
