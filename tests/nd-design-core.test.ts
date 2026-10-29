import { describe, expect, it } from 'vitest'
import {
  applyDesignCommands,
  applyDesignHistoryCommands,
  buildDesignSpec,
  createEmptyDesignDocument,
  DesignHistory,
  parseDesignDocument,
  serializeDesignDocument,
  serializeDesignSvg,
  validateDesignDocument,
  type DesignNode,
} from '../src/shared/nd-design/index.js'

function rect(id: string, x = 10, y = 20, width = 100, height = 50): DesignNode {
  return {
    id,
    type: 'rect',
    name: id,
    x,
    y,
    width,
    height,
    fill: { type: 'solid', color: '#e4e4e7' },
  }
}

function frameWithChild(): { doc: ReturnType<typeof createEmptyDesignDocument>; frameId: string; child: DesignNode } {
  const doc = createEmptyDesignDocument()
  const frameId = doc.pages[0]!.children[0]!
  const base = applyDesignCommands(doc, [{ op: 'insert', parentId: frameId, node: rect('rect-1') }])
  return { doc: base.document, frameId, child: base.document.nodes['rect-1']! }
}

describe('ND Pencil document core', () => {
  it('round-trips a new document through validation and serialization', () => {
    const doc = createEmptyDesignDocument('Test')
    const parsed = parseDesignDocument(serializeDesignDocument(doc))
    expect(parsed.legacy).toBe(false)
    expect(parsed.document.name).toBe('Test')
    expect(parsed.document.nodes[parsed.document.pages[0]!.children[0]!]?.type).toBe('frame')
  })

  it('inserts a node and returns the deleted inverse', () => {
    const doc = createEmptyDesignDocument()
    const frameId = doc.pages[0]!.children[0]!
    const result = applyDesignCommands(doc, [{ op: 'insert', parentId: frameId, node: rect('rect-1') }])
    expect(result.document.nodes['rect-1']).toBeDefined()
    expect(result.document.nodes[frameId]!.children).toEqual(['rect-1'])
    expect(result.inverse).toEqual([{ op: 'delete', ids: ['rect-1'] }])
    const undone = applyDesignHistoryCommands(result.document, result.inverse)
    expect(undone.nodes['rect-1']).toBeUndefined()
  })

  it('moves descendants when a frame moves and undoes the move', () => {
    const { doc, frameId, child } = frameWithChild()
    const result = applyDesignCommands(doc, [{ op: 'update', id: frameId, patch: { x: 200 } }])
    expect(result.document.nodes[frameId]!.x).toBe(200)
    expect(result.document.nodes['rect-1']!.x).toBe(child.x + 200)
    const undone = applyDesignHistoryCommands(result.document, result.inverse)
    expect(undone.nodes['rect-1']!.x).toBe(child.x)
  })

  it('restores a deleted container subtree exactly', () => {
    const { doc, frameId, child } = frameWithChild()
    const result = applyDesignCommands(doc, [{ op: 'delete', ids: [frameId] }])
    expect(result.document.nodes[frameId]).toBeUndefined()
    expect(result.document.nodes['rect-1']).toBeUndefined()
    const undone = applyDesignHistoryCommands(result.document, result.inverse)
    expect(undone.nodes[frameId]!.x).toBe(0)
    expect(undone.nodes['rect-1']).toEqual(child)
  })

  it('groups and ungroups with exact structural undo', () => {
    const doc = createEmptyDesignDocument()
    const inserted = applyDesignCommands(doc, [
      { op: 'insert', parentId: null, node: rect('a', 0, 0, 10, 10) },
      { op: 'insert', parentId: null, node: rect('b', 20, 20, 10, 10) },
    ])
    const grouped = applyDesignCommands(inserted.document, [{ op: 'group', ids: ['a', 'b'], name: 'Pair' }])
    const groupId = grouped.createdIds[0]!
    expect(grouped.document.nodes[groupId]?.type).toBe('group')
    const undone = applyDesignHistoryCommands(grouped.document, grouped.inverse)
    expect(undone.nodes[groupId]).toBeUndefined()
    expect(undone.pages[0]!.children).toEqual(inserted.document.pages[0]!.children)

    const ungrouped = applyDesignCommands(grouped.document, [{ op: 'ungroup', id: groupId }])
    expect(ungrouped.document.nodes[groupId]).toBeUndefined()
    expect(ungrouped.document.pages[0]!.children).toEqual(expect.arrayContaining(['a', 'b']))
    const regrouped = applyDesignHistoryCommands(ungrouped.document, ungrouped.inverse)
    expect(regrouped.nodes[groupId]?.children).toEqual(['a', 'b'])
    expect(regrouped.pages[0]!.children).toContain(groupId)
  })

  it('reorders and undoes across parents', () => {
    const { doc, frameId } = frameWithChild()
    const withSecond = applyDesignCommands(doc, [{ op: 'insert', parentId: null, node: rect('rect-2') }])
    const reordered = applyDesignCommands(withSecond.document, [{ op: 'reorder', id: 'rect-2', parentId: frameId, index: 0 }])
    expect(reordered.document.nodes[frameId]!.children).toEqual(['rect-2', 'rect-1'])
    const undone = applyDesignHistoryCommands(reordered.document, reordered.inverse)
    expect(undone.pages[0]!.children).toContain('rect-2')
    expect(undone.nodes[frameId]!.children).toEqual(['rect-1'])
  })

  it('imports a legacy 0.8.4 document with basic shapes', () => {
    const legacy = JSON.stringify({
      version: '0.8.4',
      name: 'Legacy',
      children: [
        { type: 'frame', id: 'n10', name: 'Frame', x: 0, y: 0, width: 1200, height: 800, children: [] },
        { type: 'polygon', id: 'n20', name: 'Square', x: 10, y: 20, width: 40, height: 40, polygonCount: 4, fill: [{ type: 'solid', color: '#BDC7D9' }] },
        { type: 'text', id: 'n30', name: 'Title', x: 40, y: 80, width: 300, height: 40, content: 'Hello', fontSize: 24, fill: [{ type: 'solid', color: '#111111' }] },
      ],
    })
    const parsed = parseDesignDocument(legacy)
    expect(parsed.legacy).toBe(true)
    expect(parsed.report?.from).toBe('openpencil-0.8.4')
    expect(parsed.document.nodes.n20?.type).toBe('rect')
    expect(parsed.document.nodes.n30?.text).toBe('Hello')
    expect(parsed.document.nodes.n30?.fontSize).toBe(24)
  })

  it('rejects duplicate references and orphan nodes', () => {
    const doc = createEmptyDesignDocument()
    const frameId = doc.pages[0]!.children[0]!
    const bad = structuredClone(doc)
    bad.pages[0]!.children.push(frameId)
    expect(() => validateDesignDocument(bad)).toThrow(/duplicate id/)
    const orphan = structuredClone(doc)
    orphan.nodes.orphan = rect('orphan')
    expect(() => validateDesignDocument(orphan)).toThrow(/not attached/)
  })

  it('produces SVG and a build spec', () => {
    const { doc } = frameWithChild()
    const svg = serializeDesignSvg(doc)
    expect(svg).toContain('<svg')
    expect(svg).toContain('<rect')
    const spec = buildDesignSpec(doc, [])
    expect(spec.kind).toBe('nd-pencil-build-spec')
    expect(spec.nodes.some((node) => node.id === 'rect-1')).toBe(true)
  })

  it('prevents ND Agent from undoing a human entry', () => {
    const history = new DesignHistory()
    history.push({ source: 'human', label: 'manual', forward: [], inverse: [], changedIds: [] })
    expect(() => history.undo('agent')).toThrow(/own newest/)
    expect(history.undo('human')).not.toBeNull()
  })
})
