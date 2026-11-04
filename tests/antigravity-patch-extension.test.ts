import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { NativeHostRegistry, type NdHostCallContext } from '../src/main/extensions/native-host.js'
import { InvocationBroker } from '../src/main/extensions/invocation-broker.js'
import { registerSkillComposeHost } from '../src/main/extensions/skill-compose-host.js'
import { NdSkillService } from '../src/main/skills/nd-skill-service.js'
import { manifestPermissionIssues, validateNdExtensionManifest } from '../src/shared/extension-package.js'
import { personalContext } from '../src/shared/nd-context.js'
import { prependSkillDraft, type SkillComposeRequest } from '../src/shared/skill-compose.js'
import { patchPreview, patchRequest, type PatchOperation } from '../extensions/antigravity-patch/ui/requests.js'
import type { OrganizationSnapshot } from '../src/shared/organization.js'

const packagePath = fileURLToPath(new URL('../extensions/antigravity-patch/', import.meta.url))
const raw = JSON.parse(await readFile(join(packagePath, 'nd-extension.json'), 'utf8'))
const parsed = validateNdExtensionManifest(raw)
if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
const manifest = parsed.manifest
let root: string
let packages: ExtensionPackageStore
let state: InvocationStateStore
let host: NativeHostRegistry
let broker: InvocationBroker
let skills: NdSkillService
let compose: ReturnType<typeof vi.fn<(request: SkillComposeRequest) => void>>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nd-patch-panel-'))
  packages = new ExtensionPackageStore(join(root, 'packages'))
  state = new InvocationStateStore(join(root, 'state'))
  host = new NativeHostRegistry()
  const snapshot = { activeProjectId: null, projects: [], companies: [], skills: [], memory: [] } as unknown as OrganizationSnapshot
  skills = new NdSkillService({ organization: { state: async () => snapshot }, workspace: { state: () => ({ root }) },
    bundledRoot: fileURLToPath(new URL('../configs/dsh/agent-presets/nd-dsh/skills/', import.meta.url)) })
  compose = vi.fn<(request: SkillComposeRequest) => void>()
  registerSkillComposeHost(host, skills, compose)
  broker = new InvocationBroker({ packages, state, host, organization: { state: async () => snapshot } })
  await packages.installFromDirectory(packagePath, { expectId: manifest.id })
  await state.setActivation(manifest.id, personalContext(), true)
})
afterEach(async () => {
  // Exact synthetic fixture path from mkdtemp above; no user profile is modified.
  await rm(root, { recursive: true, force: true })
})
const context: NdHostCallContext = { extensionId: manifest.id, contributionId: 'panel', host: 'skill.compose', context: personalContext(), caller: 'user', settings: {} }
const invoke = (request: string) => broker.invoke({ extensionId: manifest.id, contributionId: 'panel', contributionKind: 'view',
  context: personalContext(), caller: 'user', input: { action: 'prepare-request', skill: 'antigravity-patch', request } })

it('installs the Antigravity GUI with only draft permission and no executable or browser host', async () => {
  expect(manifest.name).toBe('Antigravity Patch')
  expect(manifest.permissions).toEqual(['chat.compose'])
  expect(manifestPermissionIssues(manifest)).toEqual([])
  expect(manifest.executable).toBeUndefined()
  expect(manifest.contributions.commands[0]?.openViewId).toBe('panel')
  expect(manifest.contributions.views[0]?.actions.map((a) => a.host)).toEqual(['skill.compose'])
  for (const file of ['ui/index.html', 'ui/panel.js', 'ui/panel.css', 'ui/requests.js']) {
    expect(await packages.snapshotFileFor(manifest.id, manifest.version, file)).not.toBeNull()
  }
  expect(await broker.loadView(manifest.id, 'panel', personalContext())).toMatchObject({ kind: 'web' })
  expect(compose).not.toHaveBeenCalled()
})

it.each(['help', 'status', 'apply', 'reset', 'adopt'] as PatchOperation[])('prepares %s as an ND slash-skill draft, resolvable through the actual bundled skill', async (operation) => {
  const result = await invoke(patchRequest(operation))
  expect(result).toMatchObject({ ok: true, value: { composed: true, skillName: 'antigravity-patch', text: patchPreview(operation) } })
  expect(compose).toHaveBeenCalledExactlyOnceWith({ skillName: 'antigravity-patch', text: patchPreview(operation) })
  const prepared = await skills.prepare(patchPreview(operation))
  expect(prepared?.prompt).toContain('ND explicit skill /antigravity-patch')
  expect(prepared?.prompt).toContain('Skill resource directory:')
  expect(prepared?.prompt).toContain('/ND/Patches/Antigravity/')
})

it('keeps the slash invocation first and preserves the existing composer text', () => {
  const draft = '  My existing unsent request\nwith details  '
  expect(prependSkillDraft(draft, patchPreview('apply'))).toBe('/antigravity-patch apply --dry-run\n\n' + draft)
  expect(prependSkillDraft('', patchPreview('help'))).toBe('/antigravity-patch -h')
})

it('uses dry run only for actions that support it and permits an explicit real request', () => {
  expect(patchRequest('help')).toBe('-h')
  expect(patchRequest('status')).toBe('status')
  expect(patchRequest('apply')).toBe('apply --dry-run')
  expect(patchRequest('reset', false)).toBe('reset')
  expect(patchRequest('adopt', false)).toBe('adopt')
  expect(() => patchRequest('unsupported' as PatchOperation)).toThrow()
})

it('rejects model callers, unknown skills and malformed requests without composing anything', async () => {
  await expect(host.call('skill.compose', { skill: 'antigravity-patch', request: 'apply' }, { ...context, caller: 'agent' })).rejects.toThrow('user action')
  await expect(host.call('skill.compose', { skill: 'missing', request: '-h' }, context)).rejects.toThrow('unavailable')
  await expect(host.call('skill.compose', { skill: '../outside', request: '-h' }, context)).rejects.toThrow('available ND skill')
  await expect(host.call('skill.compose', { skill: 'antigravity-patch', request: '' }, context)).rejects.toThrow('characters')
  expect(compose).not.toHaveBeenCalled()
})

it('requires package activation and fails closed without the ND skill service', async () => {
  await state.setActivation(manifest.id, personalContext(), false)
  expect(await invoke('-h')).toMatchObject({ ok: false })
  expect(compose).not.toHaveBeenCalled()
  const unavailable = new NativeHostRegistry()
  registerSkillComposeHost(unavailable, undefined, compose)
  await expect(unavailable.call('skill.compose', { skill: 'antigravity-patch', request: '-h' }, context)).rejects.toThrow('unavailable')
})
