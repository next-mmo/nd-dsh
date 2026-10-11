import { BrowserWindow, ipcMain } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The vault entry prompt: an ND-owned modal form for creating and editing
 * password vault entries. Launcher commands carry no typed arguments, so the
 * secret itself is typed here, in a window ND controls end to end — the same
 * posture as the wallpaper picker's native dialog, and the reason the vault
 * host handlers need no generic renderer form.
 *
 * The page is an opaque-origin data URL behind a dedicated preload that exposes
 * exactly three calls (initial, submit, cancel). It never receives Node, and
 * its IPC messages are only accepted from the window's own webContents.
 */

export interface VaultPromptValues {
  title: string
  username: string
  url: string
  notes: string
  secret: string
}

export interface VaultPromptOptions {
  mode: 'create' | 'edit'
  initial?: Partial<VaultPromptValues>
}

export interface VaultPromptResult {
  submitted: boolean
  values?: VaultPromptValues
}

const CHANNEL_INITIAL = 'nd-vault-prompt:initial'
const CHANNEL_SUBMIT = 'nd-vault-prompt:submit'
const CHANNEL_CANCEL = 'nd-vault-prompt:cancel'
const FIELD_CAPS: Record<keyof VaultPromptValues, number> = {
  title: 200,
  username: 320,
  url: 2_048,
  notes: 10_000,
  secret: 8_192,
}

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const preloadPath = join(currentDirectory, '../preload/vault-prompt.cjs')

let open: BrowserWindow | null = null

function sanitizeValues(raw: unknown): VaultPromptValues {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const read = (key: keyof VaultPromptValues): string => {
    const value = record[key]
    if (typeof value !== 'string') return ''
    return value.slice(0, FIELD_CAPS[key])
  }
  return {
    title: read('title'),
    username: read('username'),
    url: read('url'),
    notes: read('notes'),
    secret: read('secret'),
  }
}

/**
 * One prompt at a time: a second request while a form is on screen is refused
 * rather than queued, so two stale launcher invocations can never stack modals.
 */
export function promptVaultEntry(parent: BrowserWindow, options: VaultPromptOptions): Promise<VaultPromptResult> {
  if (open && !open.isDestroyed()) throw new Error('A vault entry dialog is already open')
  return new Promise((resolve) => {
    const window = new BrowserWindow({
      width: 460,
      height: 585,
      parent,
      modal: true,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      title: options.mode === 'edit' ? 'Edit vault entry' : 'Add vault entry',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    })
    open = window
    let settled = false
    const settle = (result: VaultPromptResult): void => {
      if (settled) return
      settled = true
      open = null
      ipcMain.removeListener(CHANNEL_SUBMIT, onSubmit)
      ipcMain.removeListener(CHANNEL_CANCEL, onCancel)
      ipcMain.removeHandler(CHANNEL_INITIAL)
      if (!window.isDestroyed()) window.destroy()
      resolve(result)
    }
    const fromSelf = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean =>
      !window.isDestroyed() && event.sender === window.webContents
    const onSubmit = (event: Electron.IpcMainEvent, raw: unknown): void => {
      if (!fromSelf(event)) return
      settle({ submitted: true, values: sanitizeValues(raw) })
    }
    const onCancel = (event: Electron.IpcMainEvent): void => {
      if (!fromSelf(event)) return
      settle({ submitted: false })
    }
    ipcMain.on(CHANNEL_SUBMIT, onSubmit)
    ipcMain.on(CHANNEL_CANCEL, onCancel)
    ipcMain.handle(CHANNEL_INITIAL, (event) => (fromSelf(event) ? { ...(options.initial ?? {}) } : {}))
    window.once('closed', () => settle({ submitted: false }))
    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) window.show()
    })
    void window
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(promptHtml(options))}`)
      .catch(() => settle({ submitted: false }))
  })
}

function promptHtml(options: VaultPromptOptions): string {
  const editing = options.mode === 'edit'
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 18px 20px 20px; background: #141414; color: #ececec;
    font: 13px/1.45 system-ui, sans-serif; user-select: none; }
  h1 { margin: 0 0 2px; font-size: 15px; font-weight: 600; }
  p.sub { margin: 0 0 14px; font-size: 11px; color: #9a9a9a; }
  label { display: block; margin: 10px 0 4px; font-size: 11px; font-weight: 600; color: #c9c9c9; }
  input, textarea { width: 100%; padding: 7px 9px; border-radius: 7px; border: 1px solid #333;
    background: #1d1d1d; color: #ececec; font: 13px/1.4 ui-monospace, monospace; }
  textarea { min-height: 64px; resize: vertical; font-family: system-ui, sans-serif; }
  input:focus, textarea:focus { outline: none; border-color: #6f9bff; }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .row input[type="checkbox"] { width: auto; }
  .row label { margin: 0; font-weight: 400; font-size: 11px; color: #9a9a9a; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  button { padding: 7px 14px; border-radius: 7px; border: 1px solid #3a3a3a; cursor: pointer;
    background: #262626; color: #ececec; font-size: 12px; }
  button.primary { background: #3b6fe0; border-color: #3b6fe0; color: #fff; font-weight: 600; }
  button.primary:disabled { opacity: 0.6; cursor: default; }
  .error { color: #ff8f8f; font-size: 11px; min-height: 15px; margin-top: 10px; }
</style>
</head>
<body>
  <h1>${editing ? 'Edit vault entry' : 'Add vault entry'}</h1>
  <p class="sub">Stored encrypted on this device only. ND never sends it anywhere.</p>
  <form id="form" autocomplete="off">
    <label for="f-title">Title</label>
    <input id="f-title" name="title" required maxlength="200" placeholder="Mail — example.com" autocomplete="off">
    <label for="f-username">Username</label>
    <input id="f-username" name="username" maxlength="320" placeholder="you@example.com" autocomplete="off">
    <label for="f-url">Website (optional)</label>
    <input id="f-url" name="url" maxlength="2048" placeholder="https://mail.example.com" autocomplete="off">
    <label for="f-secret">Secret</label>
    <input id="f-secret" name="secret" type="password" maxlength="8192" autocomplete="off">
    <div class="row"><input id="f-show" type="checkbox"><label for="f-show">Show secret</label></div>
    <label for="f-notes">Notes (optional)</label>
    <textarea id="f-notes" name="notes" maxlength="10000"></textarea>
    <div class="error" id="error" role="alert"></div>
    <div class="actions">
      <button type="button" id="cancel">Cancel</button>
      <button type="submit" class="primary" id="save">${editing ? 'Save changes' : 'Save entry'}</button>
    </div>
  </form>
<script>
  (async () => {
    const form = document.getElementById('form')
    const error = document.getElementById('error')
    const show = document.getElementById('f-show')
    const secret = document.getElementById('f-secret')
    show.addEventListener('change', () => { secret.type = show.checked ? 'text' : 'password' })
    try {
      const initial = await window.ndVaultPrompt.getInitial()
      for (const key of ['title', 'username', 'url', 'notes', 'secret']) {
        if (typeof initial[key] === 'string' && initial[key]) form.elements[key].value = initial[key]
      }
      if (!form.elements.title.value) form.elements.title.focus()
      else form.elements.secret.focus()
    } catch { /* empty form */ }
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (!String(form.elements.title.value).trim()) {
        error.textContent = 'A title is required.'
        return
      }
      document.getElementById('save').disabled = true
      window.ndVaultPrompt.submit({
        title: String(form.elements.title.value),
        username: String(form.elements.username.value),
        url: String(form.elements.url.value),
        notes: String(form.elements.notes.value),
        secret: String(form.elements.secret.value),
      })
    })
    document.getElementById('cancel').addEventListener('click', () => window.ndVaultPrompt.cancel())
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); window.ndVaultPrompt.cancel() }
    })
  })()
</script>
</body>
</html>`
}
