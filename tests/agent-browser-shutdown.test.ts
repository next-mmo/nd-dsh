import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({ userData: '', isPackaged: false }))
vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.userData,
    get isPackaged() { return electronState.isPackaged },
  },
}))

import {
  AGENT_BROWSER_DAEMON_NAMESPACE,
  AgentBrowserClient,
  appBrowserSocketDir,
  isAgentBrowserDaemonCommand,
  stopAppOwnedBrowserDaemons,
} from '../src/main/browser/agent-browser-client.js'

const temporary: string[] = []

afterEach(async () => {
  electronState.isPackaged = false
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('AgentBrowserClient shutdown ownership', () => {
  it('resolves its packaged MCP entry beside app.asar in extraResources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-agent-browser-packaged-path-'))
    temporary.push(root)
    electronState.userData = root
    electronState.isPackaged = true
    const previousResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: root })

    try {
      const client = new AgentBrowserClient(9_222, join(root, 'resources', 'app.asar'))
      expect(client.entryPath).toBe(process.platform === 'win32'
        ? join(root, 'scripts', 'nd-agent-browser-cli.mjs')
        : join(root, 'node_modules', 'agent-browser', 'bin', 'agent-browser.js'))
      expect(client.environment()).toMatchObject({
        ND_DSH_AGENT_BROWSER_BIN: process.execPath,
        ND_DSH_AGENT_BROWSER_ENTRY: client.entryPath,
        ND_DSH_AGENT_BROWSER_CONFIG: client.configPath,
        ND_DSH_AGENT_BROWSER_SESSION: client.sessionName,
      })
    } finally {
      if (previousResourcesPath) Object.defineProperty(process, 'resourcesPath', previousResourcesPath)
      else Reflect.deleteProperty(process, 'resourcesPath')
    }
  })

  it('cleans an app-owned daemon even when another client started it before this wrapper touched the session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-agent-browser-external-daemon-'))
    temporary.push(root)
    electronState.userData = root

    const client = new AgentBrowserClient(9_222, root)
    await mkdir(client.socketDir, { recursive: true })
    const pidPath = join(client.socketDir, `${client.sessionName}.pid`)
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (!daemon.pid) throw new Error('test daemon did not start')
    const daemonPid = daemon.pid
    await writeFile(pidPath, String(daemonPid), 'utf8')

    const internal = client as unknown as {
      sessionTouched: boolean
      run: (command: string[], globalArguments?: string[], timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>
    }
    expect(internal.sessionTouched).toBe(false)
    internal.run = vi.fn(async () => {
      await rm(pidPath, { force: true })
      return { stdout: '', stderr: '' }
    })

    try {
      await client.close()
      await waitForExit(daemon, 2_000)
      expect(isAlive(daemonPid)).toBe(false)
      expect(internal.run).toHaveBeenCalledWith(['close', '--all'], [], expect.any(Number), expect.any(Object))
    } finally {
      if (isAlive(daemonPid)) {
        try { process.kill(daemonPid, 'SIGKILL') } catch { /* already exited */ }
      }
    }
  }, 8_000)

  it('kills the daemon captured before close even when the CLI removes its pid file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-agent-browser-shutdown-'))
    temporary.push(root)
    electronState.userData = root

    const client = new AgentBrowserClient(9_222, root)
    await mkdir(client.socketDir, { recursive: true })
    const pidPath = join(client.socketDir, `${client.sessionName}.pid`)
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (!daemon.pid) throw new Error('test daemon did not start')
    const daemonPid = daemon.pid
    await writeFile(pidPath, String(daemonPid), 'utf8')

    const internal = client as unknown as {
      sessionTouched: boolean
      run: (command: string[], globalArguments?: string[], timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>
    }
    internal.sessionTouched = true
    internal.run = vi.fn(async () => {
      // Reproduce agent-browser close: its ownership file disappears while the
      // daemon remains alive. The client must retain the pre-close pid.
      await rm(pidPath, { force: true })
      return { stdout: '', stderr: '' }
    })

    try {
      await client.close()
      await waitForExit(daemon, 2_000)
      expect(isAlive(daemonPid)).toBe(false)
      expect(internal.run).toHaveBeenCalledWith(['close', '--all'], [], expect.any(Number), expect.any(Object))
    } finally {
      if (isAlive(daemonPid)) {
        try { process.kill(daemonPid, 'SIGKILL') } catch { /* already exited */ }
      }
    }
  }, 8_000)

  it('stops a daemon another app-owned session left in this app socket directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-agent-browser-other-session-'))
    temporary.push(root)
    electronState.userData = root

    const client = new AgentBrowserClient(9_222, root)
    await mkdir(client.socketDir, { recursive: true })
    // The Harness browser MCP names its own session, so its daemon lives behind
    // a sidecar this wrapper's session name never matches. The app still owns
    // it, and a daemon that outlives the app is what stalls e2e teardown.
    const otherPidPath = join(client.socketDir, 'harness-browser-mcp.pid')
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (!daemon.pid) throw new Error('test daemon did not start')
    const daemonPid = daemon.pid
    await writeFile(otherPidPath, String(daemonPid), 'utf8')

    const internal = client as unknown as {
      sessionTouched: boolean
      run: (command: string[], globalArguments?: string[], timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>
    }
    expect(internal.sessionTouched).toBe(false)
    internal.run = vi.fn(async () => {
      await rm(otherPidPath, { force: true })
      return { stdout: '', stderr: '' }
    })

    try {
      await client.close()
      await waitForExit(daemon, 2_000)
      expect(isAlive(daemonPid)).toBe(false)
      expect(internal.run).toHaveBeenCalledWith(['close', '--all'], [], expect.any(Number), expect.any(Object))
    } finally {
      if (isAlive(daemonPid)) {
        try { process.kill(daemonPid, 'SIGKILL') } catch { /* already exited */ }
      }
    }
  }, 8_000)
  it('stops a config-only consumer daemon in the namespaced home state directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-agent-browser-config-only-'))
    temporary.push(root)
    electronState.userData = root

    const client = new AgentBrowserClient(9_222, root)
    // A consumer that reads only the config file — the Harness browser MCP — has
    // no AGENT_BROWSER_SOCKET_DIR, so its daemon lands under the user's home state
    // directory rather than the app's socket directory. The pinned namespace is
    // what makes that location predictable enough to clean up.
    const configOnlyRoot = join(root, '.agent-browser', 'namespaces', AGENT_BROWSER_DAEMON_NAMESPACE, 'run')
    await mkdir(configOnlyRoot, { recursive: true })
    const pidPath = join(configOnlyRoot, 'harness-browser-mcp.pid')
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (!daemon.pid) throw new Error('test daemon did not start')
    const daemonPid = daemon.pid
    await writeFile(pidPath, String(daemonPid), 'utf8')

    const internal = client as unknown as {
      sessionTouched: boolean
      run: (command: string[], globalArguments?: string[], timeoutMs?: number, options?: object) => Promise<{ stdout: string; stderr: string }>
    }
    expect(internal.sessionTouched).toBe(false)
    internal.run = vi.fn(async () => {
      await rm(pidPath, { force: true })
      return { stdout: '', stderr: '' }
    })

    try {
      await client.close()
      await waitForExit(daemon, 2_000)
      expect(isAlive(daemonPid)).toBe(false)
      expect(internal.run).toHaveBeenCalledWith(['close', '--all'], [], expect.any(Number), { withoutSocketDir: true })
    } finally {
      if (isAlive(daemonPid)) {
        try { process.kill(daemonPid, 'SIGKILL') } catch { /* already exited */ }
      }
    }
  }, 8_000)

  it('stops owned daemons on the app-wide sweep, which runs after every service closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-agent-browser-app-sweep-'))
    temporary.push(root)
    electronState.userData = root

    // A daemon can be started while the app is already shutting down; the final
    // sweep has no session state to consult and must still stop it.
    const runDir = join(appBrowserSocketDir(), 'namespaces', AGENT_BROWSER_DAEMON_NAMESPACE, 'run')
    await mkdir(runDir, { recursive: true })
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (!daemon.pid) throw new Error('test daemon did not start')
    const daemonPid = daemon.pid
    await writeFile(join(runDir, 'leftover.pid'), String(daemonPid), 'utf8')

    try {
      expect(await stopAppOwnedBrowserDaemons()).toBe(1)
      await waitForExit(daemon, 2_000)
      expect(isAlive(daemonPid)).toBe(false)
    } finally {
      if (isAlive(daemonPid)) {
        try { process.kill(daemonPid, 'SIGKILL') } catch { /* already exited */ }
      }
    }
  }, 8_000)
})

describe('agent-browser daemon process matching', () => {
  it('matches the development CLI binary and the packaged entry script', () => {
    expect(isAgentBrowserDaemonCommand(
      String.raw`C:\Program Files\ND\resources\node_modules\agent-browser\bin\agent-browser-win32-x64.exe`,
    )).toBe(true)
    expect(isAgentBrowserDaemonCommand(
      '/repo/node_modules/.pnpm/agent-browser@0.34.0/node_modules/agent-browser/bin/agent-browser-linux-x64',
    )).toBe(true)
    expect(isAgentBrowserDaemonCommand(
      'C:\\Program Files\\ND\\resources\\app.asar\\node_modules\\agent-browser\\bin\\agent-browser.js',
    )).toBe(true)
  })

  it('does not match this app, a package shim, or another agent-browser install', () => {
    // The app itself runs the Electron binary; the packaged daemon adds the
    // entry script, which is matched above. The binary alone must not match.
    expect(isAgentBrowserDaemonCommand('/repo/node_modules/electron/dist/electron --type=renderer')).toBe(false)
    // A shim only relays to the real binary, which is matched on its own.
    expect(isAgentBrowserDaemonCommand('/repo/node_modules/.bin/agent-browser --config x get url')).toBe(false)
    // Someone else's installation is not this app's daemon.
    expect(isAgentBrowserDaemonCommand('/usr/local/bin/agent-browser open https://example.com')).toBe(false)
  })
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      reject(new Error('captured test daemon did not exit'))
    }, timeoutMs)
    const onExit = (): void => {
      clearTimeout(timer)
      resolve()
    }
    child.once('exit', onExit)
  })
}
