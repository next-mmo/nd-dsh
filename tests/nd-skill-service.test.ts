import { SessionArchiveStore } from '../src/main/sessions/session-archive-store.js'
import { foldHistory } from '../src/shared/chat-events.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NdSkillService, parseNdSkill } from '../src/main/skills/nd-skill-service.js'
import { EngineSessionRouter } from '../src/main/engines/engine-session-router.js'
import type { OrganizationSnapshot } from '../src/shared/organization.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nd-skills-')); roots.push(root)
  const state = { activeProjectId: 'p', projects: [{ id: 'p', companyId: 'c', workspacePath: root }], skills: [
    { id: 'builtin:review', scope: 'builtin', name: 'Review', description: 'Review changes', instructions: 'Canonical review instructions' },
    { id: 'custom', scope: 'project', projectId: 'p', companyId: 'c', name: 'Custom', description: 'Project skill', instructions: 'Project instructions' },
    { id: 'secret', scope: 'company', companyId: 'other', name: 'Secret', description: 'Secret', instructions: 'DO NOT LEAK' },
    { id: 'agent', scope: 'agent', companyId: 'c', agentId: 'a', name: 'Agent', description: 'Agent', instructions: 'AGENT ONLY' },
  ] } as unknown as OrganizationSnapshot
  let cwd = root
  const workspace = { state: () => ({ root: cwd, name: 'project' }), assertUsable: vi.fn() }
  const service = new NdSkillService({ organization: { state: async () => state }, workspace, bundledRoot: join(root, 'bundled') })
  async function file(path: string, name = 'sample', metadata = '', body = 'Execute exact instructions') {
    const target = join(root, path); await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, `---\nname: ${name}\ndescription: >-\n  Sample multiline\n  description\n${metadata}---\n${body}`)
  }
  return { root, state, service, workspace, file, move: (next: string) => { cwd = next } }
}

describe('ND skill metadata', () => {
  it('parses YAML multiline fields and preserves body', () => {
    const skill = parseNdSkill('---\nname: sample\ndescription: >-\n  First\n  second\ndisable-model-invocation: true\n---\n  exact body\n')
    expect(skill).toMatchObject({ name: 'sample', description: 'First second', instructions: '  exact body\n', userInvocable: true })
  })
  it.each(['user-invocable: maybe', 'userInvocable: true', 'user-invocable: true\nuser-invocable: false', 'disable-model-invocation: {}'])('rejects invalid policy %s', (metadata) => {
    expect(() => parseNdSkill(`---\nname: sample\ndescription: sample\n${metadata}\n---\nbody`)).toThrow()
  })
})

describe('ND catalog and explicit invocation', () => {
  it('uses canonical scoped organization skills and workspace precedence without exposing bodies', async () => {
    const f = await fixture()
    await f.file('bundled/sample/SKILL.md', 'sample', '', 'bundled')
    await f.file('.agents/skills/sample.md', 'sample', '', 'agents')
    await f.file('.dsh/skills/sample/SKILL.md', 'sample', '', 'project')
    const catalog = await f.service.catalog('p')
    expect(catalog.skills.map((skill) => skill.name)).toEqual(['nd:custom', 'review', 'sample'])
    expect(JSON.stringify(catalog)).not.toContain('instructions')
    expect((await f.service.prepare('/sample  hello\n  world  ', catalog.scope))?.prompt).toContain('--- Skill instructions ---\nproject\n')
    expect((await f.service.prepare('/sample  hello\n  world  '))?.prompt).toContain('/sample  hello\n  world  \n--- End original user message ---')
    expect((await f.service.prepare('/review'))?.prompt).toContain('Canonical review instructions')
  })
  it('honors user-only and model-only restrictions, including shadowing', async () => {
    const f = await fixture()
    await f.file('bundled/sample.md')
    await f.file('.dsh/skills/sample.md', 'sample', 'user-invocable: false\n')
    await f.file('.dsh/skills/manual.md', 'manual', 'disable-model-invocation: true\n')
    expect((await f.service.catalog('p')).skills.map((skill) => skill.name)).not.toContain('sample')
    await expect(f.service.prepare('/sample')).rejects.toThrow('does not allow user invocation')
    expect((await f.service.prepare('/manual'))?.prompt).toContain('Execute exact instructions')
  })
  it('leaves unknown slash, non-leading mention, and regular text unchanged', async () => {
    const f = await fixture()
    for (const prompt of ['/native keep  text', 'hello /review', 'hello', '/../../private']) expect(await f.service.prepare(prompt)).toBeUndefined()
  })
  it('rejects stale project and workspace scopes', async () => {
    const f = await fixture(); const catalog = await f.service.catalog('p')
    await expect(f.service.catalog('other')).rejects.toThrow('project changed')
    f.move(join(f.root, 'other'))
    await expect(f.service.prepare('/review', catalog.scope)).rejects.toThrow('workspace')
  })
  it('does not follow a skill-root junction outside project', async () => {
    const f = await fixture(); const other = await fixture()
    await other.file('skills/stolen.md', 'stolen')
    await mkdir(join(f.root, '.dsh'), { recursive: true })
    await symlink(join(other.root, 'skills'), join(f.root, '.dsh', 'skills'), 'junction')
    expect((await f.service.catalog('p')).skills.map((skill) => skill.name)).not.toContain('stolen')
  })
  it.each(['codex-cli', 'claude-code-cli', 'zcode-cli', 'pi-coding', 'cursor-cli', 'antigravity'])('injects once through shared direct %s boundary', async (engineId) => {
    const f = await fixture()
    const direct = { run: vi.fn(async () => ({ sessionId: 'direct' })), ownsSession: () => false }
    const harness = { status: () => ({}), run: vi.fn() }
    const router = new EngineSessionRouter(harness as never, direct as never, f.workspace as never, direct as never, undefined, undefined, direct as never, direct as never, direct as never, direct as never)
    router.setSkillService(f.service)
    await router.run('/review exact user text', { engineId })
    const prompt = direct.run.mock.calls[0] as unknown as [string]
    expect(prompt[0].split('Canonical review instructions')).toHaveLength(2)
    expect(prompt[0]).toContain('Never launch another browser')
    expect(harness.run).not.toHaveBeenCalled()
  })
  it('resolves known Harness skills once and leaves unknown native skills untouched', async () => {
    const f = await fixture()
    const harness = { status: () => ({}), run: vi.fn(async () => ({ sessionId: 'h' })) }
    const router = new EngineSessionRouter(harness as never, { ownsSession: () => false } as never, f.workspace as never)
    router.setSkillService(f.service)
    await router.run('/review text')
    expect((harness.run.mock.calls[0] as unknown as [string])[0]).toMatch(/^ND explicit skill/)
    await router.run('/native text')
    expect(harness.run).toHaveBeenLastCalledWith('/native text', undefined)
  })
  it('allows an explicit Harness skill inside an ND-owned task worktree', async () => {
    const f = await fixture()
    const taskRoot = join(f.root, '..', '.nd-dsh-worktrees', 'task-1')
    const harness = {
      status: () => ({}),
      gatewayRpc: vi.fn(async (method: string) => method === 'session.list'
        ? { ok: true, value: { items: [{ sessionId: 'task-session', cwd: taskRoot }] } }
        : { ok: true }),
      run: vi.fn(async () => ({ sessionId: 'task-session' })),
    }
    const router = new EngineSessionRouter(harness as never, { ownsSession: () => false } as never, f.workspace as never)
    router.setWorktreeGuard((cwd) => cwd === taskRoot)
    router.setSkillService(f.service)

    await router.run('/review task', { sessionId: 'task-session', workspaceCwd: taskRoot })

    expect(harness.run).toHaveBeenCalledWith(expect.stringContaining('Canonical review instructions'), {
      sessionId: 'task-session',
      workspaceCwd: taskRoot,
    })
  })

  it('rejects direct cross-project session before skill injection', async () => {
    const f = await fixture()
    const direct = { ownsSession: () => true, listSessions: () => [{ sessionId: 's', cwd: join(f.root, '..', 'other') }], run: vi.fn() }
    const router = new EngineSessionRouter({} as never, direct as never, f.workspace as never)
    router.setSkillService(f.service)
    await expect(router.run('/review', { sessionId: 's' })).rejects.toThrow('different project')
    expect(direct.run).not.toHaveBeenCalled()
  })
})


describe('ND rich skill selection', () => {
  it('returns readable canonical details without paths and rejects stale or foreign selections', async () => {
    const f = await fixture()
    await f.file('.dsh/skills/sample.md', 'sample', '', '# Local skill')
    const catalog = await f.service.catalog('p')
    const selected = catalog.skills.find((item) => item.name === 'sample')!
    expect(JSON.stringify(catalog)).not.toContain(f.root)
    expect(await f.service.detail(selected.selectionId!)).toMatchObject({ markdown: '# Local skill', skill: { source: 'Workspace .dsh' } })
    await expect(f.service.detail('../../private')).rejects.toThrow('unavailable')
    const other = await fixture()
    await expect(other.service.detail(selected.selectionId!)).rejects.toThrow('unavailable')
    await f.file('.dsh/skills/sample.md', 'sample', '', '# Changed')
    await expect(f.service.detail(selected.selectionId!)).rejects.toThrow('changed')
    await expect(f.service.prepare('/sample task', catalog.scope, selected.selectionId)).rejects.toThrow('changed')
    const next = (await f.service.catalog('p')).skills.find((item) => item.name === 'sample')!
    await rm(join(f.root, '.dsh/skills/sample.md'))
    await expect(f.service.detail(next.selectionId!)).rejects.toThrow('unavailable')
  })
})


it('maps direct engine echoes before run returns and after store reload', async () => {
  const f = await fixture()
  const path = join(f.root, 'archive.json')
  const direct = {
    createSession: async () => ({ sessionId: 'new' }),
    ownsSession: () => true,
    run: async (wire: string) => {
      const events = [{ type: 'user/message', seq: 1, data: { message: wire } }]
      const restored = await router.restoreMessages('new', events)
      expect(foldHistory(restored)[0]).toMatchObject({ text: '/review task', skillMention: { displayName: 'Review', name: 'review' } })
      expect(await new SessionArchiveStore(path).restoreSkillMessages('new', events)).toEqual(restored)
      expect(wire).toContain('Canonical review instructions')
      return { sessionId: 'new' }
    },
  }
  const router = new EngineSessionRouter({ status: () => ({}) } as never, direct as never, f.workspace as never)
  router.setSkillService(f.service)
  router.setMessageStore(new SessionArchiveStore(path))
  await router.run('/review task', { engineId: 'codex-cli' })
})
