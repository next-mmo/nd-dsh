import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import {
  CLIPBOARD_HISTORY_ID,
  ClipboardWatcherController,
  type ClipboardWatchPort,
} from '../src/main/extensions/clipboard-history.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nd-clipboard-watcher-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * A watcher port that counts live watches. Assertions run against the count
 * rather than inferring watcher state from settings — a reconcile function
 * that forgets to stop is indistinguishable from one that was never started.
 */
class CountingPort implements ClipboardWatchPort {
  live = new Set<string>()
  private next = 0
  /** When set, the next watch() rejects (watch-start failure). */
  failWatch = false

  async watch(): Promise<string> {
    if (this.failWatch) throw new Error('watcher start failed')
    const id = `watch-${++this.next}`
    this.live.add(id)
    return id
  }

  async unwatch(watchId: string): Promise<boolean> {
    return this.live.delete(watchId)
  }

  get count(): number {
    return this.live.size
  }
}

async function activatedState(recordHistory: boolean | null): Promise<InvocationStateStore> {
  const state = new InvocationStateStore(root)
  await state.setActivation(CLIPBOARD_HISTORY_ID, { kind: 'personal' }, true)
  if (recordHistory !== null) {
    await state.setSetting(CLIPBOARD_HISTORY_ID, { kind: 'personal' }, 'recordHistory', recordHistory)
  }
  return state
}

async function sync(controller: ClipboardWatcherController): Promise<void> {
  await controller.sync()
}

describe('ClipboardWatcherController lifecycle', () => {
  it('starts nothing for an uninstalled package', async () => {
    const state = new InvocationStateStore(root)
    const port = new CountingPort()
    const controller = new ClipboardWatcherController(state, port)
    await sync(controller)
    expect(port.count).toBe(0)
    expect(controller.watching).toBe(false)
  })

  it('starts nothing while installed but not activated', async () => {
    const state = new InvocationStateStore(root)
    await state.setSetting(CLIPBOARD_HISTORY_ID, { kind: 'personal' }, 'recordHistory', true)
    const port = new CountingPort()
    const controller = new ClipboardWatcherController(state, port)
    await sync(controller)
    expect(port.count).toBe(0)
  })

  it('starts nothing while activated with recordHistory off (the default)', async () => {
    const state = await activatedState(false)
    const port = new CountingPort()
    const controller = new ClipboardWatcherController(state, port)
    await sync(controller)
    expect(port.count).toBe(0)
  })

  it('starts exactly one watcher when activation and recordHistory both hold', async () => {
    const state = await activatedState(true)
    const port = new CountingPort()
    const controller = new ClipboardWatcherController(state, port)
    await sync(controller)
    expect(port.count).toBe(1)
    expect(controller.watching).toBe(true)
    // Re-sync without changes stays at one — no duplicate watchers.
    await sync(controller)
    expect(port.count).toBe(1)
  })

  it('turning recordHistory off stops the watcher', async () => {
    const state = await activatedState(true)
    const port = new CountingPort()
    const controller = new ClipboardWatcherController(state, port)
    await sync(controller)
    expect(port.count).toBe(1)

    await state.setSetting(CLIPBOARD_HISTORY_ID, { kind: 'personal' }, 'recordHistory', false)
    await sync(controller)
    expect(port.count).toBe(0)
    expect(controller.watching).toBe(false)
  })

  it('disabling activation stops the watcher even if recordHistory is still on', async () => {
    const state = await activatedState(true)
    const port = new CountingPort()
    const controller = new ClipboardWatcherController(state, port)
    await sync(controller)
    expect(port.count).toBe(1)

    await state.setActivation(CLIPBOARD_HISTORY_ID, { kind: 'personal' }, false)
    await sync(controller)
    expect(port.count).toBe(0)
  })

  it('uninstall (activation revoked) leaves zero watchers', async () => {
    const state = await activatedState(true)
    const port = new CountingPort()
    const controller = new ClipboardWatcherController(state, port)
    await sync(controller)
    expect(port.count).toBe(1)

    await state.revokeActivationsForExtension(CLIPBOARD_HISTORY_ID)
    await sync(controller)
    expect(port.count).toBe(0)
  })

  it('a failing watch start fails closed instead of half-starting', async () => {
    const state = await activatedState(true)
    const port = new CountingPort()
    port.failWatch = true
    const controller = new ClipboardWatcherController(state, port)
    await sync(controller)
    expect(port.count).toBe(0)
    expect(controller.watching).toBe(false)

    // Recovery works once the failure clears.
    port.failWatch = false
    await sync(controller)
    expect(port.count).toBe(1)
  })

  it('a sidecar exit forgets the stale handle, and re-sync re-establishes the watch', async () => {
    const state = await activatedState(true)
    const port = new CountingPort()
    const controller = new ClipboardWatcherController(state, port)
    await sync(controller)
    expect(controller.watching).toBe(true)

    // The sidecar died: everything it hosted is gone, on both sides.
    controller.invalidate()
    port.live.clear()
    expect(controller.watching).toBe(false)

    // After the sidecar restarts, reconcile re-issues the watch because the
    // user is still opted in; the sidecar itself never self-starts one.
    await sync(controller)
    expect(port.count).toBe(1)
  })

  it('stop() releases the watcher for IPC teardown', async () => {
    const state = await activatedState(true)
    const port = new CountingPort()
    const controller = new ClipboardWatcherController(state, port)
    await sync(controller)
    expect(port.count).toBe(1)
    await controller.stop()
    expect(port.count).toBe(0)
  })

  it('sync is serialized so overlapping calls cannot double-start', async () => {
    const state = await activatedState(true)
    const port = new CountingPort()
    const controller = new ClipboardWatcherController(state, port)
    await Promise.all([sync(controller), sync(controller), sync(controller)])
    expect(port.count).toBe(1)
  })
})
