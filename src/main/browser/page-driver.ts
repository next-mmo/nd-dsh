import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'

/**
 * One ND browser tab as seen by a web-chat engine. Implementations pin to a
 * single tab and refuse to run against any page outside `allowedOrigins`, so a
 * user navigating the pane mid-turn can never receive engine scripts or files.
 */
export interface PageDriver {
  readonly kind: 'cdp' | 'extension'
  /** Evaluate a main-owned expression (may return a promise) and return its JSON value. */
  evaluate<T>(expression: string): Promise<T>
  /** Assign local files to the file input selected by `expression`. */
  setFilesOnInput(expression: string, files: string[]): Promise<boolean>
  /** PNG data URL of the pinned tab, when the transport can capture one. */
  screenshot?(): Promise<string>
  close(): void
}

export type PageGuardCode = 'wrong-page' | 'tab-closed'

/** The pinned tab left the allowed origins (or closed) before a page operation. */
export class PageGuardError extends Error {
  constructor(readonly code: PageGuardCode, readonly origin: string, message: string) {
    super(message)
    this.name = 'PageGuardError'
  }
}

const WRONG_PAGE_MARKER = 'ND_WRONG_PAGE:'
const MAX_UPLOAD_BYTES = 48 * 1024 * 1024
const UPLOAD_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * Wrap an expression so it runs only on an allowed origin. The check happens
 * inside the page at evaluation time, closing the race between a main-process
 * URL check and the script actually executing.
 */
export function guardExpression(expression: string, allowedOrigins: readonly string[]): string {
  if (allowedOrigins.length === 0) return expression
  return `(() => {
    const allowed = ${JSON.stringify(allowedOrigins)};
    if (!allowed.includes(location.origin)) throw new Error(${JSON.stringify(WRONG_PAGE_MARKER)} + location.origin);
    return (${expression});
  })()`
}

/** Recover a guard failure from a transport error message, if it is one. */
export function pageGuardFromMessage(message: string): PageGuardError | undefined {
  const index = message.indexOf(WRONG_PAGE_MARKER)
  if (index < 0) return undefined
  const origin = message.slice(index + WRONG_PAGE_MARKER.length).split(/\s/)[0] ?? ''
  return new PageGuardError('wrong-page', origin, `ND's Browser pane left the expected site (now on ${origin || 'another page'}).`)
}

/** Narrow main-process surface the isolated-world driver needs from BrowserController. */
export interface IsolatedTabHost {
  evaluateInTab(tabId: string, expression: string): Promise<unknown>
  tabUrl(tabId: string): string | undefined
  screenshot(tabId: string): Promise<{ dataUrl: string }>
}

/**
 * Extension-mode driver: runs fixed, main-owned scripts in an isolated world
 * of ND's embedded tab — the content-script model ND extensions use — with no
 * debugger socket. File inputs are populated through `DataTransfer`, which the
 * page observes exactly like a user file pick.
 */
export class ElectronPageDriver implements PageDriver {
  readonly kind = 'extension' as const
  private closed = false

  constructor(
    private readonly host: IsolatedTabHost,
    private readonly tabId: string,
    private readonly allowedOrigins: readonly string[],
  ) {}

  async evaluate<T>(expression: string): Promise<T> {
    this.assertOpen()
    const wrapped = `(async () => {
      try { return { ok: true, value: await (${guardExpression(expression, this.allowedOrigins)}) }; }
      catch (error) { return { ok: false, message: String(error && error.message || error) }; }
    })()`
    let result: { ok?: boolean; value?: unknown; message?: unknown } | undefined
    try {
      result = await this.host.evaluateInTab(this.tabId, wrapped) as typeof result
    } catch (error) {
      if (this.host.tabUrl(this.tabId) === undefined) {
        throw new PageGuardError('tab-closed', '', 'ND\'s Browser tab for this turn was closed.')
      }
      throw error
    }
    if (result?.ok === true) return result.value as T
    const message = typeof result?.message === 'string' ? result.message : 'Page script failed'
    throw pageGuardFromMessage(message) ?? new Error(message)
  }

  async setFilesOnInput(expression: string, files: string[]): Promise<boolean> {
    let total = 0
    const payload = files.map((path) => {
      total += statSync(path).size
      if (total > MAX_UPLOAD_BYTES) throw new Error('Attachments are too large to hand to the page')
      return {
        name: basename(path),
        type: UPLOAD_MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
        data: readFileSync(path).toString('base64'),
      }
    })
    return await this.evaluate<boolean>(`(() => {
      const input = ${expression};
      if (!(input instanceof HTMLInputElement) || input.type !== 'file') return false;
      const transfer = new DataTransfer();
      for (const file of ${JSON.stringify(payload)}) {
        const binary = atob(file.data);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        transfer.items.add(new File([bytes], file.name, { type: file.type }));
      }
      input.files = transfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
  }

  async screenshot(): Promise<string> {
    this.assertOpen()
    return (await this.host.screenshot(this.tabId)).dataUrl
  }

  close(): void {
    this.closed = true
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Page driver is closed')
    if (this.host.tabUrl(this.tabId) === undefined) {
      throw new PageGuardError('tab-closed', '', 'ND\'s Browser tab for this turn was closed.')
    }
  }
}
