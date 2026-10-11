import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { contextKey, personalContext, type NdContext } from '../../shared/nd-context.js'
import type {
  NdCaptureResultView,
  NdHomeCaptureView,
  NdHomeChatView,
  NdHomeLinkView,
  NdHomeNoteView,
  NdHomeStateView,
} from '../../shared/nd-invocations.js'
import { dialpadSiteLabel } from '../../shared/personal-dialpad.js'
import { DEFAULT_BROWSER_URL, isAllowedBrowserUrl, normalizeBrowserUrl } from '../browser/browser-url.js'
import { quarantineFile } from '../logging/log-file.js'

interface HomeSnapshot {
  version: 1
  notes: NdHomeNoteView[]
  captures: NdHomeCaptureView[]
  chats: NdHomeChatView[]
  links: NdHomeLinkView[]
}

const NOTE_BODY_MAX = 64_000
const NOTE_TITLE_MAX = 160
const MAX_NOTES = 5_000
const MAX_CAPTURES = 500
const MAX_LINKS = 120
const LINK_TITLE_MAX = 120
const CAPTURE_NAME_MAX = 128

/**
 * ND Home owns persistent personal records: notes, capture references, and
 * context-bound chat metadata in ND-managed user storage. It is deliberately
 * not a synthetic company, project, or a grant over the user's home directory:
 * every path stays under one ND-owned root, and capture bytes never leave it
 * until the user explicitly exports or attaches them.
 */
export class HomeStore {
  private loaded = false
  private loadPromise: Promise<void> | undefined
  private saveChain: Promise<void> = Promise.resolve()
  private value: HomeSnapshot = { version: 1, notes: [], captures: [], chats: [], links: [] }
  private onChanged: ((state: NdHomeStateView) => void) | undefined

  constructor(private readonly rootDir: string) {}

  setOnChanged(listener: ((state: NdHomeStateView) => void) | undefined): void {
    this.onChanged = listener
  }

  storageRoot(): string {
    return this.rootDir
  }

  /** Managed per-chat working folder; ND creates it, and it is not an OS sandbox. */
  workDirFor(chatId: string): string {
    return join(this.rootDir, 'chats', chatId, 'work')
  }

  async state(): Promise<NdHomeStateView> {
    await this.load()
    return {
      storageRoot: this.rootDir,
      notes: [...this.value.notes].sort((left, right) => right.updatedAt - left.updatedAt),
      captures: [...this.value.captures].sort((left, right) => right.createdAt - left.createdAt),
      chats: [...this.value.chats].sort((left, right) => right.updatedAt - left.updatedAt),
      links: [...this.value.links].sort((left, right) => right.addedAt - left.addedAt),
    }
  }

  async listNotes(context?: NdContext): Promise<NdHomeNoteView[]> {
    await this.load()
    const key = context ? contextKey(context) : undefined
    return this.value.notes
      .filter((note) => !key || note.contextKey === key)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async searchNotes(query: string, context?: NdContext): Promise<NdHomeNoteView[]> {
    const needle = query.trim().toLowerCase()
    const notes = await this.listNotes(context)
    if (!needle) return notes
    return notes.filter((note) =>
      note.title.toLowerCase().includes(needle)
      || note.body.toLowerCase().includes(needle)
      || note.tags.some((tag) => tag.toLowerCase().includes(needle)))
  }

  async createNote(input: { body: string; title?: string; tags?: string[]; context?: NdContext }): Promise<NdHomeNoteView> {
    await this.load()
    const body = input.body.trim().slice(0, NOTE_BODY_MAX)
    if (!body) throw new Error('A note needs some text to save')
    const now = Date.now()
    const note: NdHomeNoteView = {
      id: randomUUID(),
      title: (input.title?.trim() || firstLine(body)).slice(0, NOTE_TITLE_MAX),
      body,
      tags: (input.tags ?? []).map((tag) => tag.trim().slice(0, 48)).filter(Boolean).slice(0, 16),
      contextKey: contextKey(input.context ?? personalContext()),
      createdAt: now,
      updatedAt: now,
    }
    this.value.notes = [note, ...this.value.notes].slice(0, MAX_NOTES)
    await this.persistAndEmit()
    return note
  }

  async updateNote(id: string, input: { body: string; title?: string; tags?: string[] }): Promise<NdHomeNoteView> {
    await this.load()
    const existing = this.value.notes.find((note) => note.id === id)
    if (!existing) throw new Error('That note no longer exists')
    const body = input.body.trim().slice(0, NOTE_BODY_MAX)
    if (!body) throw new Error('A note needs some text to save')
    existing.body = body
    existing.title = (input.title?.trim() || firstLine(body)).slice(0, NOTE_TITLE_MAX)
    if (input.tags) existing.tags = input.tags.map((tag) => tag.trim().slice(0, 48)).filter(Boolean).slice(0, 16)
    existing.updatedAt = Date.now()
    await this.persistAndEmit()
    return existing
  }

  async deleteNote(id: string): Promise<void> {
    await this.load()
    this.value.notes = this.value.notes.filter((note) => note.id !== id)
    await this.persistAndEmit()
  }

  async addCapture(
    image: { data: string; name: string; width: number; height: number; displayLabel: string },
    context?: NdContext,
  ): Promise<NdHomeCaptureView> {
    await this.load()
    const id = randomUUID()
    const fileName = `${id}.png`
    await fs.mkdir(join(this.rootDir, 'captures'), { recursive: true })
    await fs.writeFile(join(this.rootDir, 'captures', fileName), Buffer.from(image.data, 'base64'))
    const record: NdHomeCaptureView = {
      id,
      name: image.name.slice(0, CAPTURE_NAME_MAX),
      width: image.width,
      height: image.height,
      displayLabel: image.displayLabel.slice(0, 64),
      contextKey: contextKey(context ?? personalContext()),
      createdAt: Date.now(),
    }
    this.value.captures = [record, ...this.value.captures].slice(0, MAX_CAPTURES)
    await this.persistAndEmit()
    return record
  }

  async readCapture(id: string): Promise<NdCaptureResultView | null> {
    await this.load()
    const record = this.value.captures.find((capture) => capture.id === id)
    if (!record) return null
    try {
      const data = await fs.readFile(join(this.rootDir, 'captures', `${record.id}.png`))
      return {
        captureId: record.id,
        width: record.width,
        height: record.height,
        displayLabel: record.displayLabel,
        data: data.toString('base64'),
      }
    } catch {
      return null
    }
  }

  async capturePath(id: string): Promise<string | null> {
    await this.load()
    const record = this.value.captures.find((capture) => capture.id === id)
    if (!record) return null
    const path = join(this.rootDir, 'captures', `${record.id}.png`)
    try {
      await fs.access(path)
      return path
    } catch {
      return null
    }
  }

  async deleteCapture(id: string): Promise<void> {
    await this.load()
    const record = this.value.captures.find((capture) => capture.id === id)
    if (!record) return
    this.value.captures = this.value.captures.filter((capture) => capture.id !== id)
    await fs.rm(join(this.rootDir, 'captures', `${record.id}.png`), { force: true }).catch(() => undefined)
    await this.persistAndEmit()
  }

  async attachCapture(id: string, sessionId: string): Promise<void> {
    await this.load()
    const record = this.value.captures.find((capture) => capture.id === id)
    if (!record) throw new Error('That capture no longer exists')
    record.attachedSessionId = sessionId.slice(0, 128)
    await this.persistAndEmit()
  }

  /**
   * Chat metadata binds each personal chat to its context and managed working
   * folder at creation. The gateway session id is recorded once the first turn
   * returns; later company/project switches never rebind it.
   */
  async ensureChat(context: NdContext, input?: { chatId?: string; title?: string; sessionId?: string }): Promise<NdHomeChatView> {
    await this.load()
    const existing = input?.chatId ? this.value.chats.find((chat) => chat.chatId === input.chatId) : undefined
    if (existing) return existing
    const chatId = input?.chatId ?? randomUUID()
    const workDir = this.workDirFor(chatId)
    await fs.mkdir(workDir, { recursive: true })
    const now = Date.now()
    const chat: NdHomeChatView = {
      chatId,
      title: (input?.title?.trim() || 'Personal chat').slice(0, 160),
      context,
      workDir,
      createdAt: now,
      updatedAt: now,
      ...(input?.sessionId ? { sessionId: input.sessionId } : {}),
    }
    this.value.chats = [chat, ...this.value.chats]
    await this.persistAndEmit()
    return chat
  }

  async bindChatSession(chatId: string, sessionId: string): Promise<NdHomeChatView> {
    await this.load()
    const chat = this.value.chats.find((item) => item.chatId === chatId)
    if (!chat) throw new Error('That chat no longer exists')
    chat.sessionId = sessionId.slice(0, 128)
    chat.updatedAt = Date.now()
    await this.persistAndEmit()
    return chat
  }

  async setChatTitle(sessionId: string, title: string): Promise<void> {
    await this.load()
    const chat = this.value.chats.find((item) => item.sessionId === sessionId)
    if (!chat) return
    chat.title = title.trim().slice(0, 160) || chat.title
    chat.updatedAt = Date.now()
    await this.persistAndEmit()
  }

  /**
   * Personal browser dialpad: one saved one-click site. The address is
   * normalized the same way the browser's own address bar normalizes input, and
   * re-saving an address refreshes its tile instead of adding a second one.
   */
  async saveLink(input: { url: string; title?: string }): Promise<NdHomeLinkView> {
    await this.load()
    const url = normalizeBrowserUrl(input.url)
    if (!isAllowedBrowserUrl(url) || url === DEFAULT_BROWSER_URL) {
      throw new Error('A dialpad link needs an http(s) address')
    }
    const title = dialpadSiteLabel(url, input.title).slice(0, LINK_TITLE_MAX)
    const existing = this.value.links.find((link) => link.url === url)
    if (existing) {
      existing.title = title
      await this.persistAndEmit()
      return existing
    }
    const link: NdHomeLinkView = { id: randomUUID(), url, title, addedAt: Date.now() }
    this.value.links = [link, ...this.value.links].slice(0, MAX_LINKS)
    await this.persistAndEmit()
    return link
  }

  async removeLink(id: string): Promise<void> {
    await this.load()
    this.value.links = this.value.links.filter((link) => link.id !== id)
    await this.persistAndEmit()
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this.loadFromDisk().finally(() => { this.loadPromise = undefined })
    return this.loadPromise
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath(), 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object') throw new Error('ND Home record is not an object')
      const record = parsed as Record<string, unknown>
      if (record.version !== 1) throw new Error('ND Home record has an unsupported schema')
      this.value = {
        version: 1,
        notes: Array.isArray(record.notes) ? record.notes.filter(isNoteRecord) : [],
        captures: Array.isArray(record.captures) ? record.captures.filter(isCaptureRecord) : [],
        chats: Array.isArray(record.chats) ? record.chats.filter(isChatRecord) : [],
        links: Array.isArray(record.links) ? record.links.filter(isLinkRecord) : [],
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Starting empty and then persisting would silently drop the user's only
        // copy; keep the unreadable file aside for recovery instead.
        await quarantineFile(this.filePath(), error)
      }
      this.value = { version: 1, notes: [], captures: [], chats: [], links: [] }
    }
    this.loaded = true
  }

  private filePath(): string {
    return join(this.rootDir, 'home.json')
  }

  private async persistAndEmit(): Promise<void> {
    await this.persist()
    this.onChanged?.(await this.state())
  }

  private async persist(): Promise<void> {
    const serialized = `${JSON.stringify(this.value, null, 2)}\n`
    const target = this.filePath()
    const write = this.saveChain.catch(() => undefined).then(async () => {
      await fs.mkdir(dirname(target), { recursive: true })
      const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temp, serialized, 'utf8')
        await fs.rename(temp, target)
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
    })
    this.saveChain = write
    return write
  }
}

function firstLine(body: string): string {
  const line = body.split(/\r?\n/)[0]?.trim() ?? ''
  return line.slice(0, NOTE_TITLE_MAX) || 'Quick note'
}

function isNoteRecord(value: unknown): value is NdHomeNoteView {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.body === 'string' && typeof record.updatedAt === 'number'
}

function isCaptureRecord(value: unknown): value is NdHomeCaptureView {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.createdAt === 'number'
}

function isChatRecord(value: unknown): value is NdHomeChatView {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.chatId === 'string' && typeof record.workDir === 'string' && typeof record.context === 'object'
}

function isLinkRecord(value: unknown): value is NdHomeLinkView {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.url === 'string' && typeof record.addedAt === 'number'
}
