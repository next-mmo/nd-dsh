/**
 * OS Toolkit studio — package-shipped web view.
 *
 * Runs inside ND's sandboxed iframe: opaque origin, no Node, no network. Every
 * privileged operation flows through the nd.webview/1 bridge to a declared view
 * action, so this script holds no authority of its own.
 *
 * Runtime work is bounded on purpose. The 24-hour ring redraws only when the data
 * it shows actually changes, there is no requestAnimationFrame loop, drawing is
 * skipped while the document is hidden or zero-sized, and the 30-second status
 * poll stops when the frame is not visible. The countdown uses the local clock and
 * the package's own copy of the schedule rules, so it never costs a host call.
 */
import { createBridge, describeBridgeFailure } from './bridge.js'
import {
  MINUTES_PER_DAY,
  describeScheduleIssue,
  desiredTheme,
  formatHHMM,
  minutesOfDay,
  nextChange,
  parseHHMM,
  resolveOsToolkitSettings,
  timelineSegments,
} from './schedule-core.js'

const RING_CSS_PX = 148
const STATUS_POLL_MS = 30_000
const COUNTDOWN_TICK_MS = 60_000

const el = (id) => document.getElementById(id)

const nodes = {
  status: el('status'),
  badgeTheme: el('badge-theme'),
  badgeBackend: el('badge-backend'),
  ring: el('ring'),
  countdown: el('countdown'),
  legendDay: el('legend-day'),
  legendNight: el('legend-night'),
  issue: el('issue'),
  actLight: el('act-light'),
  actDark: el('act-dark'),
  actToggle: el('act-toggle'),
  applyNote: el('apply-note'),
  backendReason: el('backend-reason'),
  lightSwitchState: el('lightswitch-state'),
  backendAuto: el('backend-auto'),
  backendNative: el('backend-native'),
  backendPowertoys: el('backend-powertoys'),
  save: el('save'),
  refresh: el('refresh'),
  inputs: {
    schedulerEnabled: el('set-schedulerEnabled'),
    dayStart: el('set-dayStart'),
    nightStart: el('set-nightStart'),
    applyApps: el('set-applyApps'),
    applySystem: el('set-applySystem'),
    lightSwitchSync: el('set-lightSwitchSync'),
    startupReconcile: el('set-startupReconcile'),
  },
}

/** What the user has typed but not saved, so a poll cannot overwrite their edits. */
let draft = null
let editing = false
let state = null
let statusTimer = null
let countdownTimer = null
let lastRingSignature = ''
let busy = false

// --- bridge ------------------------------------------------------------------

const bridge = createBridge({
  onTheme: () => {
    // The palette changed under us, so the cached ring signature is stale.
    lastRingSignature = ''
    drawRing()
  },
})

// --- rendering ---------------------------------------------------------------

function palette() {
  const style = getComputedStyle(document.documentElement)
  const read = (name, fallback) => {
    const value = style.getPropertyValue(name).trim()
    return value.length > 0 ? value : fallback
  }
  return {
    sun: read('--sun', '#fbbf24'),
    moon: read('--moon', '#a78bfa'),
    border: read('--border', '#2a2f3a'),
    faint: read('--faint', '#9aa3b2'),
    text: read('--text', '#e7e9ee'),
    panel: read('--panel', '#1b1e25'),
  }
}

/**
 * Draw the 24-hour ring. Called only when something it depicts changed; the
 * signature check makes a redundant call free.
 */
function drawRing() {
  const canvas = nodes.ring
  if (!canvas || document.hidden) return
  if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const settings = currentSettings()
  const segments = timelineSegments(settings)
  const now = minutesOfDay(new Date())
  const colors = palette()
  const signature = JSON.stringify([segments, now, colors.sun, colors.moon, colors.faint, colors.text])
  if (signature === lastRingSignature) return
  lastRingSignature = signature

  const dpr = Math.min(3, window.devicePixelRatio || 1)
  const size = RING_CSS_PX
  if (canvas.width !== Math.round(size * dpr)) {
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size, size)

  const cx = size / 2
  const cy = size / 2
  const outer = size / 2 - 4
  const inner = outer - 15
  // Midnight at the top, clockwise, so the ring reads like a clock face.
  const angleAt = (minute) => (minute / MINUTES_PER_DAY) * Math.PI * 2 - Math.PI / 2

  if (segments.length === 0) {
    ctx.beginPath()
    ctx.arc(cx, cy, (outer + inner) / 2, 0, Math.PI * 2)
    ctx.strokeStyle = colors.border
    ctx.lineWidth = outer - inner
    ctx.stroke()
  } else {
    for (const segment of segments) {
      ctx.beginPath()
      ctx.arc(cx, cy, (outer + inner) / 2, angleAt(segment.start), angleAt(segment.end))
      ctx.strokeStyle = segment.theme === 'light' ? colors.sun : colors.moon
      ctx.lineWidth = outer - inner
      ctx.lineCap = 'butt'
      ctx.stroke()
    }
  }

  // Hour ticks, outside the ring, so the arcs stay legible.
  ctx.strokeStyle = colors.border
  ctx.lineWidth = 1
  for (let hour = 0; hour < 24; hour += 3) {
    const angle = angleAt(hour * 60)
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(angle) * (outer + 1), cy + Math.sin(angle) * (outer + 1))
    ctx.lineTo(cx + Math.cos(angle) * (outer + 4), cy + Math.sin(angle) * (outer + 4))
    ctx.stroke()
  }

  // The "now" hand.
  const handAngle = angleAt(now)
  ctx.beginPath()
  ctx.moveTo(cx + Math.cos(handAngle) * (inner - 4), cy + Math.sin(handAngle) * (inner - 4))
  ctx.lineTo(cx + Math.cos(handAngle) * (outer + 4), cy + Math.sin(handAngle) * (outer + 4))
  ctx.strokeStyle = colors.text
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.stroke()

  const label = formatHHMM(now) ?? '--:--'
  ctx.fillStyle = colors.text
  ctx.font = '600 19px system-ui, -apple-system, "Segoe UI", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, cx, cy - 7)
  ctx.fillStyle = colors.faint
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif'
  ctx.fillText('now', cx, cy + 12)
}

function currentSettings() {
  if (draft) return draft
  return resolveOsToolkitSettings(state?.status?.settings)
}

function themeWord(mode) {
  return mode === 'dark' ? 'dark' : mode === 'light' ? 'light' : '—'
}

function capitalize(value) {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1)
}

function setStatus(message, kind, fix) {
  nodes.status.textContent = ''
  nodes.status.className = kind === 'ok' ? 'ok' : kind === 'bad' ? 'bad' : ''
  if (!message) return
  nodes.status.textContent = message
  // A message that names a fix must also offer it, otherwise it is a dead end.
  if (fix) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = fix.label
    button.addEventListener('click', () => void fix.run())
    nodes.status.appendChild(button)
  }
}

function renderBadge(node, label, value, extraClass) {
  node.textContent = ''
  node.className = `badge${extraClass ? ` ${extraClass}` : ''}`
  node.append(`${label} `)
  const strong = document.createElement('b')
  strong.textContent = value
  node.appendChild(strong)
}

function render() {
  const settings = currentSettings()
  const payload = state?.status
  const native = payload?.native
  const onScreen = native && native.available ? native.systemTheme : null

  renderBadge(nodes.badgeTheme, 'Windows theme', themeWord(onScreen), onScreen === 'dark' ? 'moon' : onScreen === 'light' ? 'sun' : '')
  const backend = payload?.backend?.backend ?? settings.backend
  renderBadge(nodes.badgeBackend, 'Backend', backend === 'powertoys' ? 'PowerToys' : backend === 'native' ? 'Native' : 'Auto')

  // Countdown and legend are computed locally so a poll is never needed to keep
  // them honest between refreshes.
  const now = new Date()
  const upcoming = nextChange(settings, now)
  if (upcoming.ok) {
    const hours = Math.floor(upcoming.minutesUntil / 60)
    const minutes = upcoming.minutesUntil % 60
    const when = hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`
    nodes.countdown.textContent = ''
    nodes.countdown.append(`${capitalize(themeWord(upcoming.theme))} mode in `)
    const span = document.createElement('span')
    span.textContent = `${when} (at ${formatHHMM(upcoming.at) ?? '--:--'})`
    nodes.countdown.appendChild(span)
    nodes.issue.hidden = true
  } else {
    nodes.countdown.textContent = 'Nothing scheduled'
    nodes.issue.hidden = false
    nodes.issue.textContent = describeScheduleIssue(upcoming.reason)
  }

  nodes.legendDay.textContent = settings.dayStart
  nodes.legendNight.textContent = settings.nightStart

  const applyReady = Boolean(payload) && !busy
  nodes.actLight.disabled = !applyReady
  nodes.actDark.disabled = !applyReady
  nodes.actToggle.disabled = !applyReady
  nodes.save.disabled = !applyReady
  nodes.refresh.disabled = !applyReady
  // Nothing is editable until the real settings have arrived, so an early click
  // can never build a draft out of defaults and save it over the stored values.
  for (const node of Object.values(nodes.inputs)) node.disabled = !applyReady

  const targets = [settings.applySystem ? 'system' : null, settings.applyApps ? 'apps' : null].filter(Boolean)
  nodes.applyNote.textContent = targets.length === 0
    ? 'No target selected, so nothing would change.'
    : `Applies to ${targets.join(' and ')}.`

  nodes.backendReason.textContent = payload?.backend?.reason ?? 'Not probed yet.'

  const ls = payload?.lightSwitch
  nodes.lightSwitchState.textContent = !ls
    ? 'Not probed yet.'
    : !ls.installed
      ? 'Not installed. ND writes the Windows theme directly.'
      : ls.enabled
        ? `Running. Schedule mode: ${ls.scheduleMode ?? 'unknown'}${ls.manualOverride ? ', manual override active' : ''}.`
        : ls.message

  // The PowerToys backend is only offered when it can actually work; otherwise the
  // button stays disabled with the reason inline rather than failing on click.
  const powertoysUsable = Boolean(ls?.enabled)
  nodes.backendPowertoys.disabled = !applyReady || !powertoysUsable
  nodes.backendPowertoys.title = powertoysUsable ? '' : (ls?.message ?? 'PowerToys Light Switch is not available.')
  nodes.backendNative.disabled = !applyReady
  nodes.backendNative.title = payload && payload.backend && payload.backend.nativeAvailable === false
    ? 'The nd-core sidecar cannot change the theme on this machine.'
    : ''
  nodes.backendAuto.disabled = !applyReady

  for (const [key, node] of Object.entries(nodes.inputs)) {
    if (node.type === 'checkbox') node.checked = settings[key] === true
    else node.value = settings[key]
  }
  for (const node of [nodes.backendAuto, nodes.backendNative, nodes.backendPowertoys]) {
    node.classList.toggle('on', node === backendButton(settings.backend))
  }

  drawRing()
}

function backendButton(choice) {
  return choice === 'native' ? nodes.backendNative : choice === 'powertoys' ? nodes.backendPowertoys : nodes.backendAuto
}

/**
 * `busy` gates every control, so it must be rendered whenever it changes.
 * Setting it without a re-render leaves buttons looking clickable while the
 * handlers silently return — a dead control, which is worse than a disabled one.
 */
function setBusy(value) {
  busy = value
  render()
}

// --- host calls --------------------------------------------------------------

async function call(action, payload) {
  const response = await bridge.invoke({ action, ...(payload ?? {}) })
  if (!response.ok) {
    setStatus(describeBridgeFailure(response), 'bad')
    return null
  }
  return response.value
}

async function refreshStatus(silent) {
  if (busy) return
  setBusy(true)
  if (!silent) setStatus('Reading the Windows theme…')
  const status = await call('status')
  setBusy(false)
  if (!status) return
  state = { status }
  // A poll must never clobber what the user is in the middle of typing.
  if (!editing) draft = null
  render()
  if (!silent) setStatus('')
}

async function applyTheme(mode) {
  if (busy) return
  setBusy(true)
  setStatus(mode === 'toggle' ? 'Toggling the Windows theme…' : `Applying ${mode} mode…`)
  const result = await call('apply', { mode })
  setBusy(false)
  if (!result) return
  setStatus(result.message, result.ok ? 'ok' : 'bad', fixFor(result))
  // Re-read so the badge shows what Windows actually stored, not what we asked for.
  await refreshStatus(true)
}

/**
 * Turn a host-reported `actionable` into a real control. Every failure that can be
 * fixed from here gets a button, so the message is never a dead end.
 */
function fixFor(result) {
  const switchToNative = {
    label: 'Switch to the Native backend',
    run: async () => {
      const saved = await call('schedule-save', { settings: { backend: 'native' } })
      if (saved) {
        draft = null
        editing = false
        setStatus('OS Toolkit now writes the Windows theme directly.', 'ok')
        await refreshStatus(true)
      }
    },
  }
  if (result.actionable === 'switch-backend-native' || result.actionable === 'install-powertoys') return switchToNative
  if (result.actionable === 'enable-light-switch') {
    return {
      label: 'Use the Native backend instead',
      run: switchToNative.run,
    }
  }
  return null
}

async function saveSchedule() {
  if (busy) return
  const settings = currentSettings()
  // Validate locally first so a typo is caught without a round trip, using the
  // same rules the host applies.
  const day = parseHHMM(settings.dayStart)
  const night = parseHHMM(settings.nightStart)
  if (day === null || night === null) {
    setStatus(describeScheduleIssue('invalid-time'), 'bad')
    return
  }
  if (day === night) {
    setStatus(describeScheduleIssue('equal-times'), 'bad')
    return
  }
  setBusy(true)
  setStatus('Saving…')
  const saved = await call('schedule-save', { settings })
  setBusy(false)
  if (!saved) {
    render()
    return
  }
  editing = false
  draft = null
  state = { status: { ...(state?.status ?? {}), ...saved } }
  setStatus(
    settings.schedulerEnabled
      ? 'Saved. The schedule runs while ND is open.'
      : 'Saved. The schedule is off, so nothing will change on its own.',
    'ok',
  )
  await refreshStatus(true)
}

// --- input -------------------------------------------------------------------

function beginEdit() {
  if (!editing) draft = resolveOsToolkitSettings(state?.status?.settings)
  editing = true
}

function captureDraft() {
  beginEdit()
  draft = {
    schedulerEnabled: nodes.inputs.schedulerEnabled.checked,
    backend: currentSettings().backend,
    dayStart: nodes.inputs.dayStart.value || currentSettings().dayStart,
    nightStart: nodes.inputs.nightStart.value || currentSettings().nightStart,
    applyApps: nodes.inputs.applyApps.checked,
    applySystem: nodes.inputs.applySystem.checked,
    lightSwitchSync: nodes.inputs.lightSwitchSync.checked,
    startupReconcile: nodes.inputs.startupReconcile.checked,
  }
  render()
}

function chooseBackend(choice) {
  beginEdit()
  draft = { ...currentSettings(), backend: choice }
  render()
}

for (const node of Object.values(nodes.inputs)) {
  node.addEventListener('change', captureDraft)
}
nodes.backendAuto.addEventListener('click', () => chooseBackend('auto'))
nodes.backendNative.addEventListener('click', () => chooseBackend('native'))
nodes.backendPowertoys.addEventListener('click', () => chooseBackend('powertoys'))
nodes.actLight.addEventListener('click', () => void applyTheme('light'))
nodes.actDark.addEventListener('click', () => void applyTheme('dark'))
nodes.actToggle.addEventListener('click', () => void applyTheme('toggle'))
nodes.save.addEventListener('click', () => void saveSchedule())
nodes.refresh.addEventListener('click', () => void refreshStatus(false))

// --- bounded runtime work ----------------------------------------------------

/** Poll only while visible; a hidden frame must cost nothing. */
function syncTimers() {
  if (document.hidden) {
    if (statusTimer) {
      clearInterval(statusTimer)
      statusTimer = null
    }
    if (countdownTimer) {
      clearInterval(countdownTimer)
      countdownTimer = null
    }
    return
  }
  if (!statusTimer) {
    statusTimer = setInterval(() => void refreshStatus(true), STATUS_POLL_MS)
  }
  if (!countdownTimer) {
    // Local-only: recomputes the countdown and the ring hand without a host call.
    countdownTimer = setInterval(() => {
      render()
    }, COUNTDOWN_TICK_MS)
  }
}

document.addEventListener('visibilitychange', () => {
  syncTimers()
  if (!document.hidden) {
    lastRingSignature = ''
    render()
    void refreshStatus(true)
  }
})

if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    lastRingSignature = ''
    drawRing()
  }).observe(nodes.ring)
}

// --- start -------------------------------------------------------------------

render()
syncTimers()
// Every control is bound above, so `ready` is honest: the host unhides the frame
// on it and a click landing now will be handled.
bridge.start()
bridge.whenConnected(() => {
  void refreshStatus(false)
})
