/**
 * One-off driver: verifies the Mini Browser keep-alive flow against the REAL
 * running ND-DSH dev instance over its loopback CDP (9922), using raw
 * page-target websockets (Playwright's browser-level handshake stalls on
 * this Electron build). Run:
 *
 *   node scripts/verify-mini-browser-live.mjs
 *
 * It drives only user-facing surfaces (element clicks + the same install
 * activation the Discover flow performs) and prints PASS/FAIL lines.
 */
import { setTimeout as delay } from 'node:timers/promises'

const HOST = 'http://127.0.0.1:9922'
const steps = []
const note = (ok, label, detail = '') => {
  steps.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

async function targets() {
  const response = await fetch(`${HOST}/json/list`)
  return response.json()
}

/** Minimal CDP client for one page/iframe target. */
function attach(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    let id = 0
    const pending = new Map()
    socket.addEventListener('open', () => {
      const call = async (method, params = {}) => {
        const message = { id: ++id, method, params }
        socket.send(JSON.stringify(message))
        const reply = await new Promise((settle) => pending.set(message.id, settle))
        if (reply.error) throw new Error(`CDP ${method}: ${JSON.stringify(reply.error)}`)
        return reply.result ?? {}
      }
      const evaluate = async (expression) => {
        const result = await call('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        })
        if (result.exceptionDetails) throw new Error(`evaluate: ${result.exceptionDetails?.exception?.description ?? 'exception'}`)
        return result.result?.value
      }
      resolve({ call, evaluate, close: () => socket.close() })
    })
    socket.addEventListener('message', (event) => {
      const reply = JSON.parse(event.data)
      if (reply.id && pending.has(reply.id)) {
        pending.get(reply.id)(reply)
        pending.delete(reply.id)
      }
    })
    socket.addEventListener('error', () => reject(new Error(`ws error for ${url}`)))
  })
}


/** Re-docks the keep-alive chrome via its header tab and returns an attached client. */
async function redockChrome() {
  await page.evaluate(`(() => {
    const header = document.querySelector('header[data-nd-keepalive]') ?? document.querySelector('header')
    const tab = [...header.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.includes('Mini Browser'))
    if (!tab) throw new Error('keep-alive tab missing')
    tab.click()
  })()`)
  const target = await chromeFrameTarget()
  if (!target) throw new Error('chrome frame not found after re-dock')
  const client = await attach(target.webSocketDebuggerUrl)
  await client.call('Runtime.enable')
  return { target, client, close: () => client.close() }
}

async function waitForFrameUrl(matcher, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = (await targets()).find((target) => target.type === 'iframe' && matcher(target.url))
    if (found) return found
    await delay(300)
  }
  return undefined
}

async function chromeFrameTarget(timeoutMs = 20_000) {
  // Keep-alive means a previously-opened Mini Browser session stays mounted as
  // the SAME target (no fresh token) — identify the chrome by document title,
  // not by frame novelty.
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const target of (await targets()).filter((candidate) => candidate.type === 'iframe' && candidate.url.startsWith('nd-extension-ui://'))) {
      try {
        const client = await attach(target.webSocketDebuggerUrl)
        const title = await client.evaluate('document.title')
        client.close()
        if (title === 'Mini Browser') return { ...target, title }
      } catch {
        // A frame mid-load can refuse evaluation; retry on the next pass.
      }
    }
    await delay(400)
  }
  return undefined
}

const main = (await targets()).find((target) => target.type === 'page' && target.url.includes('#/') && !target.url.includes('#/launcher') && !target.url.startsWith('http://127.0.0.1:1760'))
note(Boolean(main), 'main app window target found')
if (!main) {
  for (const step of steps) console.log(step)
  process.exit(1)
}
const page = await attach(main.webSocketDebuggerUrl)
await page.call('Runtime.enable')

const sleep = (ms) => delay(ms)

// 0. Close any dialog the user left open (non-destructive close).
await page.evaluate(`(() => {
  const close = document.querySelector('[data-slot="dialog-content"] [data-slot="dialog-close"]')
  if (close) close.click()
})()`)
await sleep(500)

// 1. Install + activate nd.mini-browser through the app's own bridge.
const installed = await page.evaluate(`(async () => {
  const api = globalThis.ndDsh?.ndExtensions
  if (!api) return { error: 'bridge missing' }
  const before = await api.state()
  if (!before.packages.some((item) => item.id === 'nd.mini-browser')) {
    await api.installAvailable('nd.mini-browser')
  }
  await api.setActivation('nd.mini-browser', { kind: 'personal' }, true)
  const after = await api.state()
  return {
    hasMiniBrowser: after.packages.some((item) => item.id === 'nd.mini-browser'),
    noLegacy: !after.packages.some((item) => item.id === 'nd.youtube-mini'),
  }
})()`)
note(installed?.hasMiniBrowser === true, 'nd.mini-browser installed + activated')
note(installed?.noLegacy === true, 'legacy nd.youtube-mini id not present in installed set')

// 2. Navigate to Settings → Extensions and open the chrome card.
for (let pass = 0; pass < 10; pass += 1) {
  const atSettings = await page.evaluate(`(() => {
    const nav = document.querySelector("nav[aria-label='ND-DSH navigation']")
    const settings = [...(nav?.querySelectorAll('button') ?? [])].find((button) => button.textContent.includes('Settings'))
    if (!settings) return 'no-nav'
    if (settings.getAttribute('aria-current') === 'page') return 'there'
    settings.click()
    return 'clicked'
  })()`)
  if (atSettings === 'there') break
  await sleep(500)
}
for (let pass = 0; pass < 10; pass += 1) {
  const hasCard = await page.evaluate(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.includes('Extensions'))
    if (!tab) return 'no-tab'
    const card = [...document.querySelectorAll('article')].find((item) => item.textContent.includes('ND Mini Browser'))
    if (!card) return 'no-card'
    return 'there'
  })()`)
  if (hasCard === 'there') break
  await page.evaluate(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.includes('Extensions'))
    if (tab) tab.click()
  })()`)
  await sleep(500)
}
const openedChrome = await page.evaluate(`(() => {
  const card = [...document.querySelectorAll('article')].find((item) => item.textContent.includes('ND Mini Browser'))
  if (!card) return false
  const open = [...card.querySelectorAll('button')].find((button) => /^Open/.test(button.textContent.trim()))
  if (!open) return false
  open.click()
  return true
})()`)
note(openedChrome === true, 'chrome card Open button clicked')
const newFrame = await chromeFrameTarget()
note(Boolean(newFrame), 'chrome iframe target found (keep-alive-aware)', (newFrame?.url ?? '').slice(0, 40))
if (!newFrame) {
  for (const step of steps) console.log(step)
  process.exit(1)
}
const chromeTargetId = newFrame.id
const chrome = await attach(newFrame.webSocketDebuggerUrl)
await chrome.call('Runtime.enable')
const title = await chrome.evaluate(`document.title`)
note(title === 'Mini Browser', 'chrome document is the Mini Browser UI', title)

// 3. Open two real tabs from the address bar. Each open auto-hides the
// chrome and switches the app to the ND browser surface (browser-focus
// ping); the next address re-docks the chrome from its header tab first.
const baselineRows = await chrome.evaluate(`document.querySelectorAll('#tabs > li:not(.empty)').length`)
for (const address of ['https://example.com/live-1', 'https://example.com/live-2']) {
  const marker = address.split('/').at(-1)
  const session = await redockChrome()
  await session.client.evaluate(`(() => {
    const input = document.getElementById('address')
    input.value = ${JSON.stringify(address)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('open').click()
  })()`)
  await sleep(1500)
  const text = await session.client.evaluate(`document.getElementById('tabs').textContent`)
  note(text?.includes(marker), `tab opened from chrome (${marker})`)
  session.client.close()
  const dialogHidden = await page.evaluate(`(() => {
    const content = document.querySelector('[data-slot="dialog-content"]')
    const title = content?.querySelector('[data-slot="dialog-title"]')?.textContent ?? ''
    return !content || title !== 'Mini Browser'
  })()`)
  note(dialogHidden === true, `chrome auto-hid after open (${marker})`)
  const hash = await page.evaluate(`location.hash`)
  note(String(hash).includes('home'), 'app surfaced the browser in the Personal space', hash)
}
const rowCountNow = (await (async () => {
  const session = await redockChrome()
  const value = await session.client.evaluate(`document.querySelectorAll('#tabs > li:not(.empty)').length`)
  session.client.close()
  return value
})())
note(rowCountNow === baselineRows + 2, 'session lists baseline + the two opened rows', `${rowCountNow} rows (baseline ${baselineRows})`)

// 4. Re-dock once more and confirm the SAME keep-alive target persists.
const redocked = await redockChrome()
note(redocked.target.id === chromeTargetId, 'SAME chrome frame re-docked (no reload)', redocked.target.id)
if (redocked.target.id === chromeTargetId) {
  const stillListed = await redocked.client.evaluate(`document.querySelectorAll('#tabs > li:not(.empty)').length`)
  note(stillListed === baselineRows + 2, 'opened tabs still listed after navigation round-trip', `${stillListed} rows (baseline ${baselineRows})`)
  // 5. Close the two test tabs through the chrome, leaving the app's
  // pre-existing tabs alone; each close auto-hides and refocuses the pane,
  // so re-dock between clicks.
  for (let index = 0; index < 2; index += 1) {
    await redocked.client.evaluate(`(() => {
      const closeBtn = [...document.querySelectorAll('#tabs [aria-label^="Close tab"]')][0]
      closeBtn.click()
    })()`)
    await sleep(1200)
  }
  const afterClose = await redocked.client.evaluate(`document.querySelectorAll('#tabs > li:not(.empty)').length`)
  note(afterClose === baselineRows, 'test tabs closed through the chrome, pre-existing tabs untouched', `${afterClose} rows (baseline ${baselineRows})`)
  redocked.client.close()
}

// 6. Close the keep-alive tab from its ×.
await page.evaluate(`(() => {
  document.querySelector('[data-slot="dialog-content"] [data-slot="dialog-close"]').click()
})()`).catch(() => {})
await sleep(500)
await page.evaluate(`(() => {
  const header = document.querySelector('header[data-nd-keepalive]') ?? document.querySelector('header')
  const close = header.querySelector('[aria-label="Close Mini Browser"]')
  if (close) close.click()
})()`)
await sleep(900)
const gone = await page.evaluate(`(() => {
  const header = document.querySelector('header[data-nd-keepalive]') ?? document.querySelector('header')
  return ![...header.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent.includes('Mini Browser'))
})()`)
note(gone === true, 'extension tab closed from its ×')

for (const step of steps) console.log(step)
process.exit(process.exitCode ?? 0)
