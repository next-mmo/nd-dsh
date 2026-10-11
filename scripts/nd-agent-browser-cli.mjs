#!/usr/bin/env node
// ND owns the Windows launch boundary. The upstream Node wrapper explicitly
// enables console windows, so neither the desktop nor its MCP clients use it.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const resourceRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const binary = process.env.ND_DSH_AGENT_BROWSER_NATIVE_BIN?.trim()
  || join(resourceRoot, 'node_modules', 'agent-browser', 'bin', `agent-browser-win32-${process.arch}.exe`)

if (!existsSync(binary)) {
  console.error('ND browser runtime is missing. Reinstall ND.')
  process.exit(1)
}

const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(binary, process.argv.slice(2), {
  // Electron's inherited stdio can still attach the child to a Windows
  // console even with windowsHide. Pipes keep the native launch console-free.
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: environment,
})
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
child.stdin.on('error', () => { /* The CLI may exit before input is consumed. */ })
child.once('error', (error) => {
  console.error(`ND browser runtime could not start: ${error.message}`)
  process.exitCode = 1
})
child.once('close', (code) => {
  process.stdin.unpipe(child.stdin)
  process.stdin.pause()
  process.exitCode = code ?? 1
})
