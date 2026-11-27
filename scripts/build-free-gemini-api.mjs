#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { acquireLocalWorkload } from './local-workload.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const upstreamRoot = join(root, 'vendor', 'free-gemini-api', 'free-gemini-api')
const mainGo = join(upstreamRoot, 'main.go')
const binaryName = process.platform === 'win32' ? 'free-gemini-api.exe' : 'free-gemini-api'
const stagedDirectory = join(root, 'resources', 'free-gemini-api', 'bin')
const stagedBinary = join(stagedDirectory, binaryName)

export async function buildFreeGeminiApi(environment = process.env) {
  if (!existsSync(mainGo)) {
    throw new Error('Free Gemini API upstream source is missing. Initialize vendor/free-gemini-api first.')
  }
  const env = { ...environment }
  if (process.platform === 'win32') env.GOMAXPROCS ??= '2'
  await fs.mkdir(stagedDirectory, { recursive: true })
  await run('go', ['build', '-o', stagedBinary, '.'], upstreamRoot, env)
  if (!existsSync(stagedBinary)) {
    throw new Error(`Free Gemini API build completed without ${stagedBinary}`)
  }
  if (process.platform !== 'win32') await fs.chmod(stagedBinary, 0o755)
  console.log(`\nFree Gemini API runtime staged: ${stagedBinary}`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  acquireLocalWorkload('Free Gemini API build')
  await buildFreeGeminiApi()
}

function run(command, args, cwd, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      shell: false,
    })
    child.on('error', rejectRun)
    child.on('exit', (code) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`))
    })
  })
}
