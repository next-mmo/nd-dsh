import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RouterSafeModeStore } from '../src/main/router/router-safe-mode-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('RouterSafeModeStore', () => {
  it('is off by default and persists the explicit choice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-router-safe-mode-'))
    roots.push(root)
    const path = join(root, 'router-safe-mode.json')
    const first = new RouterSafeModeStore(path)
    expect(first.enabled()).toBe(false)

    first.setEnabled(true)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, enabled: true })
    expect(new RouterSafeModeStore(path).enabled()).toBe(true)
  })
})
