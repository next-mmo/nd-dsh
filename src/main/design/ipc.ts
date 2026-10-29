import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { ND_DESIGN_LIMITS, type DesignCommand } from '../../shared/nd-design/index.js'
import { DESIGN_IPC } from '../../shared/design.js'
import type { DesignService } from './design-service.js'
import type { DesignSessionService } from './design-session-service.js'

export function registerDesignIpc(
  window: BrowserWindow,
  design: DesignService,
  session: DesignSessionService,
): () => void {
  const channels: string[] = []
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) => {
      assertTrusted(event, window)
      return listener(event, ...args)
    })
    channels.push(channel)
  }

  handle(DESIGN_IPC.state, () => design.state())
  handle(DESIGN_IPC.refresh, () => design.refresh())
  handle(DESIGN_IPC.previewHtml, (_event, value) => design.previewHtml(asPath(value, 'Template path')))
  handle(DESIGN_IPC.startDevPreview, () => design.startDevPreview())
  handle(DESIGN_IPC.stopPreview, () => design.stopPreview())

  handle(DESIGN_IPC.designState, () => session.state())
  handle(DESIGN_IPC.designSync, () => session.sync())
  handle(DESIGN_IPC.designOpen, (_event, value) => session.open(asPath(value, 'ND Pencil path')))
  handle(DESIGN_IPC.designCreate, (_event, value, name) => session.create(asPath(value, 'ND Pencil path'), asOptionalName(name)))
  handle(DESIGN_IPC.designClose, (_event, value) => session.close(value === undefined ? true : Boolean(value)))
  handle(DESIGN_IPC.designApply, (_event, revision, commands) => session.apply(asRevision(revision), asCommands(commands)))
  handle(DESIGN_IPC.designUndo, () => session.undo())
  handle(DESIGN_IPC.designRedo, () => session.redo())
  handle(DESIGN_IPC.designSave, () => session.save())
  handle(DESIGN_IPC.designSetSelection, (_event, ids) => {
    session.setSelection(asSelection(ids))
  })
  handle(DESIGN_IPC.designBuild, () => session.build())
  handle(DESIGN_IPC.designImportAsset, (_event, value) => session.importAsset(asImportAsset(value)))

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}

function assertTrusted(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Rejected design IPC from an untrusted renderer frame')
  }
}

function asPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) throw new Error(`${label} must be a short non-empty string`)
  return value.trim()
}

function asOptionalName(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 200) throw new Error('ND Pencil name must be a short string')
  return value.trim() || undefined
}

function asRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new Error('ND Pencil revision must be a non-negative integer')
  }
  return value
}

function asCommands(value: unknown): DesignCommand[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('ND Pencil apply requires a non-empty command array')
  if (value.length > ND_DESIGN_LIMITS.maxCommandsPerBatch) throw new Error('ND Pencil command batch is too large')
  let bytes = 0
  try {
    bytes = JSON.stringify(value).length
  } catch {
    throw new Error('ND Pencil commands must be JSON serializable')
  }
  if (bytes > ND_DESIGN_LIMITS.maxBatchBytes) throw new Error('ND Pencil command batch is too large')
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('ND Pencil command must be an object')
    const op = (item as { op?: unknown }).op
    if (typeof op !== 'string' || !['insert', 'update', 'delete', 'reorder', 'group', 'ungroup'].includes(op)) {
      throw new Error('ND Pencil command op is invalid')
    }
  }
  return value as DesignCommand[]
}

function asSelection(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error('ND Pencil selection must be an array of at most 500 ids')
  return value.map((id) => {
    if (typeof id !== 'string' || !id || id.length > 128) throw new Error('ND Pencil selection contains an invalid id')
    return id
  })
}

function asImportAsset(value: unknown): { dataUrl: string; name?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ND Pencil image input is invalid')
  const record = value as Record<string, unknown>
  if (typeof record.dataUrl !== 'string' || record.dataUrl.length > ND_DESIGN_LIMITS.maxAssetBytes * 1.5) {
    throw new Error('ND Pencil image is too large')
  }
  const name = asOptionalName(record.name)
  return { dataUrl: record.dataUrl, ...(name ? { name } : {}) }
}
