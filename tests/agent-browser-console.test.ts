import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const bridge = join(process.cwd(), 'scripts', 'nd-agent-browser-cli.mjs')

describe.skipIf(process.platform !== 'win32')('ND browser Windows launch boundary', () => {
  it('keeps the real native child console hidden through the Node bridge', async () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const probe = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class NDConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'; [NDConsoleProbe]::GetConsoleWindow().ToInt64()`
    const { stdout } = await execFileAsync(process.execPath, [bridge, '-NoProfile', '-NonInteractive', '-Command', probe], {
      windowsHide: true,
      env: { ...process.env, ND_DSH_AGENT_BROWSER_NATIVE_BIN: powershell, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 20_000,
    })
    expect(stdout.trim()).toBe('0')
  }, 25_000)

  it('runs the installed native browser CLI without the upstream wrapper', async () => {
    const { stdout } = await execFileAsync(process.execPath, [bridge, '--version'], {
      windowsHide: true,
      timeout: 20_000,
    })
    expect(stdout).toMatch(/agent-browser\s+\d+\./)
  }, 25_000)

  it('keeps the native console absent when Electron runs the bridge', async () => {
    const electron = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const probe = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class NDElectronConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'; [NDElectronConsoleProbe]::GetConsoleWindow().ToInt64()`
    const { stdout } = await execFileAsync(electron, [bridge, '-NoProfile', '-NonInteractive', '-Command', probe], {
      windowsHide: true,
      env: { ...process.env, ND_DSH_AGENT_BROWSER_NATIVE_BIN: powershell, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 20_000,
    })
    expect(stdout.trim()).toBe('0')
  }, 25_000)

  it('forwards CLI input, output, errors, and failing exit status', async () => {
    const electron = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const result = await new Promise<{ code: number | string | null | undefined; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(electron, [bridge, '-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write([Console]::In.ReadToEnd()); [Console]::Error.Write("error-marker"); exit 7'], {
        windowsHide: true,
        env: { ...process.env, ND_DSH_AGENT_BROWSER_NATIVE_BIN: powershell, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 20_000,
      }, (error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr }))
      child.stdin?.end('input-marker')
    })
    expect(result).toEqual({ code: 7, stdout: 'input-marker', stderr: 'error-marker' })
  }, 25_000)
})
