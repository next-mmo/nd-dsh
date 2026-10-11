import type { CoreClient } from './core-client.js'

export interface CoreVaultEntryInput {
  title: string
  username: string
  url: string
  notes: string
  secret: string
}

export interface CoreVaultEntry extends CoreVaultEntryInput {
  id: string
  createdAt: number
  updatedAt: number
}

export interface CoreVaultEntrySummary {
  id: string
  title: string
  username: string
  url: string
  updatedAt: number
}

export interface CoreVaultListResult {
  entries: CoreVaultEntrySummary[]
  total: number
}

/**
 * Vault calls are small file operations behind one AES-GCM decrypt/encrypt;
 * the timeout only has to outlast filesystem latency, not user think time.
 */
const CORE_VAULT_TIMEOUT_MS = 15_000

/**
 * The sidecar's local password vault: one encrypted-at-rest file per user, the
 * master key protected by the OS (Windows DPAPI). Secrets cross this boundary
 * only in `get`, `create`, and `update`; `list` returns metadata rows the
 * launcher can render without exposing anything.
 */
export interface CoreVault {
  list(vaultPath: string, query?: string): Promise<CoreVaultListResult>
  get(vaultPath: string, id: string): Promise<CoreVaultEntry>
  create(vaultPath: string, entry: CoreVaultEntryInput): Promise<CoreVaultEntry>
  update(vaultPath: string, id: string, entry: CoreVaultEntryInput): Promise<CoreVaultEntry>
  delete(vaultPath: string, id: string): Promise<boolean>
}

export function createCoreVault(core: Pick<CoreClient, 'request'>): CoreVault {
  return {
    async list(vaultPath, query) {
      return await core.request<CoreVaultListResult>(
        'vault.list',
        { vaultPath, ...(query ? { query } : {}) },
        CORE_VAULT_TIMEOUT_MS,
      )
    },
    async get(vaultPath, id) {
      const result = await core.request<{ entry: CoreVaultEntry }>(
        'vault.get',
        { vaultPath, id },
        CORE_VAULT_TIMEOUT_MS,
      )
      return result.entry
    },
    async create(vaultPath, entry) {
      const result = await core.request<{ entry: CoreVaultEntry }>(
        'vault.create',
        { vaultPath, entry },
        CORE_VAULT_TIMEOUT_MS,
      )
      return result.entry
    },
    async update(vaultPath, id, entry) {
      const result = await core.request<{ entry: CoreVaultEntry }>(
        'vault.update',
        { vaultPath, id, entry },
        CORE_VAULT_TIMEOUT_MS,
      )
      return result.entry
    },
    async delete(vaultPath, id) {
      const result = await core.request<{ deleted: boolean }>(
        'vault.delete',
        { vaultPath, id },
        CORE_VAULT_TIMEOUT_MS,
      )
      return result.deleted
    },
  }
}
