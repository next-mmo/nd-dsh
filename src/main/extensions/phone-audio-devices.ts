import { execFile } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'
import type { PhoneAudioOutputDevice } from '../../shared/phone-audio.js'

const execFileAsync = promisify(execFile)

/**
 * Query active Windows MMDevice playback (render) endpoints without requiring
 * browser microphone permissions. In Windows `SWD\MMDEVAPI`, `{0.0.0.00000000}`
 * identifies render (output) endpoints and excludes microphones (`{0.0.1.00000000}`).
 */
export async function readWindowsOutputEndpoints(): Promise<PhoneAudioOutputDevice[]> {
  if (process.platform !== 'win32') return []
  try {
    const command =
      "Get-PnpDevice -Class AudioEndpoint -Status OK -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like '*{0.0.0.00000000}*' } | Select-Object FriendlyName, InstanceId | ConvertTo-Json -Compress"
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 3_000, maxBuffer: 256 * 1024 },
    )
    const trimmed = stdout.trim()
    if (!trimmed) return []
    const parsed: unknown = JSON.parse(trimmed)
    const items = Array.isArray(parsed) ? parsed : [parsed]
    const devices: PhoneAudioOutputDevice[] = []
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const record = item as { FriendlyName?: unknown; InstanceId?: unknown }
      const label = typeof record.FriendlyName === 'string' ? record.FriendlyName.trim() : ''
      const id = typeof record.InstanceId === 'string' ? record.InstanceId.trim() : label
      if (!label) continue
      devices.push({
        deviceId: id,
        label,
        groupId: 'windows-render',
        isDefault: devices.length === 0,
      })
    }
    return devices
  } catch {
    return []
  }
}
