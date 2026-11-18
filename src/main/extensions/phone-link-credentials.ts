import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface PhoneLinkCredentials {
  token: string
  pairingCode: string
}

export interface PhoneLinkCredentialsStore {
  load(): Promise<PhoneLinkCredentials | null>
  save(credentials: PhoneLinkCredentials): Promise<void>
}

function isValidCredentials(value: unknown): value is PhoneLinkCredentials {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.token === 'string' &&
    /^[0-9a-f]{32}$/.test(record.token) &&
    typeof record.pairingCode === 'string' &&
    /^\d{6}$/.test(record.pairingCode)
  )
}

/**
 * The pairing PIN/token is deliberately durable: users pair once and keep the
 * same code across stop/start and app restarts until they press "New Code".
 */
export function createFileCredentialsStore(filePath: string): PhoneLinkCredentialsStore {
  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
        return isValidCredentials(parsed) ? parsed : null
      } catch {
        return null
      }
    },
    async save(credentials) {
      await mkdir(dirname(filePath), { recursive: true })
      const tempPath = `${filePath}.${process.pid}.${Date.now()}-${Math.random().toString(16).slice(2, 8)}.tmp`
      try {
        await writeFile(tempPath, JSON.stringify(credentials), 'utf8')
        await rename(tempPath, filePath)
      } finally {
        await rm(tempPath, { force: true }).catch(() => undefined)
      }
    },
  }
}

export function createMemoryCredentialsStore(): PhoneLinkCredentialsStore {
  let stored: PhoneLinkCredentials | null = null
  return {
    async load() {
      return stored
    },
    async save(credentials) {
      stored = { ...credentials }
    },
  }
}