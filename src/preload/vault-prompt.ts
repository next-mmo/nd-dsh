import { contextBridge, ipcRenderer } from 'electron'

/**
 * The vault entry prompt is a single-purpose window: it can submit a form,
 * cancel itself, and read the prefill for an edit. Exposing nothing else keeps
 * a compromised prompt page — an opaque-origin data URL — from reaching any
 * other desktop capability.
 */
const bridge = {
  getInitial: (): Promise<Record<string, string>> => ipcRenderer.invoke('nd-vault-prompt:initial'),
  submit: (values: Record<string, string>): void => ipcRenderer.send('nd-vault-prompt:submit', values),
  cancel: (): void => ipcRenderer.send('nd-vault-prompt:cancel'),
}

export type VaultPromptBridge = typeof bridge

contextBridge.exposeInMainWorld('ndVaultPrompt', bridge)
