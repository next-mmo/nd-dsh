import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { bundledResourceRoot } from '../app-paths.js'
import { backgroundProcessEnvironment } from '../core/background-process-environment.js'
import {
  parseWorkflowDetection,
  parseWorkflowEnvelope,
  parseWorkflowSnapshot,
  type ProjectWorkflowSnapshot,
  type WorkflowDetectionData,
  type WorkflowPluginManifest,
  type WorkflowPluginMethod,
  type WorkflowResultEnvelope,
} from '../../shared/workflow-plugins.js'

export type WorkflowCliErrorCode =
  | 'package-missing'
  | 'bin-missing'
  | 'transport-unsupported'
  | 'spawn-failed'
  | 'timeout'
  | 'output-cap'
  | 'non-zero-exit'
  | 'invalid-json'
  | 'envelope-invalid'

export class WorkflowCliError extends Error {
  constructor(readonly code: WorkflowCliErrorCode, message: string) {
    super(message)
    this.name = 'WorkflowCliError'
  }
}

export interface WorkflowCliResponse {
  envelope: WorkflowResultEnvelope
  /** Parsed method payload: `detect` -> detection, `readSnapshot` -> snapshot. */
  detection?: WorkflowDetectionData
  snapshot?: ProjectWorkflowSnapshot
}

const STDERR_CAP = 64 * 1024

/**
 * Runs the workflow plugin's project-local CLI. The upstream package is
 * resolved from the project's own node_modules and executed with fixed argv,
 * `shell: false`, a hard deadline, and an output cap. ND never installs,
 * updates, or vendors the package, and never runs configured project checks.
 */
export class WorkflowCliClient {
  constructor(private readonly spawnImpl: typeof spawn = spawn) {}

  async run(root: string, method: WorkflowPluginMethod, manifest: WorkflowPluginManifest): Promise<WorkflowCliResponse> {
    if (method === 'buildContext') {
      // Context injection is a separate ND increment; fail closed for now.
      throw new WorkflowCliError('transport-unsupported', 'Workflow plugin context injection is not enabled in this ND host yet')
    }
    const transport = manifest.transport
    if (transport.kind !== 'cli' || transport.requirements.shell !== false || transport.requirements.fixedArgv !== true || transport.requirements.noInstall !== true) {
      throw new WorkflowCliError('transport-unsupported', 'Workflow plugin transport is not supported by this ND host')
    }
    const binPath = await resolvePackageBin(root, manifest)
    const cliMethod = transport.methods[method]
    const argv = [binPath, 'nd', cliMethod, '--root', root, '--json']
    const stdout = await this.spawnAndCollect(root, argv, transport.requirements.timeoutMs, transport.requirements.maxOutputBytes)
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new WorkflowCliError('invalid-json', 'Workflow CLI did not return valid JSON on stdout')
    }
    let envelope: WorkflowResultEnvelope
    try {
      envelope = parseWorkflowEnvelope(parsed, { protocol: manifest.protocol, pluginId: manifest.id })
    } catch (error) {
      throw new WorkflowCliError('envelope-invalid', error instanceof Error ? error.message : String(error))
    }
    // The CLI puts `detect` fields directly on the envelope and nests the
    // board under `snapshot`, per the nd.workflow/1 result shapes.
    if (method === 'detect') {
      return { envelope, detection: parseDetectionPayload(parsed) }
    }
    return { envelope, snapshot: parseSnapshotPayload(parsed) }
  }

  private spawnAndCollect(root: string, argv: string[], timeoutMs: number, maxOutputBytes: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stdoutBytes = 0
      let stderr = ''
      let settled = false
      // process.execPath is the Electron binary inside the packaged app; the
      // env flag makes it behave as plain Node for this child. Under plain
      // Node (tests, CLI) the flag is ignored.
      const preload = join(bundledResourceRoot(), 'scripts', 'nd-background-process.cjs')
      const nodePolicyArgs = process.platform === 'win32' ? ['--require', preload] : []
      const child = this.spawnImpl(process.execPath, [...nodePolicyArgs, ...argv], {
        cwd: root,
        shell: false,
        windowsHide: true,
        env: backgroundProcessEnvironment({ ...process.env, ELECTRON_RUN_AS_NODE: '1' }, preload),
      })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        reject(new WorkflowCliError('timeout', `Workflow CLI exceeded its ${timeoutMs}ms deadline and was terminated`))
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length
        if (stdoutBytes > maxOutputBytes) {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            child.kill()
            reject(new WorkflowCliError('output-cap', `Workflow CLI output exceeded ${maxOutputBytes} bytes and was terminated`))
          }
          return
        }
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new WorkflowCliError('spawn-failed', `Workflow CLI could not be started: ${error.message}`))
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code !== 0) {
          reject(new WorkflowCliError('non-zero-exit', `Workflow CLI exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 2_000)}` : ''}`))
          return
        }
        resolve(stdout)
      })
    })
  }
}

/**
 * Resolve the upstream package's executable entry from the project's own
 * dependency tree. ND never installs anything: a missing package is a
 * diagnostic, and the project owns its workflow dependency.
 */
async function resolvePackageBin(root: string, manifest: WorkflowPluginManifest): Promise<string> {
  const packageName = manifest.upstream?.package
  if (!packageName) throw new WorkflowCliError('transport-unsupported', 'Workflow plugin manifest does not declare an upstream package')
  let pkgJsonPath: string
  try {
    pkgJsonPath = createRequire(join(root, 'package.json')).resolve(`${packageName}/package.json`)
  } catch {
    throw new WorkflowCliError('package-missing', `The workflow package ${packageName} is not installed in this project; install it in the project itself (ND never installs project dependencies)`)
  }
  let bin: string | Record<string, string> | undefined
  try {
    bin = (JSON.parse(await fs.readFile(pkgJsonPath, 'utf8')) as { bin?: string | Record<string, string> }).bin
  } catch {
    throw new WorkflowCliError('bin-missing', `Resolved workflow package at ${pkgJsonPath} has no readable package.json`)
  }
  const binDir = dirname(pkgJsonPath)
  const entry = typeof bin === 'string'
    ? bin
    : bin
      ? bin[manifest.id] ?? bin[Object.keys(bin)[0]!]
      : undefined
  if (!entry) throw new WorkflowCliError('bin-missing', `Workflow package ${packageName} does not declare a bin entry`)
  return join(binDir, entry)
}

function parseDetectionPayload(parsed: unknown): WorkflowDetectionData {
  try {
    return parseWorkflowDetection(parsed)
  } catch (error) {
    throw new WorkflowCliError('envelope-invalid', error instanceof Error ? error.message : String(error))
  }
}

function parseSnapshotPayload(parsed: unknown): ProjectWorkflowSnapshot {
  try {
    return parseWorkflowSnapshot((parsed as Record<string, unknown>).snapshot)
  } catch (error) {
    throw new WorkflowCliError('envelope-invalid', error instanceof Error ? error.message : String(error))
  }
}
