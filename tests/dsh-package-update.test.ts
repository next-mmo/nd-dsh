import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

let runtimeRoot: string
let latestVersion: unknown
let registryExitCode: number
let installExitCode: number
let calls: string[][]
let logs: string[]

function packageFile(name: string, file: string): string {
  return join(runtimeRoot, 'node_modules', '@deepseek-ai', name, file)
}

function put(path: string, content = 'export {}\n'): void {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function installed(version = '0.2.0', adapterVersion = version): void {
  put(packageFile('dsh', 'package.json'), JSON.stringify({ version }))
  put(packageFile('dsh', 'lib/bin.js'))
  put(packageFile('cordis-plugin-group', 'lib/index.js'))
  put(packageFile('dsh-subagent-codex', 'package.json'), JSON.stringify({ version: adapterVersion }))
  put(packageFile('dsh-subagent-codex', 'lib/index.js'))
}

async function runInstaller(): Promise<void> {
  const script = '../scripts/install-harness-runtime.mjs'
  await import(script)
}

beforeEach(async () => {
  vi.resetModules()
  runtimeRoot = await mkdtemp(join(tmpdir(), 'nd-dsh-package-update-'))
  vi.stubEnv('ND_DSH_MANAGED_RUNTIME_ROOT', runtimeRoot)
  vi.stubEnv('ND_DSH_NPM_CLI', process.execPath)
  latestVersion = '0.2.0'
  registryExitCode = 0
  installExitCode = 0
  calls = []
  logs = []
  vi.spyOn(console, 'log').mockImplementation((message) => { logs.push(String(message)) })
  spawnMock.mockImplementation((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    const npmArgs = args.slice(args.findIndex((arg) => arg === 'view' || arg === 'install'))
    calls.push(npmArgs)
    queueMicrotask(() => {
      if (npmArgs[0] === 'view') {
        child.stdout.end(JSON.stringify(latestVersion))
        child.emit('close', registryExitCode)
      } else {
        if (installExitCode === 0) installed(String(latestVersion))
        child.emit('close', installExitCode)
      }
    })
    return child
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(runtimeRoot, { recursive: true, force: true })
})

describe('published DSH package updater', () => {
  it('hides registry and install children without inheriting Windows console descriptors', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    spawnMock.mockImplementation((_command: string, args: string[], options: object) => {
      expect(options).toMatchObject({ windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
      queueMicrotask(() => {
        if (args.includes('view')) child.stdout.end(JSON.stringify(latestVersion))
        else {
          installed(String(latestVersion))
          child.stdout.end('install progress\n')
        }
        child.stderr.end('npm diagnostic\n')
        child.emit('close', 0)
      })
      return child
    })
    await runInstaller()
    expect(spawnMock).toHaveBeenCalledTimes(3)
    expect(stdout).toHaveBeenCalledWith('install progress\n')
    expect(stdout).not.toHaveBeenCalledWith(JSON.stringify(latestVersion))
    expect(stderr).toHaveBeenCalledWith(Buffer.from('npm diagnostic\n'))
  })

  it('checks latest and skips all installs for a complete matching runtime', async () => {
    installed()
    const before = readFileSync(packageFile('dsh', 'package.json'), 'utf8')
    await runInstaller()
    expect(calls).toEqual([['view', '@deepseek-ai/dsh@latest', 'version', '--json', '--fetch-retries=0', '--fetch-timeout=30000']])
    expect(readFileSync(packageFile('dsh', 'package.json'), 'utf8')).toBe(before)
    expect(existsSync(join(runtimeRoot, 'package.json'))).toBe(false)
    expect(logs).toContain('DSH package already up to date at version 0.2.0. Skipping install; no restart required.')
    expect(logs.some((line) => line.startsWith('DSH package installed'))).toBe(false)
  })

  it.each(['absent', 'older'])('installs the checked release when runtime is %s', async (state) => {
    if (state === 'older') installed('0.1.0')
    await runInstaller()
    expect(calls.map((args) => args[0])).toEqual(['view', 'install', 'install'])
    expect(calls[1]).toContain('@deepseek-ai/dsh@0.2.0')
    expect(calls[1]).not.toContain('@deepseek-ai/dsh@latest')
    expect(calls[2]).toContain('@deepseek-ai/dsh-subagent-codex@0.2.0')
    expect(logs).toContain('DSH package installed at version 0.2.0.')
  })

  it.each([
    ['dsh', 'lib/bin.js'],
    ['cordis-plugin-group', 'lib/index.js'],
    ['dsh-subagent-codex', 'lib/index.js'],
  ])('repairs matching runtime missing %s %s', async (name, file) => {
    installed()
    await rm(packageFile(name, file))
    await runInstaller()
    expect(calls.filter((args) => args[0] === 'install')).toHaveLength(2)
  })

  it('repairs mismatched adapter version', async () => {
    installed('0.2.0', '0.1.0')
    await runInstaller()
    expect(calls.filter((args) => args[0] === 'install')).toHaveLength(2)
  })

  it('repairs invalid local version metadata', async () => {
    installed()
    put(packageFile('dsh', 'package.json'), '{broken')
    await runInstaller()
    expect(calls.filter((args) => args[0] === 'install')).toHaveLength(2)
  })

  it('does not install or report success after a registry failure', async () => {
    installed()
    registryExitCode = 1
    await expect(runInstaller()).rejects.toThrow('npm version check exited with code 1.')
    expect(calls).toHaveLength(1)
    expect(logs.some((line) => line.includes('already up to date'))).toBe(false)
  })

  it.each([null, '', ['0.2.0'], 'latest'])('rejects invalid registry version %j before installing', async (value) => {
    latestVersion = value
    await expect(runInstaller()).rejects.toThrow('invalid DSH version metadata')
    expect(calls).toHaveLength(1)
    expect(existsSync(join(runtimeRoot, 'package.json'))).toBe(false)
  })

  it('preserves install failures rather than reporting a skip', async () => {
    installExitCode = 1
    await expect(runInstaller()).rejects.toThrow('npm install exited with code 1.')
    expect(calls).toHaveLength(2)
    expect(logs.some((line) => line.includes('already up to date'))).toBe(false)
  })

  it('reinstalls a clean tree when top-level siblings come from different releases', async () => {
    installed()
    put(packageFile('dsh-scope', 'package.json'), JSON.stringify({ version: '0.1.0' }))
    put(packageFile('dsh-session', 'package.json'), JSON.stringify({ version: '0.2.0' }))
    await runInstaller()
    expect(calls.filter((args) => args[0] === 'install')).toHaveLength(2)
    expect(logs.some((line) => line.startsWith('Managed runtime holds sibling packages from 2 different releases') && line.includes('0.1.0') && line.includes('0.2.0'))).toBe(true)
    expect(logs.some((line) => line.includes('already up to date'))).toBe(false)
  })

  it('reinstalls a clean tree when a package is duplicated inside another package', async () => {
    installed()
    // Both copies report the same version, so only the duplicate is detectable.
    put(packageFile('dsh-scope', 'package.json'), JSON.stringify({ version: '0.2.0' }))
    put(packageFile('dsh-base', 'package.json'), JSON.stringify({ version: '0.2.0' }))
    const nested = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-base', 'node_modules', '@deepseek-ai', 'dsh-scope', 'package.json')
    put(nested, JSON.stringify({ version: '0.2.0' }))
    await runInstaller()
    expect(calls.filter((args) => args[0] === 'install')).toHaveLength(2)
    expect(logs.some((line) => line.startsWith('Managed runtime loads duplicate copies') && line.includes('dsh-scope nested in dsh-base'))).toBe(true)
    expect(logs.some((line) => line.includes('already up to date'))).toBe(false)
  })

  it('treats an unreadable sibling manifest as a differing release', async () => {
    installed()
    put(packageFile('dsh-scope', 'package.json'), '{broken')
    put(packageFile('dsh-session', 'package.json'), JSON.stringify({ version: '0.2.0' }))
    await runInstaller()
    expect(calls.filter((args) => args[0] === 'install')).toHaveLength(2)
  })

  it('drops the previous tree so an orphaned sibling cannot survive the install', async () => {
    installed()
    put(packageFile('dsh-scope', 'package.json'), JSON.stringify({ version: '0.1.0' }))
    put(packageFile('dsh-session', 'package.json'), JSON.stringify({ version: '0.2.0' }))
    put(packageFile('dsh-scope', 'ORPHAN'))
    await runInstaller()
    expect(existsSync(packageFile('dsh-scope', 'ORPHAN'))).toBe(false)
  })

  it('keeps the skip fast path for a uniform release with no nested copies', async () => {
    installed()
    put(packageFile('dsh-scope', 'package.json'), JSON.stringify({ version: '0.2.0' }))
    put(packageFile('dsh-session', 'package.json'), JSON.stringify({ version: '0.2.0' }))
    await runInstaller()
    expect(calls.filter((args) => args[0] === 'install')).toHaveLength(0)
    expect(logs).toContain('DSH package already up to date at version 0.2.0. Skipping install; no restart required.')
  })

  it('rewrites a stale runtime manifest so earlier pins cannot leak into the install', async () => {
    installed('0.1.0', '0.1.0')
    const manifest = join(runtimeRoot, 'package.json')
    put(manifest, JSON.stringify({
      name: 'nd-dsh-managed-runtime',
      private: true,
      dependencies: { '@deepseek-ai/dsh': '0.1.0', '@deepseek-ai/dsh-subagent-codex': '0.1.0' },
    }))
    await runInstaller()
    expect(calls.filter((args) => args[0] === 'install')).toHaveLength(2)
    expect(JSON.parse(readFileSync(manifest, 'utf8')).dependencies).toBeUndefined()
  })
})
