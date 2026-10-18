import { describe, expect, it } from 'vitest'
import { foldEvent, foldHistory, type HistoryEventEnvelope } from '../src/shared/chat-events.js'
import type { ThreadEntry } from '../src/shared/chat-types.js'

function message(type: string, seq: number, text: string): HistoryEventEnvelope {
  return { type, seq, data: { [type === 'assistant/chunk' ? 'chunk' : 'message']: { content: text } } }
}

describe('chat event folding', () => {
  it('does not mutate streaming state when React replays an update', () => {
    const previous: ThreadEntry[] = [{ kind: 'assistant', id: 'reply', text: 'Hel', streaming: true }]
    Object.freeze(previous[0])
    const chunk = message('assistant/chunk', 1, 'lo!')
    expect(foldEvent(previous, chunk)).toEqual(foldEvent(previous, chunk))
    expect(previous[0]).toMatchObject({ text: 'Hel', streaming: true })

    const streamed = foldEvent(previous, chunk)
    Object.freeze(streamed[0])
    const final = message('assistant/message', 2, 'Hello!')
    const completed = foldEvent(streamed, final)
    expect(foldEvent(streamed, final)).toEqual(completed)
    expect(completed).toEqual([{ kind: 'assistant', id: 'reply', text: 'Hello!', streaming: false }])
  })

  it('replaces only the entry an event changes so unchanged rows keep their identity', () => {
    const previous: ThreadEntry[] = [
      { kind: 'user', id: 'ask', text: 'hi' },
      { kind: 'tool', id: 'call', callId: 'c1', name: 'read', status: 'running' },
      { kind: 'assistant', id: 'reply', text: 'Hel', streaming: true },
    ]
    previous.forEach((entry) => Object.freeze(entry))
    const streamed = foldEvent(previous, message('assistant/chunk', 1, 'lo'))
    expect(streamed[0]).toBe(previous[0])
    expect(streamed[1]).toBe(previous[1])
    expect(streamed[2]).not.toBe(previous[2])
    expect(streamed[2]).toMatchObject({ text: 'Hello' })

    const resolved = foldEvent(streamed, { type: 'tool/result', seq: 2, data: { callId: 'c1', message: { content: 'ok' } } })
    expect(resolved[1]).not.toBe(streamed[1])
    expect(resolved[1]).toMatchObject({ status: 'done', result: 'ok' })
    expect(resolved[0]).toBe(previous[0])
    expect(resolved[2]).toBe(streamed[2])
  })

  it('keeps live and restored message order, including identical turns', () => {
    const events = [
      message('user/message', 1, 'hi'),
      message('assistant/message', 2, 'Hello!'),
      message('user/message', 3, 'hi'),
      message('assistant/message', 4, 'Hello!'),
    ]
    const live = events.reduce<ThreadEntry[]>((entries, event) => foldEvent(entries, event), [])
    const contents = (entries: ThreadEntry[]) => entries.map((entry) => ({ kind: entry.kind, text: 'text' in entry ? entry.text : '' }))
    expect(contents(live)).toEqual([
      { kind: 'user', text: 'hi' }, { kind: 'assistant', text: 'Hello!' },
      { kind: 'user', text: 'hi' }, { kind: 'assistant', text: 'Hello!' },
    ])
    expect(contents(foldHistory(events))).toEqual(contents(live))
  })

  it('folds text-delta chunk payloads emitted by streaming runtimes', () => {
    const entries = foldHistory([
      { type: 'assistant/chunk', seq: 1, data: { chunk: { type: 'text-delta', text: 'Hello' } } },
      { type: 'assistant/chunk', seq: 2, data: { chunk: { type: 'text-delta', text: ' world' } } },
      { type: 'assistant/message', seq: 3, data: { message: { content: 'Hello world' } } },
    ])
    expect(entries).toEqual([{ kind: 'assistant', id: expect.any(String), text: 'Hello world', streaming: false }])
  })

  it('folds raw runtime user and assistant events where content is on data directly', () => {
    const entries = foldHistory([
      {
        type: 'user/message',
        seq: 1,
        data: {
          id: 'user-msg-1',
          role: 'user',
          content: [{ type: 'text', text: 'Build habit tracker' }],
          source: { kind: 'user' },
        },
      },
      {
        type: 'assistant/message',
        seq: 2,
        data: {
          id: 'asst-msg-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Working on habit tracker...' }],
        },
      },
    ])
    expect(entries).toEqual([
      { kind: 'user', id: expect.any(String), text: 'Build habit tracker' },
      { kind: 'assistant', id: expect.any(String), text: 'Working on habit tracker...' },
    ])
  })

  it('matches parallel tool results to the correct call id', () => {
    const entries = foldHistory([
      { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'read', arguments: { path: 'one' } } },
      { type: 'tool/call', seq: 2, data: { callId: 'c2', name: 'read', arguments: { path: 'two' } } },
      { type: 'tool/result', seq: 3, data: { callId: 'c2', message: { content: 'two-result' } } },
      { type: 'tool/result', seq: 4, data: { callId: 'c1', message: { content: 'one-result' } } },
    ])

    expect(entries).toEqual([
      expect.objectContaining({ kind: 'tool', callId: 'c1', status: 'done', result: 'one-result' }),
      expect.objectContaining({ kind: 'tool', callId: 'c2', status: 'done', result: 'two-result' }),
    ])
  })

  it('keeps Harness-injected context out of the user messages', () => {
    const entries = foldHistory([
      { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, message: { content: 'hi' } } },
      {
        type: 'user/message',
        seq: 2,
        data: {
          source: { kind: 'agent-instructions' },
          message: { content: '<system-reminder>\nInstructions from: AGENTS.md\n</system-reminder>' },
        },
      },
      { type: 'user/message', seq: 3, data: { source: { kind: 'plugin' }, message: { content: 'Current runtime context.' } } },
      { type: 'user/message', seq: 4, data: { source: { kind: 'skill-catalog' }, message: { content: '<available_skills />' } } },
      { type: 'assistant/message', seq: 5, data: { message: { content: 'Hello!' } } },
    ])

    expect(entries.filter((entry) => entry.kind === 'user')).toEqual([
      { kind: 'user', id: expect.any(String), text: 'hi' },
    ])
    expect(entries.filter((entry) => entry.kind === 'context').map((entry) => entry.source)).toEqual([
      'agent-instructions', 'plugin', 'skill-catalog',
    ])
    // The injected blocks keep their own text; only their attribution changes.
    expect(entries.find((entry) => entry.kind === 'context' && entry.source === 'plugin'))
      .toMatchObject({ text: 'Current runtime context.' })
    expect(entries.at(-1)).toMatchObject({ kind: 'assistant', text: 'Hello!' })
  })

  it('drops the product workspace block from the visible user message', () => {
    const entries = foldHistory([
      {
        type: 'user/message',
        seq: 1,
        data: {
          source: { kind: 'user' },
          message: { content: 'Fix the login bug\n\n[ND-DSH WORKSPACE CONTEXT]\n{"workspaceName":"nd-dsh"}\n[/ND-DSH WORKSPACE CONTEXT]' },
        },
      },
    ])
    expect(entries).toEqual([{ kind: 'user', id: expect.any(String), text: 'Fix the login bug' }])
  })

  it('keeps an untagged user message from a session recorded before source tags', () => {
    const entries = foldHistory([message('user/message', 1, 'hi')])
    expect(entries).toEqual([{ kind: 'user', id: expect.any(String), text: 'hi' }])
  })

  it('strips legacy web chat prefixes and upgrades Edit image placeholders in place', () => {
    const entries = foldHistory([
      message('user/message', 1, 'generate mock prototype for our app'),
      message('assistant/message', 2, 'ChatGPT said:\n\nEdit'),
      message('user/message', 3, 'You said:\n\ngenerate mock prototype for our app'),
      message('assistant/message', 4, '![Generated image](https://chatgpt.com/backend-api/estuary/content?id=file_123)'),
      message('user/message', 5, 'generate IMG mock prototype for our app finder'),
      message('user/message', 6, '### You said generate IMG mock prototype for our app finder\n\ngenerate IMG mock prototype for our app finder'),
      message('assistant/message', 7, '![App finder mockup](data:image/webp;base64,UklGRiIAAABXRUJQ)'),
    ])
    expect(entries).toEqual([
      { kind: 'user', id: expect.any(String), text: 'generate mock prototype for our app' },
      { kind: 'assistant', id: expect.any(String), text: '![Generated image](https://chatgpt.com/backend-api/estuary/content?id=file_123)' },
      { kind: 'user', id: expect.any(String), text: 'generate IMG mock prototype for our app finder' },
      { kind: 'assistant', id: expect.any(String), text: '![App finder mockup](data:image/webp;base64,UklGRiIAAABXRUJQ)' },
    ])
  })
})

