import { createHmac } from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const DEFAULT_PERIOD_SECONDS = 30
const DEFAULT_DIGITS = 6

export interface TotpCode {
  code: string
  digits: number
  period: number
  remaining: number
}

/**
 * Accept either a Google-style `otpauth://totp/...` URI (what the 2FA page QR
 * encodes) or a raw Base32 seed. Google TOTP is SHA-1, 6 digits, 30 seconds.
 */
export function normalizeTotpSecret(input: string): string {
  const raw = input.trim()
  let seed = raw
  if (/^otpauth:\/\//i.test(raw)) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new Error('That otpauth link is not valid')
    }
    if (url.host.toLowerCase() !== 'totp') throw new Error('Only TOTP otpauth links are supported')
    const algorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase()
    if (algorithm !== 'SHA1') throw new Error('Only SHA-1 TOTP secrets are supported')
    const digits = Number(url.searchParams.get('digits') ?? DEFAULT_DIGITS)
    if (digits !== DEFAULT_DIGITS) throw new Error('Only 6-digit TOTP secrets are supported')
    const period = Number(url.searchParams.get('period') ?? DEFAULT_PERIOD_SECONDS)
    if (period !== DEFAULT_PERIOD_SECONDS) throw new Error('Only 30-second TOTP secrets are supported')
    seed = url.searchParams.get('secret') ?? ''
  }
  const normalized = seed.replace(/[\s-]/g, '').replace(/=+$/g, '').toUpperCase()
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new Error('2FA secret must be a Base32 code or an otpauth:// link')
  }
  if (normalized.length < 16) throw new Error('2FA secret is too short')
  return normalized
}

export function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/=+$/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character)
    if (index < 0) throw new Error('2FA secret contains an invalid Base32 character')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

export function generateTotp(secret: string, now = Date.now()): TotpCode {
  const key = base32Decode(normalizeTotpSecret(secret))
  const period = DEFAULT_PERIOD_SECONDS
  const counter = Math.floor(now / 1_000 / period)
  const buffer = Buffer.alloc(8)
  buffer.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0)
  buffer.writeUInt32BE(counter >>> 0, 4)
  const digest = createHmac('sha1', key).update(buffer).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff)
  const code = String(binary % 10 ** DEFAULT_DIGITS).padStart(DEFAULT_DIGITS, '0')
  const remaining = period - (Math.floor(now / 1_000) % period)
  return { code, digits: DEFAULT_DIGITS, period, remaining }
}
