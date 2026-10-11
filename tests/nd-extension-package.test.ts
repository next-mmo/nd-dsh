import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  asNdContext,
  contextKey,
  describeContext,
  isNdContext,
  personalContext,
  sameContext,
} from '../src/shared/nd-context.js'
import {
  ND_EXTENSION_API_VERSION,
  ND_EXTENSION_PERMISSIONS,
  ND_HOST_METHODS,
  manifestPermissionIssues,
  requiredPermissionsForManifest,
  validateNdExtensionManifest,
} from '../src/shared/extension-package.js'
import { BUILTIN_EXTENSION_PACKAGES, DAILY_ESSENTIALS_MANIFEST, PROJECT_WORKFLOW_MANIFEST, WALLPAPER_MANAGER_MANIFEST, defaultActivationContexts } from '../src/shared/builtin-extension-packages.js'

describe('ND contexts', () => {
  it('accepts personal without any company or project id', () => {
    expect(isNdContext({ kind: 'personal' })).toBe(true)
    expect(asNdContext({ kind: 'personal' })).toEqual(personalContext())
  })

  it('rejects malformed or mismatched context records', () => {
    expect(isNdContext(null)).toBe(false)
    expect(isNdContext({ kind: 'company' })).toBe(false)
    expect(isNdContext({ kind: 'company', companyId: '   ' })).toBe(false)
    expect(isNdContext({ kind: 'project', companyId: 'c1' })).toBe(false)
    expect(isNdContext({ kind: 'workspace', companyId: 'c1', projectId: 'p1' })).toBe(false)
    expect(() => asNdContext({ kind: 'project', projectId: 'p1' })).toThrow(/valid ND context/)
  })

  it('keys and compares contexts deterministically', () => {
    expect(contextKey({ kind: 'personal' })).toBe('personal')
    expect(contextKey({ kind: 'company', companyId: 'c1' })).toBe('company:c1')
    expect(contextKey({ kind: 'project', companyId: 'c1', projectId: 'p1' })).toBe('project:c1/p1')
    expect(sameContext({ kind: 'company', companyId: 'c1' }, { kind: 'company', companyId: 'c1' })).toBe(true)
    expect(sameContext({ kind: 'company', companyId: 'c1' }, { kind: 'project', companyId: 'c1', projectId: 'p1' })).toBe(false)
    expect(describeContext({ kind: 'personal' })).toBe('Personal')
  })

  it('trims ids rather than trusting caller formatting', () => {
    expect(asNdContext({ kind: 'company', companyId: ' c1 ' })).toEqual({ kind: 'company', companyId: 'c1' })
  })
})

describe('extension package manifests', () => {
  it('accepts every ND-maintained package', () => {
    for (const manifest of BUILTIN_EXTENSION_PACKAGES) {
      const result = validateNdExtensionManifest(manifest)
      expect(result.ok, `${manifest.id} should validate`).toBe(true)
      expect(manifestPermissionIssues(manifest)).toEqual([])
      expect(requiredPermissionsForManifest(manifest).length).toBeGreaterThan(0)
      expect(manifest.apiVersion).toBe(ND_EXTENSION_API_VERSION)
    }
  })

  it('activates only personal contexts by default for built-ins that support Personal', () => {
    expect(defaultActivationContexts(DAILY_ESSENTIALS_MANIFEST)).toEqual(['personal'])
    expect(defaultActivationContexts(WALLPAPER_MANAGER_MANIFEST)).toEqual(['personal'])
    expect(defaultActivationContexts(PROJECT_WORKFLOW_MANIFEST)).toEqual([])
  })


  it('keeps native wallpaper control personal-only and permission-scoped', () => {
    expect(WALLPAPER_MANAGER_MANIFEST.contexts).toEqual(['personal'])
    expect(WALLPAPER_MANAGER_MANIFEST.permissions).toEqual(['os.wallpaper.write'])
    expect(WALLPAPER_MANAGER_MANIFEST.contributions.commands).toEqual([
      expect.objectContaining({
        id: 'choose-wallpaper',
        host: 'os.wallpaper.chooseAndSet',
        contexts: ['personal'],
      }),
      expect.objectContaining({
        id: 'set-wallpaper-folder',
        host: 'os.wallpaper.folders.add',
        contexts: ['personal'],
      }),
      expect.objectContaining({
        id: 'previous-wallpaper',
        host: 'os.wallpaper.previous',
        contexts: ['personal'],
      }),
      expect.objectContaining({
        id: 'next-wallpaper',
        host: 'os.wallpaper.next',
        contexts: ['personal'],
      }),
      expect.objectContaining({
        id: 'random-wallpaper',
        host: 'os.wallpaper.random',
        contexts: ['personal'],
      }),
      expect.objectContaining({
        id: 'open-wallpaper-studio',
        host: 'os.wallpaper.status',
        openViewId: 'wallpaper-studio',
        contexts: ['personal'],
      }),
    ])
    expect(WALLPAPER_MANAGER_MANIFEST.contributions.views).toEqual([
      expect.objectContaining({
        id: 'wallpaper-studio',
        kind: 'detail',
        host: 'os.wallpaper.status',
        contexts: ['personal'],
        actions: expect.arrayContaining([
          expect.objectContaining({ id: 'apply', host: 'os.wallpaper.applySelected' }),
          expect.objectContaining({ id: 'prev', host: 'os.wallpaper.previous' }),
          expect.objectContaining({ id: 'next', host: 'os.wallpaper.next' }),
          expect.objectContaining({ id: 'random', host: 'os.wallpaper.random' }),
          expect.objectContaining({ id: 'choose', host: 'os.wallpaper.chooseAndSet' }),
          expect.objectContaining({ id: 'folders-add', host: 'os.wallpaper.folders.add' }),
          expect.objectContaining({ id: 'preview', host: 'os.wallpaper.preview' }),
        ]),
      }),
    ])
  })

  it('keeps Project Workflow project-only', () => {
    expect(PROJECT_WORKFLOW_MANIFEST.contexts).toEqual(['project'])
    for (const view of PROJECT_WORKFLOW_MANIFEST.contributions.views) {
      expect(view.contexts).toEqual(['project'])
      expect(view.host?.startsWith('workflow.')).toBe(true)
    }
  })

  it('rejects a wrong protocol, api version, permission, or host method', () => {
    const base = {
      protocol: 'nd.extension/1',
      id: 'nd.test',
      name: 'Test',
      description: 'Test package',
      version: '1.0.0',
      apiVersion: 1,
      contexts: ['personal'],
      permissions: [],
      settings: [],
      contributions: { commands: [{ id: 'go', title: 'Go', host: 'note.create', contexts: ['personal'] }] },
    }
    expect(validateNdExtensionManifest({ ...base, protocol: 'nd.extension/2' }).ok).toBe(false)
    expect(validateNdExtensionManifest({ ...base, apiVersion: 2 }).ok).toBe(false)
    const badPermission = validateNdExtensionManifest({ ...base, permissions: ['everything'] })
    expect(badPermission.ok).toBe(false)
    const badHost = validateNdExtensionManifest({
      ...base,
      contributions: { commands: [{ id: 'go', title: 'Go', host: 'shell.exec', contexts: ['personal'] }] },
    })
    expect(badHost.ok).toBe(false)
  })

  it('rejects contributions that widen the declared contexts and duplicate ids', () => {
    const widened = validateNdExtensionManifest({
      protocol: 'nd.extension/1',
      id: 'nd.test',
      name: 'Test',
      description: 'Test package',
      version: '1.0.0',
      apiVersion: 1,
      contexts: ['personal'],
      permissions: ['notes.write'],
      settings: [],
      contributions: { commands: [{ id: 'go', title: 'Go', host: 'note.create', contexts: ['personal', 'project'] }] },
    })
    expect(widened.ok).toBe(false)

    const duplicate = validateNdExtensionManifest({
      protocol: 'nd.extension/1',
      id: 'nd.test',
      name: 'Test',
      description: 'Test package',
      version: '1.0.0',
      apiVersion: 1,
      contexts: ['personal'],
      permissions: ['notes.write', 'notes.read'],
      settings: [],
      contributions: {
        commands: [{ id: 'same', title: 'A', host: 'note.create', contexts: ['personal'] }],
        views: [{ id: 'same', title: 'B', kind: 'list', host: 'note.search', itemTitleKey: 'title', contexts: ['personal'], actions: [] }],
      },
    })
    expect(duplicate.ok).toBe(false)
  })

  it('rejects a command that widens beyond the native host context ceiling', () => {
    const result = validateNdExtensionManifest({
      protocol: 'nd.extension/1',
      id: 'nd.bad-wallpaper',
      name: 'Bad Wallpaper',
      description: 'Attempts to expose a personal OS action in a company context.',
      version: '1.0.0',
      apiVersion: 1,
      contexts: ['personal', 'company'],
      permissions: ['os.wallpaper.write'],
      settings: [],
      contributions: {
        commands: [{
          id: 'wallpaper',
          title: 'Wallpaper',
          host: 'os.wallpaper.chooseAndSet',
          contexts: ['company'],
        }],
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes('supports only: personal'))).toBe(true)
    }
  })

  it('requires an executable runtime for tool contributions and env references instead of secrets', () => {
    const toolNoRuntime = validateNdExtensionManifest({
      protocol: 'nd.extension/1',
      id: 'nd.tools',
      name: 'Tools',
      description: 'Tool package',
      version: '1.0.0',
      apiVersion: 1,
      contexts: ['personal'],
      permissions: [],
      settings: [],
      contributions: { tools: [{ id: 'counter', title: 'Counter', toolName: 'counter_get', contexts: ['personal'] }] },
    })
    expect(toolNoRuntime.ok).toBe(false)

    const secretEnv = validateNdExtensionManifest({
      protocol: 'nd.extension/1',
      id: 'nd.tools',
      name: 'Tools',
      description: 'Tool package',
      version: '1.0.0',
      apiVersion: 1,
      contexts: ['personal'],
      permissions: [],
      settings: [],
      contributions: { tools: [{ id: 'counter', title: 'Counter', toolName: 'counter_get', contexts: ['personal'] }] },
      executable: { kind: 'mcp-stdio', command: 'node', args: ['server.mjs'], env: { TOKEN: 'sk-live-secret-value' } },
    })
    expect(secretEnv.ok).toBe(false)

    const validTools = validateNdExtensionManifest({
      protocol: 'nd.extension/1',
      id: 'nd.tools',
      name: 'Tools',
      description: 'Tool package',
      version: '1.0.0',
      apiVersion: 1,
      contexts: ['personal'],
      permissions: [],
      settings: [],
      contributions: { tools: [{ id: 'counter', title: 'Counter', toolName: 'counter_get', contexts: ['personal'] }] },
      executable: { kind: 'mcp-stdio', command: 'node', args: ['server.mjs'], env: { TOKEN: 'ND_EXT_TOKEN' } },
    })
    expect(validTools.ok).toBe(true)
  })

  it('reports every declared-permission gap for the contributions a package ships', () => {
    const manifest = structuredClone(DAILY_ESSENTIALS_MANIFEST)
    manifest.permissions = manifest.permissions.filter((permission) => permission !== 'capture.screen')
    const issues = manifestPermissionIssues(manifest)
    expect(issues.some((issue) => issue.message.includes('capture.screen'))).toBe(true)
  })
})

describe('published JSON schema', () => {
  it('enumerates exactly the runtime host-method allowlist', () => {
    // The schema is an authoring mirror the runtime validator never reads, so it
    // drifts silently: editors and external validators then reject manifests ND
    // would happily accept. Pinning parity here is what stops that.
    const schemaPath = join(__dirname, '..', 'schema', 'nd-extension.schema.json')
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      $defs?: { hostMethod?: { enum?: string[] } }
    }
    const published = schema.$defs?.hostMethod?.enum
    expect(Array.isArray(published), 'schema must publish a hostMethod enum').toBe(true)

    const allowlist = ND_HOST_METHODS.map((method) => method.id)
    expect([...published!].sort()).toEqual([...allowlist].sort())
  })

  it('enumerates exactly the runtime permission set', () => {
    // Same drift risk as the hostMethod enum: `translate.history` shipped in the
    // runtime allowlist but was missing here, so editor validation rejected the
    // ND Translate manifest that the installer accepts.
    const schemaPath = join(__dirname, '..', 'schema', 'nd-extension.schema.json')
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      properties?: { permissions?: { items?: { enum?: string[] } } }
    }
    const published = schema.properties?.permissions?.items?.enum
    expect(Array.isArray(published), 'schema must publish a permissions enum').toBe(true)

    expect([...published!].sort()).toEqual([...ND_EXTENSION_PERMISSIONS].sort())
  })

  it('maps every published host method to a permission the schema declares', () => {
    const schemaPath = join(__dirname, '..', 'schema', 'nd-extension.schema.json')
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      properties?: { permissions?: { items?: { enum?: string[] } } }
    }
    const published = new Set(schema.properties?.permissions?.items?.enum ?? [])
    for (const method of ND_HOST_METHODS) {
      expect(published.has(method.permission), `${method.id} needs "${method.permission}" in the schema`).toBe(true)
    }
  })

  it('declares a permission for every host method it publishes', () => {
    for (const method of ND_HOST_METHODS) {
      expect(method.permission, `${method.id} needs a permission`).toBeTruthy()
      expect(method.contexts.length, `${method.id} needs at least one context`).toBeGreaterThan(0)
    }
  })
})
