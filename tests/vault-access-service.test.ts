import { request as httpRequest } from 'node:http'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contextKey, type NdContext } from '../src/shared/nd-context.js'
import { VaultAccessService } from '../src/main/vault/vault-access-service.js'

const ENTRIES = [
  { id: 'e1', title: 'GitHub token', username: 'octocat', url: 'https://github.com', notes: 'notes one', secret: 's3cret-1', createdAt: 1, updatedAt: 2 },
  { id: 'e2', title: 'Deploy key', username: '', url: '', notes: '', secret: 's3cret-2', createdAt: 1, updatedAt: 2 },
  { id: 'e3', title: 'Duplicate', username: 'a', url: '', notes: '', secret: 's3cret-3', createdAt: 1, updatedAt: 2 },
  { id: 'e4', title: 'Duplicate', username: 'b', url: '', notes: '', secret: 's3cret-4', createdAt: 1, updatedAt: 2 },
  { id: 'e5', title: 'Short PIN', username: '', url: '', notes: '', secret: 'q7Z', createdAt: 1, updatedAt: 2 },
]

interface Grant {
  id: string
  contextKey: string
  resource: string
  scope: 'once' | 'remembered'
}

interface Approval {
  approvalId: string
  context: NdContext
  resources: string[]
  approve(remember?: boolean): void
  deny(): void
}

function jsonLine(events: string): Array<Record<string, unknown>> {
  return events.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}

function stdoutText(events: Array<Record<string, unknown>>): string {
  return events
    .filter((event) => event.type === 'stdout')
    .map((event) => Buffer.from(String(event.data), 'base64').toString('utf8'))
    .join('')
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the vault approval')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('VaultAccessService', () => {
  let workspaceRoot: string
  let projectRoot: string
  let currentRoot: string
  let userData: string
  let service: VaultAccessService
  let baseUrl: string
  let token: string
  let activations: Map<string, boolean>
  let settings: Map<string, Record<string, unknown>>
  let grants: Map<string, Grant>
  let audits: Array<Record<string, unknown>>
  let approvals: Approval[]
  let organization: { activeProjectId?: string | undefined; projects: Array<{ id: string; companyId: string; workspacePath?: string }>; runs: Array<{ projectId: string; companyId: string; workspaceRoot?: string; startedAt: number }> }

  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
  }

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'nd-vault-ws-'))
    projectRoot = await mkdtemp(join(tmpdir(), 'nd-vault-project-'))
    currentRoot = workspaceRoot
    userData = await mkdtemp(join(tmpdir(), 'nd-vault-data-'))
    activations = new Map()
    settings = new Map()
    grants = new Map()
    audits = []
    approvals = []
    organization = { projects: [], runs: [] }
    const coreVault = {
      list: async (_path: string, query?: string) => {
        const needle = (query ?? '').toLowerCase()
        const entries = ENTRIES.filter((entry) =>
          !needle
          || entry.title.toLowerCase().includes(needle)
          || entry.username.toLowerCase().includes(needle)
          || entry.url.toLowerCase().includes(needle))
        return { entries: entries.map(({ secret: _secret, notes: _notes, createdAt: _createdAt, ...rest }) => rest), total: entries.length }
      },
      get: async (_path: string, id: string) => {
        const entry = ENTRIES.find((candidate) => candidate.id === id)
        if (!entry) throw new Error('missing entry')
        return entry
      },
    }
    const state = {
      activation: async (_id: string, context: NdContext) => ({
        enabled: activations.get(contextKey(context)) ?? true,
      }),
      settingsFor: async (_id: string, context: NdContext) => settings.get(contextKey(context)) ?? {},
      findGrant: async (_id: string, _host: string, context: NdContext, resource?: string) => {
        const key = contextKey(context)
        return [...grants.values()].find((grant) => grant.contextKey === key && grant.resource === resource)
      },
      consumeGrant: async (id: string) => {
        for (const [key, grant] of grants) if (grant.id === id) grants.delete(key)
      },
      recordAudit: async (entry: Record<string, unknown>) => {
        audits.push(entry)
      },
    }
    const broker = {
      requestAccess: (input: { context: NdContext; resources: string[]; title: string; detail?: string }) => {
        const approvalId = `approval-${approvals.length + 1}`
        let resolveDecision: (value: { approved: boolean; remember: boolean }) => void = () => undefined
        const decision = new Promise<{ approved: boolean; remember: boolean }>((resolve) => {
          resolveDecision = resolve
        })
        let settled = false
        const finish = (approved: boolean, remember: boolean): void => {
          if (settled) return
          settled = true
          if (approved) {
            for (const resource of input.resources) {
              grants.set(`${contextKey(input.context)}:${resource}`, {
                id: `grant-${resource}-${grants.size + 1}`,
                contextKey: contextKey(input.context),
                resource,
                scope: remember ? 'remembered' : 'once',
              })
            }
          }
          resolveDecision({ approved, remember })
        }
        approvals.push({
          approvalId,
          context: input.context,
          resources: input.resources,
          approve: (remember = false) => finish(true, remember),
          deny: () => finish(false, false),
        })
        return { approvalId, decision }
      },
      cancelAccess: async (approvalId: string) => {
        const approval = approvals.find((candidate) => candidate.approvalId === approvalId)
        approval?.deny()
        return true
      },
    }
    service = new VaultAccessService({
      coreVault,
      vaultPath: join(userData, 'vault.ndvault'),
      packages: {
        activeManifest: async () => ({
          protocol: 'nd.extension/1',
          id: 'nd.password-vault',
          name: 'Password Vault',
          description: 'test',
          version: '1.1.0',
          apiVersion: 1,
          contexts: ['personal', 'company', 'project'],
          permissions: ['vault.read', 'vault.write'],
          contributions: { tools: [], skills: [], commands: [], views: [], workflows: [] },
        }),
      } as never,
      state: state as never,
      broker: broker as never,
      organization: {
        state: async () => organization as never,
        policy: async () => 'allow',
      },
      workspace: { state: () => ({ root: currentRoot }) },
      ownsWorktree: () => false,
      userDataPath: userData,
      resourceRoot: process.cwd(),
      nodeBin: process.execPath,
      log: () => undefined,
    })
    await service.start()
    const environment = service.environment()
    baseUrl = environment.ND_DSH_VAULT_URL!
    token = environment.ND_DSH_VAULT_TOKEN!
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  afterAll(async () => {
    await service.dispose()
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(projectRoot, { recursive: true, force: true })
    await rm(userData, { recursive: true, force: true })
  })

  it('rejects missing credentials, browser origins, and unexpected hosts', async () => {
    const unauthorized = await fetch(`${baseUrl}/v1/status?cwd=${encodeURIComponent(workspaceRoot)}`)
    expect(unauthorized.status).toBe(401)

    const origin = await fetch(`${baseUrl}/v1/status?cwd=${encodeURIComponent(workspaceRoot)}`, {
      headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' },
    })
    expect(origin.status).toBe(403)

    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: Number(new URL(baseUrl).port),
        path: `/v1/status?cwd=${encodeURIComponent(workspaceRoot)}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Host: 'localhost' },
      }, (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      request.on('error', reject)
      request.end()
    })
    expect(status).toBe(403)
  })

  it('reports status and lists metadata without secret material', async () => {
    const status = await (await call(`/v1/status?cwd=${encodeURIComponent(workspaceRoot)}`)).json() as Record<string, unknown>
    expect(status).toMatchObject({ ok: true, context: { kind: 'personal' }, contextLabel: 'Personal', version: '1.1.0' })

    const list = await (await call(`/v1/list?cwd=${encodeURIComponent(workspaceRoot)}`)).json() as {
      entries: Array<Record<string, unknown>>
    }
    expect(list.entries).toHaveLength(5)
    expect(list.entries[0]).toMatchObject({ id: 'e1', title: 'GitHub token', ref: 'ndvault://e1/secret' })
    const serialized = JSON.stringify(list)
    expect(serialized).not.toContain('s3cret-1')
    expect(serialized).not.toContain('notes one')
  })

  it('creates one approval, injects the value into the child, and consumes a one-shot grant', async () => {
    const responsePromise = call('/v1/run', {
      method: 'POST',
      body: JSON.stringify({
        cwd: workspaceRoot,
        command: [process.execPath, '-e', "process.stdout.write(process.env.TOKEN === 's3cret-1' ? 'ok' : 'missing')"],
        env: { TOKEN: 'ndvault://e1/secret' },
        purpose: 'test injection',
      }),
    })
    await waitFor(() => approvals.length === 1)
    expect(approvals[0]!.context).toEqual({ kind: 'personal' })
    expect(approvals[0]!.resources).toEqual(['e1'])
    approvals[0]!.approve(false)
    const response = await responsePromise
    expect(response.status).toBe(200)
    const events = jsonLine(await response.text())
    expect(stdoutText(events)).toBe('ok')
    expect(events.at(-1)).toMatchObject({ type: 'exit', code: 0 })
    expect(grants.size).toBe(0)
    const audit = JSON.stringify(audits)
    expect(audit).toContain('GitHub token')
    expect(audit).not.toContain('s3cret-1')
  })

  it('redacts a short value passed as a whole argument from the audit row', async () => {
    grants.set('personal:e5', { id: 'remembered-e5', contextKey: 'personal', resource: 'e5', scope: 'remembered' })
    const response = await call('/v1/run', {
      method: 'POST',
      body: JSON.stringify({
        cwd: workspaceRoot,
        command: [process.execPath, '-e', "process.stdout.write('ok')", 'q7Z'],
        env: { KEY: 'ndvault://e5/secret' },
      }),
    })
    expect(response.status).toBe(200)
    expect(stdoutText(jsonLine(await response.text()))).toBe('ok')
    await waitFor(() => audits.some((entry) => String(entry.reason ?? '').includes('Short PIN')))
    const audit = audits.filter((entry) => String(entry.reason ?? '').includes('Short PIN')).at(-1)!
    expect(JSON.stringify(audit)).toContain('[redacted]')
    expect(JSON.stringify(audit)).not.toContain('q7Z')
  })

  it('does not execute when the user denies the approval', async () => {
    const responsePromise = call('/v1/run', {
      method: 'POST',
      body: JSON.stringify({
        cwd: workspaceRoot,
        command: [process.execPath, '-e', "process.stdout.write('ran')"],
        env: { TOKEN: 'ndvault://e1/secret' },
      }),
    })
    await waitFor(() => approvals.length === 2)
    approvals[1]!.deny()
    const response = await responsePromise
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('not approved')
  })

  it('reuses a remembered grant without asking again', async () => {
    grants.set('personal:e2', { id: 'remembered-e2', contextKey: 'personal', resource: 'e2', scope: 'remembered' })
    const response = await call('/v1/run', {
      method: 'POST',
      body: JSON.stringify({
        cwd: workspaceRoot,
        command: [process.execPath, '-e', "process.stdout.write(process.env.KEY ? 'ok' : 'missing')"],
        env: { KEY: 'ndvault://e2/secret' },
      }),
    })
    expect(response.status).toBe(200)
    expect(stdoutText(jsonLine(await response.text()))).toBe('ok')
    expect(approvals).toHaveLength(2)
    expect(grants.get('personal:e2')?.scope).toBe('remembered')
  })

  it('resolves unique titles and rejects ambiguous or unknown references', async () => {
    grants.set('personal:e1', { id: 'remembered-e1', contextKey: 'personal', resource: 'e1', scope: 'remembered' })
    const byTitle = await call('/v1/run', {
      method: 'POST',
      body: JSON.stringify({
        cwd: workspaceRoot,
        command: [process.execPath, '-e', "process.stdout.write(process.env.KEY === 's3cret-1' ? 'ok' : 'missing')"],
        env: { KEY: 'ndvault://GitHub%20token/secret' },
      }),
    })
    expect(byTitle.status).toBe(200)
    expect(stdoutText(jsonLine(await byTitle.text()))).toBe('ok')

    const ambiguous = await call('/v1/run', {
      method: 'POST',
      body: JSON.stringify({
        cwd: workspaceRoot,
        command: [process.execPath, '-e', ''],
        env: { KEY: 'ndvault://Duplicate/secret' },
      }),
    })
    expect(ambiguous.status).toBe(400)
    expect(await ambiguous.text()).toContain('matches 2 vault entries')

    const missing = await call('/v1/run', {
      method: 'POST',
      body: JSON.stringify({
        cwd: workspaceRoot,
        command: [process.execPath, '-e', ''],
        env: { KEY: 'ndvault://missing/secret' },
      }),
    })
    expect(missing.status).toBe(404)
  })

  it('writes injected files inside the workspace and never to stdout', async () => {
    grants.set('personal:e1', { id: 'remembered-e1', contextKey: 'personal', resource: 'e1', scope: 'remembered' })
    const output = join(workspaceRoot, '.env.test')
    const response = await call('/v1/inject', {
      method: 'POST',
      body: JSON.stringify({
        cwd: workspaceRoot,
        template: 'TOKEN={{ ndvault://e1/secret }}\n',
        outPath: '.env.test',
      }),
    })
    expect(response.status).toBe(200)
    expect(await readFile(output, 'utf8')).toBe('TOKEN=s3cret-1\n')
    if (process.platform !== 'win32') {
      expect((await stat(output)).mode & 0o777).toBe(0o600)
    }

    const replace = await call('/v1/inject', {
      method: 'POST',
      body: JSON.stringify({
        cwd: workspaceRoot,
        template: 'TOKEN={{ ndvault://e1/secret }}\n',
        outPath: '.env.test',
      }),
    })
    expect(replace.status).toBe(409)

    const outside = await call('/v1/inject', {
      method: 'POST',
      body: JSON.stringify({
        cwd: workspaceRoot,
        template: 'TOKEN={{ ndvault://e1/secret }}\n',
        outPath: '../outside.env',
      }),
    })
    expect(outside.status).toBe(403)

    const stdout = await call('/v1/inject', {
      method: 'POST',
      body: JSON.stringify({
        cwd: workspaceRoot,
        template: 'TOKEN={{ ndvault://e1/secret }}\n',
        outPath: '-',
      }),
    })
    expect(stdout.status).toBe(400)
  })

  it('refuses an injected file through a symlinked directory outside the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'nd-vault-outside-'))
    const link = join(workspaceRoot, 'outside-link')
    try {
      try {
        await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      } catch {
        return // Symlink creation is unavailable in this environment.
      }
      grants.set('personal:e1', { id: 'remembered-e1', contextKey: 'personal', resource: 'e1', scope: 'remembered' })
      const response = await call('/v1/inject', {
        method: 'POST',
        body: JSON.stringify({
          cwd: workspaceRoot,
          template: 'TOKEN={{ ndvault://e1/secret }}\n',
          outPath: 'outside-link/secret.env',
        }),
      })
      expect(response.status).toBe(403)
      await expect(stat(join(outside, 'secret.env'))).rejects.toThrow()
    } finally {
      await rm(link, { force: true }).catch(() => undefined)
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('strips broker control variables from the child environment', async () => {
    grants.set('personal:e1', { id: 'remembered-e1', contextKey: 'personal', resource: 'e1', scope: 'remembered' })
    const response = await call('/v1/run', {
      method: 'POST',
      body: JSON.stringify({
        cwd: workspaceRoot,
        command: [
          process.execPath,
          '-e',
          "process.stdout.write(['ND_DSH_VAULT_TOKEN','DSH_X','ND_VAULT_X','ELECTRON_RUN_AS_NODE'].map((key) => process.env[key] ?? 'absent').join(','))",
        ],
        env: {
          KEY: 'ndvault://e1/secret',
          ND_DSH_VAULT_TOKEN: 'leak',
          DSH_X: 'leak',
          ND_VAULT_X: 'leak',
          ELECTRON_RUN_AS_NODE: '1',
        },
      }),
    })
    expect(response.status).toBe(200)
    expect(stdoutText(jsonLine(await response.text()))).toBe('absent,absent,absent,absent')
  })

  it('rejects a reference assigned to a reserved environment key', async () => {
    for (const key of ['ND_DSH_VAULT_TOKEN', 'DSH_TOKEN', 'ND_VAULT_TOKEN', 'ELECTRON_RUN_AS_NODE']) {
      const response = await call('/v1/run', {
        method: 'POST',
        body: JSON.stringify({
          cwd: workspaceRoot,
          command: [process.execPath, '-e', ''],
          env: { [key]: 'ndvault://e1/secret' },
        }),
      })
      expect(response.status, key).toBe(400)
      expect(await response.text(), key).toContain('reserved by ND')
    }
  })

  it('times a command out and reports exit 124', async () => {
    grants.set('personal:e1', { id: 'remembered-e1', contextKey: 'personal', resource: 'e1', scope: 'remembered' })
    const started = Date.now()
    const response = await call('/v1/run', {
      method: 'POST',
      body: JSON.stringify({
        cwd: workspaceRoot,
        command: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'],
        env: { KEY: 'ndvault://e1/secret' },
        timeoutSeconds: 1,
      }),
    })
    expect(response.status).toBe(200)
    const events = jsonLine(await response.text())
    expect(events.some((event) => event.type === 'error' && String(event.message).includes('timed out'))).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'exit', code: 124 })
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('requires a JSON content type for POST routes', async () => {
    const response = await fetch(`${baseUrl}/v1/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: '{}',
    })
    expect(response.status).toBe(415)
  })

  it('publishes shims for both shell families and puts them on PATH', async () => {
    const bin = join(userData, 'nd-vault-bin')
    expect(await readFile(join(bin, 'nd-vault.cmd'), 'utf8')).toContain('nd-vault-cli.mjs')
    expect(await readFile(join(bin, 'nd-vault'), 'utf8')).toContain('nd-vault-cli.mjs')
    expect(service.environment().ND_DSH_VAULT_BIN).toBe(bin)
    expect(service.environment().PATH ?? service.environment().Path).toContain(bin)
  })

  it('denies folders outside the workspace and inactive contexts', async () => {
    const outsideCwd = await call('/v1/status?cwd=' + encodeURIComponent(tmpdir()))
    expect(outsideCwd.status).toBe(403)

    activations.set('personal', false)
    const inactive = await call('/v1/status?cwd=' + encodeURIComponent(workspaceRoot))
    expect(inactive.status).toBe(409)
    expect(await inactive.text()).toContain('not active for Personal')
    activations.delete('personal')

    settings.set('personal', { agentCli: false })
    const disabled = await call('/v1/status?cwd=' + encodeURIComponent(workspaceRoot))
    expect(disabled.status).toBe(403)
    settings.delete('personal')
  })

  it('derives a project context from the workspace and keeps its grants separate', async () => {
    organization.activeProjectId = 'p1'
    organization.projects = [{ id: 'p1', companyId: 'c1', workspacePath: projectRoot }]
    currentRoot = projectRoot
    try {
      const status = await (await call('/v1/status?cwd=' + encodeURIComponent(projectRoot))).json() as Record<string, unknown>
      expect(status.context).toEqual({ kind: 'project', companyId: 'c1', projectId: 'p1' })

      const responsePromise = call('/v1/run', {
        method: 'POST',
        body: JSON.stringify({
          cwd: projectRoot,
          command: [process.execPath, '-e', "process.stdout.write(process.env.KEY ? 'ok' : 'missing')"],
          env: { KEY: 'ndvault://e1/secret' },
        }),
      })
      await waitFor(() => approvals.length === 3)
      expect(approvals[2]!.context).toEqual({ kind: 'project', companyId: 'c1', projectId: 'p1' })
      approvals[2]!.approve(true)
      const response = await responsePromise
      expect(response.status).toBe(200)
      expect(grants.get('project:c1/p1:e1')?.scope).toBe('remembered')
      expect(grants.has('personal:e1')).toBe(true)
    } finally {
      organization.activeProjectId = undefined
      organization.projects = []
      currentRoot = workspaceRoot
    }
  })

  it('rejects malformed requests before approving anything', async () => {
    const noRef = await call('/v1/run', {
      method: 'POST',
      body: JSON.stringify({ cwd: workspaceRoot, command: [process.execPath, '-e', ''], env: {} }),
    })
    expect(noRef.status).toBe(400)

    const literal = await call('/v1/run', {
      method: 'POST',
      body: JSON.stringify({ cwd: workspaceRoot, command: [process.execPath, '-e', ''], env: { KEY: 'plain-value' } }),
    })
    expect(literal.status).toBe(400)

    const body = await call('/v1/run', {
      method: 'POST',
      body: JSON.stringify({ cwd: workspaceRoot, command: [], env: { KEY: 'ndvault://e1/secret' } }),
    })
    expect(body.status).toBe(400)
  })

  it('reports an unavailable CLI when the package is not installed', async () => {
    const uninstalled = new VaultAccessService({
      coreVault: { list: async () => ({ entries: [], total: 0 }), get: async () => { throw new Error('none') } },
      vaultPath: join(userData, 'vault.ndvault'),
      packages: { activeManifest: async () => undefined } as never,
      state: { activation: async () => ({ enabled: true }), settingsFor: async () => ({}), findGrant: async () => undefined, consumeGrant: async () => undefined, recordAudit: async () => undefined } as never,
      broker: { requestAccess: () => ({ approvalId: '', decision: Promise.resolve({ approved: false, remember: false }) }), cancelAccess: async () => false } as never,
      organization: { state: async () => ({ projects: [], runs: [] }), policy: async () => 'allow' },
      workspace: { state: () => ({ root: workspaceRoot }) },
      ownsWorktree: () => false,
      userDataPath: userData,
      resourceRoot: process.cwd(),
      nodeBin: process.execPath,
      log: () => undefined,
    })
    await uninstalled.start()
    try {
      const environment = uninstalled.environment()
      const response = await fetch(`${environment.ND_DSH_VAULT_URL}/v1/status?cwd=${encodeURIComponent(workspaceRoot)}`, {
        headers: { Authorization: `Bearer ${environment.ND_DSH_VAULT_TOKEN}` },
      })
      expect(response.status).toBe(409)
      expect(await response.text()).toContain('not installed')
    } finally {
      await uninstalled.dispose()
    }
  })
})
