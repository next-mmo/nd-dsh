/**
 * Clipboard History recording and the watcher reconcile loop (task 0050).
 *
 * Two independent switches must both hold before anything is ever recorded:
 * the package is activated for the Personal context AND the `recordHistory`
 * setting is explicitly on. `syncClipboardWatcher` is modelled on the
 * wallpaper rotation reconcile: it stops any running watcher first, so no
 * ordering of activation, setting, update, rollback, or uninstall events can
 * leave a watcher running that the user believes is off. Failures resolving
 * authorization leave the watcher stopped — fail closed, never fail recording.
 *
 * Content flows only through the trusted read path: a content-free
 * `clipboard.changed` event triggers a sidecar `clipboard.read`, and what is
 * read is stored locally. Image bytes live as files on disk named by a
 * pixel-data fingerprint, with the index keeping metadata only — the same
 * bytes-on-disk pattern that keeps base64 image blobs out of one JSON
 * document rewritten per mutation.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import type { CoreClipboard, CoreClipboardChangedEvent } from '../core/core-clipboard.js'
import type { InvocationStateStore } from './invocation-state.js'

export const CLIPBOARD_HISTORY_ID = 'nd.clipboard-history'

/** Caps by content type, pins exempt — the manifest exposes them as settings. */
export interface ClipboardCaps {
  text: number
  image: number
  pinned: number
}

export const DEFAULT_CAPS: ClipboardCaps = { text: 300, image: 30, pinned: 25 }

/** Per-item text bound in the index; the sidecar's own read bound is wider. */
export const MAX_HISTORY_TEXT_CHARS = 20_000

export interface ClipboardHistoryEntry {
  id: string
  kind: 'text' | 'image' | 'files'
  createdAt: number
  lastCopiedAt: number
  pinned: boolean
  /** How many times this content was (re)copied. */
  occurrences: number
  /** Dedup key: content hash for text/files, pixel fingerprint for images. */
  fingerprint: string
  text?: string
  truncated?: boolean
  imageFile?: string
  imageWidth?: number
  imageHeight?: number
  /** The image was real but beyond the storage bound; metadata only. */
  tooLarge?: boolean
  fileName?: string
  names?: string[]
}

interface ClipboardIndex {
  version: 1
  entries: ClipboardHistoryEntry[]
}

function clampCap(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

export function capsFromSettings(settings: Record<string, unknown> | undefined): ClipboardCaps {
  return {
    text: clampCap(settings?.textCap, DEFAULT_CAPS.text, 1, 1_000),
    image: clampCap(settings?.imageCap, DEFAULT_CAPS.image, 1, 100),
    pinned: clampCap(settings?.pinnedCap, DEFAULT_CAPS.pinned, 1, 100),
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export interface ClipboardRecordInput {
  text?: string
  truncated?: boolean
  pngBase64?: string
  fingerprint?: string
  width?: number
  height?: number
  /** The image was real but beyond the storage bound; metadata only. */
  tooLarge?: boolean
  fileName?: string
  names?: string[]
}

/**
 * The history index plus its image store. Every mutating call is serialized
 * through one save chain, and writes go through temp-file + rename like every
 * other durable ND record.
 */
export class ClipboardHistoryStore {
  private loaded = false
  private loadPromise: Promise<void> | undefined
  private saveChain: Promise<void> = Promise.resolve()
  private index: ClipboardIndex = { version: 1, entries: [] }

  constructor(
    private readonly rootDir: string,
    private readonly imagesDir = join(rootDir, 'images'),
  ) {}

  get imageDirectory(): string {
    return this.imagesDir
  }

  async initialize(): Promise<void> {
    if (this.loaded) return
    this.loadPromise ??= this.loadFromDisk().finally(() => {
      this.loadPromise = undefined
    })
    await this.loadPromise
    this.loaded = true
  }

  private async loadFromDisk(): Promise<void> {
    const file = this.filePath()
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<ClipboardIndex>
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('unsupported clipboard history schema')
      this.index = { version: 1, entries: parsed.entries.filter(isEntry) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Clipboard history index failed to load, starting empty:', error)
      }
      this.index = { version: 1, entries: [] }
    }
  }

  private filePath(): string {
    return join(this.rootDir, 'index.json')
  }

  private async persist(): Promise<void> {
    const serialized = `${JSON.stringify(this.index, null, 2)}\n`
    const write = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(this.rootDir, { recursive: true })
        const temp = `${this.filePath()}.${process.pid}.${randomUUID()}.tmp`
        try {
          await fs.writeFile(temp, serialized, 'utf8')
          await fs.rename(temp, this.filePath())
        } catch (error) {
          await fs.rm(temp, { force: true }).catch(() => undefined)
          throw error
        }
      })
    this.saveChain = write
    return write
  }

  private entryIdFor(fingerprint: string): ClipboardHistoryEntry | undefined {
    return this.index.entries.find((entry) => entry.fingerprint === fingerprint)
  }

  /**
   * Record one copied item. Duplicate content bumps the existing entry's
   * recency instead of adding a row; new entries are trimmed against the
   * caller's caps (pins exempt).
   */
  async record(input: ClipboardRecordInput, caps: ClipboardCaps, at = Date.now()): Promise<ClipboardHistoryEntry> {
    await this.initialize()
    let entry: ClipboardHistoryEntry
    if (typeof input.text === 'string' && input.text.trim()) {
      const text = input.text.slice(0, MAX_HISTORY_TEXT_CHARS)
      const fingerprint = hashText(text)
      const existing = this.entryIdFor(fingerprint)
      if (existing) {
        existing.lastCopiedAt = at
        existing.occurrences += 1
        entry = existing
      } else {
        entry = {
          id: randomUUID(),
          kind: 'text',
          createdAt: at,
          lastCopiedAt: at,
          pinned: false,
          occurrences: 1,
          fingerprint,
          text,
          ...(input.truncated ? { truncated: true } : {}),
        }
        this.index.entries.push(entry)
      }
    } else if (input.fingerprint) {
      const fingerprint = input.fingerprint
      const existing = this.entryIdFor(fingerprint)
      if (existing) {
        existing.lastCopiedAt = at
        existing.occurrences += 1
        entry = existing
      } else {
        let imageFile: string | undefined
        if (input.pngBase64) {
          await fs.mkdir(this.imagesDir, { recursive: true })
          imageFile = `${fingerprint}.png`
          const target = join(this.imagesDir, imageFile)
          if (!existsSync(target)) {
            const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
            try {
              await fs.writeFile(temp, Buffer.from(input.pngBase64, 'base64'))
              await fs.rename(temp, target)
            } catch (error) {
              await fs.rm(temp, { force: true }).catch(() => undefined)
              throw error
            }
          }
        }
        entry = {
          id: randomUUID(),
          kind: 'image',
          createdAt: at,
          lastCopiedAt: at,
          pinned: false,
          occurrences: 1,
          fingerprint,
          ...(imageFile ? { imageFile } : {}),
          ...(typeof input.width === 'number' ? { imageWidth: input.width } : {}),
          ...(typeof input.height === 'number' ? { imageHeight: input.height } : {}),
          ...(input.tooLarge ? { tooLarge: true } : {}),
          ...(input.fileName ? { fileName: input.fileName } : {}),
        }
        this.index.entries.push(entry)
      }
    } else if (Array.isArray(input.names) && input.names.length > 0) {
      const fingerprint = hashText(input.names.join('\n'))
      const existing = this.entryIdFor(fingerprint)
      if (existing) {
        existing.lastCopiedAt = at
        existing.occurrences += 1
        entry = existing
      } else {
        entry = {
          id: randomUUID(),
          kind: 'files',
          createdAt: at,
          lastCopiedAt: at,
          pinned: false,
          occurrences: 1,
          fingerprint,
          names: input.names.slice(0, 32),
        }
        this.index.entries.push(entry)
      }
    } else {
      throw new Error('Nothing recordable on the clipboard')
    }

    await this.enforceCaps(caps)
    await this.persist()
    return structuredClone(entry)
  }

  /** Caps by content type; pins are exempt from every cap. */
  private async enforceCaps(caps: ClipboardCaps): Promise<void> {
    await this.trimKind('text', caps.text)
    await this.trimKind('image', caps.image)
    const pinned = this.index.entries.filter((entry) => entry.pinned)
    if (pinned.length > caps.pinned) {
      throw new Error(`Pinned cap (${caps.pinned}) reached; unpin something first`)
    }
  }

  private async trimKind(kind: ClipboardHistoryEntry['kind'], cap: number): Promise<void> {
    const over = this.index.entries
      .filter((entry) => entry.kind === kind && !entry.pinned)
      .sort((left, right) => right.lastCopiedAt - left.lastCopiedAt)
      .slice(cap)
    if (over.length === 0) return
    const remove = new Set(over.map((entry) => entry.id))
    this.index.entries = this.index.entries.filter((entry) => !remove.has(entry.id))
    await this.deleteOrphanImages()
  }

  /** Remove image files no entry references anymore. */
  private async deleteOrphanImages(): Promise<void> {
    const referenced = new Set(
      this.index.entries.map((entry) => entry.imageFile).filter((file): file is string => Boolean(file)),
    )
    try {
      const files = await fs.readdir(this.imagesDir)
      for (const file of files) {
        if (!file.endsWith('.png')) continue
        if (!referenced.has(file)) {
          await fs.rm(join(this.imagesDir, file), { force: true }).catch(() => undefined)
        }
      }
    } catch {
      // No images dir yet, or unreadable: nothing to clean.
    }
  }

  async list(): Promise<ClipboardHistoryEntry[]> {
    await this.initialize()
    return structuredClone(
      [...this.index.entries].sort((left, right) => right.lastCopiedAt - left.lastCopiedAt),
    )
  }

  async get(id: string): Promise<ClipboardHistoryEntry | undefined> {
    await this.initialize()
    const entry = this.index.entries.find((item) => item.id === id)
    return entry ? structuredClone(entry) : undefined
  }

  async readImageFile(entry: ClipboardHistoryEntry): Promise<Buffer | undefined> {
    if (!entry.imageFile) return undefined
    const target = join(this.imagesDir, entry.imageFile)
    // imageFile is always a bare file name this store generated; refuse
    // anything that could traverse out of the images directory.
    if (entry.imageFile.includes('/') || entry.imageFile.includes('\\') || entry.imageFile.includes('..')) return undefined
    try {
      return await fs.readFile(target)
    } catch {
      return undefined
    }
  }

  async setPinned(id: string, pinned: boolean, caps: ClipboardCaps): Promise<boolean> {
    await this.initialize()
    const entry = this.index.entries.find((item) => item.id === id)
    if (!entry) return false
    if (pinned && !entry.pinned) {
      const pinnedCount = this.index.entries.filter((item) => item.pinned).length
      if (pinnedCount >= caps.pinned) {
        throw new Error(`Pinned cap (${caps.pinned}) reached; unpin something first`)
      }
    }
    entry.pinned = pinned
    await this.persist()
    return true
  }

  async delete(id: string): Promise<boolean> {
    await this.initialize()
    const before = this.index.entries.length
    this.index.entries = this.index.entries.filter((entry) => entry.id !== id)
    if (this.index.entries.length === before) return false
    await this.persist()
    await this.deleteOrphanImages()
    return true
  }

  /**
   * Clear history. Pins survive — the caps treat them as exempt, and a clear
   * that silently destroyed the user's pinned references would be surprising.
   */
  async clear(): Promise<{ cleared: number; keptPinned: number }> {
    await this.initialize()
    const keptPinned = this.index.entries.filter((entry) => entry.pinned).length
    const cleared = this.index.entries.length - keptPinned
    this.index.entries = this.index.entries.filter((entry) => entry.pinned)
    await this.persist()
    await this.deleteOrphanImages()
    return { cleared, keptPinned }
  }

  async counts(): Promise<{ total: number; text: number; image: number; files: number }> {
    await this.initialize()
    const counts = { total: this.index.entries.length, text: 0, image: 0, files: 0 }
    for (const entry of this.index.entries) counts[entry.kind] += 1
    return counts
  }
}

function isEntry(value: unknown): value is ClipboardHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && (record.kind === 'text' || record.kind === 'image' || record.kind === 'files')
    && typeof record.createdAt === 'number'
    && typeof record.lastCopiedAt === 'number'
    && typeof record.pinned === 'boolean'
    && typeof record.fingerprint === 'string'
}

// --- Watcher reconcile --------------------------------------------------------

/** The narrow watcher surface the controller drives; fakeable in tests. */
export interface ClipboardWatchPort {
  watch(): Promise<string>
  unwatch(watchId: string): Promise<boolean>
}

/**
 * The clipboard-history watcher lifecycle. `sync()` stops first and starts
 * only when activation AND `recordHistory` both say so, exactly like the
 * wallpaper rotation reconcile it is modelled on.
 */
export class ClipboardWatcherController {
  private watchId: string | null = null
  private syncing: Promise<void> = Promise.resolve()

  constructor(
    private readonly state: Pick<InvocationStateStore, 'activation'>,
    private readonly port: ClipboardWatchPort,
    private readonly extensionId = CLIPBOARD_HISTORY_ID,
  ) {}

  /** Reconcile the watcher with activation + the recordHistory opt-in. */
  sync(): Promise<void> {
    this.syncing = this.syncing
      .catch(() => undefined)
      .then(() => this.syncOnce())
    return this.syncing
  }

  private async syncOnce(): Promise<void> {
    // Stop before deciding anything, so a disable can never be missed.
    if (this.watchId) {
      const previous = this.watchId
      this.watchId = null
      await this.port.unwatch(previous).catch(() => undefined)
    }
    try {
      const activation = await this.state.activation(this.extensionId, { kind: 'personal' })
      if (!activation?.enabled) return
      // The dedicated default-false switch; activation alone is not enough
      // because activation records can predate the opt-in or be flipped by
      // seeding logic.
      if (activation.settings.recordHistory !== true) return
      const watchId = await this.port.watch()
      this.watchId = watchId
    } catch {
      // Fail closed: an error resolving authorization or starting the watcher
      // leaves recording off, never half on.
      this.watchId = null
    }
  }

  get watching(): boolean {
    return this.watchId !== null
  }

  /** A sidecar exit killed every watcher it hosted; forget the stale handle. */
  invalidate(): void {
    this.watchId = null
  }

  async stop(): Promise<void> {
    if (!this.watchId) return
    const previous = this.watchId
    this.watchId = null
    await this.port.unwatch(previous).catch(() => undefined)
  }
}

// --- Attachment ---------------------------------------------------------------

export interface ClipboardHistoryOptions {
  state: InvocationStateStore
  /** Present only when the nd-core sidecar is available. */
  coreClipboard?: CoreClipboard
  userDataDir: string
  log?: (line: string) => void
}

export interface ClipboardHistoryAttachment {
  store: ClipboardHistoryStore
  controller: ClipboardWatcherController
  sync(): Promise<void>
  dispose(): Promise<void>
}

/**
 * Wire the history store, the watcher controller, and the event recorder
 * together. The store works without the sidecar (reading old history), but
 * the watcher and recorder exist only when it does.
 */
export function attachClipboardHistory(options: ClipboardHistoryOptions): ClipboardHistoryAttachment {
  const { state, coreClipboard, userDataDir } = options
  const log = options.log ?? ((line: string) => console.warn(line))
  const store = new ClipboardHistoryStore(join(userDataDir, 'clipboard-history'))

  // Without the sidecar there is no watcher and nothing to reconcile; the
  // host methods still expose the stored history.
  if (!coreClipboard) {
    const controller = new ClipboardWatcherController(state, {
      watch: async () => {
        throw new Error('The nd-core sidecar is required for clipboard history recording')
      },
      unwatch: async () => false,
    })
    return {
      store,
      controller,
      sync: () => controller.sync(),
      dispose: async () => {
        await controller.stop()
      },
    }
  }

  const controller = new ClipboardWatcherController(state, {
    watch: async () => (await coreClipboard.watch()).watchId,
    unwatch: (watchId) => coreClipboard.unwatch(watchId),
  })

  const isRecordableEvent = (event: CoreClipboardChangedEvent): boolean =>
    event.contentType === 'text' || event.contentType === 'image' || event.contentType === 'files'

  // One recording operation at a time; a burst of copies still lands in order.
  let recording: Promise<void> = Promise.resolve()
  const disposeChanged = coreClipboard.onChanged((event) => {
    if (!controller.watching) return
    if (!isRecordableEvent(event)) return
    recording = recording
      .catch(() => undefined)
      .then(async () => {
        const activation = await state.activation(CLIPBOARD_HISTORY_ID, { kind: 'personal' })
        if (!activation?.enabled || activation.settings.recordHistory !== true) return
        const content = await coreClipboard.read()
        if (content.kind === 'none') return
        const caps = capsFromSettings(activation.settings)
        if (content.kind === 'text' && content.text?.trim()) {
          await store.record(
            { text: content.text, truncated: content.truncated === true },
            caps,
            event.timestamp || Date.now(),
          )
        } else if (content.kind === 'image' && content.fingerprint) {
          await store.record(
            {
              fingerprint: content.fingerprint,
              ...(content.pngBase64 !== undefined ? { pngBase64: content.pngBase64 } : {}),
              ...(content.width !== undefined ? { width: content.width } : {}),
              ...(content.height !== undefined ? { height: content.height } : {}),
              ...(content.fileName !== undefined ? { fileName: content.fileName } : {}),
            },
            caps,
            event.timestamp || Date.now(),
          )
        } else if (content.kind === 'files' && content.names?.length) {
          await store.record({ names: content.names }, caps, event.timestamp || Date.now())
        }
        if (event.droppedSinceLast) {
          log(`Clipboard history: ${event.droppedSinceLast} change event(s) were dropped by the sidecar before delivery`)
        }
      })
      .catch((error) => {
        log(`Clipboard history recording failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  })

  // A sidecar restart kills every watcher it hosted. Forget the stale handle
  // and reconcile again once the sidecar is ready, so an opted-in user ends
  // up watched again and a non-opted user stays unwatched.
  const disposeExit = coreClipboard.onExit(() => {
    controller.invalidate()
  })
  const disposeReady = coreClipboard.onReady(() => {
    void controller.sync().catch(() => undefined)
  })

  return {
    store,
    controller,
    sync: () => controller.sync(),
    dispose: async () => {
      disposeChanged()
      disposeExit()
      disposeReady()
      await controller.stop()
    },
  }
}
