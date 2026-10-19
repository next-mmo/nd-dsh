import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { NativeHostRegistry } from '../src/main/extensions/native-host.js'
import { InvocationBroker, type NdOrganizationPort } from '../src/main/extensions/invocation-broker.js'
import {
  ApiStudioSpecStore,
  ApiStudioWorkspaceSaveBuffer,
  ApiStudioWorkspaceStore,
  emptyWorkspace,
  sanitizeApiStudioRequest,
  sanitizeWorkspace,
  type ApiStudioCipher,
} from '../src/main/extensions/api-studio-store.js'
import { manifestPermissionIssues, validateNdExtensionManifest, type NdExtensionManifest } from '../src/shared/extension-package.js'
import { personalContext } from '../src/shared/nd-context.js'
import {
  normalizeSpec,
  normalizeWorkspace,
  operationRequest,
  parseCurl,
  parseSpecDocument,
  prepareRequest,
  schemaExample,
  toCurl,
  variableMap,
  importPostman,
  type NormalizedSpec,
} from '../extensions/api-studio/ui/core.js'

const packagePath = fileURLToPath(new URL('../extensions/api-studio/', import.meta.url))
const manifestPath = new URL('../extensions/api-studio/nd-extension.json', import.meta.url)

async function loadManifest(): Promise<NdExtensionManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

const sampleDocument = {
  openapi: '3.0.1',
  info: { title: 'User API', version: '1.2.0' },
  servers: [{ url: 'http://localhost:8080' }],
  paths: {
    '/users/{id}': {
      get: {
        summary: 'Get a user',
        tags: ['Users'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'expand', in: 'query', schema: { type: 'string', default: 'roles' } },
        ],
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      User: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } },
    },
  },
}

function specFrom(document: unknown): NormalizedSpec {
  const spec = normalizeSpec(document)
  spec.id = 'spec-1'
  return spec
}

function workspaceWithToken() {
  const workspace = normalizeWorkspace({
    environments: [{
      id: 'env-1',
      name: 'Local',
      variables: [
        { id: 'var-1', key: 'baseUrl', value: 'http://127.0.0.1:3000', enabled: true, secret: false },
        { id: 'var-2', key: 'token', value: 'secret-token', enabled: true, secret: true },
      ],
    }],
    activeEnvironmentId: 'env-1',
  })
  return workspace
}

describe('ND API Studio extension package', () => {
  it('validates as a Personal-only web-view package with no missing permissions', async () => {
    const manifest = await loadManifest()
    expect(manifest.id).toBe('nd.api-studio')
    expect(manifest.contexts).toEqual(['personal'])
    expect(manifest.permissions).toEqual(['apistudio.read', 'apistudio.write', 'apistudio.execute', 'clipboard.write'])
    expect(manifest.executable).toBeUndefined()
    expect(manifestPermissionIssues(manifest)).toEqual([])

    const [view] = manifest.contributions.views
    expect(view?.kind).toBe('web')
    expect(view?.entry).toBe('ui/index.html')
    expect(view?.host).toBeUndefined()
    expect(view?.actions.map((action) => [action.id, action.host])).toEqual([
      ['workspace-read', 'apistudio.workspace.get'],
      ['workspace-save', 'apistudio.workspace.save'],
      ['spec-list', 'apistudio.spec.list'],
      ['spec-read', 'apistudio.spec.read'],
      ['spec-import', 'apistudio.spec.import'],
      ['spec-delete', 'apistudio.spec.delete'],
      ['execute', 'apistudio.request.execute'],
      ['copy', 'clipboard.write'],
    ])
    expect(manifest.contributions.commands[0]?.openViewId).toBe('studio')
  })

  it('installs from its folder including the UI and vendored YAML parser, activates, and uninstalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-api-studio-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const installed = await packages.installFromDirectory(packagePath, { expectId: 'nd.api-studio' })
      expect(installed.id).toBe('nd.api-studio')

      for (const asset of [
        'ui/index.html',
        'ui/app.js',
        'ui/bridge.js',
        'ui/core.js',
        'ui/styles.css',
        'ui/vendor/js-yaml.mjs',
        'ui/vendor/js-yaml.LICENSE',
      ]) {
        expect(await packages.snapshotFileFor('nd.api-studio', installed.version, asset)).not.toBeNull()
      }

      const state = new InvocationStateStore(root)
      expect(await state.activation('nd.api-studio', personalContext())).toBeUndefined()
      await state.setActivation('nd.api-studio', personalContext(), true)
      expect((await state.activation('nd.api-studio', personalContext()))?.enabled).toBe(true)

      await packages.uninstall('nd.api-studio')
      expect(await packages.activeManifest('nd.api-studio')).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

const organization: NdOrganizationPort = {
  state: async () => ({
    companies: [{ id: 'c1' } as never],
    projects: [{ id: 'p1', companyId: 'c1' } as never],
    memory: [],
  }),
}

const HOST_METHODS = [
  'apistudio.workspace.get',
  'apistudio.workspace.save',
  'apistudio.spec.list',
  'apistudio.spec.read',
  'apistudio.spec.import',
  'apistudio.spec.delete',
  'apistudio.request.execute',
  'clipboard.write',
] as const

describe('API Studio broker gating', () => {
  let root: string
  let packages: ExtensionPackageStore
  let state: InvocationStateStore
  let host: NativeHostRegistry
  let broker: InvocationBroker
  let calls: string[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-api-studio-broker-'))
    packages = new ExtensionPackageStore(join(root, 'packages'))
    state = new InvocationStateStore(join(root, 'state'))
    host = new NativeHostRegistry()
    calls = []
    for (const method of HOST_METHODS) {
      host.register(method, async (input) => {
        calls.push(method)
        return { method, input }
      })
    }
    await packages.registerBuiltin(await loadManifest())
    broker = new InvocationBroker({ packages, state, host, organization })
    await state.setActivation('nd.api-studio', personalContext(), true)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const invoke = (overrides: Partial<Parameters<InvocationBroker['invoke']>[0]>) =>
    broker.invoke({
      extensionId: 'nd.api-studio',
      contributionId: 'studio',
      contributionKind: 'view',
      context: personalContext(),
      caller: 'user',
      input: {},
      ...overrides,
    })

  it('loads the web view without running a host method', async () => {
    const view = await broker.loadView('nd.api-studio', 'studio', personalContext())
    expect(view).toMatchObject({ kind: 'web', extensionId: 'nd.api-studio', viewId: 'studio' })
    expect(view.webView?.entry).toBe('ui/index.html')
    expect(view.rows).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses to load before activation', async () => {
    await state.setActivation('nd.api-studio', personalContext(), false)
    await expect(broker.loadView('nd.api-studio', 'studio', personalContext())).rejects.toThrow(/Activate/)
    expect(calls).toEqual([])
  })

  it('routes each named action to its declared host and never executes without an action', async () => {
    await invoke({ input: { action: 'workspace-read' } })
    await invoke({ input: { action: 'workspace-save', workspace: { version: 1 } } })
    await invoke({ input: { action: 'execute', request: { url: 'http://127.0.0.1/' } } })
    const missingAction = await invoke({})
    expect(missingAction).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(calls).toEqual(['apistudio.workspace.get', 'apistudio.workspace.save', 'apistudio.request.execute'])
  })

  it('requires an explicit grant before an agent may send a request', async () => {
    const result = await invoke({ caller: 'agent', input: { action: 'execute', request: { url: 'http://127.0.0.1/' } } })
    expect(result).toMatchObject({ ok: false, error: { code: 'approval-required' } })
    expect(calls).toEqual([])
    const approvalId = (result.value as { approvalId: string }).approvalId
    await broker.approve(approvalId, true)
    const granted = await invoke({ caller: 'agent', input: { action: 'execute', request: { url: 'http://127.0.0.1/' } } })
    expect(granted).toMatchObject({ ok: true })
  })
})

describe('API Studio workspace store', () => {
  const validWorkspace = () => ({
    version: 1,
    collections: [{
      id: 'col-1',
      name: 'User Service',
      requests: [{
        id: 'req-1',
        name: 'Get user',
        method: 'GET',
        url: '{{baseUrl}}/users/1',
        pathVars: [],
        params: [],
        headers: [{ id: 'hdr-1', key: 'Accept', value: 'application/json', enabled: true }],
        body: { mode: 'none', text: '', fields: [] },
        auth: { type: 'none', token: '', username: '', password: '', key: '', value: '', addTo: 'header' },
      }],
    }],
    environments: [{
      id: 'env-1',
      name: 'Local',
      variables: [{ id: 'var-1', key: 'baseUrl', value: 'http://localhost:8080', enabled: true, secret: false }],
    }],
    activeEnvironmentId: 'env-1',
    history: [],
  })

  it('rebuilds only known fields and rejects unsupported methods or identifiers', () => {
    const workspace = sanitizeWorkspace({ ...validWorkspace(), extra: 'ignored' })
    expect(workspace.version).toBe(1)
    expect((workspace as unknown as { extra?: unknown }).extra).toBeUndefined()
    expect(() => sanitizeWorkspace({
      ...validWorkspace(),
      collections: [{ id: 'col-1', name: 'C', requests: [{ ...validWorkspace().collections[0]!.requests[0], method: 'TRACE' }] }],
    })).toThrow(/Unsupported request method/)
    expect(() => sanitizeWorkspace({
      ...validWorkspace(),
      collections: [{ id: '../escape', name: 'C', requests: [] }],
    })).toThrow(/identifier/)
    expect(() => sanitizeWorkspace({
      ...validWorkspace(),
      collections: [{
        id: 'col-1',
        name: 'C',
        requests: [{
          ...validWorkspace().collections[0]!.requests[0],
          body: { mode: 'json', text: 'x'.repeat(120_001), fields: [] },
        }],
      }],
    })).toThrow(/Body text/)
  })

  it('redacts credentials from history before returning it', () => {
    const request = validWorkspace().collections[0]!.requests[0]!
    const workspace = sanitizeWorkspace({
      ...validWorkspace(),
      history: [{
        id: 'hist-1',
        at: 1,
        environmentId: 'env-1',
        method: 'GET',
        url: 'https://api.example.com/users',
        status: 200,
        statusText: 'OK',
        durationMs: 12,
        bytes: 34,
        request: {
          ...request,
          auth: { type: 'bearer', token: 'secret', username: '', password: '', key: '', value: '', addTo: 'header' },
          headers: [
            { id: 'hdr-1', key: 'Authorization', value: 'Bearer secret', enabled: true },
            { id: 'hdr-2', key: 'Cookie', value: 'session=1', enabled: true },
            { id: 'hdr-3', key: 'Accept', value: 'application/json', enabled: true },
          ],
        },
      }],
    })
    expect(workspace.history[0]?.request.auth.token).toBe('')
    expect(workspace.history[0]?.request.headers.map((header) => header.key)).toEqual(['Accept'])
  })

  it('round-trips an encrypted workspace and refuses to downgrade it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-api-studio-workspace-'))
    try {
      const path = join(root, 'workspace.json')
      const cipher: ApiStudioCipher = {
        available: () => true,
        encrypt: (plain) => Buffer.from(`enc:${plain}`, 'utf8').toString('base64'),
        decrypt: (encoded) => Buffer.from(encoded, 'base64').toString('utf8').slice(4),
      }
      const store = new ApiStudioWorkspaceStore(path, cipher)
      const result = await store.write(validWorkspace())
      expect(result.encrypted).toBe(true)
      const file = JSON.parse(await readFile(path, 'utf8')) as { encrypted: boolean; payload: string }
      expect(file.encrypted).toBe(true)
      expect(file.payload).not.toContain('User Service')
      const readBack = await store.read()
      expect(readBack.encrypted).toBe(true)
      expect(readBack.workspace.collections[0]?.name).toBe('User Service')

      const locked = new ApiStudioWorkspaceStore(path, {
        available: () => false,
        encrypt: () => { throw new Error('unavailable') },
        decrypt: () => { throw new Error('unavailable') },
      })
      await expect(locked.read()).rejects.toThrow(/keychain/)
      await expect(locked.write(validWorkspace())).rejects.toThrow(/Refusing to replace an encrypted workspace/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a corrupt workspace file for recovery instead of overwriting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-api-studio-corrupt-'))
    try {
      const path = join(root, 'workspace.json')
      await writeFile(path, '{not json', 'utf8')
      const store = new ApiStudioWorkspaceStore(path)
      const read = await store.read()
      expect(read.warning).toMatch(/could not be read/)
      expect(read.workspace.collections).toEqual([])
      expect((await readdir(root)).some((name) => name.includes('.corrupt-'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('API Studio environment selection', () => {
  it('keeps an explicit "No environment" choice but defaults a missing one to the first', () => {
    const environments = [{ id: 'env-1', name: 'Local', variables: [] }]
    expect(normalizeWorkspace({ environments, activeEnvironmentId: null }).activeEnvironmentId).toBeNull()
    expect(normalizeWorkspace({ environments }).activeEnvironmentId).toBe('env-1')
    expect(normalizeWorkspace({ environments, activeEnvironmentId: 'gone' }).activeEnvironmentId).toBe('env-1')
    const fresh = emptyWorkspace()
    expect(fresh.activeEnvironmentId).toBe(fresh.environments[0]?.id)
  })
})

describe('API Studio workspace save buffer', () => {
  it('reassembles ordered chunks and rejects out-of-order or oversized saves', () => {
    const buffer = new ApiStudioWorkspaceSaveBuffer(10)
    expect(buffer.append('save-1', 0, 'abc', false)).toMatchObject({ complete: false, received: 3 })
    expect(buffer.append('save-1', 3, 'def', true)).toMatchObject({ complete: true, text: 'abcdef' })

    expect(() => buffer.append('save-2', 3, 'x', false)).toThrow(/offset 0/)
    buffer.append('save-3', 0, 'abc', false)
    expect(() => buffer.append('save-3', 4, 'x', false)).toThrow(/out of order/)
    expect(() => buffer.append('save-4', 0, '12345678901', true)).toThrow(/too large/)
    expect(() => buffer.append('../bad', 0, 'x', false)).toThrow(/Save id/)
  })
})

describe('API Studio spec store', () => {
  it('imports, chunks, lists, detects YAML, and deletes a specification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-api-studio-spec-'))
    try {
      const store = new ApiStudioSpecStore(root)
      const json = JSON.stringify(sampleDocument)
      const meta = await store.import({ text: json, name: 'Users', sourceUrl: 'http://localhost:8080/v3/api-docs' })
      expect(meta).toMatchObject({ name: 'Users', format: 'json', bytes: Buffer.byteLength(json) })

      const first = await store.readChunk(meta.id, 0, 10)
      expect(first.chunk).toHaveLength(10)
      expect(first.done).toBe(false)
      const tail = await store.readChunk(meta.id, first.nextOffset, 1_000)
      expect(`${first.chunk}${tail.chunk}`).toBe(json)
      expect(tail.done).toBe(true)

      expect((await store.list()).map((item) => item.id)).toEqual([meta.id])
      expect(await store.delete(meta.id)).toBe(true)
      expect(await store.list()).toEqual([])
      await expect(store.readChunk(meta.id, 0)).rejects.toThrow(/not found/)

      const yaml = await store.import({ text: 'openapi: "3.0.1"\npaths: {}\n', contentType: 'application/yaml' })
      expect(yaml.format).toBe('yaml')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a JSON document that does not parse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-api-studio-spec-bad-'))
    try {
      const store = new ApiStudioSpecStore(root)
      await expect(store.import({ text: '{"openapi": ' })).rejects.toThrow(/not valid JSON/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('API Studio request preparation', () => {
  it('parses JSON and YAML documents and extracts operations with dereferenced schemas', () => {
    const json = parseSpecDocument(JSON.stringify(sampleDocument))
    const yaml = parseSpecDocument('openapi: "3.0.1"\ninfo:\n  title: Y\n  version: "1"\npaths: {}\n')
    expect(json.info).toMatchObject({ title: 'User API' })
    expect(yaml.info).toMatchObject({ title: 'Y' })

    const spec = specFrom(json)
    expect(spec.baseUrl).toBe('http://localhost:8080')
    expect(spec.operations).toHaveLength(1)
    expect(spec.operations[0]).toMatchObject({ method: 'GET', path: '/users/{id}', tags: ['Users'] })
    expect(schemaExample(spec.components.schemas?.User, spec.components)).toEqual({ id: 0, name: 'string' })
  })

  it('builds Try It Out requests with path, query, variables, auth, and a body', () => {
    const spec = specFrom(sampleDocument)
    const workspace = workspaceWithToken()
    const request = operationRequest(spec, spec.operations[0]!, workspace)
    expect(request.url).toBe('{{baseUrl}}/users/{id}')
    expect(request.pathVars.map((row) => row.key)).toEqual(['id'])
    expect(request.params.map((row) => [row.key, row.value])).toEqual([['expand', 'roles']])
    request.pathVars[0]!.value = '42'
    request.auth = { type: 'bearer', token: '{{token}}', username: '', password: '', key: '', value: '', addTo: 'header' }
    const prepared = prepareRequest(request, variableMap(workspace))
    expect(prepared.url).toBe('http://127.0.0.1:3000/users/42?expand=roles')
    expect(prepared.headers).toContainEqual({ name: 'Authorization', value: 'Bearer secret-token' })
    expect(prepared.missing).toEqual([])
    expect(toCurl(prepared)).toContain('curl -X GET')
  })

  it('reports missing variables instead of sending literal placeholders', () => {
    const prepared = prepareRequest({
      id: 'req-1',
      name: 'Missing',
      method: 'GET',
      url: '{{baseUrl}}/users',
      pathVars: [],
      params: [],
      headers: [],
      body: { mode: 'none', text: '', fields: [] },
      auth: { type: 'none', token: '', username: '', password: '', key: '', value: '', addTo: 'header' },
    })
    expect(prepared.url).toBe('{{baseUrl}}/users')
    expect(prepared.missing).toEqual(['baseUrl'])
  })

  it('imports cURL commands, including JSON bodies and basic auth', () => {
    const request = parseCurl("curl -X POST https://api.example.com/users -H 'Content-Type: application/json' -u 'alice:secret' -d '{\"name\":\"Alice\"}'")
    expect(request.method).toBe('POST')
    expect(request.url).toBe('https://api.example.com/users')
    expect(request.body.mode).toBe('json')
    expect(request.body.text).toContain('Alice')
    expect(request.auth).toMatchObject({ type: 'basic', username: 'alice', password: 'secret' })
    expect(() => parseCurl('wget https://example.com')).toThrow(/curl/)
  })

  it('imports Postman Collection v2.1 requests and variables', () => {
    const imported = importPostman({
      info: { name: 'User Service', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{
        name: 'Users',
        item: [{
          name: 'List',
          request: {
            method: 'GET',
            url: { raw: '{{baseUrl}}/users' },
            header: [{ key: 'Accept', value: 'application/json' }],
          },
        }],
      }],
      variable: [{ key: 'baseUrl', value: 'https://api.example.com' }],
    })
    expect(imported.collections[0]?.name).toBe('User Service')
    expect(imported.collections[0]?.requests[0]).toMatchObject({ name: 'Users / List', method: 'GET', url: '{{baseUrl}}/users' })
    expect(imported.environments[0]?.variables[0]).toMatchObject({ key: 'baseUrl', value: 'https://api.example.com' })
    expect(() => importPostman({ info: {}, item: [] })).not.toThrow()
    expect(() => importPostman({ info: {}, item: '/no' })).toThrow(/Postman/)
  })

  it('validates the execution payload at the host boundary', () => {
    const request = validRequest()
    expect(sanitizeApiStudioRequest(request)).toMatchObject({ method: 'GET', url: 'https://api.example.com' })
    expect(() => sanitizeApiStudioRequest({ ...request, method: 'TRACE' })).toThrow(/Unsupported request method/)
    expect(() => sanitizeApiStudioRequest({ ...request, headers: [{ id: 'h', key: 'X', value: 'v', enabled: true }], body: { mode: 'bogus' } })).toThrow(/body mode/)
  })
})

function validRequest() {
  return {
    id: 'req-1',
    name: 'Request',
    method: 'GET',
    url: 'https://api.example.com',
    pathVars: [],
    params: [],
    headers: [],
    body: { mode: 'none', text: '', fields: [] },
    auth: { type: 'none', token: '', username: '', password: '', key: '', value: '', addTo: 'header' },
  }
}
