import type { BrowserBounds } from './contracts.js'
import type {
  DesignCommand,
  DesignDocument,
  DesignMigrationReport,
} from './nd-design/index.js'

export type DesignProjectKind = 'shadcn' | 'next' | 'react' | 'vite' | 'static-html' | 'web' | 'canvas'

export type DesignTemplateKind = 'html' | 'ejs' | 'handlebars' | 'nunjucks' | 'liquid'

export interface DesignTemplateEntry {
  path: string
  name: string
  kind: DesignTemplateKind
  previewable: boolean
  entry: boolean
}

export interface DesignComponentEntry {
  name: string
  path: string
  kind: 'shadcn'
}

export interface DesignShadcnState {
  detected: boolean
  configPath?: string
  style?: string
  baseColor?: string
  cssVariables?: boolean
  components: DesignComponentEntry[]
}

export interface DesignFreeformDocumentEntry {
  path: string
  name: string
}

export type DesignFreeformStatus = 'idle' | 'ready' | 'saving' | 'error'

export interface DesignFreeformState {
  engine: 'nd-pencil'
  status: DesignFreeformStatus
  available: boolean
  visible: boolean
  dirty: boolean
  documentPath?: string
  documentName?: string
  version?: string
  revision: number
  canUndo: boolean
  canRedo: boolean
  selectionCount: number
  agentEditing: boolean
  error?: string
  migration?: DesignMigrationReport
}

export interface DesignSessionSync {
  state: DesignFreeformState
  document: DesignDocument | null
  assets: Record<string, string>
}

export interface DesignApplyAck {
  ok: true
  revision: number
  changedIds: string[]
  createdIds: string[]
  deletedIds: string[]
  state: DesignFreeformState
}

export interface DesignApplyConflict {
  ok: false
  conflict: true
  sync: DesignSessionSync
}

export type DesignApplyResponse = DesignApplyAck | DesignApplyConflict

export interface DesignChangedEvent {
  state: DesignFreeformState
  document?: DesignDocument
  assets?: Record<string, string>
  reason: 'open' | 'close' | 'agent' | 'undo' | 'redo' | 'save' | 'conflict'
  changedIds?: string[]
}

export interface DesignBuildResult {
  specPath: string
  svgPath: string
  prompt: string
}

export interface DesignImportAssetInput {
  dataUrl: string
  name?: string
}

export interface DesignImportedAsset {
  path: string
  dataUrl: string
}

export interface DesignPreviewState {
  kind: 'static-html' | 'dev-server'
  root: string
  url: string
  templatePath?: string
  command?: string
}

export interface DesignProjectState {
  root: string
  kind: DesignProjectKind
  frameworks: string[]
  packageManager?: 'pnpm' | 'npm' | 'yarn' | 'bun'
  devCommand?: string
  templates: DesignTemplateEntry[]
  shadcn: DesignShadcnState
  freeform: {
    documents: DesignFreeformDocumentEntry[]
  }
  capabilities: {
    liveApp: boolean
    htmlTemplates: boolean
    shadcn: boolean
    canvas: true
    freeform: true
  }
  preview?: DesignPreviewState
}

export interface DesignDesktopApi {
  state(): Promise<DesignProjectState>
  refresh(): Promise<DesignProjectState>
  previewHtml(path: string): Promise<DesignPreviewState>
  startDevPreview(): Promise<DesignPreviewState>
  stopPreview(): Promise<void>
  designState(): Promise<DesignFreeformState>
  designSync(): Promise<DesignSessionSync>
  designOpen(path: string): Promise<DesignSessionSync>
  designCreate(path: string, name?: string): Promise<DesignSessionSync>
  designClose(save?: boolean): Promise<DesignSessionSync>
  designApply(baseRevision: number, commands: DesignCommand[]): Promise<DesignApplyResponse>
  designUndo(): Promise<DesignSessionSync>
  designRedo(): Promise<DesignSessionSync>
  designSave(): Promise<DesignFreeformState>
  designSetSelection(ids: string[]): Promise<void>
  designBuild(): Promise<DesignBuildResult>
  designImportAsset(input: DesignImportAssetInput): Promise<DesignImportedAsset>
  onDesignChanged(listener: (event: DesignChangedEvent) => void): () => void
}

export const DESIGN_IPC = {
  state: 'design:state',
  refresh: 'design:refresh',
  previewHtml: 'design:preview-html',
  startDevPreview: 'design:start-dev-preview',
  stopPreview: 'design:stop-preview',
  designState: 'design:session-state',
  designSync: 'design:session-sync',
  designOpen: 'design:session-open',
  designCreate: 'design:session-create',
  designClose: 'design:session-close',
  designApply: 'design:session-apply',
  designUndo: 'design:session-undo',
  designRedo: 'design:session-redo',
  designSave: 'design:session-save',
  designSetSelection: 'design:session-set-selection',
  designBuild: 'design:session-build',
  designImportAsset: 'design:session-import-asset',
  designChanged: 'design:session-changed',
} as const
