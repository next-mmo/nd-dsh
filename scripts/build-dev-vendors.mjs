import { spawn } from 'node:child_process'
import { constants, setPriority } from 'node:os'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.some((arg) => arg !== '--skip-harness-install')) {
  console.error('Usage: corepack pnpm dev:vendors [--skip-harness-install]')
  process.exitCode = 1
} else {
  const env = { ...process.env }
  if (process.platform === 'win32') {
    setPriority(constants.priority.PRIORITY_BELOW_NORMAL)
    env.CARGO_BUILD_JOBS ??= '4'
    env.GOMAXPROCS ??= '4'
  }

  const root = fileURLToPath(new URL('../', import.meta.url))
  const harnessArgs = args.includes('--skip-harness-install') ? ['--skip-install'] : []
  for (const [script, ...scriptArgs] of [
    ['scripts/build-harness.mjs', ...harnessArgs],
    ['scripts/build-nd-pencil.mjs'],
    ['scripts/build-free-gemini-api.mjs'],
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
}
