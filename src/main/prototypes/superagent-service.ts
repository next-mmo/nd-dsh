import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, promises as fs, type WriteStream } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { app } from 'electron'
import type { ProviderStore } from '../providers.js'
import { harnessCliBinPath, harnessNodeBinPath } from '../app-paths.js'
import { pickFreePort } from '../dsh/gateway-client.js'
import {
  SUPERAGENT_PROTOTYPE_DEFAULT_PORT,
  SUPERAGENT_PROTOTYPE_PROFILE,
  SUPERAGENT_PROTOTYPE_REPOSITORY,
  buildSuperagentProfilePatch,
  parseSuperagentPanelUrl,
  toDshPosixPath,
  type SuperagentPrototypePhase,
  type SuperagentPrototypePrerequisites,
  type SuperagentPrototypeStatus,
} from '../../shared/superagent-prototype.js'

const INSTALL_TIMEOUT_MS = 10 * 60_000
const COMMAND_TIMEOUT_MS = 60_000
const PREREQUISITE_CACHE_MS = 30_000
const STOP_TIMEOUT_MS = 8_000
const STALE_LOCK_RETRY_MS = 12_000
const LOG_TAIL_BYTES = 16_384
const OUTPUT_LIMIT_CHARS = 32_768

interface CommandResult {
  code: number
  output: string
}

interface ProfileManifest extends Record<string, unknown> {
  dependencies?: Record<string, string>
  dsh?: {
    profile?: {
      bundles?: string[]
    }
  }
}

/**
 * ND-owned lifecycle for the Superagent research prototype, a separate DSH
 * profile that serves its own web panel. ND spawns the bundled DSH CLI
 * directly so Windows does not need the upstream tmux/fcntl service scripts.
 */
export class SuperagentPrototypeService {
  private readonly checkoutPath = join(app.getPath('userData'), 'prototypes', 'dsh-superagent')
  private readonly prototypesRoot = dirname(this.checkoutPath)
  private readonly stateDirPath = join(this.prototypesRoot, 'superagent-state')
  private readonly logPath = join(this.prototypesRoot, 'superagent.log')
  private readonly dshHome = join(app.getPath('userData'), 'dsh-home')
  private readonly profileDir = join(this.dshHome, 'profiles', SUPERAGENT_PROTOTYPE_PROFILE)
  private child: ChildProcess | undefined
  private phase: SuperagentPrototypePhase = 'stopped'
  private panelUrl: string | undefined
  private message: string | undefined
  private installPromise: Promise<SuperagentPrototypeStatus> | undefined
  private installMessage: string | undefined
  private stopping = false
  private startAttempt = 0
  private retryTimer: NodeJS.Timeout | undefined
  private outputBuffer = ''
  private logStream: WriteStream | undefined
  private prerequisiteCache: { at: number; value: SuperagentPrototypePrerequisites } | undefined
  private port = SUPERAGENT_PROTOTYPE_DEFAULT_PORT

  constructor(private readonly providers: ProviderStore) {}

  async status(): Promise<SuperagentPrototypeStatus> {
    const prerequisites = await this.prerequisites()
    const installed = await this.isInstalled()
    let phase = this.phase
    if (this.installPromise) phase = 'installing'
    else if (!this.child && !installed && !this.stopping) phase = this.phase === 'error' ? 'error' : 'not-installed'
    else if (!this.child && phase === 'running') phase = 'stopped'
    const message = this.installMessage ?? this.message
    return {
      phase,
      checkoutPath: this.checkoutPath,
      stateDir: this.stateDirPath,
      profileDir: this.profileDir,
      logPath: this.logPath,
      port: this.port,
      prerequisites,
      ...(this.panelUrl ? { panelUrl: this.panelUrl } : {}),
      ...(message !== undefined ? { message } : {}),
      logTail: await this.readLogTail(),
    }
  }

  install(): Promise<SuperagentPrototypeStatus> {
    if (this.installPromise) return this.installPromise
    this.installPromise = this.runInstall()
      .catch((cause) => {
        this.message = cause instanceof Error ? cause.message : String(cause)
        this.phase = 'error'
      })
      .then(() => {
        this.installPromise = undefined
        this.installMessage = undefined
        return this.status()
      })
    return this.installPromise
  }

  async start(): Promise<SuperagentPrototypeStatus> {
    if (this.installPromise) return this.status()
    if (this.child) return this.status()
    if (!(await this.isInstalled())) {
      this.phase = 'not-installed'
      this.message = 'Install the Superagent prototype first.'
      return this.status()
    }
    this.startAttempt = 0
    this.stopping = false
    this.message = undefined
    await this.launch()
    return this.status()
  }

  async stop(): Promise<SuperagentPrototypeStatus> {
    this.stopping = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    const child = this.child
    if (!child?.pid) {
      this.child = undefined
      this.phase = 'stopped'
      this.panelUrl = undefined
      this.message = undefined
      this.stopping = false
      return this.status()
    }
    const pid = child.pid
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      if (process.platform === 'win32') {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'])
      } else {
        try {
          process.kill(-pid, 'SIGTERM')
        } catch {
          child.kill('SIGTERM')
        }
      }
    } catch {
      // The process may have exited between the status read and the kill.
    }
    await Promise.race([exited, delay(STOP_TIMEOUT_MS)])
    if (this.child) {
      try {
        this.child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      this.child = undefined
    }
    this.phase = 'stopped'
    this.panelUrl = undefined
    this.message = undefined
    this.stopping = false
    return this.status()
  }

  async open(): Promise<{ url?: string }> {
    return this.panelUrl ? { url: this.panelUrl } : {}
  }

  /** Fire-and-forget teardown for app shutdown; the next launch never reuses the child. */
  dispose(): void {
    void this.stop().catch(() => {})
    this.logStream?.end()
    this.logStream = undefined
  }

  private async runInstall(): Promise<void> {
    await fs.mkdir(this.prototypesRoot, { recursive: true })
    if (!existsSync(join(this.checkoutPath, 'package.json'))) {
      if (existsSync(this.checkoutPath)) {
        throw new Error(`The prototype install folder is not a checkout: ${this.checkoutPath}. Remove it and retry.`)
      }
      this.installMessage = 'Cloning the Superagent prototype…'
      await this.run('git', ['clone', '--depth=1', SUPERAGENT_PROTOTYPE_REPOSITORY, this.checkoutPath], this.prototypesRoot, undefined, INSTALL_TIMEOUT_MS)
    }
    this.installMessage = 'Installing prototype dependencies…'
    await this.runPnpm(['install'], this.checkoutPath, INSTALL_TIMEOUT_MS)
    this.installMessage = 'Building prototype bundles…'
    await this.runPnpm(['build'], this.checkoutPath, INSTALL_TIMEOUT_MS)

    await fs.mkdir(this.profileDir, { recursive: true })
    if (!existsSync(join(this.profileDir, 'package.json'))) {
      this.installMessage = 'Creating the isolated DSH profile…'
      await this.runDsh(['superagent', '--from-default-profile', 'web', '--dump-config'], 'Profile creation')
      await fs.mkdir(this.profileDir, { recursive: true })
    }
    this.installMessage = 'Writing the profile overlay…'
    const stateDir = toDshPosixPath(this.stateDirPath)
    await fs.writeFile(join(this.profileDir, 'cordis.patch.yml'), buildSuperagentProfilePatch({ port: SUPERAGENT_PROTOTYPE_DEFAULT_PORT, stateDir }), 'utf8')
    this.installMessage = 'Linking the bundle into the DSH profile…'
    await this.linkProfileBundle()
    await this.runPnpm(['install'], this.profileDir, INSTALL_TIMEOUT_MS)

    this.phase = 'stopped'
    this.message = 'Superagent prototype installed. Start it to open the panel.'
  }

  private async linkProfileBundle(): Promise<void> {
    const manifestPath = join(this.profileDir, 'package.json')
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>
    const manifest = raw as ProfileManifest
    const dependencies: Record<string, string> = {}
    if (isRecord(manifest.dependencies)) {
      for (const [name, version] of Object.entries(manifest.dependencies)) {
        if (typeof version === 'string') dependencies[name] = version
      }
    }
    dependencies['dsh-superagent'] = `link:${this.checkoutPath.replace(/\\/g, '/')}`
    const dsh = isRecord(manifest.dsh) ? { ...manifest.dsh } : {}
    const profile = isRecord(dsh.profile) ? { ...dsh.profile } : {}
    const bundles = Array.isArray(profile.bundles)
      ? profile.bundles.filter((entry): entry is string => typeof entry === 'string')
      : []
    if (!bundles.includes('dsh-superagent')) bundles.push('dsh-superagent')
    manifest.dependencies = dependencies
    manifest.dsh = { ...dsh, profile: { ...profile, bundles } }
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  private async launch(): Promise<void> {
    this.port = await pickFreePort()
    const stateDir = toDshPosixPath(this.stateDirPath)
    await fs.mkdir(this.profileDir, { recursive: true })
    await fs.writeFile(join(this.profileDir, 'cordis.patch.yml'), buildSuperagentProfilePatch({ port: this.port, stateDir }), 'utf8')
    this.panelUrl = undefined
    this.outputBuffer = ''
    this.phase = 'starting'
    this.message = `Starting Superagent on 127.0.0.1:${String(this.port)}…`
    this.log(`\n--- ND starting superagent on port ${String(this.port)} (${new Date().toISOString()}) ---\n`)

    const child = spawn(harnessNodeBinPath(), [
      harnessCliBinPath(),
      '--profile',
      SUPERAGENT_PROTOTYPE_PROFILE,
      '--no-open',
      '--port',
      String(this.port),
    ], {
      cwd: this.prototypesRoot,
      env: this.childEnvironment(),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.handleOutput(chunk))
    child.stderr?.on('data', (chunk: string) => this.handleOutput(chunk))
    child.once('error', (cause) => {
      if (this.child !== child) return
      this.child = undefined
      this.phase = 'error'
      this.message = `Superagent failed to spawn: ${cause.message}`
    })
    child.once('exit', (code) => {
      if (this.child !== child) return
      this.child = undefined
      if (this.stopping) return
      if (this.phase === 'running') {
        this.phase = 'stopped'
        this.panelUrl = undefined
        this.message = `Superagent exited (code ${String(code)}).`
        return
      }
      if (this.startAttempt < 1 && /Lock file is already being held/.test(this.outputBuffer)) {
        this.startAttempt += 1
        this.phase = 'starting'
        this.message = 'Waiting for the previous state lock to expire, then retrying…'
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined
          if (!this.child && !this.stopping) void this.launch()
        }, STALE_LOCK_RETRY_MS)
        this.retryTimer.unref()
        return
      }
      this.phase = 'error'
      this.message = `Superagent failed to start (code ${String(code)}).`
      this.log(`\n--- ND: startup failed with code ${String(code)} ---\n`)
    })
  }

  private handleOutput(chunk: string): void {
    this.log(chunk)
    this.outputBuffer = `${this.outputBuffer}${chunk}`.slice(-32_768)
    const panelUrl = parseSuperagentPanelUrl(this.outputBuffer)
    if (panelUrl && this.phase !== 'running') {
      this.panelUrl = panelUrl
      this.phase = 'running'
      this.message = undefined
      this.startAttempt = 0
    }
    if (this.phase === 'starting' && /startup failed/.test(this.outputBuffer)) {
      this.message = 'Superagent reported a startup failure.'
    }
  }

  private log(chunk: string): void {
    if (!this.logStream) {
      this.logStream = createWriteStream(this.logPath, { flags: 'a' })
      this.logStream.on('error', () => {})
    }
    this.logStream.write(chunk)
  }

  private async isInstalled(): Promise<boolean> {
    return existsSync(join(this.checkoutPath, 'package.json'))
      && existsSync(join(this.profileDir, 'package.json'))
      && existsSync(join(this.profileDir, 'node_modules', 'dsh-superagent', 'package.json'))
  }

  private async prerequisites(): Promise<SuperagentPrototypePrerequisites> {
    const cached = this.prerequisiteCache
    if (cached && Date.now() - cached.at < PREREQUISITE_CACHE_MS) return cached.value
    const value = {
      git: Boolean(this.executableOnPath('git')),
      pnpm: Boolean(this.corepackEntry()) || Boolean(this.executableOnPath('pnpm')),
      gh: Boolean(this.executableOnPath('gh')),
    }
    this.prerequisiteCache = { at: Date.now(), value }
    return value
  }

  private executableOnPath(name: string): string | undefined {
    const directories = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
    const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
    for (const directory of directories) {
      for (const extension of extensions) {
        const candidate = join(directory, `${name}${extension}`)
        if (existsSync(candidate)) return candidate
      }
    }
    return undefined
  }

  private async runPnpm(args: string[], cwd: string, timeoutMs: number): Promise<void> {
    const corepack = this.corepackEntry()
    const result = corepack
      ? await this.capture(harnessNodeBinPath(), [corepack, 'pnpm', ...args], cwd, this.childEnvironment(), timeoutMs)
      : await this.capture(process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'pnpm',
        process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm', ...args] : args,
        cwd, this.childEnvironment(), timeoutMs)
    if (result.code !== 0) throw new Error(`pnpm ${args[0] ?? ''} failed: ${diagnostics(result.output, result.code)}`)
  }

  private async runDsh(args: string[], label: string): Promise<void> {
    const result = await this.capture(harnessNodeBinPath(), [harnessCliBinPath(), ...args], this.prototypesRoot, this.childEnvironment(), INSTALL_TIMEOUT_MS)
    if (result.code !== 0) throw new Error(`${label} failed: ${diagnostics(result.output, result.code)}`)
  }

  private corepackEntry(): string | undefined {
    const dir = dirname(process.execPath)
    const candidates = [
      join(dir, 'node_modules', 'corepack', 'dist', 'corepack.js'),
      join(dir, '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
      join(dir, '..', 'node_modules', 'corepack', 'dist', 'corepack.js'),
    ]
    const directories = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
    for (const directory of directories) {
      candidates.push(join(directory, 'node_modules', 'corepack', 'dist', 'corepack.js'))
    }
    return candidates.find((candidate) => existsSync(candidate))
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const runtime = this.providers.runtimeConfig()
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...runtime.environment,
      ND_DSH_LLM_PROVIDERS_JSON: JSON.stringify(runtime.profiles),
      ND_DSH_DEEPSEEK_ENABLED: this.providers.list().some((provider) => provider.id === 'deepseek' && provider.enabled) ? '1' : '0',
      DSH_HOME: this.dshHome,
    }
    if (runtime.defaultProvider) environment.ND_DSH_DEFAULT_PROVIDER = runtime.defaultProvider
    if (runtime.defaultModel) environment.ND_DSH_DEFAULT_MODEL = runtime.defaultModel
    delete environment.ELECTRON_RUN_AS_NODE
    return environment
  }

  private async readLogTail(): Promise<string[]> {
    try {
      const handle = await fs.open(this.logPath, 'r')
      try {
        const stat = await handle.stat()
        const size = Math.min(stat.size, LOG_TAIL_BYTES)
        if (size === 0) return []
        const buffer = Buffer.alloc(size)
        await handle.read(buffer, 0, size, Math.max(0, stat.size - size))
        return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-30)
      } finally {
        await handle.close()
      }
    } catch {
      return []
    }
  }

  private run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv | undefined, timeoutMs: number): Promise<void> {
    return this.capture(command, args, cwd, env, timeoutMs).then((result) => {
      if (result.code !== 0) throw new Error(`${command} failed: ${diagnostics(result.output, result.code)}`)
    })
  }

  private capture(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv | undefined, timeoutMs: number): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd,
        ...(env ? { env } : {}),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const finish = (code: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, output })
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(-1)
      }, timeoutMs)
      timer.unref()
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { output = `${output}${chunk}`.slice(-OUTPUT_LIMIT_CHARS) })
      child.stderr?.on('data', (chunk: string) => { output = `${output}${chunk}`.slice(-OUTPUT_LIMIT_CHARS) })
      child.once('error', (cause) => {
        output = `${output}${cause.message}`
        finish(-1)
      })
      child.once('exit', (code) => finish(code ?? -1))
    })
  }
}

function diagnostics(output: string, code: number): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines.slice(-6).join(' ') || `exit ${String(code)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

function execFileAsync(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}
