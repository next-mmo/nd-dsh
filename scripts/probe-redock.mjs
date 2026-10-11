/** Temp probe: the immediate re-dock race after a browser-focus auto-hide. */
import { setTimeout as delay } from 'node:timers/promises'

const HOST = 'http://127.0.0.1:9922'
const list = () => fetch(`${HOST}/json/list`).then((r) => r.json())

function attach(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    let id = 0
    const pending = new Map()
    socket.addEventListener('open', () => {
      const call = async (method, params = {}) => {
        const message = { id: ++id, method, params }
        socket.send(JSON.stringify(message))
        const reply = await new Promise((settle) => {
          pending.set(message.id, settle)
          setTimeout(() => { if (pending.has(message.id)) { pending.delete(message.id); settle({ result: {} }) } }, 8000)
        })
        pending.delete(message.id)
        return reply.result ?? {}
      }
      const evaluate = async (expression) => {
        const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        if (result.exceptionDetails) throw new Error(`eval ${String(result.exceptionDetails?.exception?.description ?? 'x')}`)
        return result.result?.value
      }
      resolve({ call, evaluate, close: () => socket.close() })
    })
    socket.addEventListener('message', (event) => {
      const reply = JSON.parse(event.data)
      if (reply.id && pending.has(reply.id)) { pending.get(reply.id)(reply); pending.delete(reply.id) }
    })
    socket.addEventListener('error', () => reject(new Error('ws error')))
  })
}

async function chromeTarget() {
  for (let pass = 0; pass < 30; pass += 1) {
    for (const target of await list()) {
      if (target.type !== 'iframe' || !target.url.startsWith('nd-extension-ui://')) continue
      try {
        const client = await attach(target.webSocketDebuggerUrl)
        const title = await client.evaluate('document.title')
        client.close()
        if (title === 'Mini Browser') return target
      } catch { /* retry */ }
    }
    await delay(250)
  }
  return undefined
}

const targets = await list()
const main = targets.find((t) => t.type === 'page' && (t.url.includes('#/') || t.url.includes('index.html')) && !t.url.includes('#/launcher') && t.url.length > 30)
const page = await attach(main.webSocketDebuggerUrl)
await page.call('Runtime.enable')
await page.evaluate(`(() => {
  const close = document.querySelector('[data-slot="dialog-content"] [data-slot="dialog-close"]')
  if (close) close.click()
})()`)
await delay(600)
await page.evaluate(`(() => {
  const nav = document.querySelector("nav[aria-label='ND-DSH navigation']")
  const settings = [...nav.querySelectorAll('button')].find((button) => button.textContent.includes('Settings'))
  settings.click()
})()`)
await delay(500)
await page.evaluate(`(() => {
  const tab = [...document.querySelectorAll('[role="tab"]')].find((item) => item.textContent.includes('Extensions'))
  if (tab) tab.click()
})()`)
for (let pass = 0; pass < 20; pass += 1) {
  const found = await page.evaluate(`(() => {
    const card = [...document.querySelectorAll('article')].find((item) => item.textContent.includes('ND Mini Browser'))
    return Boolean(card?.querySelector('button'))
  })()`)
  if (found) break
  await delay(400)
}
await page.evaluate(`(() => {
  const card = [...document.querySelectorAll('article')].find((item) => item.textContent.includes('ND Mini Browser'))
  const open = [...card.querySelectorAll('button')].find((button) => /^Open/.test(button.textContent.trim()))
  open.click()
})()`)
await delay(700)
const chrome = await chromeTarget()
console.log('chrome target found:', Boolean(chrome))
const one = await attach(chrome.webSocketDebuggerUrl)
await one.call('Runtime.enable')
await one.evaluate(`(() => {
  const input = document.getElementById('address')
  input.value = 'https://example.com/race-1'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  document.getElementById('open').click()
})()`)
await delay(900)
console.log('after open — dialog:', await page.evaluate(`Boolean(document.querySelector('[data-slot="dialog-content"]'))`), '| hash:', await page.evaluate('location.hash'))

// Immediate redock attempt, exactly the e2e situation.
await page.evaluate(`(() => {
  const header = document.querySelector('header')
  const tab = [...header.querySelectorAll('[role="tab"]')].find((item) => item.textContent.includes('Mini Browser'))
  tab.click()
})()`)
for (let tick = 0; tick < 12; tick += 1) {
  const state = await page.evaluate(`(() => {
    const content = document.querySelector('[data-slot="dialog-content"]')
    const title = content?.querySelector('[data-slot="dialog-title"]')?.textContent ?? ''
    return { open: Boolean(content), title, hash: location.hash }
  })()`)
  console.log(`t+${tick * 120}ms — dialog: ${state.open} title:${state.title} hash:${state.hash}`)
  if (state.title === 'Mini Browser') break
}
console.log('+1.25s        — dialog:', await page.evaluate(`Boolean(document.querySelector('[data-slot="dialog-content"]'))`), '| hash:', await page.evaluate('location.hash'))
// Retry click.
await page.evaluate(`(() => {
  const header = document.querySelector('header')
  const tab = [...header.querySelectorAll('[role="tab"]')].find((item) => item.textContent.includes('Mini Browser'))
  tab.click()
})()`)
await delay(800)
console.log('after retry   — dialog:', await page.evaluate(`Boolean(document.querySelector('[data-slot="dialog-content"]'))`), '| hash:', await page.evaluate('location.hash'))
one.close()
process.exit(0)
