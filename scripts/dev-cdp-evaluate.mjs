/**
 * Dev-only smoke check: connect to the running ND-DSH dev app's loopback CDP
 * and invoke the new wallpaper-links IPC surface from the renderer's isolated
 * world (where window.ndDsh lives). Not used in production paths.
 */
const pageWs = process.argv[2]
const expr = process.argv[3]
if (!pageWs || !expr) {
  console.error('usage: node scripts/dev-cdp-evaluate.mjs <pageWsUrl> <expression>')
  process.exit(1)
}

const ws = new WebSocket(pageWs)
let id = 0
const pending = new Map()

function send(method, params) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
  } else if (msg.method === 'Runtime.executionContextCreated') {
    contexts.push(msg.params.context)
  }
}

const contexts = []

const result = await new Promise((resolve, reject) => {
  ws.onopen = () => resolve()
  ws.onerror = (err) => reject(new Error(`WebSocket error: ${err.message ?? err}`))
})

await send('Runtime.enable')
await new Promise((resolve) => setTimeout(resolve, 500))

// contextBridge exposes into the page's main (default) world; try that first,
// then fall back to the isolated worlds.
const candidates = [
  ...contexts.filter((ctx) => ctx.auxData?.isDefault !== false),
  ...contexts.filter((ctx) => ctx.auxData?.isDefault === false),
]
if (candidates.length === 0) {
  console.error('No execution contexts found. Contexts:', JSON.stringify(contexts.map((c) => ({ id: c.id, name: c.name, origin: c.origin, isDefault: c.auxData?.isDefault }))))
  process.exit(2)
}

let lastError
for (const ctx of candidates) {
  try {
    const evalResult = await send('Runtime.evaluate', {
      expression: expr,
      contextId: ctx.id,
      awaitPromise: true,
      returnByValue: true,
    })
    if (evalResult.exceptionDetails) {
      lastError = new Error(evalResult.exceptionDetails.exception?.description ?? 'evaluate failed')
      continue
    }
    console.log(JSON.stringify(evalResult.result.value, null, 2))
    ws.close()
    process.exit(0)
  } catch (error) {
    lastError = error
  }
}
console.error('All execution contexts failed:', lastError?.message ?? lastError)
ws.close()
process.exit(3)
