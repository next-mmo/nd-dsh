import { patchRequest, patchPreview } from './requests.js'

let operation = 'help'
let origin = null
let ready = false
let busy = false
let disposed = false
let retry
let delay = 200
const pending = new Map()
const button = document.querySelector('#compose')
const preview = document.querySelector('#preview')
const dryRun = document.querySelector('#dry-run')
const status = document.querySelector('#status')
const descriptions = {
  help: "Help prepares the skill's usage instructions.",
  status: 'Ask the skill to inspect the installed Antigravity version, patch hashes, and pending operations.',
  apply: 'Ask the skill to add Inspect / Annotate to Antigravity, preserving other patches and keeping verified backups.',
  reset: 'Ask the skill to undo the latest compatible patch transaction. Updates and unknown modifications are checked first.',
  adopt: 'Ask the skill to recognize an exact known patch and manage it with ND-owned state.',
}
function render() {
  preview.value = patchPreview(operation, dryRun.checked)
  document.querySelector('#detail').textContent = descriptions[operation]
  dryRun.disabled = !['apply', 'reset', 'adopt'].includes(operation)
  button.disabled = !ready || busy
  for (const item of document.querySelectorAll('[data-operation]')) item.setAttribute('aria-pressed', String(item.dataset.operation === operation))
}
for (const item of document.querySelectorAll('[data-operation]')) item.addEventListener('click', () => { operation = item.dataset.operation; render() })
dryRun.addEventListener('change', render)
window.addEventListener('message', (event) => {
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.kind === 'nd-webview:hello' && message.protocol === 'nd.webview/1' && message.extensionId === 'nd.antigravity-patch' && message.viewId === 'panel') {
    if (origin !== null && origin !== event.origin) return
    origin = event.origin
    ready = true
    clearTimeout(retry)
    document.documentElement.dataset.theme = message.theme === 'dark' ? 'dark' : 'light'
    status.textContent = 'Ready. Nothing runs until you send the request in ND chat.'
    render()
  } else if (event.origin === origin && message.kind === 'nd-webview:theme') {
    document.documentElement.dataset.theme = message.theme === 'dark' ? 'dark' : 'light'
  } else if (event.origin === origin && message.kind === 'nd-webview:result') {
    const call = pending.get(message.requestId)
    if (call) { clearTimeout(call.timer); pending.delete(message.requestId); call.resolve(message) }
  }
})
function announce() {
  if (ready || disposed) return
  window.parent.postMessage({ kind: 'nd-webview:ready' }, '*')
  retry = setTimeout(announce, delay)
  delay = Math.min(2_000, delay * 1.5)
}
button.addEventListener('click', async () => {
  if (!ready || busy) return
  busy = true
  render()
  status.textContent = 'Preparing the request in ND chat…'
  const requestId = crypto.randomUUID()
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(requestId); resolve({ ok: false, error: { message: 'ND did not respond. Check the chat before trying again.' } }) }, 10_000)
    pending.set(requestId, { timer, resolve })
    window.parent.postMessage({ kind: 'nd-webview:invoke', requestId,
      input: { action: 'prepare-request', skill: 'antigravity-patch', request: patchRequest(operation, dryRun.checked) } }, origin === 'null' ? '*' : origin)
  })
  busy = false
  status.textContent = result.ok ? 'Prepared in ND chat. Review the draft and send when ready.' : (result.error?.message || 'Could not prepare the request.')
  render()
})
window.addEventListener('pagehide', () => { disposed = true; clearTimeout(retry); for (const call of pending.values()) { clearTimeout(call.timer); call.resolve({ ok: false }) } pending.clear() }, { once: true })
render()
announce()
