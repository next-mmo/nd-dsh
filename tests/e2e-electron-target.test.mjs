import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { electronLaunchOptions, electronTargetIdentity, payloadFiles } from '../scripts/e2e-electron-target.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Electron release target', () => {
  it('hashes artifacts spanning several chunks without changing their byte identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-e2e-large-target-'))
    roots.push(root)
    const executable = join(root, 'large.exe')
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 42)
    bytes[1024 * 1024] = 7
    bytes[bytes.length - 1] = 99
    await writeFile(executable, bytes)
    expect(electronTargetIdentity({ ND_DSH_E2E_EXECUTABLE: executable }).sha256)
      .toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it('overrides an inherited real profile with the disposable test profile', () => {
    const options = electronLaunchOptions('test-profile', 'checkout', { ND_DSH_USER_DATA_DIR: 'real-profile' })
    expect(options.args).toEqual(['.', '--user-data-dir=test-profile'])
    expect(options.env.ND_DSH_USER_DATA_DIR).toBe('test-profile')
    expect(options.executablePath).toBeUndefined()
  })

  it('launches the selected package without the source entry and records its hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-e2e-target-'))
    roots.push(root)
    const executable = join(root, 'ND-DSH-test.exe')
    await writeFile(executable, 'test-package-placeholder')
    const env = { ND_DSH_E2E_EXECUTABLE: executable, ND_DSH_NODE_BIN: 'host-node', ND_DSH_HARNESS_ROOT: 'source-runtime', ND_DSH_CORE_BIN: 'debug-core', ND_AGENT_BINARY: 'debug-agent' }
    const options = electronLaunchOptions('test-profile', root, env)
    expect(options.executablePath).toBe(executable)
    expect(options.args).toEqual(['--user-data-dir=test-profile'])
    expect(options.env.ND_DSH_NODE_BIN).toBeUndefined()
    expect(options.env.ND_DSH_HARNESS_ROOT).toBeUndefined()
    expect(options.env.ND_DSH_CORE_BIN).toBeUndefined()
    expect(options.env.ND_AGENT_BINARY).toBeUndefined()
    const hash = createHash('sha256').update('test-package-placeholder').digest('hex')
    expect(electronTargetIdentity(env).artifact).toBe('ND-DSH-test.exe#sha256:' + hash)
    await writeFile(executable, 'different-test-package')
    expect(electronTargetIdentity(env).artifact).not.toBe('ND-DSH-test.exe#sha256:' + hash)
  })

  it('rejects missing and directory targets instead of testing source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-e2e-invalid-target-'))
    roots.push(root)
    expect(() => electronLaunchOptions('test-profile', root, { ND_DSH_E2E_EXECUTABLE: join(root, 'missing.exe') })).toThrow()
    const directory = join(root, 'directory.exe')
    await mkdir(directory)
    expect(() => electronTargetIdentity({ ND_DSH_E2E_EXECUTABLE: directory })).toThrow(/must be a file/)
  })

  it('binds extracted app contents to the exact portable and rejects payload changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-e2e-extraction-'))
    roots.push(root)
    const portablePath = join(root, 'ND-DSH-test-portable.exe')
    await writeFile(portablePath, 'dummy portable bytes')
    const portable = electronTargetIdentity({ ND_DSH_E2E_EXECUTABLE: portablePath })
    const payloadRoot = join(root, 'payload')
    await mkdir(payloadRoot)
    const executable = join(payloadRoot, 'ND-DSH.exe')
    await writeFile(executable, 'dummy packaged app')
    await writeFile(join(payloadRoot, 'app.asar'), 'dummy renderer')
    const files = payloadFiles(payloadRoot)
    const receipt = join(root, 'proof.json')
    const proof = { kind: 'nd-portable-extraction', portable, executable, payloadRoot, files,
      payloadSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') }
    await writeFile(receipt, JSON.stringify(proof))
    const env = { ND_DSH_E2E_EXECUTABLE: executable, ND_DSH_E2E_PACKAGE_RECEIPT: receipt }
    expect(electronTargetIdentity(env).artifact).toBe(portable.artifact)
    expect(electronTargetIdentity(env).executable).toBe(executable)
    await writeFile(join(payloadRoot, 'app.asar'), 'changed renderer')
    expect(() => electronTargetIdentity(env)).toThrow(/payload changed/)
    await writeFile(join(payloadRoot, 'app.asar'), 'dummy renderer')
    await writeFile(join(payloadRoot, 'extra.js'), 'unattested file')
    expect(() => electronTargetIdentity(env)).toThrow(/payload changed/)
    await rm(join(payloadRoot, 'extra.js'))
    await writeFile(portablePath, 'changed portable bytes')
    expect(() => electronTargetIdentity(env)).toThrow(/Portable artifact changed/)
  })
})
