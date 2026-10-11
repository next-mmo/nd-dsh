import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runArtifactVerification, type ArtifactFingerprintRunner } from '../src/main/organization/verification-evidence.js'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nd-artifact-evidence-'))
  temporary.push(root)
  return root
}

describe('artifact verification', () => {
  it('records the fingerprints ND Core returns for the declared artifacts', async () => {
    const root = await workspace()
    const calls: Array<{ root: string; paths: readonly string[] }> = []
    const fingerprint: ArtifactFingerprintRunner = async (target, paths) => {
      calls.push({ root: target, paths })
      return paths.map((path) => ({
        path,
        kind: path === 'design' ? ('directory' as const) : ('file' as const),
        size: 12,
        sha256: 'a'.repeat(64),
      }))
    }

    const evidence = await runArtifactVerification(['research.md', 'design', 'research.md'], root, fingerprint)
    expect(evidence.status).toBe('passed')
    expect(evidence.artifacts?.map((item) => item.path)).toEqual(['research.md', 'design'])
    expect(evidence.artifacts?.every((item) => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.root).toBe(root)
    expect(calls[0]?.paths).toEqual(['research.md', 'design'])
  })

  it('fails closed when ND Core refuses the artifact, is unwired, or the path escapes before hashing', async () => {
    const root = await workspace()

    const refused = await runArtifactVerification(['missing.txt'], root, async () => {
      throw new Error('artifact path is unavailable: missing.txt')
    })
    expect(refused.status).toBe('failed')
    expect(refused.reason).toMatch(/artifact verification failed/i)

    const unwired = await runArtifactVerification(['research.md'], root)
    expect(unwired.status).toBe('failed')
    expect(unwired.reason).toMatch(/artifact verification failed/i)
    expect(unwired.reason).toMatch(/ND Core/i)

    let requested = false
    const escaped = await runArtifactVerification(['../outside.txt'], root, async () => {
      requested = true
      return []
    })
    expect(escaped.status).toBe('failed')
    expect(escaped.reason).toMatch(/escapes the task workspace/i)
    expect(requested).toBe(false)
  })
})
