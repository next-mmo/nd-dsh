/**
 * YouTube Downloader — package-shipped ND web view.
 *
 * Runs inside ND's sandboxed iframe: opaque origin, no Node, no network. Every
 * privileged operation is an `nd.webview/1` invoke that the parent routes
 * through the extension broker. This script never builds HTML from page text;
 * titles, filenames, and errors are written with `textContent`.
 */

import {
  filenameForDisplay,
  formatBytes,
  formatEta,
  formatHeight,
  formatSpeed,
  isActiveJob,
  modeLabel,
  nextPollDelay,
  progressRatio,
  stateLabel,
} from './media-core.js'

// --- nd.webview/1 bridge client ---------------------------------------------

function createBridge() {
  let hello = null
  const pending = new Map()
  const connectQueue = []

  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.kind === 'nd-webview:hello' && data.protocol === 'nd.webview/1') {
      hello = data
      while (connectQueue.length > 0) connectQueue.shift()()
      return
    }
    if (data.kind === 'nd-webview:result') {
      const settle = pending.get(data.requestId)
      if (settle) {
        pending.delete(data.requestId)
        settle(data)
      }
    }
  })

  // `ready` means "the UI can accept input": the host unhides the frame on
  // this message. Announce until the host answers, with a fast burst first and
  // a slow retry forever so a late-mounting host still connects.
  let attempts = 0
  let slow = false
  let retry = null
  const announce = () => window.parent.postMessage({ kind: 'nd-webview:ready' }, '*')
  const start = () => {
    if (retry) return
    announce()
    retry = setInterval(() => {
      if (hello) {
        clearInterval(retry)
        return
      }
      attempts += 1
      if (!slow && attempts > 40) {
        slow = true
        clearInterval(retry)
        setInterval(function slower() {
          if (!hello) announce()
          else clearInterval(slower)
        }, 2_000)
        return
      }
      announce()
    }, 250)
  }

  return {
    start,
    whenConnected(fn) {
      if (hello) fn()
      else connectQueue.push(fn)
    },
    invoke(input) {
      if (!hello) {
        return Promise.resolve({ ok: false, error: { code: 'unavailable', message: 'Not connected to ND' } })
      }
      const requestId = crypto.randomUUID()
      return new Promise((resolve) => {
        pending.set(requestId, resolve)
        window.parent.postMessage({ kind: 'nd-webview:invoke', requestId, input }, '*')
        setTimeout(() => {
          if (pending.has(requestId)) {
            pending.delete(requestId)
            resolve({ ok: false, error: { code: 'timeout', message: 'ND did not answer in time' } })
          }
        }, 15_000)
      })
    },
  }
}

const bridge = createBridge()

// --- DOM ---------------------------------------------------------------------

function byId(id) {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing element #${id}`)
  return element
}

const els = {
  app: byId('app'),
  banner: byId('banner'),
  setupBadge: byId('setup-badge'),
  setupCard: byId('setup-card'),
  setupMessage: byId('setup-message'),
  setupButton: byId('setup-button'),
  setupProgress: byId('setup-progress'),
  setupBar: byId('setup-bar'),
  toolList: byId('tool-list'),
  setupError: byId('setup-error'),
  currentTitle: byId('current-title'),
  currentUrl: byId('current-url'),
  useCurrent: byId('use-current'),
  url: byId('url'),
  start: byId('start'),
  startHint: byId('start-hint'),
  modeButtons: Array.from(document.querySelectorAll('[data-mode]')),
  activeCard: byId('active-card'),
  activeTitle: byId('active-title'),
  activeMeta: byId('active-meta'),
  activeBar: byId('active-bar'),
  activeDetail: byId('active-detail'),
  cancel: byId('cancel'),
  jobs: byId('jobs'),
}

const state = {
  status: null,
  current: null,
  mode: 'video',
  url: '',
  urlDirty: false,
  useCurrentTitle: false,
  busy: false,
  setupBusy: false,
  snapshotAt: 0,
  visible: true,
  polling: false,
  pollTimer: null,
  bannerTimer: null,
}

// --- Actions and rendering ---------------------------------------------------

function currentActiveJob() {
  const jobs = state.status && Array.isArray(state.status.jobs) ? state.status.jobs : []
  if (!jobs.length) return null
  return jobs.find((job) => job.id === state.status.activeJobId) || jobs.find(isActiveJob) || null
}

function setupState() {
  return state.status && state.status.setup ? state.status.setup.state : 'missing'
}

function showBanner(message) {
  els.banner.textContent = message
  els.banner.hidden = false
  if (state.bannerTimer) clearTimeout(state.bannerTimer)
  state.bannerTimer = setTimeout(() => {
    els.banner.hidden = true
    state.bannerTimer = null
  }, 8_000)
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
}

function render() {
  renderSetup()
  renderCurrent()
  renderActive()
  renderJobs()
  updateControls()
}

function renderSetup() {
  const setup = state.status && state.status.setup ? state.status.setup : null
  const setupValue = setup ? setup.state : 'missing'
  const ready = setupValue === 'ready'
  const inProgress = setupValue === 'downloading' || setupValue === 'verifying' || setupValue === 'extracting'

  els.setupCard.hidden = ready
  els.setupBadge.className = 'badge'
  if (ready) {
    els.setupBadge.textContent = 'Ready'
    els.setupBadge.classList.add('ok')
    return
  }
  if (setupValue === 'unsupported') {
    els.setupBadge.textContent = 'Windows only'
    els.setupBadge.classList.add('bad')
  } else if (setupValue === 'failed') {
    els.setupBadge.textContent = 'Setup failed'
    els.setupBadge.classList.add('bad')
  } else if (inProgress) {
    els.setupBadge.textContent = 'Setting up'
    els.setupBadge.classList.add('warn')
  } else {
    els.setupBadge.textContent = 'Setup required'
    els.setupBadge.classList.add('warn')
  }

  const tools = setup && Array.isArray(setup.tools) ? setup.tools : []
  els.toolList.replaceChildren()
  for (const tool of tools) {
    const row = document.createElement('li')
    row.className = 'tool-row'
    const name = document.createElement('span')
    name.className = 'tool-name'
    name.textContent = `${tool.name} ${tool.version}`
    const meta = document.createElement('span')
    meta.className = 'tool-meta'
    meta.textContent = `${formatBytes(tool.bytes)} · ${tool.license}`
    if (tool.installed) {
      const installed = document.createElement('span')
      installed.className = 'installed'
      installed.textContent = ' · Installed'
      meta.appendChild(installed)
    }
    row.append(name, meta)
    els.toolList.appendChild(row)
  }

  els.setupMessage.textContent = setup
    ? setup.message
    : 'The downloader needs two pinned tools. Use the active tab or paste a link after setup.'
  els.setupProgress.hidden = !inProgress
  els.setupBar.style.width = `${Math.max(0, Math.min(100, setup && typeof setup.progress === 'number' ? setup.progress : 0))}%`
  els.setupError.hidden = !setup || !setup.error
  els.setupError.textContent = setup && setup.error ? setup.error : ''

  const totalBytes = tools.reduce((sum, tool) => sum + (typeof tool.bytes === 'number' ? tool.bytes : 0), 0)
  const sizeLabel = totalBytes > 0 ? ` (about ${formatBytes(totalBytes)})` : ''
  els.setupButton.disabled = state.setupBusy || inProgress || setupValue === 'unsupported'
  if (setupValue === 'unsupported') els.setupButton.textContent = 'Windows only'
  else if (inProgress) els.setupButton.textContent = 'Setting up…'
  else if (setupValue === 'failed') els.setupButton.textContent = 'Retry setup'
  else els.setupButton.textContent = `Set up downloader${sizeLabel}`
}

function renderCurrent() {
  const current = state.current
  els.currentTitle.textContent = current && current.title ? current.title : 'No YouTube video detected'
  els.currentUrl.textContent = current && current.url
    ? current.url
    : 'Open a watch, Shorts, or live page in ND or connected Chrome browser.'
  els.useCurrent.disabled = !current || state.busy
}

function renderActive() {
  const active = currentActiveJob()
  els.activeCard.hidden = !active
  if (!active) return
  els.activeTitle.textContent = active.title || 'YouTube download'
  const height = formatHeight(active.height)
  els.activeMeta.textContent = [modeLabel(active.mode), height, stateLabel(active.state)]
    .filter(Boolean)
    .join(' · ')
  els.cancel.disabled = state.busy || !(active.state === 'starting' || active.state === 'downloading')
  updateActiveProgress()
}

function updateActiveProgress() {
  const active = currentActiveJob()
  if (!active || els.activeCard.hidden) return
  let received = typeof active.receivedBytes === 'number' ? active.receivedBytes : 0
  let ratio = progressRatio(active)
  const elapsed = Math.max(0, (Date.now() - state.snapshotAt) / 1000)
  if (active.state === 'downloading' && active.totalBytes > 0 && active.speedBps > 0) {
    received = Math.min(active.totalBytes, received + active.speedBps * elapsed)
    ratio = received / active.totalBytes
  }
  els.activeBar.style.width = `${Math.round((ratio === null ? 0 : ratio) * 100)}%`

  if (active.state === 'processing') {
    els.activeDetail.textContent = 'Writing the finished file…'
    return
  }
  const parts = []
  if (received > 0) parts.push(formatBytes(received))
  if (active.totalBytes > 0) parts.push(`of ${formatBytes(active.totalBytes)}`)
  if (active.speedBps > 0) parts.push(formatSpeed(active.speedBps))
  const eta = active.etaSeconds > 0
    ? Math.max(0, active.etaSeconds - elapsed)
    : null
  if (eta !== null && eta > 0) parts.push(`${formatEta(eta)} left`)
  els.activeDetail.textContent = parts.length ? parts.join(' · ') : 'Starting the download…'
}

function badgeClass(jobState) {
  if (jobState === 'completed') return 'badge ok'
  if (jobState === 'failed') return 'badge bad'
  if (jobState === 'downloading' || jobState === 'processing') return 'badge warn'
  return 'badge'
}

function renderJobs() {
  const all = state.status && Array.isArray(state.status.jobs) ? state.status.jobs : []
  const active = currentActiveJob()
  const recent = all.filter((job) => !active || job.id !== active.id).slice(0, 8)
  els.jobs.replaceChildren()
  if (!recent.length) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'No downloads yet. Open a YouTube video or paste a link above.'
    els.jobs.appendChild(empty)
    return
  }

  for (const job of recent) {
    const row = document.createElement('div')
    row.className = 'job'
    const top = document.createElement('div')
    top.className = 'job-top'
    const title = document.createElement('span')
    title.className = 'job-title'
    title.textContent = job.title || filenameForDisplay(job) || 'YouTube video'
    title.title = job.title || ''
    const badge = document.createElement('span')
    badge.className = badgeClass(job.state)
    badge.textContent = stateLabel(job.state)
    top.append(title, badge)

    const meta = document.createElement('span')
    meta.className = 'job-meta'
    const details = [modeLabel(job.mode)]
    if (job.fileName) details.push(job.fileName)
    else if (job.totalBytes > 0) details.push(formatBytes(job.totalBytes))
    if (job.height) details.push(formatHeight(job.height))
    meta.textContent = details.join(' · ')

    row.append(top, meta)
    if (job.error) {
      const error = document.createElement('span')
      error.className = 'error'
      error.textContent = job.error
      row.appendChild(error)
    }
    if (job.state === 'completed') {
      const actions = document.createElement('div')
      actions.className = 'job-actions'
      const reveal = document.createElement('button')
      reveal.type = 'button'
      reveal.className = 'btn ghost small'
      reveal.dataset.reveal = job.id
      reveal.textContent = 'Show in folder'
      actions.appendChild(reveal)
      row.appendChild(actions)
    }
    els.jobs.appendChild(row)
  }
}

function updateControls() {
  const active = currentActiveJob()
  const ready = setupState() === 'ready'
  els.useCurrent.disabled = !state.current || state.busy
  els.start.disabled = state.busy || !ready || Boolean(active) || !state.url.trim()
  els.start.textContent = state.busy ? 'Starting…' : 'Download'
  for (const button of els.modeButtons) {
    button.setAttribute('aria-pressed', button.dataset.mode === state.mode ? 'true' : 'false')
  }

  if (setupState() === 'unsupported') els.startHint.textContent = 'The downloader supports Windows only.'
  else if (!ready) els.startHint.textContent = 'Set up the downloader first.'
  else if (active) els.startHint.textContent = 'A download is already running.'
  else if (!state.url.trim()) els.startHint.textContent = 'Paste a link or use the active tab.'
  else els.startHint.textContent = 'Single video only; playlists and sign-in-only videos are not supported.'
}

// --- Data flow ---------------------------------------------------------------

function setUrl(value, dirty) {
  state.url = value
  els.url.value = value
  state.urlDirty = dirty
  if (dirty) state.useCurrentTitle = false
}

async function loadCurrent(force) {
  const result = await bridge.invoke({ action: 'current' })
  if (!result.ok) return null
  state.current = result.value || null
  if (state.current && (force || !state.urlDirty || !state.url.trim())) {
    setUrl(state.current.url, false)
    state.useCurrentTitle = true
  }
  render()
  return state.current
}

async function refreshStatus() {
  if (state.polling) return
  state.polling = true
  try {
    const result = await bridge.invoke({ action: 'status' })
    if (!result.ok) {
      showBanner(result.error && result.error.message ? result.error.message : 'Downloader status is unavailable')
      schedulePoll(10_000)
      return
    }
    state.status = result.value
    state.snapshotAt = Date.now()
    render()
    schedulePoll(nextPollDelay(state.status))
  } finally {
    state.polling = false
  }
}

function schedulePoll(delay) {
  if (state.pollTimer) clearTimeout(state.pollTimer)
  state.pollTimer = null
  if (!state.visible || document.hidden) return
  state.pollTimer = setTimeout(() => {
    state.pollTimer = null
    void refreshStatus()
  }, delay)
}

async function prepareTools() {
  if (state.setupBusy) return
  state.setupBusy = true
  render()
  const result = await bridge.invoke({ action: 'prepare' })
  state.setupBusy = false
  if (!result.ok) {
    showBanner(result.error && result.error.message ? result.error.message : 'Setup could not start')
  } else if (result.value) {
    state.status = result.value
    state.snapshotAt = Date.now()
  }
  render()
  schedulePoll(0)
}

async function startDownload() {
  if (els.start.disabled) return
  state.busy = true
  render()
  const input = { action: 'start', url: state.url.trim(), mode: state.mode }
  if (state.useCurrentTitle && state.current && state.current.title) input.title = state.current.title
  const result = await bridge.invoke(input)
  state.busy = false
  if (!result.ok) {
    showBanner(result.error && result.error.message ? result.error.message : 'The download could not start')
    render()
    return
  }
  state.useCurrentTitle = false
  state.urlDirty = false
  await refreshStatus()
  schedulePoll(0)
}

async function cancelDownload() {
  const active = currentActiveJob()
  if (!active || state.busy) return
  state.busy = true
  render()
  const result = await bridge.invoke({ action: 'cancel', id: active.id })
  state.busy = false
  if (!result.ok) showBanner(result.error && result.error.message ? result.error.message : 'The download could not be canceled')
  await refreshStatus()
  schedulePoll(0)
}

async function revealJob(id) {
  const result = await bridge.invoke({ action: 'reveal', id })
  if (!result.ok) showBanner(result.error && result.error.message ? result.error.message : 'The file could not be shown')
}

function setVisible(value) {
  if (state.visible === value) return
  state.visible = value
  if (!value) {
    if (state.pollTimer) clearTimeout(state.pollTimer)
    state.pollTimer = null
    return
  }
  void refreshStatus()
}

// --- Event wiring ------------------------------------------------------------

els.url.addEventListener('input', () => {
  state.url = els.url.value
  state.urlDirty = true
  state.useCurrentTitle = false
  updateControls()
})

for (const button of els.modeButtons) {
  button.addEventListener('click', () => {
    state.mode = button.dataset.mode === 'audio' ? 'audio' : 'video'
    updateControls()
  })
}

els.useCurrent.addEventListener('click', () => { void loadCurrent(true) })
els.setupButton.addEventListener('click', () => { void prepareTools() })
els.start.addEventListener('click', () => { void startDownload() })
els.cancel.addEventListener('click', () => { void cancelDownload() })
els.jobs.addEventListener('click', (event) => {
  const button = event.target && event.target.closest ? event.target.closest('[data-reveal]') : null
  if (button) void revealJob(button.getAttribute('data-reveal'))
})

document.addEventListener('visibilitychange', () => {
  if (document.hidden) setVisible(false)
  else {
    setVisible(true)
    void refreshStatus()
  }
})
window.addEventListener('pagehide', () => setVisible(false))

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    setVisible(entries.some((entry) => entry.isIntersecting))
  }, { threshold: 0.01 })
  observer.observe(els.app)
}

window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || typeof data !== 'object') return
  if (data.kind === 'nd-webview:hello' && data.protocol === 'nd.webview/1') applyTheme(data.theme)
  else if (data.kind === 'nd-webview:theme') applyTheme(data.theme)
})

// The progress bar advances between polls without additional audits; polls
// themselves stay at 2–10 s depending on what is running.
setInterval(() => {
  if (state.visible && !document.hidden) updateActiveProgress()
}, 1_000)

// Every control is bound before announcing readiness, so the host cannot
// reveal the frame onto a UI that would drop the first click.
render()
bridge.start()
bridge.whenConnected(() => {
  setVisible(true)
  void (async () => {
    await loadCurrent(false)
    await refreshStatus()
    schedulePoll(nextPollDelay(state.status))
  })()
})
