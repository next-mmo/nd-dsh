/**
 * Pure deterministic helpers for ND Video Gen: bounds, choreography curves,
 * canvas text wrapping, codec selection, and export filename formatting.
 */

export const EXPORT_WIDTH = 720
export const EXPORT_HEIGHT = 1280
export const EXPORT_FPS = 30
export const EXPORT_BITRATE = 4_500_000
export const DURATION_CHOICES = [4, 6, 8]
export const DEFAULT_DURATION_SECONDS = 6
export const MAX_HOOK_CHARS = 72
export const MAX_CTA_CHARS = 36

export const DEFAULT_HOOK_TEXT = 'Ship local 3D motion in seconds.'
export const DEFAULT_CTA_TEXT = 'Built with ND Studio'

export const PREFERRED_VIDEO_MIME_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

/** Clamp duration to one of the supported bounded choices. */
export function clampDurationSeconds(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_DURATION_SECONDS
  let best = DEFAULT_DURATION_SECONDS
  let bestDistance = Infinity
  for (const choice of DURATION_CHOICES) {
    const distance = Math.abs(choice - numeric)
    if (distance < bestDistance) {
      bestDistance = distance
      best = choice
    }
  }
  return best
}

/** Normalize user-editable overlay text without breaking line clarity. */
export function normalizeOverlayText(value, fallback, maxChars) {
  if (typeof value !== 'string') return fallback
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trimStart()
  return cleaned.slice(0, maxChars)
}

/** Pick the highest-quality WebM MediaRecorder codec supported by this Chromium build. */
export function pickSupportedVideoMimeType(isTypeSupported) {
  if (typeof isTypeSupported !== 'function') return null
  for (const mimeType of PREFERRED_VIDEO_MIME_TYPES) {
    try {
      if (isTypeSupported(mimeType)) return mimeType
    } catch {
      // Ignore probe failure and continue down fallback chain.
    }
  }
  return null
}

export function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export function easeOutCubic(t) {
  const x = clamp01(t)
  return 1 - Math.pow(1 - x, 3)
}

export function easeInOutSine(t) {
  const x = clamp01(t)
  return -(Math.cos(Math.PI * x) - 1) / 2
}

/**
 * Compute deterministic 3D scene and burned-in overlay animation parameters
 * for normalized clip progress t in [0, 1].
 */
export function computeChoreography(progress) {
  const t = clamp01(progress)
  const intro = easeOutCubic(Math.min(1, t / 0.16))
  const ctaReveal = easeOutCubic(Math.max(0, Math.min(1, (t - 0.18) / 0.18)))
  const outroFade = t > 0.92 ? 1 - easeInOutSine((t - 0.92) / 0.08) * 0.15 : 1

  const orbitAngle = -0.38 + t * 0.92 + Math.sin(t * Math.PI * 2) * 0.08
  const cameraRadius = 5.45 - easeInOutSine(t) * 0.65
  const cameraY = 0.35 + Math.sin(t * Math.PI * 2) * 0.24

  const orbScale = 0.86 + intro * 0.14 + Math.sin(t * Math.PI * 4) * 0.025
  const orbSpinY = t * Math.PI * 2.25
  const orbSpinX = Math.sin(t * Math.PI * 2) * 0.28
  const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 4)

  const hookOpacity = intro * outroFade
  const hookOffsetY = (1 - intro) * 24

  const ctaOpacity = ctaReveal * outroFade
  const ctaOffsetY = (1 - ctaReveal) * 20

  return {
    t,
    orbitAngle,
    cameraRadius,
    cameraY,
    orbScale,
    orbSpinY,
    orbSpinX,
    pulse,
    hookOpacity,
    hookOffsetY,
    ctaOpacity,
    ctaOffsetY,
    accentSweep: easeInOutSine(Math.min(1, t / 0.32)),
  }
}

/** Word-wrap text to fit maxWidth and maxLines on a 2D canvas context. */
export function wrapCanvasLines(ctx, text, maxWidth, maxLines = 3) {
  const clean = (typeof text === 'string' ? text : '').trim()
  if (!clean) return []
  const words = clean.split(/\s+/)
  const lines = []
  let current = ''

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate
      continue
    }
    if (current) {
      lines.push(current)
      current = word
      if (lines.length === maxLines) break
    } else {
      lines.push(truncateToWidth(ctx, word, maxWidth))
      current = ''
      if (lines.length === maxLines) break
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(ctx.measureText(current).width <= maxWidth ? current : truncateToWidth(ctx, current, maxWidth))
  } else if (current && lines.length === maxLines) {
    const last = lines[maxLines - 1]
    lines[maxLines - 1] = truncateToWidth(ctx, `${last}…`, maxWidth)
  }

  return lines
}

function truncateToWidth(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text
  let out = text
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1)
  }
  return `${out}…`
}

/** Build a safe download filename for the rendered WebM clip. */
export function buildExportFilename(hookText) {
  const slug = (typeof hookText === 'string' ? hookText : '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return `nd-video-gen-${slug || 'studio-clip'}-720x1280.webm`
}
