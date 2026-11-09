import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { NdSkillService } from '../src/main/skills/nd-skill-service.js'
import type { OrganizationSnapshot } from '../src/shared/organization.js'

it('discovers and invokes the complete Antigravity skill from a relocated release bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nd-antigravity-bundle-'))
  try {
    const bundledRoot = join(root, 'resources', 'configs', 'dsh', 'agent-presets', 'nd-dsh', 'skills')
    const directory = join(bundledRoot, 'antigravity-patch')
    await cp(join(__dirname, '..', 'configs', 'dsh', 'agent-presets', 'nd-dsh', 'skills', 'antigravity-patch'), directory, { recursive: true })
    const state = { activeProjectId: 'p', projects: [{ id: 'p', companyId: 'c', workspacePath: root }], skills: [] } as unknown as OrganizationSnapshot
    const service = new NdSkillService({
      organization: { state: async () => state },
      workspace: { state: () => ({ root }) },
      bundledRoot,
    })
    const catalog = await service.catalog('p')
    const skill = catalog.skills.find((item) => item.name === 'antigravity-patch')!
    expect(skill).toMatchObject({ source: 'ND bundled' })
    const prepared = await service.prepare('/antigravity-patch add a temporary browser control', catalog.scope, skill.selectionId)
    expect(prepared?.prompt).toContain(`Skill resource directory: ${directory}`)

    // The candidate can be built with resources in the shipped tree, without a
    // developer's global skill, chat folder, or machine-specific patch register.
    const recipe = JSON.parse(await readFile(join(directory, 'assets', 'browser-annotate', 'recipe.json'), 'utf8')) as { implementation: string; implementation_sha256: string }
    const implementation = await readFile(join(directory, 'assets', 'browser-annotate', recipe.implementation))
    expect(createHash('sha256').update(implementation).digest('hex')).toBe(recipe.implementation_sha256)
    await Promise.all([
      'references/antigravity-desktop.md', 'references/patch-lifecycle.md',
      'scripts/asar_tool.py', 'scripts/build_browser_annotate.py',
      'scripts/test_asar_tool.py', 'scripts/test_browser_annotate.py',
      'scripts/patch.py', 'scripts/test_patch_cli.py', 'references/cli.md',
    ].map((path) => readFile(join(directory, path))))
    const catalog229 = JSON.parse(await readFile(join(directory, 'assets/browser-annotate/recipes.json'), 'utf8'))
    const port = catalog229.recipes.find((entry: { app_version: string }) => entry.app_version === '2.29.0')
    const block = await readFile(join(directory, 'assets/browser-annotate', port.block))
    expect(createHash('sha256').update(block).digest('hex')).toBe(port.block_sha256)
    const cli = await readFile(join(directory, 'scripts/patch.py'), 'utf8')
    expect(cli).toContain("local / 'ND/Patches/Antigravity'")
    expect(cli).not.toMatch(/\.codex|Codex\/Patches|MT-Staff/)
    const universalDir = join(__dirname, '..', '.agents', 'skills', 'antigravity-patch')
    for (const relPath of ['SKILL.md', 'references/cli.md', 'references/antigravity-desktop.md', 'references/patch-lifecycle.md', 'scripts/patch.py', 'scripts/asar_tool.py', 'assets/browser-annotate/recipes.json', 'assets/browser-annotate/2.29.0-block.js']) {
      expect(await readFile(join(universalDir, relPath), 'utf8')).toBe(await readFile(join(directory, relPath), 'utf8'))
    }
    const help = await service.prepare('/antigravity-patch -h', catalog.scope, skill.selectionId)
    expect(help?.prompt).toContain(`Skill resource directory: ${directory}`)
    expect(help?.prompt).toContain('/antigravity-patch -h')
  } finally {
    // root is the exact directory created by mkdtemp for this test.
    await rm(root, { recursive: true, force: true })
  }
})
