import { cn } from '../lib/utils'

export interface ChatAvatarTone {
  id: string
  from: string
  to: string
}

export type ChatAvatarStatus = 'idle' | 'busy' | 'archived' | 'none'

/**
 * Curated soft-vivid avatar gradients tuned for crisp white monograms on both
 * dark and light ND surfaces.
 */
export const CHAT_AVATAR_TONES: readonly ChatAvatarTone[] = [
  { id: 'sage', from: '#68b88a', to: '#48956b' },
  { id: 'periwinkle', from: '#7494ff', to: '#516ff2' },
  { id: 'tangerine', from: '#f6a452', to: '#e67f2e' },
  { id: 'coral', from: '#f3846f', to: '#de5879' },
  { id: 'violet', from: '#a182ff', to: '#7959eb' },
  { id: 'teal', from: '#40c2b5', to: '#27959a' },
  { id: 'rose', from: '#ed749f', to: '#cf4c7d' },
  { id: 'azure', from: '#52b1f2', to: '#3184d4' },
] as const

const GENERIC_CHAT_TITLES = new Set([
  'new chat',
  'new session',
  'untitled',
  'untitled chat',
  'chat',
  'session',
])

function hashSeed(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Deterministic avatar gradient tone for a chat, agent, or author seed. */
export function chatAvatarTone(seed: string): ChatAvatarTone {
  const normalized = seed.trim().toLowerCase() || 'nd'
  const index = hashSeed(normalized) % CHAT_AVATAR_TONES.length
  return CHAT_AVATAR_TONES[index]!
}

function extractTokens(value: string): string[] {
  const matches = value.match(/[\p{L}\p{N}]+/gu)
  return matches ?? []
}

/**
 * Derives a crisp 2-character monogram (e.g. `Shop_bot` -> `SH`,
 * `Coupon launch` -> `CO`, `A quick fix` -> `AQ`). Falls back to `fallbackName`
 * when `name` is empty or a generic placeholder like "New chat".
 */
export function chatAvatarMonogram(name: string, fallbackName?: string): string {
  const trimmed = name.trim()
  const useFallback = !trimmed || GENERIC_CHAT_TITLES.has(trimmed.toLowerCase())
  const primaryTokens = useFallback ? [] : extractTokens(trimmed)
  const tokens = primaryTokens.length > 0
    ? primaryTokens
    : extractTokens(fallbackName?.trim() ?? '')

  if (tokens.length === 0) return 'ND'

  const firstChars = Array.from(tokens[0]!)
  if (firstChars.length >= 2) {
    return `${firstChars[0]}${firstChars[1]}`.toUpperCase()
  }
  if (tokens.length >= 2) {
    const secondFirst = Array.from(tokens[1]!)[0] ?? ''
    return `${firstChars[0]}${secondFirst}`.toUpperCase()
  }
  return firstChars[0]!.toUpperCase()
}

export interface ChatAvatarProps {
  /** Display name or chat title used for the 2-letter monogram. */
  name: string
  /** Used for the monogram when `name` is empty or a generic placeholder. */
  fallbackName?: string | undefined
  /** Stable identifier for deterministic color selection (defaults to `name`). */
  seed?: string | undefined
  /** Diameter in pixels (default 28). */
  size?: number
  /** Optional bottom-right status badge (`idle`, `busy`, `archived`, or `none`). */
  status?: ChatAvatarStatus
  /** Ring class creating a crisp surface-matched cutout around the status dot. */
  ringClassName?: string
  className?: string
}

/**
 * Circular monogram avatar with a deterministic gradient and optional
 * bottom-right presence dot (green when idle, pulsing blue when running).
 */
export function ChatAvatar({
  name,
  fallbackName,
  seed,
  size = 28,
  status = 'none',
  ringClassName = 'ring-sidebar',
  className,
}: ChatAvatarProps) {
  const monogram = chatAvatarMonogram(name, fallbackName)
  const tone = chatAvatarTone(seed?.trim() || name || fallbackName || 'nd')
  const fontSize = Math.max(8, Math.round(size * 0.37))
  const dotSize = size >= 28 ? 9 : size >= 22 ? 8 : 7

  return (
    <span
      aria-hidden="true"
      data-avatar-tone={tone.id}
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center rounded-full font-bold tracking-[0.02em] text-white',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize,
        lineHeight: 1,
        backgroundImage: `linear-gradient(140deg, ${tone.from} 0%, ${tone.to} 100%)`,
        boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.24), 0 1px 2px rgba(0, 0, 0, 0.16)',
      }}
    >
      <span className="leading-none">{monogram}</span>
      {status !== 'none' ? (
        <span
          data-avatar-status={status}
          className={cn(
            'absolute -bottom-[1px] -right-[1px] rounded-full ring-2 transition-colors',
            ringClassName,
            status === 'busy'
              ? 'animate-pulse-dot bg-primary'
              : status === 'idle'
                ? 'bg-success'
                : 'bg-faint',
          )}
          style={{ width: dotSize, height: dotSize }}
        />
      ) : null}
    </span>
  )
}
