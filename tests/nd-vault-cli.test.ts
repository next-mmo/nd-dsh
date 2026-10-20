import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CLI = resolve('scripts/nd-vault-cli.mjs')

interface Recorded {
  method: string
  path: string
  body?: Record<string, unknown>
  authorization?: string | undefined
}

function runCli(args: string[], environment: NodeJS.ProcessEnv, cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: cwd ?? process.cwd(),
      env: { ...process.env, ...environment },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

describe('nd-vault CLI', () => {
  let server: Server
  let url: string
  let recorded: Recorded[]
  let workspace: string
  let runEvents: Array<Record<string, unknown>>

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'nd-vault-cli-'))
    recorded = []
    runEvents = [
      { type: 'stdout', data: Buffer.from('ok').toString('base64') },
      { type: 'stderr', data: Buffer.from('').toString('base64') },
      { type: 'exit', code: 0 },
    ]
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined
        recorded.push({ method: req.method ?? '', path: req.url ?? '', ...(body ? { body } : {}), authorization: req.headers.authorization })
        if (req.headers.authorization !== 'Bearer test-token') {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'bad token' } }))
          return
        }
        if (req.url?.startsWith('/v1/status')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, context: { kind: 'personal' }, contextLabel: 'Personal', version: '1.1.0' }))
          return
        }
        if (req.url?.startsWith('/v1/list')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            ok: true,
            total: 1,
            entries: [{ id: 'e1', title: 'GitHub token', username: 'octocat', url: '', updatedAt: 1, ref: 'ndvault://e1/secret' }],
          }))
          return
        }
        if (req.url === '/v1/run') {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
          res.end(`${runEvents.map((event) => JSON.stringify(event)).join('\n')}\n`)
          return
        }
        if (req.url === '/v1/inject') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, path: '/workspace/.env.local' }))
          return
        }
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'not-found', message: 'no route' } }))
      })
    })
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
    const address = server.address()
    if (!address || typeof address !== 'object') throw new Error('stub server has no port')
    url = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    await rm(workspace, { recursive: true, force: true })
  })

  const env = (): NodeJS.ProcessEnv => ({ ND_DSH_VAULT_URL: url, ND_DSH_VAULT_TOKEN: 'test-token' })

  it('prints help without a broker', async () => {
    const result = await runCli(['--help'], { ND_DSH_VAULT_URL: '', ND_DSH_VAULT_TOKEN: '' })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('nd-vault')
    expect(result.stdout).toContain('ndvault://<entry-id>/secret')
  })

  it('fails closed when the session has no vault environment', async () => {
    const result = await runCli(['status'], { ND_DSH_VAULT_URL: '', ND_DSH_VAULT_TOKEN: '' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('not available in this session')
  })

  it('streams command output and sends only references', async () => {
    recorded = []
    const result = await runCli([
      'run',
      '--env', 'TOKEN=ndvault://e1/secret',
      '--purpose', 'unit test',
      '--',
      'node', '-e', 'process.stdout.write("ok")',
    ], env())
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('ok')
    const call = recorded.find((item) => item.path === '/v1/run')
    expect(call?.authorization).toBe('Bearer test-token')
    expect(call?.body).toMatchObject({
      command: ['node', '-e', 'process.stdout.write("ok")'],
      purpose: 'unit test',
    })
    expect((call?.body?.env as Record<string, string>).TOKEN).toBe('ndvault://e1/secret')
  })

  it('reads references from an env file', async () => {
    recorded = []
    await writeFile(join(workspace, '.env.ndvault'), '# deploy\nTOKEN=ndvault://e1/secret\n', 'utf8')
    const result = await runCli(['run', '--env-file', '.env.ndvault', '--', 'node', '-e', ''], env(), workspace)
    expect(result.code).toBe(0)
    const call = recorded.find((item) => item.path === '/v1/run')
    expect((call?.body?.env as Record<string, string>).TOKEN).toBe('ndvault://e1/secret')
  })

  it('refuses literal values in --env and prints no secret', async () => {
    recorded = []
    const result = await runCli(['run', '--env', 'TOKEN=plain-value', '--', 'node', '-e', ''], env(), workspace)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('not a literal value')
    expect(recorded.some((item) => item.path === '/v1/run')).toBe(false)
    expect(result.stderr).not.toContain('plain-value')
  })

  it('refuses reserved environment keys even with a reference', async () => {
    for (const key of ['ND_DSH_VAULT_TOKEN', 'DSH_TOKEN', 'ND_VAULT_TOKEN', 'ELECTRON_RUN_AS_NODE']) {
      const result = await runCli(['run', '--env', `${key}=ndvault://e1/secret`, '--', 'node', '-e', ''], env(), workspace)
      expect(result.code, key).toBe(1)
      expect(result.stderr, key).toContain('reserved by ND')
    }
  })

  it('rejects unknown options', async () => {
    const listResult = await runCli(['list', '--bogus'], env(), workspace)
    expect(listResult.code).toBe(1)
    expect(listResult.stderr).toContain('unknown option')
    const whoamiResult = await runCli(['whoami', '--bogus'], env(), workspace)
    expect(whoamiResult.code).toBe(1)
    expect(whoamiResult.stderr).toContain('unknown option')
    const runResult = await runCli(['run', '--bogus'], env(), workspace)
    expect(runResult.code).toBe(1)
    expect(runResult.stderr).toContain('unknown option')
  })

  it('propagates the child exit code', async () => {
    runEvents = [{ type: 'stdout', data: Buffer.from('partial').toString('base64') }, { type: 'exit', code: 7 }]
    try {
      const result = await runCli(['run', '--env', 'TOKEN=ndvault://e1/secret', '--', 'node', '-e', ''], env(), workspace)
      expect(result.stdout).toBe('partial')
      expect(result.code).toBe(7)
    } finally {
      runEvents = [{ type: 'stdout', data: Buffer.from('ok').toString('base64') }, { type: 'stderr', data: '', }, { type: 'exit', code: 0 }]
    }
  })

  it('lists metadata and references', async () => {
    const result = await runCli(['list', '--refs'], env(), workspace)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('GitHub token')
    expect(result.stdout).toContain('ndvault://e1/secret')
  })

  it('writes injected files through the broker and refuses stdout', async () => {
    recorded = []
    await writeFile(join(workspace, 'config.template'), 'TOKEN={{ ndvault://e1/secret }}\n', 'utf8')
    const result = await runCli(['inject', '--in', 'config.template', '--out', '.env.local'], env(), workspace)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('/workspace/.env.local')
    const call = recorded.find((item) => item.path === '/v1/inject')
    expect(call?.body).toMatchObject({ outPath: '.env.local', force: false })
    expect((call?.body?.template as string)).toContain('ndvault://e1/secret')

    const refused = await runCli(['inject', '--in', 'config.template', '--out', '-'], env(), workspace)
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('never writes resolved secrets to stdout')
  })

  it('prints broker errors without leaking the token', async () => {
    const result = await runCli(['whoami'], { ND_DSH_VAULT_URL: url, ND_DSH_VAULT_TOKEN: 'wrong-token' }, workspace)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('bad token')
    expect(result.stderr).not.toContain('wrong-token')
  })

  it('keeps a template readable and never prints values', async () => {
    const template = await readFile(join(workspace, 'config.template'), 'utf8')
    expect(template).toContain('ndvault://e1/secret')
  })
})
