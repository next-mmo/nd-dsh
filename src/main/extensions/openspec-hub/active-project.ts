import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SAFE_ID } from './security.js'

/**
 * Persisted default project the assistant focuses on when no project route is
 * active. Hub-owned state in the data directory, never inside a watched
 * repository. Writes are atomic (tmp + rename); a corrupt file reads as null.
 */
export class ActiveProjectStore {
  private readonly file: string

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'active-project.json')
  }

  get(): string | null {
    if (!existsSync(this.file)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { projectId?: unknown }
      const id = parsed.projectId
      return typeof id === 'string' && SAFE_ID.test(id) ? id : null
    } catch {
      return null
    }
  }

  set(projectId: string | null): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify({ projectId }, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.file)
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    }
  }
}