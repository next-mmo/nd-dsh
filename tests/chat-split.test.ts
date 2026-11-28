import { describe, expect, it } from 'vitest'
import {
  addSplitPane,
  MAX_SPLIT_PANES,
  persistSplitPanes,
  readStoredSplitPanes,
  removeSplitPane,
  sortSplitCandidates,
  splitGridClass,
  splitPaneSpanClass,
  swapSplitPanes,
  type SplitChatCandidate,
} from '../src/renderer/src/lib/chat-split.js'

describe('multi-chat split view model', () => {
  it('adds, dedupes, caps at 4 panes, removes, and swaps panes cleanly', () => {
    let panes = addSplitPane([], 's1')
    panes = addSplitPane(panes, 's2')
    panes = addSplitPane(panes, 's2')
    expect(panes.map((p) => p.sessionId)).toEqual(['s1', 's2'])

    panes = addSplitPane(panes, 's3')
    panes = addSplitPane(panes, 's4')
    expect(panes).toHaveLength(MAX_SPLIT_PANES)

    panes = addSplitPane(panes, 's5')
    expect(panes.map((p) => p.sessionId)).toEqual(['s1', 's2', 's3', 's5'])

    panes = swapSplitPanes(panes, 0, 2)
    expect(panes.map((p) => p.sessionId)).toEqual(['s3', 's2', 's1', 's5'])

    panes = removeSplitPane(panes, 1)
    expect(panes.map((p) => p.sessionId)).toEqual(['s3', 's1', 's5'])
  })

  it('persists and restores split panes safely while filtering invalid entries', () => {
    const memory = new Map<string, string>()
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value) },
    }
    persistSplitPanes([{ sessionId: 'a' }, { sessionId: 'b' }], storage)
    expect(readStoredSplitPanes(storage)).toEqual([{ sessionId: 'a' }, { sessionId: 'b' }])

    storage.setItem('nd-dsh-chat-split-panes', JSON.stringify(['a', { sessionId: 'a' }, { sessionId: '' }, { sessionId: 'c' }, 'd', 'e', 'f']))
    expect(readStoredSplitPanes(storage)).toEqual([
      { sessionId: 'a' },
      { sessionId: 'c' },
      { sessionId: 'd' },
      { sessionId: 'e' },
    ])
  })

  it('sorts candidates by live urgency (working -> needs-you -> ready -> archived)', () => {
    const candidates: SplitChatCandidate[] = [
      { sessionId: 'arch', title: 'Old', engineLabel: 'ND', state: 'archived', updatedAt: 900 },
      { sessionId: 'ready-old', title: 'Ready old', engineLabel: 'ND', state: 'ready', updatedAt: 100 },
      { sessionId: 'need', title: 'Waiting', engineLabel: 'Codex', state: 'needs-you', updatedAt: 200 },
      { sessionId: 'work', title: 'Running', engineLabel: 'ND', state: 'working', updatedAt: 50 },
      { sessionId: 'ready-new', title: 'Ready new', engineLabel: 'ND', state: 'ready', updatedAt: 500 },
    ]
    expect(sortSplitCandidates(candidates).map((item) => item.sessionId)).toEqual([
      'work',
      'need',
      'ready-new',
      'ready-old',
      'arch',
    ])
  })

  it('computes 1/2/3/4 pane grid layouts with a tall primary pane for 3 panes', () => {
    expect(splitGridClass(1)).toBe('grid-cols-1 grid-rows-1')
    expect(splitGridClass(2)).toBe('grid-cols-2 grid-rows-1')
    expect(splitGridClass(3)).toBe('grid-cols-2 grid-rows-2')
    expect(splitGridClass(4)).toBe('grid-cols-2 grid-rows-2')
    expect(splitPaneSpanClass(3, 0)).toBe('row-span-2')
    expect(splitPaneSpanClass(3, 1)).toBe('')
    expect(splitPaneSpanClass(4, 0)).toBe('')
  })
})
