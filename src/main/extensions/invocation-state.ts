import { normalizeExtensionRuntimePolicy, type ExtensionRuntimePolicy } from '../../shared/extension-runtime-policy.js'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { contextKey, type NdContext } from '../../shared/nd-context.js'
import type {
  NdActivationView,
  NdAuditEntryView,
  NdGrantHost,
  NdGrantScope,
  NdGrantView,
} from '../../shared/nd-invocations.js'
import { quarantineFile } from '../logging/log-file.js'

interface ActivationRecord {
  extensionId: string
  contextKey: string
  context: NdContext
  enabled: boolean
  settings: Record<string, unknown>
  updatedAt: number
}

type GrantRecord = NdGrantView

interface InvocationSnapshot {
  runtimePolicy?: ExtensionRuntimePolicy
  version: 1
  activations: ActivationRecord[]
  grants: GrantRecord[]
  audit: NdAuditEntryView[]
}

/** Audit rows stay bounded; the newest decisions matter, not an unbounded log. */
const AUDIT_LIMIT = 500

/**
 * Durable record of context activations, per-context settings overrides, and
 * grants. Deliberately separate from the package store: installation is
 * availability, while activation and grants are authorization, and neither is
 * implied by the other.
 */
export class InvocationStateStore {
  private activationIndex = new Map<string, ActivationRecord>()
  private generation = 0
  private loaded = false
  private loadPromise: Promise<void> | undefined
  private saveChain: Promise<void> = Promise.resolve()
  private value: InvocationSnapshot = { version: 1, activations: [], grants: [], audit: [] }

  constructor(private readonly rootDir: string) {}

  async runtimePolicy(): Promise<ExtensionRuntimePolicy> {
    await this.load()
    return normalizeExtensionRuntimePolicy(this.value.runtimePolicy)
  }

  async setRuntimePolicy(policy: unknown): Promise<void> {
    await this.load()
    this.value.runtimePolicy = normalizeExtensionRuntimePolicy(policy)
    await this.persist()
  }

  get revision(): number { return this.generation }

  async enabledExtensionIds(context: NdContext): Promise<string[]> {
    await this.load()
    const key = contextKey(context)
    return this.value.activations.filter((record) => record.contextKey === key && record.enabled).map((record) => record.extensionId)
  }

  private rebuildIndex(): void {
    this.activationIndex = new Map(this.value.activations.map((record) => [JSON.stringify([record.extensionId, record.contextKey]), record]))
    this.generation += 1
  }

  async activations(): Promise<NdActivationView[]> {
    await this.load()
    return this.value.activations.map((record) => structuredClone({ ...record, context: record.context }))
  }

  async activation(extensionId: string, context: NdContext): Promise<ActivationRecord | undefined> {
    await this.load()
    const key = contextKey(context)
    const record = this.activationIndex.get(JSON.stringify([extensionId, key]))
    return record ? structuredClone(record) : undefined
  }

  async setActivation(extensionId: string, context: NdContext, enabled: boolean): Promise<void> {
    await this.load()
    const key = contextKey(context)
    const existing = this.activationIndex.get(JSON.stringify([extensionId, key]))
    if (existing) {
      existing.enabled = enabled
      existing.context = context
      existing.updatedAt = Date.now()
    } else {
      this.value.activations.push({
        extensionId,
        contextKey: key,
        context,
        enabled,
        settings: {},
        updatedAt: Date.now(),
      })
    }
    this.rebuildIndex()
    await this.persist()
  }

  async settingsFor(extensionId: string, context: NdContext): Promise<Record<string, unknown>> {
    const record = await this.activation(extensionId, context)
    return record?.settings ? structuredClone(record.settings) : {}
  }

  async setSetting(extensionId: string, context: NdContext, key: string, value: unknown): Promise<void> {
    await this.load()
    const contextId = contextKey(context)
    let record = this.activationIndex.get(JSON.stringify([extensionId, contextId]))
    if (!record) {
      record = { extensionId, contextKey: contextId, context, enabled: false, settings: {}, updatedAt: Date.now() }
      this.value.activations.push(record)
    }
    record.settings = { ...record.settings, [key]: value }
    record.updatedAt = Date.now()
    this.rebuildIndex()
    await this.persist()
  }

  async grants(): Promise<NdGrantView[]> {
    await this.load()
    return this.value.grants.map((grant) => structuredClone(grant))
  }

  async findGrant(
    extensionId: string,
    host: NdGrantHost,
    context: NdContext,
    resource?: string,
  ): Promise<GrantRecord | undefined> {
    await this.load()
    const key = contextKey(context)
    const grant = this.value.grants.find((item) =>
      item.extensionId === extensionId
      && item.host === host
      && item.contextKey === key
      && (resource === undefined ? item.resource === undefined : item.resource === resource),
    )
    return grant ? structuredClone(grant) : undefined
  }

  async addGrant(input: {
    extensionId: string
    host: NdGrantHost
    context: NdContext
    scope: NdGrantScope
    resource?: string
  }): Promise<NdGrantView> {
    await this.load()
    const record: GrantRecord = {
      id: randomUUID(),
      extensionId: input.extensionId,
      host: input.host,
      contextKey: contextKey(input.context),
      scope: input.scope,
      grantedAt: Date.now(),
      ...(input.resource ? { resource: input.resource.slice(0, 512) } : {}),
    }
    this.value.grants.push(record)
    await this.persist()
    return structuredClone(record)
  }

  async revokeGrant(id: string): Promise<boolean> {
    await this.load()
    const before = this.value.grants.length
    this.value.grants = this.value.grants.filter((grant) => grant.id !== id)
    const removed = this.value.grants.length !== before
    if (removed) await this.persist()
    return removed
  }

  async revokeGrantsForExtension(extensionId: string, context?: NdContext): Promise<void> {
    await this.load()
    const before = this.value.grants.length
    const key = context ? contextKey(context) : undefined
    this.value.grants = this.value.grants.filter((grant) => grant.extensionId !== extensionId || (key !== undefined && grant.contextKey !== key))
    if (this.value.grants.length !== before) await this.persist()
  }

  /** Uninstall drops every activation record; reinstall starts unactivated. */
  async revokeActivationsForExtension(extensionId: string): Promise<void> {
    await this.load()
    const before = this.value.activations.length
    this.value.activations = this.value.activations.filter((record) => record.extensionId !== extensionId)
    if (this.value.activations.length !== before) {
      this.rebuildIndex()
      await this.persist()
    }
  }

  /** One-shot grants are consumed by the invocation that used them. */
  async consumeGrant(id: string): Promise<void> {
    await this.load()
    const before = this.value.grants.length
    this.value.grants = this.value.grants.filter((grant) => grant.id !== id)
    if (this.value.grants.length !== before) await this.persist()
  }

  async recordAudit(entry: Omit<NdAuditEntryView, 'at'> & { at?: number }): Promise<void> {
    await this.load()
    this.value.audit = [{ ...entry, at: entry.at ?? Date.now() }, ...this.value.audit].slice(0, AUDIT_LIMIT)
    await this.persist()
  }

  async audit(): Promise<NdAuditEntryView[]> {
    await this.load()
    return this.value.audit.map((entry) => structuredClone(entry))
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this.loadFromDisk().finally(() => { this.loadPromise = undefined })
    return this.loadPromise
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath(), 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object') throw new Error('invocation state is not an object')
      const record = parsed as Record<string, unknown>
      if (record.version !== 1) throw new Error('invocation state has an unsupported schema')
      this.value = {
        version: 1,
        runtimePolicy: normalizeExtensionRuntimePolicy(record.runtimePolicy),
        activations: Array.isArray(record.activations) ? record.activations.filter(isActivationRecord) : [],
        grants: Array.isArray(record.grants) ? record.grants.filter(isGrantRecord) : [],
        audit: Array.isArray(record.audit) ? record.audit.slice(0, AUDIT_LIMIT).filter(isAuditRecord) : [],
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await quarantineFile(this.filePath(), error)
      }
      this.value = { version: 1, activations: [], grants: [], audit: [] }
    }
    this.rebuildIndex()
    this.loaded = true
  }

  private filePath(): string {
    return join(this.rootDir, 'nd-invocation-state.json')
  }

  private async persist(): Promise<void> {
    const serialized = `${JSON.stringify(this.value, null, 2)}\n`
    const target = this.filePath()
    const write = this.saveChain.catch(() => undefined).then(async () => {
      await fs.mkdir(dirname(target), { recursive: true })
      const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temp, serialized, 'utf8')
        await fs.rename(temp, target)
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
    })
    this.saveChain = write
    return write
  }
}

function isActivationRecord(value: unknown): value is ActivationRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.extensionId === 'string' && typeof record.contextKey === 'string' && typeof record.enabled === 'boolean'
    && Boolean(record.context) && typeof record.context === 'object'
}

function isGrantRecord(value: unknown): value is GrantRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.extensionId === 'string'
    && typeof record.host === 'string' && typeof record.contextKey === 'string'
    && (record.scope === 'once' || record.scope === 'remembered')
}

function isAuditRecord(value: unknown): value is NdAuditEntryView {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.extensionId === 'string'
    && typeof record.at === 'number'
    && typeof record.contextKey === 'string'
    && typeof record.host === 'string'
}
