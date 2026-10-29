import { contextBridge, ipcRenderer } from 'electron'
import { DESIGN_IPC, type DesignDesktopApi } from '../shared/design.js'

const api: DesignDesktopApi = {
  state: () => ipcRenderer.invoke(DESIGN_IPC.state),
  refresh: () => ipcRenderer.invoke(DESIGN_IPC.refresh),
  previewHtml: (path) => ipcRenderer.invoke(DESIGN_IPC.previewHtml, path),
  startDevPreview: () => ipcRenderer.invoke(DESIGN_IPC.startDevPreview),
  stopPreview: () => ipcRenderer.invoke(DESIGN_IPC.stopPreview),
  designState: () => ipcRenderer.invoke(DESIGN_IPC.designState),
  designSync: () => ipcRenderer.invoke(DESIGN_IPC.designSync),
  designOpen: (path) => ipcRenderer.invoke(DESIGN_IPC.designOpen, path),
  designCreate: (path, name) => ipcRenderer.invoke(DESIGN_IPC.designCreate, path, name),
  designClose: (save) => ipcRenderer.invoke(DESIGN_IPC.designClose, save),
  designApply: (baseRevision, commands) => ipcRenderer.invoke(DESIGN_IPC.designApply, baseRevision, commands),
  designUndo: () => ipcRenderer.invoke(DESIGN_IPC.designUndo),
  designRedo: () => ipcRenderer.invoke(DESIGN_IPC.designRedo),
  designSave: () => ipcRenderer.invoke(DESIGN_IPC.designSave),
  designSetSelection: (ids) => ipcRenderer.invoke(DESIGN_IPC.designSetSelection, ids),
  designBuild: () => ipcRenderer.invoke(DESIGN_IPC.designBuild),
  designImportAsset: (input) => ipcRenderer.invoke(DESIGN_IPC.designImportAsset, input),
  onDesignChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload)
    ipcRenderer.on(DESIGN_IPC.designChanged, handler)
    return () => ipcRenderer.removeListener(DESIGN_IPC.designChanged, handler)
  },
}

contextBridge.exposeInMainWorld('ndDshDesign', api)
