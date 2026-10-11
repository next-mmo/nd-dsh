import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import {
  ND_CODEX_CLI_CAPABILITY_ID,
  ND_CODEX_DELEGATED_CAPABILITY_ID,
  ND_HARNESS_CAPABILITY_ID,
  ND_MEMORY_MCP_ID,
  ND_SESSION_RECALL_ID,
  type CapabilityPrerequisiteResult,
  type CapabilitySourceRuntimeSetupDescriptor,
} from '../../shared/capabilities.js'
import { bundledResourceRoot, codexBinPath, harnessRoot } from '../app-paths.js'
import { backgroundProcessEnvironment } from '../core/background-process-environment.js'
import type { CapabilitySetupAdapter, CapabilitySetupAdapters, CapabilitySetupProgress } from './capability-registry.js'

const HARNESS_SOURCE_URL = 'https://github.com/deepseek-ai/deepseek-harness'
const REQUIRED_NODE_MAJOR = 24

type FixedCommandRunner = (command: string, args: readonly string[], cwd: string) => Promise<string>
type FixedCommand = { command: string; argsPrefix: readonly string[] }

export interface HarnessSourceSetupOptions {
  harnessDirectory?: string
  nodeVersion?: string
  runCommand?: FixedCommandRunner
}

/**
 * Source checkouts keep generated Harness payloads out of Git. Expose one
 * fixed setup routine through the capability lifecycle so users can build the
 * runtime from Settings without giving the renderer command execution.
 * Packaged ND builds already bundle these payloads and do not use this path.
 */
export function createHarnessSourceSetupAdapters(options: HarnessSourceSetupOptions = {}): CapabilitySetupAdapters {
  const directory = options.harnessDirectory ?? harnessRoot()
  const manifestPath = join(directory, 'package.json')
  const lockPath = join(directory, 'pnpm-lock.yaml')
  if (!existsSync(manifestPath) || !existsSync(lockPath)) return {}

  const version = readHarnessVersion(manifestPath)
  const descriptor: CapabilitySourceRuntimeSetupDescriptor = {
    mode: 'source-runtime',
    sourceLabel: 'DeepSeek Harness source checkout',
    sourceUrl: HARNESS_SOURCE_URL,
    runtimeId: 'DeepSeek Harness runtime',
    version,
    prerequisites: ['Node.js 24 or newer', 'Corepack', 'DeepSeek Harness source checkout'],
    fields: [],
  }
  const runCommand = options.runCommand ?? runFixedCommand
  const nodeVersion = options.nodeVersion ?? process.version
  const corepack = options.runCommand
    ? { command: process.platform === 'win32' ? 'corepack.cmd' : 'corepack', argsPrefix: [] }
    : resolveCorepackCommand()
  const useAppCodexResolver = options.harnessDirectory === undefined

  let installInFlight: Promise<{ installedVersion: string }> | undefined
  const install = async (
    _values: Readonly<Record<string, string>>,
    report: (progress: CapabilitySetupProgress) => Promise<void>,
  ): Promise<{ installedVersion: string }> => {
    if (installInFlight) return installInFlight
    installInFlight = installHarnessSource(directory, version, useAppCodexResolver, corepack, runCommand, report).finally(() => {
      installInFlight = undefined
    })
    return installInFlight
  }

  const common = (): Omit<CapabilitySetupAdapter, 'verify'> => ({
    descriptor,
    checkPrerequisites: () => checkHarnessPrerequisites(directory, nodeVersion, corepack, runCommand),
    install,
  })

  return {
    [ND_HARNESS_CAPABILITY_ID]: { ...common(), verify: async () => assertHarnessReady(directory) },
    [ND_CODEX_DELEGATED_CAPABILITY_ID]: { ...common(), verify: async () => assertDelegatedCodexReady(directory) },
    [ND_CODEX_CLI_CAPABILITY_ID]: { ...common(), verify: async () => assertDirectCodexReady(directory, useAppCodexResolver) },
    [ND_MEMORY_MCP_ID]: { ...common(), verify: async () => assertHarnessReady(directory) },
    [ND_SESSION_RECALL_ID]: { ...common(), verify: async () => assertHarnessReady(directory) },
  }
}

async function checkHarnessPrerequisites(
  directory: string,
  nodeVersion: string,
  corepack: FixedCommand,
  runCommand: FixedCommandRunner,
): Promise<CapabilityPrerequisiteResult[]> {
  const nodeMajor = Number.parseInt(nodeVersion.replace(/^v/, '').split('.')[0] ?? '0', 10)
  let corepackVersion: string | undefined
  try {
    corepackVersion = (await runCommand(corepack.command, [...corepack.argsPrefix, '--version'], directory)).trim().split(/\r?\n/).at(-1)
  } catch {
    corepackVersion = undefined
  }
  const sourceReady = existsSync(join(directory, 'package.json')) && existsSync(join(directory, 'pnpm-lock.yaml'))
  return [
    { id: 'node', label: 'Node.js 24 or newer', met: nodeMajor >= REQUIRED_NODE_MAJOR, detail: nodeVersion },
    { id: 'corepack', label: 'Corepack', met: Boolean(corepackVersion), ...(corepackVersion ? { detail: corepackVersion } : { detail: 'Not found on PATH' }) },
    { id: 'harness-source', label: 'DeepSeek Harness source checkout', met: sourceReady, detail: sourceReady ? directory : 'Source checkout is incomplete' },
  ]
}

async function installHarnessSource(
  directory: string,
  version: string,
  useAppCodexResolver: boolean,
  corepack: FixedCommand,
  runCommand: FixedCommandRunner,
  report: (progress: CapabilitySetupProgress) => Promise<void>,
): Promise<{ installedVersion: string }> {
  await report({ state: 'installing', progress: 10, message: 'Installing Harness runtime dependencies' })
  await runCommand(corepack.command, [...corepack.argsPrefix, 'pnpm', 'install', '--frozen-lockfile'], directory)
  await report({ state: 'installing', progress: 55, message: 'Building Harness host runtime packages' })
  // ND consumes the host runtime and CLI. The upstream aggregate build also
  // compiles its standalone React client, which is not shipped or loaded by ND.
  await runCommand(corepack.command, [...corepack.argsPrefix, 'pnpm', 'run', 'build:lib:host'], directory)
  await report({ state: 'configuring', progress: 90, message: 'Checking generated runtime payloads' })
  assertHarnessReady(directory)
  assertDelegatedCodexReady(directory)
  assertDirectCodexReady(directory, useAppCodexResolver)
  return { installedVersion: version }
}

function assertHarnessReady(directory: string): void {
  const cli = join(directory, 'apps/cli/lib/bin.js')
  if (!existsSync(cli)) throw new Error(`Harness CLI was not built at ${cli}`)
}

function assertDelegatedCodexReady(directory: string): void {
  const entry = join(directory, 'packages/subagent/subagent-codex/lib/index.js')
  if (!existsSync(entry)) throw new Error(`Delegated Codex adapter was not built at ${entry}`)
}

function assertDirectCodexReady(directory: string, useAppCodexResolver: boolean): void {
  if (!useAppCodexResolver) {
    const entry = join(directory, 'packages/subagent/subagent-codex/lib/index.js')
    if (!existsSync(entry)) throw new Error(`Codex package anchor was not built at ${entry}`)
    return
  }
  if (!codexBinPath()) throw new Error('The pinned Codex CLI payload could not be resolved after setup.')
}

function readHarnessVersion(manifestPath: string): string {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error('DeepSeek Harness package version is missing.')
  return manifest.version.trim()
}

function resolveCorepackCommand(): FixedCommand {
  if (process.platform !== 'win32') return { command: 'corepack', argsPrefix: [] }

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
    const corepackEntry = join(nodeDirectory, 'node_modules/corepack/dist/corepack.js')
    if (existsSync(node) && existsSync(corepackEntry)) {
      return { command: node, argsPrefix: [corepackEntry] }
    }
  }
  return { command: 'corepack.cmd', argsPrefix: [] }
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
        const detail = output
          .trim()
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !/^\[?ELIFECYCLE\]?\s+Command failed with exit code \d+\.?$/i.test(line))
          .slice(-6)
          .join('\n')
        reject(new Error(detail ?? `${command} exited with code ${String(code)}`))
      }
    })
  })
}
