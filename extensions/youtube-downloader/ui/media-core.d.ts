export interface UiMediaJob {
  id: string
  mode: 'video' | 'audio'
  state: 'starting' | 'downloading' | 'processing' | 'completed' | 'canceled' | 'failed'
  receivedBytes: number
  totalBytes: number | null
  speedBps: number | null
  etaSeconds: number | null
  height: number | null
  fileName?: string | null
  title?: string
}

export interface UiStatusLike {
  setup: { state: string }
  jobs: UiMediaJob[]
  activeJobId?: string | null
}

export function formatBytes(bytes: number | null | undefined): string
export function formatSpeed(bytesPerSecond: number | null | undefined): string
export function formatEta(seconds: number | null | undefined): string
export function formatHeight(height: number | null | undefined): string
export function progressRatio(job: Pick<UiMediaJob, 'receivedBytes' | 'totalBytes'> | null | undefined): number | null
export function isActiveJob(job: Pick<UiMediaJob, 'state'> | null | undefined): boolean
export function nextPollDelay(status: UiStatusLike | null | undefined): number
export function stateLabel(state: string): string
export function modeLabel(mode: string): string
export function filenameForDisplay(job: UiMediaJob | null | undefined): string
