export interface SessionStateBadgeMeta {
  label: string
  tone: 'idle' | 'accent' | 'ok' | 'warn' | 'bad'
}

export function describeSessionState(state: string): SessionStateBadgeMeta

export function formatTransportKind(kind: string): string

export function summarizeUserAgent(ua?: string): string

export function formatInjectionSummary(snapshot?: {
  injectedChars?: number
  injectedKeys?: number
} | null): string