import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { manifestPermissionIssues, validateNdExtensionManifest } from '../src/shared/extension-package.js'
import { personalContext } from '../src/shared/nd-context.js'

const packagePath = fileURLToPath(new URL('../examples/nd-extension-hello/', import.meta.url))
const manifestPath = new URL('../examples/nd-extension-hello/nd-extension.json', import.meta.url)
const guidePath = new URL('../docs/extensions/authoring.md', import.meta.url)

/**
 * The authoring guide and its sample package are the entry point for third-party
 * developers. `examples/extension-counter` rotted into an agent-capabilities
 * descriptor while the guide still pointed at it, so both are pinned here.
 */
describe('Hello Notes sample ND extension', () => {
  it('validates with no missing permissions', async () => {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    const result = validateNdExtensionManifest(parsed)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(manifestPermissionIssues(result.manifest)).toEqual([])
    expect(result.manifest.id).toBe('example.hello-notes')
    expect(result.manifest.contexts).toEqual(['personal', 'company', 'project'])
    expect(result.manifest.permissions).toEqual(['notes.read', 'notes.write'])
    expect(result.manifest.executable).toBeUndefined()
  })

  it('contributes the commands, view, and skill the guide documents', async () => {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    const result = validateNdExtensionManifest(parsed)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { commands, views, skills } = result.manifest.contributions
    expect(commands.map((command) => command.id)).toEqual(['hello-save', 'hello-open-notes'])
    expect(commands[1]?.openViewId).toBe('hello-notes')
    expect(views.map((view) => view.id)).toEqual(['hello-notes'])
    // A view's keys must match what note.search actually returns, or the list
    // renders empty and no validator catches it.
    expect(views[0]?.itemTitleKey).toBe('title')
    expect(views[0]?.itemBodyKey).toBe('body')
    expect(skills.map((skill) => skill.id)).toEqual(['hello-notes-walkthrough'])
  })

  it('installs from its folder, activates for Personal, and uninstalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-hello-example-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const installed = await packages.installFromDirectory(packagePath, { expectId: 'example.hello-notes' })
      expect(installed.id).toBe('example.hello-notes')
      expect(installed.hasExecutable).toBe(false)

      const manifest = await packages.activeManifest('example.hello-notes')
      expect(manifest?.contributions.commands.map((command) => command.id))
        .toEqual(['hello-save', 'hello-open-notes'])

      const state = new InvocationStateStore(root)
      expect(await state.activation('example.hello-notes', personalContext())).toBeUndefined()
      await state.setActivation('example.hello-notes', personalContext(), true)
      expect((await state.activation('example.hello-notes', personalContext()))?.enabled).toBe(true)

      await packages.uninstall('example.hello-notes')
      expect(await packages.activeManifest('example.hello-notes')).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the manifest sample in the authoring guide valid', async () => {
    const guide = await readFile(guidePath, 'utf8')
    const sample = guide.split('```json')[1]?.split('```')[0]
    expect(sample, 'authoring.md must open with a json manifest sample').toBeTruthy()

    const result = validateNdExtensionManifest(JSON.parse(sample!))
    expect(result.ok, result.ok ? '' : result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')).toBe(true)
    if (!result.ok) return
    expect(manifestPermissionIssues(result.manifest)).toEqual([])
    expect(result.manifest.id).toBe('com.example.standup')
  })
})
