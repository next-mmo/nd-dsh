import { contextBridge, ipcRenderer } from 'electron'
import { ND_GATEWAY_IPC, type NdGatewayDesktopApi, type NdGatewayState } from '../shared/gateway.js'
import { PROMPT_SHIELD_IPC, type PromptShieldDesktopApi, type PromptShieldState } from '../shared/prompt-shield.js'
import { NINE_ROUTER_IPC } from '../shared/nine-router.js'
import { ROUTER_IPC, type RouterDesktopApi, type RouterPlaygroundEvent } from '../shared/router.js'
import { TERMINAL_IPC, type TerminalDesktopApi, type TerminalExitEvent, type TerminalOutputEvent, type TerminalStateEvent } from '../shared/terminal.js'
import { TOKEN_SAVER_IPC, type TokenSaverDesktopApi, type TokenSaverState } from '../shared/token-saver.js'

const api: TerminalDesktopApi = {
  state: (sessionId) => ipcRenderer.invoke(TERMINAL_IPC.state, sessionId),
  create: (input) => ipcRenderer.invoke(TERMINAL_IPC.create, input),
  write: (sessionId, terminalId, data) => ipcRenderer.invoke(TERMINAL_IPC.write, sessionId, terminalId, data),
  resize: (sessionId, terminalId, cols, rows) => ipcRenderer.invoke(TERMINAL_IPC.resize, sessionId, terminalId, cols, rows),
  close: (sessionId, terminalId) => ipcRenderer.invoke(TERMINAL_IPC.close, sessionId, terminalId),
  restart: (sessionId, terminalId) => ipcRenderer.invoke(TERMINAL_IPC.restart, sessionId, terminalId),
  rename: (sessionId, terminalId, title) => ipcRenderer.invoke(TERMINAL_IPC.rename, sessionId, terminalId, title),
  setLayout: (sessionId, layout, activePaneId, activeTerminalId) => ipcRenderer.invoke(TERMINAL_IPC.setLayout, sessionId, layout, activePaneId, activeTerminalId),
  onOutput: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: TerminalOutputEvent) => listener(value)
    ipcRenderer.on(TERMINAL_IPC.outputEvent, handler)
    return () => ipcRenderer.removeListener(TERMINAL_IPC.outputEvent, handler)
  },
  onExit: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: TerminalExitEvent) => listener(value)
    ipcRenderer.on(TERMINAL_IPC.exitEvent, handler)
    return () => ipcRenderer.removeListener(TERMINAL_IPC.exitEvent, handler)
  },
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: TerminalStateEvent) => listener(value)
    ipcRenderer.on(TERMINAL_IPC.stateEvent, handler)
    return () => ipcRenderer.removeListener(TERMINAL_IPC.stateEvent, handler)
  },
}

const tokenSaverApi: TokenSaverDesktopApi = {
  state: () => ipcRenderer.invoke(TOKEN_SAVER_IPC.state),
  updateSettings: (settings) => ipcRenderer.invoke(TOKEN_SAVER_IPC.updateSettings, settings),
  resetCounters: () => ipcRenderer.invoke(TOKEN_SAVER_IPC.resetCounters),
  detectExternalApps: () => ipcRenderer.invoke(TOKEN_SAVER_IPC.detectExternalApps),
  runDemo: () => ipcRenderer.invoke(TOKEN_SAVER_IPC.runDemo),
  connectAccount: (id) => ipcRenderer.invoke(TOKEN_SAVER_IPC.connectAccount, id),
  disconnectAccount: (id) => ipcRenderer.invoke(TOKEN_SAVER_IPC.disconnectAccount, id),
  refreshAccounts: () => ipcRenderer.invoke(TOKEN_SAVER_IPC.refreshAccounts),
  onChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: TokenSaverState) => listener(value)
    ipcRenderer.on(TOKEN_SAVER_IPC.changedEvent, handler)
    return () => ipcRenderer.removeListener(TOKEN_SAVER_IPC.changedEvent, handler)
  },
}

const promptShieldApi: PromptShieldDesktopApi = {
  state: () => ipcRenderer.invoke(PROMPT_SHIELD_IPC.state),
  updateSettings: (settings) => ipcRenderer.invoke(PROMPT_SHIELD_IPC.updateSettings, settings),
  testText: (text) => ipcRenderer.invoke(PROMPT_SHIELD_IPC.testText, text),
  resetCounters: () => ipcRenderer.invoke(PROMPT_SHIELD_IPC.resetCounters),
  onChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: PromptShieldState) => listener(value)
    ipcRenderer.on(PROMPT_SHIELD_IPC.changedEvent, handler)
    return () => ipcRenderer.removeListener(PROMPT_SHIELD_IPC.changedEvent, handler)
  },
}

const routerApi: RouterDesktopApi = {
  nineRouterState: () => ipcRenderer.invoke(NINE_ROUTER_IPC.state),
  nineRouterDiscover: (input) => ipcRenderer.invoke(NINE_ROUTER_IPC.discover, input),
  nineRouterConnect: (input) => ipcRenderer.invoke(NINE_ROUTER_IPC.connect, input),
  nineRouterInstall: () => ipcRenderer.invoke(NINE_ROUTER_IPC.pickInstall),
  nineRouterImportUnverified: () => ipcRenderer.invoke(NINE_ROUTER_IPC.importUnverified),
  nineRouterPrepare: (password) => ipcRenderer.invoke(NINE_ROUTER_IPC.prepare, password),
  nineRouterStart: () => ipcRenderer.invoke(NINE_ROUTER_IPC.start),
  nineRouterStop: () => ipcRenderer.invoke(NINE_ROUTER_IPC.stop),
  nineRouterDashboardOpen: (baseUrl) => ipcRenderer.invoke(NINE_ROUTER_IPC.dashboardOpen, baseUrl),
  nineRouterDashboardBounds: (bounds) => ipcRenderer.invoke(NINE_ROUTER_IPC.dashboardBounds, bounds),
  nineRouterDashboardClose: () => ipcRenderer.invoke(NINE_ROUTER_IPC.dashboardClose),
  state: () => ipcRenderer.invoke(ROUTER_IPC.state),
  saveProvider: (input) => ipcRenderer.invoke(ROUTER_IPC.saveProvider, input),
  deleteProvider: (providerId) => ipcRenderer.invoke(ROUTER_IPC.deleteProvider, providerId),
  saveAccount: (input) => ipcRenderer.invoke(ROUTER_IPC.saveAccount, input),
  deleteAccount: (providerId, accountId) => ipcRenderer.invoke(ROUTER_IPC.deleteAccount, providerId, accountId),
  saveCombo: (input) => ipcRenderer.invoke(ROUTER_IPC.saveCombo, input),
  deleteCombo: (comboId) => ipcRenderer.invoke(ROUTER_IPC.deleteCombo, comboId),
  testProvider: (providerId) => ipcRenderer.invoke(ROUTER_IPC.testProvider, providerId),
  usage: () => ipcRenderer.invoke(ROUTER_IPC.usage),
  resetUsage: () => ipcRenderer.invoke(ROUTER_IPC.resetUsage),
  externalKeyState: () => ipcRenderer.invoke(ROUTER_IPC.externalKeyState),
  revealExternalKey: () => ipcRenderer.invoke(ROUTER_IPC.revealExternalKey),
  rotateExternalKey: () => ipcRenderer.invoke(ROUTER_IPC.rotateExternalKey),
  playgroundStart: (input) => ipcRenderer.invoke(ROUTER_IPC.playgroundStart, input),
  playgroundStop: (requestId) => ipcRenderer.invoke(ROUTER_IPC.playgroundStop, requestId),
  onPlaygroundEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: RouterPlaygroundEvent) => listener(value)
    ipcRenderer.on(ROUTER_IPC.playgroundEvent, handler)
    return () => ipcRenderer.removeListener(ROUTER_IPC.playgroundEvent, handler)
  },
}

const gatewayApi: NdGatewayDesktopApi = {
  state: () => ipcRenderer.invoke(ND_GATEWAY_IPC.state),
  connect: (input) => ipcRenderer.invoke(ND_GATEWAY_IPC.connect, input),
  disconnect: (appId) => ipcRenderer.invoke(ND_GATEWAY_IPC.disconnect, appId),
  onChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: NdGatewayState) => listener(value)
    ipcRenderer.on(ND_GATEWAY_IPC.changedEvent, handler)
    return () => ipcRenderer.removeListener(ND_GATEWAY_IPC.changedEvent, handler)
  },
}

import { TOOL_ROUTING_IPC, type ToolRoutingDesktopApi } from '../shared/tool-routing.js'

const toolRoutingApi: ToolRoutingDesktopApi = {
  state: () => ipcRenderer.invoke(TOOL_ROUTING_IPC.state),
  updateSettings: (settings) => ipcRenderer.invoke(TOOL_ROUTING_IPC.updateSettings, settings),
  routeTools: (taskText) => ipcRenderer.invoke(TOOL_ROUTING_IPC.routeTools, taskText),
}

contextBridge.exposeInMainWorld('ndDshTerminal', api)
contextBridge.exposeInMainWorld('ndDshTokenSaver', tokenSaverApi)
contextBridge.exposeInMainWorld('ndDshPromptShield', promptShieldApi)
contextBridge.exposeInMainWorld('ndDshRouter', routerApi)
contextBridge.exposeInMainWorld('ndDshToolRouting', toolRoutingApi)
contextBridge.exposeInMainWorld('ndDshGateway', gatewayApi)
