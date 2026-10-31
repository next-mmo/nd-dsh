import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\fake-user-data' },
  dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      ipc.handlers.set(channel, listener)
    },
    removeHandler: (channel: string) => {
      ipc.handlers.delete(channel)
    },
  },
  BrowserWindow: class {},
  WebContentsView: class {},
  session: { fromPartition: () => ({ on: () => undefined }) },
  shell: { openExternal: () => Promise.resolve() },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import { registerRouterIpc } from '../src/main/router/ipc.js'
import { ROUTER_IPC } from '../src/shared/router.js'

function fakeContext() {
  const calls = { safeMode: [] as boolean[], stopped: [] as string[], deleted: [] as string[] }
  const webContents = { id: 1 }
  const window = { webContents }
  // registerRouterIpc always prepends the real IpcMainInvokeEvent, so a handler
  // that reads its first parameter positionally would receive the event.
  const event = { sender: webContents, senderFrame: undefined }
  const service = {
    setSafeMode: async (enabled: boolean) => { calls.safeMode.push(enabled); return { safeMode: enabled } },
    state: async () => ({ endpoint: '', providers: [], combos: [], counters: {} }),
    playgroundStop: (requestId: string) => { calls.stopped.push(requestId) },
    deleteProvider: async (providerId: string) => { calls.deleted.push(providerId); return { providers: [], combos: [], counters: {} } },
  }
  registerRouterIpc(window as never, service as never)
  const send = (channel: string, ...args: unknown[]) => ipc.handlers.get(channel)?.(event, ...args)
  return { calls, send, webContents, event }
}

describe('ND Router IPC argument plumbing', () => {
  beforeEach(() => {
    ipc.handlers.clear()
  })

  it('passes the toggled boolean, not the IPC event, to router.setSafeMode', async () => {
    const { calls, send } = fakeContext()

    await send(ROUTER_IPC.setSafeMode, false)
    await send(ROUTER_IPC.setSafeMode, true)

    // Boolean(event) is always true, which would make the switch impossible to turn off.
    expect(calls.safeMode).toEqual([false, true])
  })

  it('forwards positional arguments to id-only handlers', async () => {
    const { calls, send } = fakeContext()

    await send(ROUTER_IPC.playgroundStop, 'req-42')
    await send(ROUTER_IPC.deleteProvider, 'prov-7')

    expect(calls.stopped).toEqual(['req-42'])
    expect(calls.deleted).toEqual(['prov-7'])
  })

  it('accepts the shell renderer and rejects every other sender', async () => {
    const { calls, send, event } = fakeContext()

    await send(ROUTER_IPC.setSafeMode, false)
    expect(calls.safeMode).toEqual([false])

    await expect(ipc.handlers.get(ROUTER_IPC.setSafeMode)?.({ ...event, sender: {} }, true))
      .rejects.toThrow(/untrusted renderer/i)
    expect(calls.safeMode).toEqual([false])
  })
})
