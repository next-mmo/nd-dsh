import { execFile } from 'node:child_process'
import { assertSafeId } from './security.js'
import type { ProjectConfig } from './types.js'

export interface CliResult {
  ok: boolean
  exitCode: number | null
  json: unknown
  stderr: string
}

/**
 * Runs the OpenSpec CLI with a fixed argv array (never a shell string).
 * Only the builder methods below may produce arguments; identifiers are
 * whitelist-validated before they ever reach argv.
 */
export class OpenSpecCli {
  constructor(
    private binPath: string,
    private timeoutMs = 30_000,
  ) {}

  run(project: ProjectConfig, args: string[]): Promise<CliResult> {
    const argv = [...args]
    if (project.store) argv.push('--store', project.store)
    for (const arg of argv) {
      if (typeof arg !== 'string' || arg.includes('\0')) {
        return Promise.resolve({ ok: false, exitCode: null, json: null, stderr: 'invalid argv' })
      }
    }
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [this.binPath, ...argv],
        {
          cwd: project.path,
          timeout: this.timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        },
        (error, stdout, stderr) => {
          const exitCode =
            error && typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code: number }).code)
              : error
                ? null
                : 0
          let json: unknown = null
          const text = stdout.trim()
          if (text.length > 0) {
            try {
              json = JSON.parse(text)
            } catch {
              json = null
            }
          }
          resolve({ ok: !error, exitCode, json, stderr: stderr.slice(0, 4000) })
        },
      )
    })
  }

  listSpecs(project: ProjectConfig): Promise<CliResult> {
    return this.run(project, ['list', '--specs', '--json'])
  }

  listAllChanges(project: ProjectConfig): Promise<CliResult> {
    return this.run(project, ['list', '--all', '--json'])
  }

  status(project: ProjectConfig, changeId: string): Promise<CliResult> {
    assertSafeId(changeId, 'change id')
    return this.run(project, ['status', '--change', changeId, '--json'])
  }

  validateAll(project: ProjectConfig): Promise<CliResult> {
    return this.run(project, ['validate', '--all', '--strict', '--json'])
  }

  doctor(project: ProjectConfig): Promise<CliResult> {
    return this.run(project, ['doctor', '--json'])
  }

  showSpec(project: ProjectConfig, specId: string): Promise<CliResult> {
    assertSafeId(specId, 'spec id')
    return this.run(project, ['show', specId, '--type', 'spec', '--json'])
  }
}