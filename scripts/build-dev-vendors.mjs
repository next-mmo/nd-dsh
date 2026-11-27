import { spawn, execFileSync } from 'node:child_process'
import { acquireLocalWorkload } from './local-workload.mjs'
import { buildFreeGeminiApi } from './build-free-gemini-api.mjs'
import { constants, setPriority } from 'node:os'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.some((arg) => arg !== '--skip-harness-install')) {
  console.error('Usage: corepack pnpm dev:vendors [--skip-harness-install]')
  process.exitCode = 1
} else {
  acquireLocalWorkload('vendor build')
  // Fail before cleaning and rebuilding the Harness if the last stage cannot run.
  try {
    execFileSync('go', ['version'], { timeout: 10_000, windowsHide: true, stdio: 'pipe' })
  } catch (cause) {
    throw new Error('The vendor build requires a working Go toolchain on PATH. No vendor builds were started.', { cause })
  }
  const env = { ...process.env }
  if (process.platform === 'win32') {
    setPriority(constants.priority.PRIORITY_BELOW_NORMAL)
    env.CARGO_BUILD_JOBS ??= '2'
    env.RAYON_NUM_THREADS ??= '2'
    env.GOMAXPROCS ??= '2'
  }

  const root = fileURLToPath(new URL('../', import.meta.url))
  const harnessArgs = args.includes('--skip-harness-install') ? ['--skip-install'] : []
  for (const [script, ...scriptArgs] of [
    ['scripts/build-harness.mjs', ...harnessArgs],
    ['scripts/build-nd-pencil.mjs'],
  ]) {
    console.log(`\n> node ${[script, ...scriptArgs].join(' ')}`)
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...scriptArgs], { cwd: root, env, stdio: 'inherit' })
      child.once('error', reject)
      child.once('close', (code) => resolve(code ?? 1))
    })
    if (code !== 0) {
      process.exitCode = code
      break
    }
  }
  if (!process.exitCode) await buildFreeGeminiApi(env)
}
