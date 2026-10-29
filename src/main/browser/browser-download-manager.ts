import { randomUUID } from 'node:crypto'
import { app, type DownloadItem, type Event, type Session, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { extname, join, parse } from 'node:path'
import type { BrowserDownloadRecord } from '../../shared/browser-platform.js'
import { DEFAULT_BROWSER_PROFILE_ID } from '../../shared/browser-platform.js'

interface ArmedDownloadContext {
  sessionId: string
  expiresAt: number
}

export interface BrowserDownloadAuthorizationRequest {
  sessionId: string
  tabId?: string
  url: string
  origin?: string
  filename: string
}

const DOWNLOAD_CONTEXT_TTL_MS = 15_000

export class BrowserDownloadManager {
  private readonly records = new Map<string, BrowserDownloadRecord>()
  private readonly items = new Map<string, DownloadItem>()
  private readonly armedByTab = new Map<string, ArmedDownloadContext>()
  private readonly handler: (event: Event, item: DownloadItem, webContents: WebContents) => void
  private authorizeAgentDownload: ((request: BrowserDownloadAuthorizationRequest) => Promise<boolean>) | undefined

  constructor(
    private readonly browserSession: Session,
    private readonly targetId: string,
    private readonly tabIdForWebContents: (webContentsId: number) => string | undefined,
    private readonly onChanged: () => void,
    private readonly profileId: string = DEFAULT_BROWSER_PROFILE_ID,
  ) {
    this.handler = (_event, item, webContents) => this.track(item, webContents)
    this.browserSession.on('will-download', this.handler)
  }

  setAuthorizationHandler(
    handler: ((request: BrowserDownloadAuthorizationRequest) => Promise<boolean>) | undefined,
  ): void {
    this.authorizeAgentDownload = handler
  }

  armAgentDownload(tabId: string, sessionId: string): void {
    this.pruneArmed()
    this.armedByTab.set(tabId, {
      sessionId,
      expiresAt: Date.now() + DOWNLOAD_CONTEXT_TTL_MS,
    })
  }

  list(): BrowserDownloadRecord[] {
    return [...this.records.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((item) => structuredClone(item))
  }

  path(id: string): string | undefined {
    return this.records.get(id)?.path
  }

  cancel(id: string): boolean {
    const item = this.items.get(id)
    if (!item) return false
    try { item.cancel() } catch { return false }
    return true
  }

  clearFinished(): number {
    let removed = 0
    for (const [id, record] of this.records) {
      if (record.state === 'starting' || record.state === 'progressing') continue
      if (this.items.has(id)) continue
      this.records.delete(id)
      removed += 1
    }
    if (removed > 0) this.onChanged()
    return removed
  }

  dispose(): void {
    this.browserSession.removeListener('will-download', this.handler)
    this.items.clear()
    this.armedByTab.clear()
    this.authorizeAgentDownload = undefined
  }

  private track(item: DownloadItem, webContents: WebContents): void {
    this.pruneArmed()
    const id = randomUUID()
    const filename = safeFilename(item.getFilename() || 'download')
    const savePath = uniqueDownloadPath(filename)
    const tabId = this.tabIdForWebContents(webContents.id)
    const url = item.getURL()
    const pageOrigin = origin(url)
    const armed = tabId ? this.armedByTab.get(tabId) : undefined
    if (tabId && armed) this.armedByTab.delete(tabId)
    item.setSavePath(savePath)

    const record: BrowserDownloadRecord = {
      id,
      targetId: this.targetId,
      profileId: this.profileId,
      ...(tabId ? { tabId } : {}),
      url,
      ...(pageOrigin ? { origin: pageOrigin } : {}),
      filename,
      path: savePath,
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      state: 'starting',
      startedAt: Date.now(),
    }
    this.records.set(id, record)
    this.items.set(id, item)
    this.installItemListeners(id, item)
    this.onChanged()

    if (!armed) return

    // A download causally following an agent navigation/click/press/site-tool
    // mutation is paused until the dedicated file.download policy check
    // completes. Direct user downloads have no armed agent context and retain
    // ordinary browser behavior.
    try { item.pause() } catch {
      item.cancel()
      return
    }

    const authorize = this.authorizeAgentDownload
    if (!authorize) {
      item.cancel()
      return
    }

    void authorize({
      sessionId: armed.sessionId,
      ...(tabId ? { tabId } : {}),
      url,
      ...(pageOrigin ? { origin: pageOrigin } : {}),
      filename,
    }).then((allowed) => {
      if (!this.items.has(id)) return
      if (!allowed) {
        item.cancel()
        return
      }
      try {
        item.resume()
        const current = this.records.get(id)
        if (current) current.state = 'progressing'
        this.onChanged()
      } catch {
        item.cancel()
      }
    }).catch(() => {
      if (this.items.has(id)) item.cancel()
    })
  }

  private installItemListeners(id: string, item: DownloadItem): void {
    item.on('updated', (_event, state) => {
      const current = this.records.get(id)
      if (!current) return
      current.receivedBytes = item.getReceivedBytes()
      current.totalBytes = item.getTotalBytes()
      current.state = state === 'progressing' ? 'progressing' : 'interrupted'
      this.onChanged()
    })
    item.once('done', (_event, state) => {
      const current = this.records.get(id)
      if (!current) return
      current.receivedBytes = item.getReceivedBytes()
      current.totalBytes = item.getTotalBytes()
      current.state = state === 'completed'
        ? 'completed'
        : state === 'cancelled'
          ? 'cancelled'
          : 'interrupted'
      current.completedAt = Date.now()
      this.items.delete(id)
      this.onChanged()
    })
  }

  private pruneArmed(): void {
    const now = Date.now()
    for (const [tabId, context] of this.armedByTab) {
      if (context.expiresAt <= now) this.armedByTab.delete(tabId)
    }
  }
}

function uniqueDownloadPath(filename: string): string {
  const parsed = parse(filename)
  const directory = app.getPath('downloads')
  const first = join(directory, filename)
  if (!existsSync(first)) return first
  const suffix = new Date().toISOString().replace(/[:.]/g, '-')
  return join(directory, `${parsed.name}-${suffix}${parsed.ext || extname(filename)}`)
}

function safeFilename(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return (cleaned || 'download').slice(0, 240)
}

function origin(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    return parsed.origin === 'null' ? undefined : parsed.origin
  } catch {
    return undefined
  }
}
