import { basename, relative, resolve } from 'node:path'
import {
  applyDesignCommands,
  applyDesignHistoryCommands,
  buildDesignSpec,
  createEmptyDesignDocument,
  DesignHistory,
  pageBounds,
  parseDesignDocument,
  serializeDesignDocument,
  serializeDesignSpec,
  serializeDesignSvg,
  validateDesignDocument,
  type DesignCommand,
  type DesignDocument,
  type DesignNode,
} from '../../shared/nd-design/index.js'
import { ND_DESIGN_LIMITS } from '../../shared/nd-design/model.js'
import type {
  DesignApplyResponse,
  DesignBuildResult,
  DesignChangedEvent,
  DesignFreeformState,
  DesignImportedAsset,
  DesignImportAssetInput,
  DesignSessionSync,
} from '../../shared/design.js'
import { buildDesignPrompt } from './design-build.js'
import { DesignStore, type ResolvedDesignPath } from './design-store.js'

type Broadcast = (event: DesignChangedEvent) => void
type Source = 'human' | 'agent'

export class DesignSessionService {
  private document: DesignDocument | undefined
  private path: ResolvedDesignPath | undefined
  private revision = 0
  private dirty = false
  private status: DesignFreeformState['status'] = 'idle'
  private error: string | undefined
  private selection: string[] = []
  private readonly history = new DesignHistory()
  private sourceHash: string | undefined
  private legacyRaw: string | undefined
  private legacyBackupPath: string | undefined
  private assets: Record<string, string> = {}
  private autosaveTimer: NodeJS.Timeout | undefined
  private saveInFlight: Promise<DesignFreeformState> | undefined
  private autosaveBlocked = false
  private agentEditing = false

  constructor(
    private readonly store: DesignStore,
    private readonly broadcast: Broadcast,
  ) {}

  get projectRoot(): string {
    return this.store.projectRoot
  }

  state(): DesignFreeformState {
    const migration = this.document?.meta?.migration
    return {
      engine: 'nd-pencil',
      status: this.status,
      available: true,
      visible: Boolean(this.document),
      dirty: this.dirty,
      version: '2',
      revision: this.revision,
      canUndo: this.history.canUndo(),
      canRedo: this.history.canRedo(),
      selectionCount: this.selection.length,
      agentEditing: this.agentEditing,
      ...(this.path ? { documentPath: this.path.relative, documentName: basename(this.path.relative) } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(migration ? { migration } : {}),
    }
  }

  sync(): DesignSessionSync {
    return { state: this.state(), document: this.document ?? null, assets: { ...this.assets } }
  }

  async open(relativePath: string): Promise<DesignSessionSync> {
    if (this.document && this.dirty) throw new Error('Save or close the current ND Pencil document before opening another one')
    const path = this.store.resolveDocument(relativePath, 'open')
    await this.store.assertOpenable(path)
    const raw = await this.store.readDocument(path)
    const parsed = parseDesignDocument(raw)
    this.document = parsed.document
    this.path = path
    this.revision = 1
    this.dirty = parsed.legacy
    this.status = 'ready'
    this.error = undefined
    this.selection = []
    this.history.clear()
    this.sourceHash = this.store.hash(raw)
    this.legacyRaw = parsed.legacy ? raw : undefined
    this.legacyBackupPath = undefined
    this.autosaveBlocked = false
    this.assets = await this.store.assetDataUrls(parsed.document)
    this.emit('open', true)
    return this.sync()
  }

  async create(relativePath: string, name?: string): Promise<DesignSessionSync> {
    if (this.document && this.dirty) throw new Error('Save or close the current ND Pencil document before creating another one')
    const path = this.store.resolveDocument(relativePath, 'create')
    await this.store.prepareCreate(path)
    const document = createEmptyDesignDocument(name?.trim() || basename(relativePath).replace(/\.op$/i, '') || 'Untitled design')
    const serialized = serializeDesignDocument(document)
    await this.store.writeDocument(path, serialized)
    this.document = document
    this.path = path
    this.revision = 1
    this.dirty = false
    this.status = 'ready'
    this.error = undefined
    this.selection = []
    this.history.clear()
    this.sourceHash = this.store.hash(serialized)
    this.legacyRaw = undefined
    this.legacyBackupPath = undefined
    this.autosaveBlocked = false
    this.assets = {}
    this.emit('open', true)
    return this.sync()
  }

  async close(save = true): Promise<DesignSessionSync> {
    if (this.dirty && save) await this.save()
    this.clearSession()
    this.emit('close', false)
    return this.sync()
  }

  apply(baseRevision: number, commands: DesignCommand[]): DesignApplyResponse {
    if (!this.document) throw new Error('No ND Pencil document is open')
    if (baseRevision !== this.revision) {
      return { ok: false, conflict: true, sync: this.sync() }
    }
    const result = applyDesignCommands(this.document, commands)
    this.document = result.document
    this.revision += 1
    this.dirty = true
    this.status = 'ready'
    this.error = undefined
    this.history.push({
      source: 'human',
      label: 'Canvas edit',
      forward: commands,
      inverse: result.inverse,
      changedIds: result.changedIds,
    })
    this.pruneSelection()
    this.scheduleAutosave()
    return {
      ok: true,
      revision: this.revision,
      changedIds: result.changedIds,
      createdIds: result.createdIds,
      deletedIds: result.deletedIds,
      state: this.state(),
    }
  }

  async undo(): Promise<DesignSessionSync> {
    if (!this.document) throw new Error('No ND Pencil document is open')
    const entry = this.history.undo('human')
    if (!entry) return this.sync()
    this.document = applyDesignHistoryCommands(this.document, entry.commands)
    this.history.commitUndo()
    this.revision += 1
    this.dirty = true
    this.status = 'ready'
    this.error = undefined
    this.pruneSelection()
    this.scheduleAutosave()
    this.emit('undo', true, entry.entry.changedIds)
    return this.sync()
  }

  async redo(): Promise<DesignSessionSync> {
    if (!this.document) throw new Error('No ND Pencil document is open')
    const entry = this.history.redo('human')
    if (!entry) return this.sync()
    this.document = applyDesignHistoryCommands(this.document, entry.commands)
    this.history.commitRedo()
    this.revision += 1
    this.dirty = true
    this.status = 'ready'
    this.error = undefined
    this.pruneSelection()
    this.scheduleAutosave()
    this.emit('redo', true, entry.entry.changedIds)
    return this.sync()
  }

  async save(): Promise<DesignFreeformState> {
    if (this.saveInFlight) return this.saveInFlight
    this.saveInFlight = this.performSave().finally(() => {
      this.saveInFlight = undefined
    })
    return this.saveInFlight
  }

  setSelection(ids: string[]): void {
    if (!Array.isArray(ids)) throw new Error('ND Pencil selection must be an array')
    if (ids.length > 500) throw new Error('ND Pencil selection is too large')
    if (!this.document) {
      this.selection = []
      return
    }
    this.selection = [...new Set(ids.filter((id): id is string => typeof id === 'string' && Boolean(this.document?.nodes[id])))].slice(0, 500)
  }

  async importAsset(input: DesignImportAssetInput): Promise<DesignImportedAsset> {
    if (!this.document) throw new Error('No ND Pencil document is open')
    if (!input || typeof input.dataUrl !== 'string') throw new Error('ND Pencil image data is required')
    return this.store.importAsset(input.dataUrl, input.name)
  }

  async build(): Promise<DesignBuildResult> {
    if (!this.document) throw new Error('No ND Pencil document is open')
    this.assets = await this.store.assetDataUrls(this.document)
    const spec = serializeDesignSpec(this.document, this.selection)
    const svg = serializeDesignSvg(this.document, this.assets)
    const artifacts = await this.store.writeBuildArtifacts(this.document, spec, svg)
    return { ...artifacts, prompt: buildDesignPrompt(this.document, artifacts.specPath, artifacts.svgPath) }
  }

  async flushForClose(): Promise<void> {
    if (this.dirty) await this.save()
  }

  destroy(): void {
    this.stopAutosave()
    this.document = undefined
    this.path = undefined
    this.assets = {}
  }

  async handleWorkspaceChanged(nextRoot: string): Promise<void> {
    if (resolve(nextRoot) === resolve(this.store.projectRoot)) return
    if (this.path && !isInside(nextRoot, this.path.absolute)) {
      if (this.dirty) await this.save()
      this.clearSession()
      this.emit('close', false)
    }
    this.store.setRoot(nextRoot)
  }

  // ── ND Agent surface ────────────────────────────────────────────────────────

  agentState(): unknown {
    if (!this.document || !this.path) {
      return { open: false, message: 'No ND Pencil document is open. Use action=open or action=create first.' }
    }
    const bounds = pageBounds(this.document)
    const selection = this.selection
      .map((id) => this.document?.nodes[id])
      .filter((node): node is DesignNode => Boolean(node))
      .map((node) => compactNode(node, 0))
    const outline: ReturnType<typeof compactNode>[] = []
    const walk = (id: string, depth: number): void => {
      if (outline.length >= 240 || depth > 3) return
      const node = this.document?.nodes[id]
      if (!node) return
      outline.push(compactNode(node, depth))
      for (const child of node.children ?? []) walk(child, depth + 1)
    }
    for (const id of this.document.pages[0]?.children ?? []) walk(id, 0)
    const migration = this.document.meta?.migration
    return {
      open: true,
      path: this.path.relative,
      name: this.document.name,
      revision: this.revision,
      dirty: this.dirty,
      page: { name: this.document.pages[0]?.name, bounds },
      nodeCount: Object.keys(this.document.nodes).length,
      selection,
      outline,
      limits: ND_DESIGN_LIMITS,
      ...(migration ? { migration } : {}),
    }
  }

  async agentOpen(relativePath: string): Promise<DesignSessionSync> {
    return this.open(relativePath)
  }

  async agentCreate(relativePath: string, name?: string): Promise<DesignSessionSync> {
    return this.create(relativePath, name)
  }

  agentApply(commands: DesignCommand[]): { revision: number; changedIds: string[]; createdIds: string[]; deletedIds: string[] } {
    if (!this.document) throw new Error('No ND Pencil document is open. Use action=open or action=create first.')
    const result = applyDesignCommands(this.document, commands)
    this.document = result.document
    this.revision += 1
    this.dirty = true
    this.status = 'ready'
    this.error = undefined
    this.autosaveBlocked = false
    this.history.push({
      source: 'agent',
      label: 'Agent edit',
      forward: commands,
      inverse: result.inverse,
      changedIds: result.changedIds,
    })
    this.pruneSelection()
    this.scheduleAutosave()
    this.emit('agent', true, result.changedIds)
    return {
      revision: this.revision,
      changedIds: result.changedIds,
      createdIds: result.createdIds,
      deletedIds: result.deletedIds,
    }
  }

  async agentUndo(): Promise<DesignSessionSync> {
    if (!this.document) throw new Error('No ND Pencil document is open')
    const entry = this.history.undo('agent')
    if (!entry) return this.sync()
    this.document = applyDesignHistoryCommands(this.document, entry.commands)
    this.history.commitUndo()
    this.revision += 1
    this.dirty = true
    this.scheduleAutosave()
    this.emit('undo', true, entry.entry.changedIds)
    return this.sync()
  }

  async agentRedo(): Promise<DesignSessionSync> {
    if (!this.document) throw new Error('No ND Pencil document is open')
    const entry = this.history.redo('agent')
    if (!entry) return this.sync()
    this.document = applyDesignHistoryCommands(this.document, entry.commands)
    this.history.commitRedo()
    this.revision += 1
    this.dirty = true
    this.scheduleAutosave()
    this.emit('redo', true, entry.entry.changedIds)
    return this.sync()
  }

  async agentSave(): Promise<DesignFreeformState> {
    return this.save()
  }

  async agentBuild(): Promise<DesignBuildResult> {
    return this.build()
  }

  agentExport(format: 'spec' | 'svg'): Promise<DesignBuildResult> {
    if (format !== 'spec' && format !== 'svg') throw new Error('ND Pencil export format must be spec or svg')
    return this.build()
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private async performSave(): Promise<DesignFreeformState> {
    if (!this.document || !this.path) throw new Error('No ND Pencil document is open')
    if (!this.dirty) return this.state()
    this.stopAutosave()
    this.status = 'saving'
    this.error = undefined
    try {
      if (this.legacyRaw && !this.legacyBackupPath) {
        this.legacyBackupPath = await this.store.backupLegacy(this.path, this.legacyRaw)
      }
      const currentHash = await this.store.sourceHash(this.path)
      if (currentHash !== this.sourceHash) {
        throw new Error(
          currentHash === undefined
            ? `${this.path.relative} was deleted outside ND Pencil. Reload or discard this canvas before saving.`
            : `${this.path.relative} changed on disk. Reload it from disk before saving this canvas.`,
        )
      }
      const serialized = serializeDesignDocument(this.document)
      await this.store.writeDocument(this.path, serialized)
      this.sourceHash = this.store.hash(serialized)
      this.dirty = false
      this.status = 'ready'
      this.autosaveBlocked = false
      this.emit('save', false)
      return this.state()
    } catch (cause) {
      this.status = 'error'
      this.error = errorMessage(cause)
      this.autosaveBlocked = true
      this.emit('conflict', false)
      throw cause
    }
  }

  private scheduleAutosave(): void {
    this.stopAutosave()
    if (this.autosaveBlocked || !this.document || !this.path) return
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = undefined
      void this.save().catch(() => undefined)
    }, 1_500)
    this.autosaveTimer.unref?.()
  }

  private stopAutosave(): void {
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer)
      this.autosaveTimer = undefined
    }
  }

  private pruneSelection(): void {
    if (!this.document) {
      this.selection = []
      return
    }
    this.selection = this.selection.filter((id) => Boolean(this.document?.nodes[id]))
  }

  private clearSession(): void {
    this.stopAutosave()
    this.document = undefined
    this.path = undefined
    this.revision = 0
    this.dirty = false
    this.status = 'idle'
    this.error = undefined
    this.selection = []
    this.history.clear()
    this.sourceHash = undefined
    this.legacyRaw = undefined
    this.legacyBackupPath = undefined
    this.assets = {}
    this.autosaveBlocked = false
  }

  private emit(reason: DesignChangedEvent['reason'], includeDocument: boolean, changedIds?: string[]): void {
    this.broadcast({
      state: this.state(),
      reason,
      ...(changedIds ? { changedIds } : {}),
      ...(includeDocument && this.document ? { document: this.document } : {}),
      ...(includeDocument ? { assets: { ...this.assets } } : {}),
    })
  }
}

function compactNode(node: DesignNode, depth: number): {
  id: string
  type: DesignNode['type']
  name: string
  x: number
  y: number
  width: number
  height: number
  depth: number
  text?: string
  children?: string[]
} {
  return {
    id: node.id,
    type: node.type,
    name: node.name.slice(0, 80),
    x: Math.round(node.x),
    y: Math.round(node.y),
    width: Math.round(node.width),
    height: Math.round(node.height),
    depth,
    ...(node.text !== undefined ? { text: node.text.slice(0, 160) } : {}),
    ...(node.children ? { children: node.children.slice(0, 64) } : {}),
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate))
  return path === '' || (!path.startsWith('..') && !path.startsWith('/') && !path.startsWith('\\'))
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export { validateDesignDocument, buildDesignSpec }
