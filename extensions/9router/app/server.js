import http from 'node:http'

function parsePort(): number {
  const portArgIndex = process.argv.indexOf('--port')
  if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
    const parsed = parseInt(process.argv[portArgIndex + 1], 10)
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed
    }
  }
  if (process.env.PORT) {
    const parsed = parseInt(process.env.PORT, 10)
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed
    }
  }
  return 20128
}

const port = parsePort()

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const pathname = url.pathname

  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: '9router/auto', object: 'model', owned_by: '9router' },
        { id: '9router/default', object: 'model', owned_by: '9router' },
      ],
    }))
    return
  }

  if (pathname === '/' || pathname === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>9Router Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0b0f17; color: #e2e8f0; margin: 0; padding: 2rem; }
    .card { background: #161e2e; border: 1px solid #2d3748; border-radius: 8px; padding: 1.5rem; max-width: 600px; margin: auto; }
    h1 { margin-top: 0; font-size: 1.25rem; color: #38bdf8; }
    .status { display: inline-block; padding: 0.25rem 0.5rem; border-radius: 4px; background: #065f46; color: #34d399; font-size: 0.875rem; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <h1>9Router Gateway</h1>
    <p><span class="status">Running</span></p>
    <p>Local proxy and model gateway runtime managed by ND.</p>
  </div>
</body>
</html>`)
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'Not found' } }))
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[9router] Listening on http://127.0.0.1:${port}`)
})

const shutdown = () => {
  server.close(() => {
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
