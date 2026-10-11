import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TranslateHistoryStore } from '../src/main/extensions/translate-history-store.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function entry(text: string): { text: string; translatedText: string; sourceLanguage: string; targetLanguage: string; provider: 'google' } {
  return { text, translatedText: `translated:${text}`, sourceLanguage: 'auto', targetLanguage: 'km', provider: 'google' }
}

describe('TranslateHistoryStore', () => {
  it('persists successful translations newest first and scopes them per context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-translate-history-'))
    roots.push(root)
    const path = join(root, 'history.json')
    const store = new TranslateHistoryStore(path)
    await store.add('personal', entry('one'))
    await store.add('project:p1', entry('other'))
    await store.add('personal', entry('two'))

    expect((await store.list('personal')).map((item) => item.text)).toEqual(['two', 'one'])
    expect((await store.list('project:p1')).map((item) => item.text)).toEqual(['other'])
    expect(await store.list('project:p2')).toEqual([])

    const reopened = new TranslateHistoryStore(path)
    const persisted = await reopened.list('personal')
    expect(persisted.map((item) => item.text)).toEqual(['two', 'one'])
    expect(persisted[0]?.id).toBeTruthy()
    expect(persisted[0]?.createdAt).toBeTypeOf('number')
    expect(persisted[0]?.translatedText).toBe('translated:two')
  })

  it('removes one entry or clears a whole context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-translate-history-'))
    roots.push(root)
    const store = new TranslateHistoryStore(join(root, 'history.json'))
    const first = await store.add('personal', entry('one'))
    await store.add('personal', entry('two'))
    await store.add('company:c1', entry('three'))

    expect(await store.remove('personal', first.id)).toBe(1)
    expect((await store.list('personal')).map((item) => item.text)).toEqual(['two'])
    expect((await store.list('company:c1')).map((item) => item.text)).toEqual(['three'])

    expect(await store.remove('company:c1')).toBe(1)
    expect(await store.list('company:c1')).toEqual([])
    expect(await store.remove('company:c1')).toBe(0)
  })

  it('caps stored entries and filters invalid records on load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-translate-history-'))
    roots.push(root)
    const path = join(root, 'history.json')
    const store = new TranslateHistoryStore(path)
    for (let i = 0; i < 205; i += 1) await store.add('personal', entry(`item-${i}`))
    const list = await store.list('personal')
    expect(list).toHaveLength(200)
    expect(list[0]?.text).toBe('item-204')

    const corrupted = { version: 1, entries: [
      { ...entry('valid'), id: 'ok', contextKey: 'personal', createdAt: 1 },
      { ...entry('bad-provider'), id: 'bad', contextKey: 'personal', createdAt: 2, provider: 'other' },
      { ...entry('bad-type'), id: 'bad2', contextKey: 'personal', createdAt: 'nope' },
      { id: 'no-context', text: 'x', translatedText: 'y', sourceLanguage: 'auto', targetLanguage: 'km', provider: 'google', createdAt: 3 },
    ] }
    await writeFile(path, JSON.stringify(corrupted), 'utf8')
    const reopened = new TranslateHistoryStore(path)
    expect((await reopened.list('personal')).map((item) => item.text)).toEqual(['valid'])
  })

  it('persists LLM provider entries with their model and rejects malformed llm ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-translate-history-'))
    roots.push(root)
    const path = join(root, 'history.json')
    const store = new TranslateHistoryStore(path)
    await store.add('personal', { ...entry('one'), provider: 'llm:deepseek', model: 'deepseek-v4-flash' })
    expect(await store.list('personal')).toMatchObject([{ provider: 'llm:deepseek', model: 'deepseek-v4-flash' }])

    const corrupted = { version: 1, entries: [
      { ...entry('valid'), id: 'ok', contextKey: 'personal', createdAt: 1 },
      { ...entry('empty-id'), id: 'bad', contextKey: 'personal', createdAt: 2, provider: 'llm:' },
    ] }
    await writeFile(path, JSON.stringify(corrupted), 'utf8')
    const reopened = new TranslateHistoryStore(path)
    expect((await reopened.list('personal')).map((item) => item.text)).toEqual(['valid'])
  })

  it('treats a missing file as empty history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-translate-history-'))
    roots.push(root)
    const store = new TranslateHistoryStore(join(root, 'missing.json'))
    expect(await store.list('personal')).toEqual([])
  })
})
