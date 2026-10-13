/// <reference lib="dom" />
import { expect, test } from '@playwright/test'
import type { NdSystemVolumeState, NdSystemVolumeUpdate } from '../src/shared/media-session.js'
import { closeApp, launchApp } from './fixtures.js'

type VolumeWindow = {
  ndDsh: {
    media: {
      state(): Promise<unknown>
      volumeState(): Promise<NdSystemVolumeState>
      setVolume(update: NdSystemVolumeUpdate): Promise<NdSystemVolumeState>
    }
    window: { toggleLauncherPopup(): Promise<unknown> }
  }
}
type Fixture = {
  state: NdSystemVolumeState
  writes: NdSystemVolumeUpdate[]
  inFlight: number
  maxInFlight: number
}
type TestGlobal = typeof globalThis & { volumeFixture: Fixture }

test('native volume is independent of playback, supports keyboard/mute, and fits the popup', async () => {
  const launched = await launchApp()
  try {
    const { page, app } = launched
    // Read the real native endpoint through the trusted preload and RPC. This
    // must report availability as a boolean even when the host has no device.
    const native = await page.evaluate(() => (window as unknown as VolumeWindow).ndDsh.media.volumeState())
    expect(typeof native.available).toBe('boolean')
    if (native.available) {
      expect(native.level).toBeGreaterThanOrEqual(0)
      expect(native.level).toBeLessThanOrEqual(100)
      // Write the same value: exercise the real native setter without changing
      // the developer's output volume or mute state.
      const result = await page.evaluate((level) => (window as unknown as VolumeWindow).ndDsh.media.setVolume({ level }), native.level)
      expect(result.available).toBe(true)
      if (result.available) expect(result.level).toBeCloseTo(native.level, 2)
    }
    const invalid = await page.evaluate(async () => {
      try {
        await (window as unknown as VolumeWindow).ndDsh.media.setVolume({ level: 101 })
        return false
      } catch { return true }
    })
    expect(invalid).toBe(true)
    expect(await page.evaluate(() => (window as unknown as VolumeWindow).ndDsh.media.state())).toBeNull()

    // The remaining gestures use a test-only Electron IPC fixture so tests never
    // mute the host or change its real speakers. No production mocks/hooks.
    await app.evaluate(({ ipcMain }) => {
      const fixture: Fixture = {
        state: { available: true, level: 42, muted: false, canMute: true },
        writes: [], inFlight: 0, maxInFlight: 0,
      }
      ;(globalThis as TestGlobal).volumeFixture = fixture
      ipcMain.removeHandler('media:volume-state')
      ipcMain.removeHandler('media:volume-set')
      ipcMain.handle('media:volume-state', () => fixture.state)
      ipcMain.handle('media:volume-set', async (_event, update: NdSystemVolumeUpdate) => {
        fixture.writes.push(update)
        ++fixture.inFlight
        fixture.maxInFlight = Math.max(fixture.maxInFlight, fixture.inFlight)
        await new Promise((resolve) => setTimeout(resolve, 150))
        if (fixture.state.available) fixture.state = { ...fixture.state, ...update }
        --fixture.inFlight
        return fixture.state
      })
    })
    const popupPromise = app.waitForEvent('window')
    await page.evaluate(() => (window as unknown as VolumeWindow).ndDsh.window.toggleLauncherPopup())
    const popup = await popupPromise
    const dialog = popup.getByRole('dialog', { name: 'ND Quick Launcher' })
    const controls = dialog.getByRole('group', { name: 'System volume controls' })
    const slider = controls.getByRole('slider', { name: 'System volume', exact: true })
    await expect(slider).toHaveValue('42')
    await expect(dialog.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0)
    await slider.focus()
    await slider.press('ArrowRight')
    await expect(slider).toHaveValue('43')
    await expect(dialog).toBeVisible()
    await expect(controls.getByRole('button', { name: 'Mute system volume', exact: true })).toBeEnabled()
    await controls.getByRole('button', { name: 'Mute system volume', exact: true }).click()
    await expect(controls.getByRole('button', { name: 'Unmute system volume', exact: true })).toBeEnabled()
    await expect(controls.getByText('Muted', { exact: true })).toBeVisible()
    await controls.getByRole('button', { name: 'Unmute system volume', exact: true }).click()
    await expect(controls.getByRole('button', { name: 'Mute system volume', exact: true })).toBeEnabled()

    // Rapid changes must coalesce and finish at the last requested position.
    await slider.evaluate((input) => {
      const element = input as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      for (const value of ['20', '30', '60']) {
        setter.call(element, value)
        element.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    await expect.poll(() => app.evaluate(() => {
      const fixture = (globalThis as TestGlobal).volumeFixture
      return fixture.inFlight === 0 && fixture.state.available ? fixture.state.level : null
    })).toBe(60)
    await expect(slider).toHaveValue('60')
    expect(await app.evaluate(() => (globalThis as TestGlobal).volumeFixture.maxInFlight)).toBe(1)

    // Polling mirrors external volume and mute changes while the popup is open.
    await app.evaluate(() => {
      (globalThis as TestGlobal).volumeFixture.state = { available: true, level: 25, muted: true, canMute: true }
    })
    await expect(slider).toHaveValue('25')
    await expect(controls.getByRole('button', { name: 'Unmute system volume', exact: true })).toBeVisible()
    const bounds = await dialog.boundingBox()
    const viewportHeight = await popup.evaluate(() => window.innerHeight)
    expect(bounds).not.toBeNull()
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewportHeight)
    await popup.screenshot({ path: 'test-results/launcher-system-volume.png' })

    await app.evaluate(() => {
      (globalThis as TestGlobal).volumeFixture.state = { available: false, reason: 'Output device unavailable' }
    })
    await expect(controls.getByRole('status')).toHaveText('Output device unavailable')
    await expect(controls.getByRole('button')).toBeDisabled()
    await expect(slider).toHaveCount(0)
    // Recover when the sidecar/device becomes available again.
    await app.evaluate(() => {
      (globalThis as TestGlobal).volumeFixture.state = { available: true, level: 70, muted: false, canMute: false }
    })
    await expect(slider).toHaveValue('70')
    await expect(controls.getByRole('button')).toBeDisabled()
    await slider.press('Escape')
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('#/launcher'))?.isVisible() ?? false
    })).toBe(false)
  } finally {
    await closeApp(launched)
  }
})
