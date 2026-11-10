export interface StreamStateBadgeMeta {
  label: string
  tone: 'idle' | 'accent' | 'ok' | 'warn' | 'bad'
}

export function describeStreamState(state: string): StreamStateBadgeMeta

export function formatTransportKind(kind: string): string

export function formatLatencySummary(
  stats?: { rttMs?: number; jitterMs?: number } | null,
  client?: { latencyMs?: number; jitterMs?: number } | null,
): string

export function summarizeUserAgent(ua?: string): string

export function detectOutputDiagnostics(snapshot: {
  outputDevices?: unknown[]
  systemVolume?: { available?: boolean; muted?: boolean }
}): { ok: boolean; message?: string; warning?: string }
