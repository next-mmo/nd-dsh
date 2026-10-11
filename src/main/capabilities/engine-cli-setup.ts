import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import {
  ND_CLAUDE_CODE_CAPABILITY_ID,
  ND_PI_CODING_CAPABILITY_ID,
  type CapabilityPackageSetupDescriptor,
  type CapabilityPrerequisiteResult,
} from '../../shared/capabilities.js'
import { bundledResourceRoot, managedEngineBinRoot } from '../app-paths.js'
import { backgroundProcessEnvironment } from '../core/background-process-environment.js'
import type { CapabilitySetupAdapter, CapabilitySetupAdapters, CapabilitySetupProgress } from './capability-registry.js'

type FixedCommandRunner = (command: string, args: readonly string[], cwd: string) => Promise<string>
type FixedCommand = { command: string; argsPrefix: readonly string[] }
type TarballDownloader = (url: string, targetPath: string) => Promise<string>

export interface ReviewedEnginePackage {
  capabilityId: string
  name: string
  packageId: string
  /** Exact version ND reviewed; floating tags are rejected by the registry. */
  version: string
  /** sha256 of the reviewed registry tarball, re-checked before every install. */
  integrity: `sha256-${string}`
  /** The reviewed registry tarball; ND's approved HTTPS source for this CLI. */
  tarball: string
  nodeRequirement: { major: number; minor: number }
  /** Binary name npm links into the managed prefix. */
  bin: string
}

const DOWNLOAD_TIMEOUT_MS = 180_000

/**
 * Engine CLIs ND installs on explicit user request through Settings →
 * Capabilities. Refresh a pin by reviewing the new registry tarball and
 * re-recording its version and sha256 digest together.
 */
export const REVIEWED_ENGINE_PACKAGES: readonly ReviewedEnginePackage[] = [
  {
    capabilityId: ND_PI_CODING_CAPABILITY_ID,
    name: 'Pi coding agent CLI',
    packageId: '@mariozechner/pi-coding-agent',
    version: '0.73.1',
    integrity: 'sha256-7bf5d492670c04fd7c599dee7e6eaabff964084affd216766107e6741df7a2e1',
    tarball: 'https://registry.npmjs.org/@mariozechner/pi-coding-agent/-/pi-coding-agent-0.73.1.tgz',
    nodeRequirement: { major: 20, minor: 6 },
    bin: 'pi',
  },
  {
    capabilityId: ND_CLAUDE_CODE_CAPABILITY_ID,
    name: 'Claude Code CLI',
    packageId: '@anthropic-ai/claude-code',
    version: '2.1.283',
    integrity: 'sha256-e9d3ee7e3c007c2e7c435ee8a64213a65f0341ae80abc51c1e9fde2614c351cb',
    tarball: 'https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.283.tgz',
    nodeRequirement: { major: 22, minor: 0 },
    bin: 'claude',
  },
]

export interface EngineCliSetupOptions {
  binRoot?: string
  nodeVersion?: string
  runCommand?: FixedCommandRunner
  downloadTarball?: TarballDownloader
  packages?: readonly ReviewedEnginePackage[]
}

/**
 * Approved-package setup for the engine CLIs published on npm. ND downloads
 * the reviewed tarball, verifies its recorded digest, then installs exactly
 * that artifact with npm into ND's own prefix; dependency resolution stays
 * npm's, and nothing is written to the user's global npm location.
 */
export function createEngineCliSetupAdapters(options: EngineCliSetupOptions = {}): CapabilitySetupAdapters {
  const packages = options.packages ?? REVIEWED_ENGINE_PACKAGES
  return Object.fromEntries(packages.map((reviewed) => [reviewed.capabilityId, createAdapter(reviewed, options)]))
}

function createAdapter(reviewed: ReviewedEnginePackage, options: EngineCliSetupOptions): CapabilitySetupAdapter {
  const binRoot = options.binRoot ?? managedEngineBinRoot()
  const runCommand = options.runCommand ?? runFixedCommand
  const downloadTarball = options.downloadTarball ?? downloadReviewedTarball
  const nodeVersion = options.nodeVersion ?? process.version
  const nodeLabel = `Node.js ${reviewed.nodeRequirement.major}.${reviewed.nodeRequirement.minor} or newer`
  const descriptor: CapabilityPackageSetupDescriptor = {
    mode: 'approved-package',
    sourceLabel: 'the official npm registry',
    sourceUrl: reviewed.tarball,
    packageId: reviewed.packageId,
    version: reviewed.version,
    integrity: reviewed.integrity,
    prerequisites: [nodeLabel, 'npm'],
    fields: [],
  }

  return {
    descriptor,
    checkPrerequisites: () => checkPrerequisites(reviewed, nodeLabel, nodeVersion, binRoot, runCommand),
    install: (_values, report) => enqueueInstall(() => installReviewedPackage(reviewed, binRoot, runCommand, downloadTarball, report)),
    verify: async () => {
      if (!installedBinPath(binRoot, reviewed.bin)) {
        throw new Error(`${reviewed.name} is not installed in ND's managed engine directory.`)
      }
    },
  }
}

async function checkPrerequisites(
  reviewed: ReviewedEnginePackage,
  nodeLabel: string,
  nodeVersion: string,
  binRoot: string,
  runCommand: FixedCommandRunner,
): Promise<CapabilityPrerequisiteResult[]> {
  const [major = 0, minor = 0] = nodeVersion.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10))
  const nodeMet = major > reviewed.nodeRequirement.major
    || (major === reviewed.nodeRequirement.major && minor >= reviewed.nodeRequirement.minor)
  const npm = resolveNpmCommand()
  let npmVersion: string | undefined
  if (npm) {
    try {
      const cwd = existsSync(binRoot) ? binRoot : process.cwd()
      npmVersion = (await runCommand(npm.command, [...npm.argsPrefix, '--version'], cwd)).trim().split(/\r?\n/).at(-1)
    } catch {
      npmVersion = undefined
    }
  }
  return [
    { id: 'node', label: nodeLabel, met: nodeMet, detail: nodeVersion },
    {
      id: 'npm',
      label: 'npm',
      met: Boolean(npmVersion),
      ...(npmVersion
        ? { detail: npmVersion }
        : { detail: npm ? 'The npm version probe failed.' : 'npm was not found beside a Node.js installation' }),
    },
  ]
}

async function installReviewedPackage(
  reviewed: ReviewedEnginePackage,
  binRoot: string,
  runCommand: FixedCommandRunner,
  downloadTarball: TarballDownloader,
  report: (progress: CapabilitySetupProgress) => Promise<void>,
): Promise<{ installedVersion: string; sourceUrl: string; integrity: string }> {
  const npm = resolveNpmCommand()
  if (!npm) throw new Error(`npm is required to install ${reviewed.packageId}.`)
  await mkdir(binRoot, { recursive: true })
  const artifactPath = join(binRoot, `.reviewed-${reviewed.bin}-${reviewed.version}.tgz`)
  try {
    await report({ state: 'downloading', progress: 20, message: `Downloading ${reviewed.packageId} ${reviewed.version}` })
    const integrity = await downloadTarball(reviewed.tarball, artifactPath)
    if (integrity !== reviewed.integrity) {
      throw new Error(`${reviewed.packageId} ${reviewed.version} failed integrity verification; the download was discarded.`)
    }
    await report({ state: 'installing', progress: 60, message: 'Installing the reviewed package with npm' })
    await runCommand(npm.command, [
      ...npm.argsPrefix,
      'install',
      '--global',
      '--prefix', binRoot,
      '--no-fund',
      '--no-audit',
      '--loglevel=error',
      artifactPath,
    ], binRoot)
    await report({ state: 'configuring', progress: 90, message: 'Checking the installed CLI' })
    if (!installedBinPath(binRoot, reviewed.bin)) {
      throw new Error(`${reviewed.packageId} installed without a ${reviewed.bin} command in ND's managed engine directory.`)
    }
    return { installedVersion: reviewed.version, sourceUrl: reviewed.tarball, integrity }
  } finally {
    await rm(artifactPath, { force: true }).catch(() => undefined)
  }
}

async function downloadReviewedTarball(url: string, targetPath: string): Promise<string> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`Download failed with HTTP ${String(response.status)}: ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const integrity = `sha256-${createHash('sha256').update(bytes).digest('hex')}`
  await writeFile(targetPath, bytes)
  return integrity
}

function installedBinPath(binRoot: string, bin: string): string | undefined {
  const candidates = process.platform === 'win32' ? [`${bin}.cmd`, bin] : [bin]
  return candidates.map((file) => join(binRoot, file)).find((entry) => existsSync(entry))
}

/**
 * Both CLIs install into one npm prefix, so runs are serialized; npm is not
 * safe to drive twice against the same prefix at once.
 */
let installQueue: Promise<unknown> = Promise.resolve()
function enqueueInstall<T>(task: () => Promise<T>): Promise<T> {
  const result = installQueue.then(task, task)
  installQueue = result.catch(() => undefined)
  return result
}

/**
 * Windows cannot spawn `npm.cmd` without a shell, so resolve the npm CLI entry
 * beside a real Node.js installation instead of going through `PATH` shims.
 */
function resolveNpmCommand(): FixedCommand | undefined {
  if (process.platform !== 'win32') return { command: 'npm', argsPrefix: [] }
  const searchDirectories = [
    ...(process.env.PATH ?? '').split(delimiter),
    process.env.NODE_HOME,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'nodejs') : undefined,
    process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'nodejs') : undefined,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs/nodejs') : undefined,
  ]
  for (const directory of searchDirectories) {
    if (!directory) continue
    const nodeDirectory = directory.replace(/^"|"$/g, '')
    const node = join(nodeDirectory, 'node.exe')
    const npmEntry = join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js')
    if (existsSync(node) && existsSync(npmEntry)) return { command: node, argsPrefix: [npmEntry] }
  }
  return undefined
}

function runFixedCommand(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: backgroundProcessEnvironment(
        { ...process.env, CI: 'true' },
        join(bundledResourceRoot(), 'scripts', 'nd-background-process.cjs'),
      ),
    })
    let output = ''
    const append = (chunk: string | Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-8_000)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolvePromise(output)
      else {
        const detail = output.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-6).join('\n')
        reject(new Error(detail || `${command} exited with code ${String(code)}`))
      }
    })
  })
}
