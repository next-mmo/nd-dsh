import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesignAgentTool } from '../src/main/design/design-agent-tool.js'
import { DesignSessionService } from '../src/main/design/design-session-service.js'
import { DesignStore } from '../src/main/design/design-store.js'
import type { DesignChangedEvent } from '../src/shared/design.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})

async function createFixture(): Promise<{ root: string; service: DesignSessionService; events: DesignChangedEvent[] }> {
  const root = await mkdtemp(join(tmpdir(), 'nd-design-session-'))
  roots.push(root)
  const events: DesignChangedEvent[] = []
  const service = new DesignSessionService(new DesignStore(root), (event) => events.push(event))
  return { root, service, events }
}

function rect(id: string, x = 10, y = 20) {
  return {
    id,
    type: 'rect' as const,
    name: id,
    x,
    y,
    width: 100,
    height: 50,
    fill: { type: 'solid' as const, color: '#e4e4e7' },
  }
}

describe('ND Pencil design session', () => {
  it('creates, edits, saves and reopens a project document', async () => {
    const { root, service } = await createFixture()
    const created = await service.create('.nd/design/home.op', 'Home')
    expect(created.state.status).toBe('ready')
    expect(created.state.revision).toBe(1)
    expect(created.document?.format).toBe('nd-pencil')
    const frameId = created.document!.pages[0]!.children[0]!
    const applied = service.apply(created.state.revision, [{ op: 'insert', parentId: frameId, node: rect('rect-1') }])
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error('expected ack')
    expect(applied.revision).toBe(2)
    expect(applied.state.canUndo).toBe(true)
    const saved = await service.save()
    expect(saved.dirty).toBe(false)

    const reopened = new DesignSessionService(new DesignStore(root), () => undefined)
    const sync = await reopened.open('.nd/design/home.op')
    expect(sync.document?.nodes['rect-1']?.x).toBe(10)
    expect(sync.state.dirty).toBe(false)
    reopened.destroy()
    service.destroy()
  })

  it('undoes and redoes a human edit through the shared history', async () => {
    const { service } = await createFixture()
    const created = await service.create('.nd/design/home.op')
    const frameId = created.document!.pages[0]!.children[0]!
    const applied = service.apply(1, [{ op: 'insert', parentId: frameId, node: rect('rect-1') }])
    if (!applied.ok) throw new Error('expected ack')
    const undone = await service.undo()
    expect(undone.document?.nodes['rect-1']).toBeUndefined()
    expect(undone.state.canRedo).toBe(true)
    const redone = await service.redo()
    expect(redone.document?.nodes['rect-1']).toBeDefined()
    service.destroy()
  })

  it('refuses to overwrite a document changed outside ND', async () => {
    const { root, service } = await createFixture()
    const created = await service.create('.nd/design/home.op')
    const frameId = created.document!.pages[0]!.children[0]!
    await writeFile(join(root, '.nd/design/home.op'), '{"changed":true}', 'utf8')
    const applied = service.apply(1, [{ op: 'insert', parentId: frameId, node: rect('rect-1') }])
    expect(applied.ok).toBe(true)
    await expect(service.save()).rejects.toThrow(/changed on disk/)
    expect(service.state().status).toBe('error')
    expect(service.state().dirty).toBe(true)
    service.destroy()
  })

  it('imports legacy .op, reports drops and backs up before saving', async () => {
    const { root, service } = await createFixture()
    const legacy = JSON.stringify({
      version: '0.8.4',
      name: 'Legacy',
      variables: { accent: '#ff0000' },
      children: [
        { type: 'frame', id: 'frame-1', name: 'Frame', x: 0, y: 0, width: 800, height: 600, children: [] },
        { type: 'rectangle', id: 'rect-1', name: 'Box', x: 30, y: 40, width: 120, height: 60, fill: [{ type: 'solid', color: '$accent' }] },
        { type: 'path', id: 'path-1', name: 'Dropped path' },
      ],
    })
    await mkdir(join(root, '.nd/design'), { recursive: true })
    await writeFile(join(root, '.nd/design/home.op'), legacy, 'utf8')
    const sync = await service.open('.nd/design/home.op')
    expect(sync.state.dirty).toBe(true)
    expect(sync.document?.nodes['rect-1']?.fill?.color).toBe('#ff0000')
    expect(sync.document?.meta?.migration?.dropped.path).toBe(1)
    const applied = service.apply(sync.state.revision, [{ op: 'update', id: 'rect-1', patch: { x: 40 } }])
    expect(applied.ok).toBe(true)
    await service.save()
    const backups = await readdir(join(root, '.nd/design/.backups'))
    expect(backups.some((name) => name.startsWith('home.v084-'))).toBe(true)
    const saved = await readFile(join(root, '.nd/design/home.op'), 'utf8')
    expect(JSON.parse(saved).format).toBe('nd-pencil')
    service.destroy()
  })

  it('writes a build spec and SVG from the live document', async () => {
    const { root, service } = await createFixture()
    const created = await service.create('.nd/design/home.op', 'Build me')
    const frameId = created.document!.pages[0]!.children[0]!
    service.apply(1, [{ op: 'insert', parentId: frameId, node: rect('rect-1') }])
    const result = await service.build()
    expect(result.specPath).toMatch(/\.nd\/design\/\.build\/build-me\/spec\.json$/)
    expect(result.svgPath).toMatch(/reference\.svg$/)
    expect(result.prompt).toContain('real application source')
    const spec = JSON.parse(await readFile(join(root, result.specPath), 'utf8'))
    expect(spec.kind).toBe('nd-pencil-build-spec')
    expect(spec.nodes.some((node: { id: string }) => node.id === 'rect-1')).toBe(true)
    expect(await readFile(join(root, result.svgPath), 'utf8')).toContain('<svg')
    service.destroy()
  })

  it('keeps the agent bound to the active project root', async () => {
    const { root, service } = await createFixture()
    await service.create('.nd/design/home.op')
    const tool = new DesignAgentTool(service)
    await expect(tool.call({ sessionCwd: join(root, 'worktree'), action: 'state', args: {} })).rejects.toThrow(/active project root/)
    const state = await tool.call({ sessionCwd: root, action: 'state', args: {} }) as { open: boolean }
    expect(state.open).toBe(true)
    service.destroy()
  })
})
