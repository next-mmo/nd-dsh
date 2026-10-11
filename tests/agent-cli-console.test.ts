import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { spawnCliCommand } from '../src/main/engines/agent-cli/agent-cli-support.js'

const root = mkdtempSync(join(tmpdir(), 'nd-cli-console-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('ND background CLI launch policy', () => {
  it.each([undefined, false])('hides a direct CLI even when the caller supplies %s', (windowsHide) => {
    const child = {} as ChildProcess
    const spawnProcess = vi.fn(() => child)
    const environment = { ND_TEST_MARKER: 'dummy-test-value' }
    expect(spawnCliCommand(spawnProcess as typeof spawn, 'fixture-cli', ['--stdio'], {
      windowsHide, cwd: root, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: false,
    })).toBe(child)
    expect(spawnProcess).toHaveBeenCalledWith('fixture-cli', ['--stdio'], {
      windowsHide: true, cwd: root, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: false,
    })
  })
})

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const consoleProbe = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class NDCliConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'; [NDCliConsoleProbe]::GetConsoleWindow().ToInt64()`

function run(bin: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Deliberately omit windowsHide: the production helper owns this policy.
    const child = spawnCliCommand(spawn, bin, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Background CLI probe did not exit within 20 seconds'))
    }, 20_000)
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    child.stdin?.end(input)
  })
}

describe.skipIf(process.platform !== 'win32')('actual Windows background coding CLI processes', () => {
  it('creates no console for the direct CLI process', async () => {
    const result = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', consoleProbe])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('0')
    expect(result.stderr).toBe('')
  }, 25_000)

  it('creates no console for the cmd shim or its inherited native child', async () => {
    const script = join(root, 'console-probe.ps1')
    writeFileSync(script, consoleProbe)
    const shim = join(root, 'plain-native.cmd')
    writeFileSync(shim, `@echo off\r\n"${powershell}" -NoProfile -NonInteractive -File "${script}"\r\n`)
    const result = await run(shim, [])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('0')
    expect(result.stderr).toBe('')
  }, 25_000)

  it('preserves input, output, diagnostics, and failure status', async () => {
    const result = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::Out.Write([Console]::In.ReadToEnd()); [Console]::Error.Write("diagnostic-marker"); exit 7'], 'input-marker')
    expect(result).toEqual({ code: 7, stdout: 'input-marker', stderr: 'diagnostic-marker' })
  }, 25_000)
})
