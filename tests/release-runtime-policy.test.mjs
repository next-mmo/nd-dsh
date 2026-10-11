import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, truncate, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertNoOfficeEngines, removeOfficeEngines } from '../scripts/release-runtime-policy.mjs'

const checkSize = createRequire(import.meta.url)('../scripts/check-release-size.cjs')
const checkPayload = createRequire(import.meta.url)('../scripts/check-release-payload.cjs')
const roots = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function scratch() { const root = await mkdtemp(join(tmpdir(), 'nd-release-policy-')); roots.push(root); return root }

describe('release payload policy', () => {
  async function packagedFixture(electronPlatformName = 'win32') {
    const appOutDir = await scratch()
    const resources = electronPlatformName === 'darwin'
      ? join(appOutDir, 'ND-DSH.app', 'Contents', 'Resources') : join(appOutDir, 'resources')
    await mkdir(join(resources, 'vendor', 'deepseek-harness'), { recursive: true })
    await mkdir(join(resources, 'nd-extensions', 'translate'), { recursive: true })
    await mkdir(join(resources, 'scripts'), { recursive: true })
    await writeFile(join(resources, 'scripts', 'nd-agent-browser-cli.mjs'), '// fixture')
    await writeFile(join(resources, 'scripts', 'nd-background-process.cjs'), '// fixture')
    const manifestPath = join(resources, 'nd-extensions', 'translate', 'nd-extension.json')
    const manifest = JSON.parse(await readFile(new URL('../extensions/translate/nd-extension.json', import.meta.url), 'utf8'))
    return { appOutDir, electronPlatformName, manifestPath, manifest }
  }

  it.each(['win32', 'darwin'])('rejects a %s package that omits the optional Translate manifest', async (platform) => {
    const fixture = await packagedFixture(platform)
    await expect(checkPayload(fixture)).rejects.toThrow('ND Translate release manifest is missing or invalid')
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest))
    await expect(checkPayload(fixture)).resolves.toBeUndefined()
  })

  it('rejects a present Translate payload with mismatched identity or contributions', async () => {
    const fixture = await packagedFixture()
    await writeFile(fixture.manifestPath, JSON.stringify({ ...fixture.manifest, id: 'other.package' }))
    await expect(checkPayload(fixture)).rejects.toThrow('invalid identity or contributions')
    fixture.manifest.contributions.views[0].host = 'browser.openUrl'
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest))
    await expect(checkPayload(fixture)).rejects.toThrow('invalid identity or contributions')
  })

  it('rejects a corrupt Translate manifest before accepting a complete package', async () => {
    const fixture = await packagedFixture()
    await writeFile(fixture.manifestPath, '{broken json')
    await expect(checkPayload(fixture)).rejects.toThrow('missing or invalid')
  })

  it('removes native Office engines, including nested copies, and preserves runtime JS and other engines', async () => {
    const root = await scratch()
    const scope = join(root, 'node_modules', '@deepseek-ai')
    const native = join(scope, 'libreoffice-kit-win32-x64')
    const nested = join(scope, 'dsh-web-app', 'node_modules', '@deepseek-ai', 'libreoffice-kit-wasm')
    const wrapper = join(scope, 'libreoffice-kit')
    const codex = join(scope, 'dsh-subagent-codex')
    for (const directory of [native, nested, wrapper, codex]) await mkdir(directory, { recursive: true })
    await expect(assertNoOfficeEngines(root)).rejects.toThrow('native Office engines')
    expect(await removeOfficeEngines(root)).toBe(2)
    await assertNoOfficeEngines(root)
    expect((await stat(wrapper)).isDirectory()).toBe(true)
    expect((await stat(codex)).isDirectory()).toBe(true)
  })

  it('accepts a 400 MB download and rejects even one byte over budget', async () => {
    const root = await scratch()
    const path = join(root, 'ND-DSH.exe')
    await writeFile(path, '')
    await truncate(path, 400_000_000)
    expect(checkSize({ artifactPaths: [path] })).toEqual([])
    await truncate(path, 400_000_001)
    expect(() => checkSize({ artifactPaths: [path] })).toThrow('limit is 400 MB')
  })

  it('accepts an aliased staging root without following links outside staging', async () => {
    const parent = await scratch()
    const root = join(parent, 'staging')
    const alias = join(parent, 'alias')
    const scope = join(root, 'node_modules', '@deepseek-ai')
    const native = join(scope, 'libreoffice-kit-win32-x64')
    const external = await scratch()
    const externalEngine = join(external, 'node_modules', '@deepseek-ai', 'libreoffice-kit-wasm')
    await mkdir(native, { recursive: true })
    await mkdir(externalEngine, { recursive: true })
    await symlink(root, alias, 'junction')
    await symlink(external, join(scope, 'linked-package'), 'junction')
    expect(await removeOfficeEngines(alias)).toBe(1)
    await expect(stat(native)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(externalEngine)).isDirectory()).toBe(true)
  })
})
