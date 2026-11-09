import { describe, expect, it } from 'vitest'
import { base32Decode, generateTotp, normalizeTotpSecret } from '../src/main/extensions/access-totp.js'

// RFC 6238 SHA-1 test seed ("12345678901234567890").
const RFC_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('access TOTP', () => {
  it('matches RFC 6238 SHA-1 vectors (6 digits)', () => {
    expect(generateTotp(RFC_SEED, 59_000).code).toBe('287082')
    expect(generateTotp(RFC_SEED, 1_111_111_109_000).code).toBe('081804')
    expect(generateTotp(RFC_SEED, 2_000_000_000_000).code).toBe('279037')
  })

  it('reports the remaining seconds in the current window', () => {
    const result = generateTotp(RFC_SEED, 59_000)
    expect(result.period).toBe(30)
    expect(result.remaining).toBe(1)
    expect(generateTotp(RFC_SEED, 60_000).remaining).toBe(30)
  })

  it('accepts raw Base32 and otpauth links', () => {
    expect(normalizeTotpSecret(RFC_SEED.toLowerCase())).toBe(RFC_SEED)
    expect(normalizeTotpSecret(`otpauth://totp/Test?secret=${RFC_SEED}&issuer=ND`)).toBe(RFC_SEED)
    expect(normalizeTotpSecret(`otpauth://totp/Test?secret=${RFC_SEED}&digits=6&period=30&algorithm=SHA1`)).toBe(RFC_SEED)
  })

  it('rejects non-Google TOTP variants and invalid seeds', () => {
    expect(() => normalizeTotpSecret(`otpauth://totp/Test?secret=${RFC_SEED}&algorithm=SHA256`)).toThrow(/SHA-1/i)
    expect(() => normalizeTotpSecret(`otpauth://totp/Test?secret=${RFC_SEED}&digits=8`)).toThrow(/6-digit/i)
    expect(() => normalizeTotpSecret(`otpauth://totp/Test?secret=${RFC_SEED}&period=60`)).toThrow(/30-second/i)
    expect(() => normalizeTotpSecret('not-base32!')).toThrow(/Base32/i)
    expect(() => normalizeTotpSecret('MZXW6')).toThrow(/too short/i)
  })

  it('decodes Base32', () => {
    expect(base32Decode('MZXW6').toString('utf8')).toBe('foo')
  })
})
