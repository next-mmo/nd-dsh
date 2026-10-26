import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { TERMINAL_IPC, type TerminalCreateInput, type TerminalPaneLayout } from '../../shared/terminal.js'
import { registerTokenSaverIpc } from '../token-saver/ipc.js'
import { registerPromptShieldIpc } from '../prompt-shield/ipc.js'
import { registerRouterIpc } from '../router/ipc.js'
import type { RouterService } from '../router/router-service.js'
import { registerToolRoutingIpc } from '../organization/tool-routing-ipc.js'
import type { TerminalManager } from './terminal-manager.js'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>

export function registerTerminalIpc(window: BrowserWindow, manager: TerminalManager, router?: RouterService): () => void {
  // Token Saver, Prompt Shield, ND Router and Tool Routing are registered
  // beside the small terminal preload/IPC bridge to avoid expanding the
  // already-large desktop IPC composition root.
  const disposeTokenSaverIpc = registerTokenSaverIpc(window)
  const disposePromptShieldIpc = registerPromptShieldIpc(window)
  const disposeRouterIpc = router ? registerRouterIpc(window, router) : () => undefined
  const { dispose: disposeToolRoutingIpc } = registerToolRoutingIpc(window)
  const channels: string[] = []
  const handle = (channel: string, listener: Handler): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Rejected terminal IPC from untrusted renderer')
      return listener(event, ...args)
    })
    channels.push(channel)
  }
  handle(TERMINAL_IPC.state, (_e, sessionId) => manager.state(id(sessionId, 'Session id')))
  handle(TERMINAL_IPC.create, (_e, input) => manager.create(createInput(input)))
  handle(TERMINAL_IPC.write, (_e, sessionId, terminalId, data) => manager.write(id(sessionId, 'Session id'), id(terminalId, 'Terminal id'), rawInput(data)))
  handle(TERMINAL_IPC.resize, (_e, sessionId, terminalId, cols, rows) => manager.resize(id(sessionId, 'Session id'), id(terminalId, 'Terminal id'), number(cols), number(rows)))
  handle(TERMINAL_IPC.close, (_e, sessionId, terminalId) => manager.close(id(sessionId, 'Session id'), id(terminalId, 'Terminal id')))
  handle(TERMINAL_IPC.restart, (_e, sessionId, terminalId) => manager.restart(id(sessionId, 'Session id'), id(terminalId, 'Terminal id')))
  handle(TERMINAL_IPC.rename, (_e, sessionId, terminalId, title) => manager.rename(id(sessionId, 'Session id'), id(terminalId, 'Terminal id'), text(title, 'Title', 80)))
  handle(TERMINAL_IPC.setLayout, (_e, sessionId, layout, paneId, terminalId) => manager.setLayout(id(sessionId, 'Session id'), readLayout(layout), nullableId(paneId), nullableId(terminalId)))
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
    disposeTokenSaverIpc()
    disposePromptShieldIpc()
    disposeRouterIpc()
    disposeToolRoutingIpc()
  }
}

function createInput(value: unknown): TerminalCreateInput {
  if (!record(value)) throw new Error('Invalid terminal create input')
  return {
    sessionId: id(value.sessionId, 'Session id'),
    ...(value.cwd === undefined ? {} : { cwd: text(value.cwd, 'Cwd', 4096) }),
    ...(value.title === undefined ? {} : { title: text(value.title, 'Title', 80) }),
    ...(value.shell === undefined ? {} : { shell: text(value.shell, 'Shell', 4096) }),
    ...(value.cols === undefined ? {} : { cols: number(value.cols) }),
    ...(value.rows === undefined ? {} : { rows: number(value.rows) }),
  }
}
function readLayout(value: unknown, depth = 0): TerminalPaneLayout | null {
  if (value === null) return null
  if (depth > 24 || !record(value)) throw new Error('Invalid terminal layout')
  if (value.type === 'leaf') return { type: 'leaf', paneId: id(value.paneId, 'Pane id'), terminalId: id(value.terminalId, 'Terminal id') }
  if (value.type !== 'split' || (value.direction !== 'horizontal' && value.direction !== 'vertical')) throw new Error('Invalid terminal layout')
  const first = readLayout(value.first, depth + 1); const second = readLayout(value.second, depth + 1)
  if (!first || !second) throw new Error('Invalid terminal split')
  return { type: 'split', direction: value.direction, first, second, ...(value.ratio === undefined ? {} : { ratio: number(value.ratio) }) }
}
function rawInput(value: unknown): string { if (typeof value !== 'string' || value.length > 64 * 1024) throw new Error('Invalid terminal input'); return value }
function nullableId(value: unknown): string | null { return value === null ? null : id(value, 'Id') }
function id(value: unknown, label: string): string { return text(value, label, 256) }
function text(value: unknown, label: string, max: number): string { if (typeof value !== 'string') throw new Error(`${label} must be a string`); const v = value.trim(); if (!v || v.length > max) throw new Error(`${label} is invalid`); return v }
function number(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected finite number'); return value }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
