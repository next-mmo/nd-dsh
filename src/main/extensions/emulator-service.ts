/**
 * ND Emulator native backend service.
 *
 * Spawns and manages ADB and scrcpy processes through Node child_process.
 * Safe timeouts, argument sanitization, and clean error messages when tools
 * are not installed on the host OS.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Read the current display size from `dumpsys window displays` (rotation-aware),
 * falling back to the physical size from `wm size`.
 */
export function parseDisplaySize(output: string): { width: number; height: number } | undefined {
  const current = output.match(/\bcur=(\d+)x(\d+)/)
  if (current) return { width: Number(current[1]), height: Number(current[2]) }
  const physical = output.match(/(?:Physical|Override) size:\s*(\d+)x(\d+)/)
  if (physical) return { width: Number(physical[1]), height: Number(physical[2]) }
  return undefined
}

async function terminateChildTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid) {
    try {
      child.kill()
    } catch {
      // Already exited.
    }
    return
  }
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5_000 })
      return
    } catch {
      // Fall through to a direct kill.
    }
  }
  try {
    child.kill()
  } catch {
    // Already exited.
  }
}

export interface DeviceInfo {
  serial: string
  type: string
  model: string
  product: string
  device: string
  transportId: string
}

export interface EmulatorServiceOptions {
  adbPath?: string
  scrcpyPath?: string
}

export class EmulatorService {
  private activeScrcpy: ChildProcess | null = null
  private activeScrcpySerial: string | null = null

  constructor(private readonly defaultOptions: EmulatorServiceOptions = {}) {}

  private resolveAdbPath(custom?: string): string {
    return custom?.trim() || this.defaultOptions.adbPath?.trim() || 'adb'
  }

  private resolveScrcpyPath(custom?: string): string {
    return custom?.trim() || this.defaultOptions.scrcpyPath?.trim() || 'scrcpy'
  }

  /**
   * List connected Android devices and emulators via `adb devices -l`.
   */
  async listDevices(customAdbPath?: string): Promise<{ devices: DeviceInfo[]; adbAvailable: boolean; error?: string }> {
    const adb = this.resolveAdbPath(customAdbPath)
    try {
      const { stdout } = await execFileAsync(adb, ['devices', '-l'], { timeout: 10_000 })
      const lines = stdout.split(/\r?\n/)
      const devices: DeviceInfo[] = []

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('List of devices attached') || trimmed.startsWith('* daemon')) continue

        const parts = trimmed.split(/\s+/)
        if (parts.length < 2) continue

        const serial = parts[0] ?? ''
        const type = parts[1] ?? 'unknown'

        let product = ''
        let model = ''
        let dev = ''
        let transportId = ''

        for (let i = 2; i < parts.length; i++) {
          const item = parts[i]
          if (!item) continue
          if (item.startsWith('product:')) product = item.slice('product:'.length)
          else if (item.startsWith('model:')) model = item.slice('model:'.length).replace(/_/g, ' ')
          else if (item.startsWith('device:')) dev = item.slice('device:'.length)
          else if (item.startsWith('transport_id:')) transportId = item.slice('transport_id:'.length)
        }

        devices.push({
          serial,
          type,
          model: model || serial,
          product,
          device: dev,
          transportId,
        })
      }

      return { devices, adbAvailable: true }
    } catch (err) {
      const isNotFound = (err as { code?: string })?.code === 'ENOENT'
      return {
        devices: [],
        adbAvailable: false,
        error: isNotFound
          ? 'ADB not found. Install Android SDK Platform-Tools or set the ADB path in settings.'
          : err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Connect to an Android device over wireless ADB.
   */
  async connectDevice(address: string, customAdbPath?: string): Promise<{ connected: boolean; output: string }> {
    const adb = this.resolveAdbPath(customAdbPath)
    try {
      const { stdout } = await execFileAsync(adb, ['connect', address], { timeout: 15_000 })
      const connected = stdout.toLowerCase().includes('connected')
      return { connected, output: stdout.trim() }
    } catch (err) {
      return {
        connected: false,
        output: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Disconnect an Android device.
   */
  async disconnectDevice(address: string, customAdbPath?: string): Promise<{ output: string }> {
    const adb = this.resolveAdbPath(customAdbPath)
    try {
      const { stdout } = await execFileAsync(adb, ['disconnect', address], { timeout: 10_000 })
      return { output: stdout.trim() }
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Execute an arbitrary ADB command on a target device.
   */
  async execAdb(
    command: string,
    serial?: string,
    customAdbPath?: string,
  ): Promise<{ output: string; exitCode: number }> {
    const adb = this.resolveAdbPath(customAdbPath)
    // Parse command arguments, keeping quoted tokens together
    const rawTokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
    const cleanTokens = rawTokens.map((t) => t.replace(/^["']|["']$/g, ''))

    // Strip leading 'adb' if user provided it
    if (cleanTokens[0]?.toLowerCase() === 'adb') cleanTokens.shift()

    const args: string[] = []
    if (serial) args.push('-s', serial)
    args.push(...cleanTokens)

    try {
      const { stdout, stderr } = await execFileAsync(adb, args, { timeout: 30_000 })
      return { output: (stdout + stderr).trim(), exitCode: 0 }
    } catch (err) {
      const code = (err as { code?: number })?.code ?? 1
      const stdout = (err as { stdout?: string })?.stdout ?? ''
      const stderr = (err as { stderr?: string })?.stderr ?? ''
      const message = err instanceof Error ? err.message : String(err)
      return { output: (stdout + '\n' + stderr).trim() || message, exitCode: typeof code === 'number' ? code : 1 }
    }
  }

  /**
   * Capture a PNG screenshot from the target device.
   */
  async captureScreenshot(
    serial?: string,
    customAdbPath?: string,
  ): Promise<{ dataUrl?: string; bytes?: number; error?: string }> {
    const adb = this.resolveAdbPath(customAdbPath)
    const args = serial ? ['-s', serial, 'exec-out', 'screencap', '-p'] : ['exec-out', 'screencap', '-p']

    return new Promise((resolve) => {
      try {
        const child = spawn(adb, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        const chunks: Buffer[] = []
        let errStr = ''

        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => { errStr += chunk.toString() })

        const timer = setTimeout(() => {
          child.kill()
          resolve({ error: 'Screenshot capture timed out after 20s' })
        }, 20_000)

        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0 && chunks.length > 0) {
            const buf = Buffer.concat(chunks)
            const base64 = buf.toString('base64')
            resolve({ dataUrl: `data:image/png;base64,${base64}`, bytes: buf.length })
          } else {
            resolve({ error: errStr || `screencap exited with code ${code}` })
          }
        })

        child.on('error', (err) => {
          clearTimeout(timer)
          resolve({ error: err.message })
        })
      } catch (err) {
        resolve({ error: err instanceof Error ? err.message : String(err) })
      }
    })
  }

  /**
   * Install an APK onto a target device.
   */
  async installApk(
    serial: string,
    apkPath: string,
    customAdbPath?: string,
  ): Promise<{ installed: boolean; output: string }> {
    const adb = this.resolveAdbPath(customAdbPath)
    const args = serial ? ['-s', serial, 'install', '-r', apkPath] : ['install', '-r', apkPath]

    try {
      const { stdout, stderr } = await execFileAsync(adb, args, { timeout: 120_000 })
      const out = (stdout + stderr).trim()
      return { installed: out.toLowerCase().includes('success'), output: out }
    } catch (err) {
      return {
        installed: false,
        output: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Start a scrcpy screen mirroring process for a device.
   */
  async startScrcpy(options: {
    serial: string
    bitrate?: number | undefined
    maxFps?: number | undefined
    codec?: string | undefined
    audio?: boolean | undefined
    maxResolution?: number | undefined
    scrcpyPath?: string | undefined
    embedded?: boolean | undefined
  }): Promise<{ started: boolean; error?: string }> {
    const scrcpy = this.resolveScrcpyPath(options.scrcpyPath)

    // Stop existing instance if running
    await this.stopScrcpy()

    const args: string[] = ['--serial', options.serial]
    if (options.embedded) {
      args.push(
        '--window-x=-10000',
        '--window-y=-10000',
        '--window-width=432',
        '--window-height=936',
        '--window-title',
        `ND Emulator · ${options.serial}`,
        '--no-control',
      )
    }
    if (options.bitrate && options.bitrate > 0) args.push('--video-bit-rate', `${options.bitrate}M`)
    if (options.maxFps && options.maxFps > 0) args.push('--max-fps', String(options.maxFps))
    if (options.codec) args.push('--video-codec', options.codec)
    if (options.audio === false) args.push('--no-audio')
    if (options.maxResolution && options.maxResolution > 0) args.push('--max-size', String(options.maxResolution))

    return new Promise((resolve) => {
      let settled = false
      let spawned = false
      let failure: string | undefined
      const finish = (result: { started: boolean; error?: string }): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      try {
        const child = spawn(scrcpy, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false })
        this.activeScrcpy = child
        this.activeScrcpySerial = options.serial

        const fail = (message: string): void => {
          if (!failure) failure = message
          if (this.activeScrcpy === child) {
            this.activeScrcpy = null
            this.activeScrcpySerial = null
          }
          void terminateChildTree(child)
          finish({ started: false, error: message })
        }
        const onOutput = (chunk: Buffer | string): void => {
          const match = chunk.toString().match(/ERROR:\s*(Could not find any ADB device|Server connection failed)[^\r\n]*/i)
          if (match?.[0]) fail(match[0].trim())
        }
        child.stdout?.on('data', onOutput)
        child.stderr?.on('data', onOutput)

        child.on('spawn', () => {
          spawned = true
          // Give scrcpy a moment to establish the ADB/server connection before
          // reporting success; connection failures print an ERROR line quickly.
          setTimeout(() => {
            if (!settled && !failure) finish({ started: true })
          }, 1200)
        })

        child.on('error', (err) => {
          const isNotFound = (err as { code?: string })?.code === 'ENOENT'
          const message = isNotFound
            ? 'scrcpy binary not found on PATH. Install scrcpy from https://github.com/Genymobile/scrcpy'
            : err.message
          if (!spawned) {
            if (this.activeScrcpy === child) {
              this.activeScrcpy = null
              this.activeScrcpySerial = null
            }
            finish({ started: false, error: message })
          } else {
            fail(message)
          }
        })

        child.on('close', (code) => {
          if (this.activeScrcpy === child) {
            this.activeScrcpy = null
            this.activeScrcpySerial = null
          }
          if (!settled) {
            finish({
              started: false,
              error: failure || `scrcpy exited before the device connected (code ${code ?? 'unknown'}).`,
            })
          }
        })

        // Safety fallback if the spawn event takes a moment.
        setTimeout(() => {
          if (!spawned && this.activeScrcpy === child && !settled) finish({ started: true })
        }, 1500)
      } catch (err) {
        this.activeScrcpy = null
        this.activeScrcpySerial = null
        finish({
          started: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  /**
   * Stop any active scrcpy screen mirroring process.
   */
  async stopScrcpy(serial?: string): Promise<{ stopped: boolean }> {
    const child = this.activeScrcpy
    if (!child) return { stopped: false }
    if (serial && serial !== this.activeScrcpySerial) return { stopped: false }
    this.activeScrcpy = null
    this.activeScrcpySerial = null
    await terminateChildTree(child)
    return { stopped: true }
  }

  /** Read the rotation-aware current display size for input coordinate mapping. */
  async deviceSize(serial?: string, customAdbPath?: string): Promise<{ width: number; height: number }> {
    const current = await this.execAdb('shell dumpsys window displays', serial, customAdbPath)
    const parsed = parseDisplaySize(current.output)
    if (parsed) return parsed
    const wm = await this.execAdb('shell wm size', serial, customAdbPath)
    return parseDisplaySize(wm.output) ?? { width: 1080, height: 2340 }
  }

  async tap(
    serial: string,
    x: number,
    y: number,
    customAdbPath?: string,
  ): Promise<{ ok: boolean; output: string; exitCode: number }> {
    const result = await this.execAdb(`shell input tap ${Math.round(x)} ${Math.round(y)}`, serial, customAdbPath)
    return { ok: result.exitCode === 0, ...result }
  }

  async swipe(
    serial: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration = 300,
    customAdbPath?: string,
  ): Promise<{ ok: boolean; output: string; exitCode: number }> {
    const result = await this.execAdb(
      `shell input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(duration)}`,
      serial,
      customAdbPath,
    )
    return { ok: result.exitCode === 0, ...result }
  }

  /**
   * Read recent logcat lines from a device.
   */
  async readLogcat(
    serial?: string,
    lines = 100,
    customAdbPath?: string,
  ): Promise<{ output: string; lines: number }> {
    const adb = this.resolveAdbPath(customAdbPath)
    const count = Math.min(Math.max(1, lines), 2000)
    const args = serial ? ['-s', serial, 'logcat', '-d', '-t', String(count)] : ['logcat', '-d', '-t', String(count)]

    try {
      const { stdout } = await execFileAsync(adb, args, { timeout: 15_000 })
      const outLines = stdout.split(/\r?\n/).length
      return { output: stdout, lines: outLines }
    } catch (err) {
      return {
        output: err instanceof Error ? err.message : String(err),
        lines: 0,
      }
    }
  }

  dispose(): void {
    void this.stopScrcpy()
  }
}
