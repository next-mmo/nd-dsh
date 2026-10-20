#!/usr/bin/env node
/**
 * ND secure vault CLI.
 *
 * This is a thin client. It sends references and a command (or template) to the
 * ND desktop broker, which resolves the values itself and executes the child or
 * writes the file. The CLI never receives a value, never prints one, and never
 * forwards its own loopback token to the child command.
 */

import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { StringDecoder } from 'node:string_decoder'

const PREFIX = 'ndvault://'
const FIELDS = new Set(['secret', 'username', 'url', 'notes'])
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const CONTROL_ENV = /^(ND_DSH_|DSH_|ND_VAULT_)/i
const MAX_TEMPLATE_BYTES = 1024 * 1024
const VERSION = '1.0.0'

const USAGE = `nd-vault ${VERSION} — use ND Password Vault entries without reading them

Usage:
  nd-vault whoami [--json]
  nd-vault list [query] [--json] [--refs]
  nd-vault run [--env KEY=REF]... [--env-file FILE]... [--purpose TEXT]
               [--timeout SECONDS] -- COMMAND [ARGS...]
  nd-vault inject --in TEMPLATE --out FILE [--force] [--purpose TEXT]
  nd-vault --help

References:
  ndvault://<entry-id>/secret     (default field: secret)
  ndvault://<title>/username      (title must match exactly one entry)
  Fields: secret, username, url, notes

Examples:
  nd-vault list --refs
  nd-vault run --env GITHUB_TOKEN=ndvault://github/secret -- gh release create v1.0.0
  nd-vault run --env-file .env.ndvault -- npm run deploy
  nd-vault inject --in config.template --out .env.local

Security:
  Commands receive references only. ND resolves them inside the desktop process
  and injects them into the child process environment; the CLI never sees a
  value. Never print, echo, or pass a resolved value on a command line, and
  never run env/printenv with vault references. Each entry needs the user's
  approval in ND unless they remembered the grant.
`

function fail(message, code = 1) {
  process.stderr.write(`nd-vault: ${message}\n`)
  process.exitCode = code
}

function broker() {
  const url = process.env.ND_DSH_VAULT_URL?.trim()
  const token = process.env.ND_DSH_VAULT_TOKEN?.trim()
  if (!url || !token) {
    throw new Error(
      'the secure vault CLI is not available in this session. Install and activate Password Vault for this context in ND Settings → Extensions, then start a new agent session.',
    )
  }
  return { url, token }
}

async function request(path, options = {}) {
  const { url, token } = broker()
  const response = await fetch(`${url}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const parsed = await response.json()
      if (parsed?.error?.message) detail = parsed.error.message
    } catch {
      // Keep the status line.
    }
    throw new Error(detail)
  }
  return response
}

async function requestJson(path, options) {
  return await (await request(path, options)).json()
}

function parseRef(value) {
  const text = value.trim()
  if (!text.startsWith(PREFIX)) return undefined
  const body = text.slice(PREFIX.length)
  if (!body) return undefined
  const slash = body.lastIndexOf('/')
  let target = body
  let field = 'secret'
  if (slash > 0) {
    const candidate = body.slice(slash + 1)
    if (FIELDS.has(candidate)) {
      field = candidate
      target = body.slice(0, slash)
    }
  }
  if (!target) return undefined
  try {
    target = decodeURIComponent(target)
  } catch {
    return undefined
  }
  if (!target.trim() || target.includes('\0')) return undefined
  return { raw: text, target, field }
}

function requireRef(value, label) {
  const ref = parseRef(value)
  if (!ref) throw new Error(`${label} must reference an entry as ndvault://<entry>/<field>, not a literal value`)
  return ref
}

function requireEnvKey(key, label) {
  if (!ENV_KEY.test(key)) throw new Error(`${label}: "${key}" is not a valid environment variable name`)
  if (CONTROL_ENV.test(key) || key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') {
    throw new Error(`${label}: ${key} is reserved by ND and cannot receive a vault value`)
  }
}

function parseEnvFile(text, source) {
  const entries = []
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error(`${source}:${index + 1}: expected KEY=ndvault://...`)
    const key = line.slice(0, separator).trim()
    requireEnvKey(key, `${source}:${index + 1}`)
    entries.push({ key, ref: requireRef(line.slice(separator + 1), `${source}:${index + 1}`) })
  }
  return entries
}

async function whoami(args) {
  const unknown = args.filter((arg) => arg !== '--json')
  if (unknown.length > 0) throw new Error(`unknown option: ${unknown[0]}`)
  const json = args.includes('--json')
  const payload = await requestJson(`/v1/status?cwd=${encodeURIComponent(process.cwd())}`)
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }
  process.stdout.write(`context: ${payload.contextLabel}\nvault: enabled (v${payload.version})\n`)
}

async function list(args) {
  const positional = []
  const flags = new Set()
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      if (name !== 'json' && name !== 'refs') throw new Error(`unknown option: ${arg}`)
      flags.add(name)
    } else {
      positional.push(arg)
    }
  }
  const query = positional.join(' ').trim()
  const payload = await requestJson(
    `/v1/list?cwd=${encodeURIComponent(process.cwd())}${query ? `&query=${encodeURIComponent(query)}` : ''}`,
  )
  if (flags.has('json')) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }
  if (!payload.entries?.length) {
    process.stdout.write('No vault entries match.\n')
    return
  }
  for (const entry of payload.entries) {
    const row = [entry.id, entry.title, entry.username, entry.url].filter(Boolean).join('  ')
    process.stdout.write(`${row}\n`)
    if (flags.has('refs')) process.stdout.write(`  ${entry.ref}\n`)
  }
}

async function parseRun(args) {
  const env = []
  const envFiles = []
  let purpose
  let timeout
  const separator = args.indexOf('--')
  const options = separator === -1 ? args : args.slice(0, separator)
  const command = separator === -1 ? [] : args.slice(separator + 1)
  for (let index = 0; index < options.length; index += 1) {
    const arg = options[index]
    const separatorIndex = arg.indexOf('=')
    const name = separatorIndex === -1 ? arg : arg.slice(0, separatorIndex)
    const inline = separatorIndex === -1 ? undefined : arg.slice(separatorIndex + 1)
    const take = () => {
      if (inline !== undefined) return inline
      const value = options[++index]
      if (value === undefined) throw new Error(`${name} needs a value`)
      return value
    }
    if (name === '--env') {
      const value = take()
      const split = value.indexOf('=')
      if (split <= 0) throw new Error('--env expects KEY=ndvault://...')
      const key = value.slice(0, split)
      requireEnvKey(key, '--env')
      env.push({ key, ref: requireRef(value.slice(split + 1), '--env') })
    } else if (name === '--env-file') {
      envFiles.push(take())
    } else if (name === '--purpose') {
      purpose = take()
    } else if (name === '--timeout') {
      const parsed = Number(take())
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--timeout must be a positive number of seconds')
      timeout = parsed
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }
  if (command.length === 0) throw new Error('run needs a command after --')
  for (const file of envFiles) {
    const text = await fs.readFile(resolve(process.cwd(), file), 'utf8')
    env.push(...parseEnvFile(text, file))
  }
  if (env.length === 0) throw new Error('run needs at least one --env or --env-file reference')
  return { env, command, purpose, timeout }
}

function handleEvent(event) {
  if (event.type === 'stdout') {
    process.stdout.write(Buffer.from(event.data, 'base64'))
  } else if (event.type === 'stderr') {
    process.stderr.write(Buffer.from(event.data, 'base64'))
  } else if (event.type === 'error') {
    process.stderr.write(`nd-vault: ${event.message}\n`)
    if (!process.exitCode) process.exitCode = 1
  } else if (event.type === 'exit') {
    process.exitCode = typeof event.code === 'number' ? event.code : 1
  }
}

async function run(args) {
  const parsed = await parseRun(args)
  const environment = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !/^ND_DSH_VAULT_/i.test(key)) environment[key] = value
  }
  for (const { key, ref } of parsed.env) environment[key] = ref.raw
  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const response = await request('/v1/run', {
      method: 'POST',
      body: {
        cwd: process.cwd(),
        command: parsed.command,
        env: environment,
        ...(parsed.purpose ? { purpose: parsed.purpose } : {}),
        ...(parsed.timeout ? { timeoutSeconds: parsed.timeout } : {}),
      },
      signal: controller.signal,
    })
    if (!response.body) throw new Error('ND returned an empty command stream')
    const decoder = new StringDecoder('utf8')
    let pending = ''
    for await (const chunk of response.body) {
      pending += decoder.write(Buffer.from(chunk))
      let newline
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (line) handleEvent(JSON.parse(line))
      }
    }
    pending += decoder.end()
    if (pending.trim()) handleEvent(JSON.parse(pending.trim()))
  } catch (error) {
    if (controller.signal.aborted) {
      process.exitCode = 130
      return
    }
    throw error
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
}

async function inject(args) {
  let input
  let output
  let force = false
  let purpose
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--force') {
      force = true
      continue
    }
    if (arg === '--in') {
      input = args[++index]
      continue
    }
    if (arg === '--out') {
      output = args[++index]
      continue
    }
    if (arg === '--purpose') {
      purpose = args[++index]
      continue
    }
    throw new Error(`unknown option: ${arg}`)
  }
  if (!input || !output) throw new Error('inject needs --in TEMPLATE and --out FILE')
  if (output === '-') throw new Error('inject never writes resolved secrets to stdout')
  const template = await fs.readFile(resolve(process.cwd(), input), 'utf8')
  if (Buffer.byteLength(template, 'utf8') > MAX_TEMPLATE_BYTES) throw new Error('template is too large')
  const payload = await requestJson('/v1/inject', {
    method: 'POST',
    body: {
      cwd: process.cwd(),
      template,
      outPath: output,
      force,
      ...(purpose ? { purpose } : {}),
    },
  })
  process.stdout.write(`${payload.path}\n`)
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE)
    return
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`nd-vault ${VERSION}\n`)
    return
  }
  if (command === 'whoami' || command === 'status') return await whoami(args)
  if (command === 'list') return await list(args)
  if (command === 'run') return await run(args)
  if (command === 'inject') return await inject(args)
  throw new Error(`unknown command: ${command}\n\n${USAGE}`)
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
