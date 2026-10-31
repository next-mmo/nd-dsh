import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface PersistedRouterSafeMode {
  version: 1
  enabled: boolean
}

/**
 * Durable network-lockdown preference for ND Router.
 *
 * The Rust sidecar carries the authoritative runtime flag; this small file
 * lets Electron restore the user's choice across launches without adding a
 * second persisted router setting.
 */
export class RouterSafeModeStore {
  private enabledValue = false

  constructor(private readonly filePath: string, private readonly log: (message: string) => void = () => undefined) {
    this.load()
  }

  enabled(): boolean {
    return this.enabledValue
  }

  setEnabled(enabled: boolean): void {
    if (this.enabledValue === enabled) return
    this.enabledValue = enabled
    this.persist()
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PersistedRouterSafeMode>
      this.enabledValue = parsed.version === 1 && parsed.enabled === true
    } catch (error) {
      this.log(`ND Router safe mode setting is unreadable; staying off: ${error instanceof Error ? error.message : String(error)}`)
      this.enabledValue = false
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      const payload: PersistedRouterSafeMode = { version: 1, enabled: this.enabledValue }
      try {
        writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        renameSync(tmp, this.filePath)
      } finally {
        if (existsSync(tmp)) rmSync(tmp, { force: true })
      }
      if (process.platform !== 'win32') {
        try {
          chmodSync(this.filePath, 0o600)
        } catch {
          // Best effort; the file is already created with 0600 where supported.
        }
      }
    } catch (error) {
      this.log(`ND Router safe mode setting could not be persisted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
