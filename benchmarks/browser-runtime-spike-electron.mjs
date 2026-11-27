import { app, BrowserWindow, WebContentsView, safeStorage, session } from 'electron'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { acquireLocalWorkload, watchTestDriver } from '../scripts/local-workload.mjs'

const output = process.argv[2]
if (!output) throw new Error('output path is required')
acquireLocalWorkload('browser runtime benchmark')
const driver = Number(process.env.ND_DSH_TEST_DRIVER_PID)
if (Number.isSafeInteger(driver) && driver > 0) watchTestDriver(driver, () => app.quit())

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'nd-dsh-browser-runtime-spike-'))
app.setPath('userData', userData)

const failures = []
const observations = []
const temporary = [userData]
const recordFailure = (label, cause) => failures.push({
  label,
  message: cause instanceof Error ? cause.message : String(cause),
})

let window
// Awaiting whenReady at module top level can deadlock an ESM Electron entry, so the probe runs from its callback.
app.whenReady().then(run)

async function run() {
  const server = await startFixtureServer()
  const origin = `http://127.0.0.1:${server.address().port}`
  const partition = 'persist:nd-dsh-browser-runtime-spike'
  const browserSession = session.fromPartition(partition)
  window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })
  const views = []

  try {
    const capabilities = {
      runtime: {
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        safeStorageAvailable: safeStorage.isEncryptionAvailable(),
      },
      session: await probeSession(browserSession, origin),
      extensions: await probeExtensions(browserSession, origin, window),
      tabs: await probeTabs(browserSession, origin, window, views),
      webMcp: await probeWebMcp(browserSession, origin, window),
    }

    const coreBrowserPass = Boolean(
      capabilities.session.cookies
      && capabilities.session.history
      && capabilities.session.storageClear
      && capabilities.session.download,
    )
    const extensionBaselinePass = Boolean(
      capabilities.extensions.mv2?.contentScript
        && capabilities.extensions.mv2?.runtimeMessaging
      || capabilities.extensions.mv3?.contentScript
        && capabilities.extensions.mv3?.runtimeMessaging,
    )
    const multiTabPass = capabilities.tabs.points.every((point) => point.loaded === point.count)

    let decision = 'B-candidate'
    if (!coreBrowserPass || !extensionBaselinePass || !multiTabPass) decision = 'C-candidate'
    else if (capabilities.extensions.mv3?.runtimeMessaging && capabilities.webMcp.documentPresent) decision = 'A-candidate'

    const result = {
      schemaVersion: 1,
      kind: 'nd-builtin-browser-runtime-spike',
      timestamp: new Date().toISOString(),
      status: failures.length ? 'completed-with-probe-errors' : 'pass',
      decision,
      decisionMeaning: {
        'A-candidate': 'Electron satisfied this automated baseline, including the MV3/runtime and WebMCP presence probes. Manual representative-extension and credential UX review is still required.',
        'B-candidate': 'Electron satisfied the core browser baseline and at least one extension execution path, but compatibility breadth remains limited or unproven.',
        'C-candidate': 'Electron failed at least one required baseline; evaluate a different Chromium-grade built-in runtime before continuing.',
      }[decision],
      requirements: {
        coreBrowserPass,
        extensionBaselinePass,
        extensionActionPopupPass: Boolean(
          capabilities.extensions.mv3ActionPopup?.popupLoaded
          && capabilities.extensions.mv3ActionPopup?.runtimeAvailable
          && capabilities.extensions.mv3ActionPopup?.storageAvailable
          && capabilities.extensions.mv3ActionPopup?.tabsQueryAvailable
          && capabilities.extensions.mv3ActionPopup?.tabsReloadAvailable
          && capabilities.extensions.mv3ActionPopup?.activeTabMatchesHost,
        ),
        multiTabPass,
        credentialVaultPrimitiveAvailable: capabilities.runtime.safeStorageAvailable,
        webMcpNavigatorPresent: capabilities.webMcp.documentPresent,
      },
      capabilities,
      observations,
      failures,
    }

    await writeFile(output, JSON.stringify(result, null, 2) + '\n', 'utf8')
  } catch (cause) {
    recordFailure('fatal', cause)
    await writeFile(output, JSON.stringify({
      schemaVersion: 1,
      kind: 'nd-builtin-browser-runtime-spike',
      timestamp: new Date().toISOString(),
      status: 'failed',
      failures,
    }, null, 2) + '\n', 'utf8')
    process.exitCode = 1
  } finally {
    for (const view of views) {
      try {
        window.contentView.removeChildView(view)
        if (!view.webContents.isDestroyed()) view.webContents.close()
      } catch {}
    }
    if (!window.isDestroyed()) window.destroy()
    server.closeAllConnections()
    await new Promise((resolvePromise) => server.close(resolvePromise))
    await Promise.allSettled(temporary.map((path) => rm(path, { recursive: true, force: true })))
    app.quit()
  }
}

async function probeSession(ses, origin) {
  const result = {
    cookies: false,
    storageClear: false,
    history: false,
    download: false,
    details: {},
  }

  try {
    await ses.cookies.set({ url: origin, name: 'nd_spike_cookie', value: 'present' })
    result.cookies = (await ses.cookies.get({ url: origin, name: 'nd_spike_cookie' })).some((cookie) => cookie.value === 'present')
    await ses.clearStorageData({ origin, storages: ['cookies'] })
    result.storageClear = (await ses.cookies.get({ url: origin, name: 'nd_spike_cookie' })).length === 0
  } catch (cause) {
    recordFailure('session.cookies-storage-clear', cause)
  }

  const view = createView(ses, window)
  try {
    await bounded('session.history.a', view.webContents.loadURL(origin + '/history/a'))
    await bounded('session.history.b', view.webContents.loadURL(origin + '/history/b'))
    result.history = view.webContents.navigationHistory.canGoBack()
    result.details.historyEntries = view.webContents.navigationHistory.getAllEntries().map((entry) => entry.url)
  } catch (cause) {
    recordFailure('session.history', cause)
  } finally {
    destroyView(view, window)
  }

  const downloadPath = join(userData, 'runtime-spike-download.txt')
  const downloadView = createView(ses, window)
  try {
    const done = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('download timed out')), 15_000)
      ses.once('will-download', (_event, item) => {
        item.setSavePath(downloadPath)
        item.once('done', (_doneEvent, state) => {
          clearTimeout(timer)
          if (state === 'completed') resolvePromise(state)
          else reject(new Error('download state: ' + state))
        })
      })
    })
    downloadView.webContents.downloadURL(origin + '/download')
    await done
    await access(downloadPath)
    result.download = (await readFile(downloadPath, 'utf8')) === 'nd-browser-runtime-spike\n'
  } catch (cause) {
    recordFailure('session.download', cause)
  } finally {
    destroyView(downloadView, window)
  }

  return result
}

async function probeExtensions(ses, origin, hostWindow) {
  const result = {
    mv2: await loadAndExerciseExtension('mv2', resolve(root, 'tests/fixtures/browser-runtime-spike/extensions/mv2-baseline'), ses, origin, hostWindow),
    mv3: await loadAndExerciseExtension('mv3', resolve(root, 'tests/fixtures/browser-runtime-spike/extensions/mv3-service-worker'), ses, origin, hostWindow),
    mv3ActionPopup: await loadAndExerciseActionPopup(
      resolve(root, 'tests/fixtures/browser-runtime-spike/extensions/mv3-action-popup'),
      ses,
      origin,
      hostWindow,
    ),
  }
  result.loadedExtensionsAfterCleanup = ses.extensions.getAllExtensions().map((extension) => ({
    id: extension.id,
    name: extension.name,
    version: extension.version,
  }))
  return result
}

async function loadAndExerciseExtension(label, extensionPath, ses, origin, hostWindow) {
  const result = {
    loaded: false,
    id: null,
    manifestVersion: label === 'mv2' ? 2 : 3,
    contentScript: false,
    runtimeMessaging: false,
    removed: false,
    loadMs: null,
    error: null,
  }
  let extension
  try {
    const started = performance.now()
    extension = await bounded('extension.' + label + '.load', ses.extensions.loadExtension(extensionPath, { allowFileAccess: false }))
    result.loadMs = performance.now() - started
    result.loaded = true
    result.id = extension.id

    const view = createView(ses, hostWindow)
    try {
      await bounded('extension.' + label + '.page', view.webContents.loadURL(origin + '/extension/' + label))
      await wait(500)
      const dataset = await bounded('extension.' + label + '.inspect', view.webContents.executeJavaScript(`({
        content: document.documentElement.dataset.ndSpike${label === 'mv2' ? 'Mv2' : 'Mv3'}Content || '',
        runtime: document.documentElement.dataset.ndSpike${label === 'mv2' ? 'Mv2' : 'Mv3'}Runtime || ''
      })`))
      result.contentScript = dataset.content === 'ok'
      result.runtimeMessaging = dataset.runtime === 'ok'
    } finally {
      destroyView(view, hostWindow)
    }
  } catch (cause) {
    result.error = cause instanceof Error ? cause.message : String(cause)
    observations.push({ label: 'extension-' + label, outcome: 'unsupported-or-failed', detail: result.error })
  } finally {
    if (extension?.id) {
      try {
        ses.extensions.removeExtension(extension.id)
        result.removed = !ses.extensions.getAllExtensions().some((item) => item.id === extension.id)
      } catch (cause) {
        recordFailure('extension.' + label + '.remove', cause)
      }
    }
  }
  return result
}

async function loadAndExerciseActionPopup(extensionPath, ses, origin, hostWindow) {
  const result = {
    loaded: false,
    popupLoaded: false,
    runtimeAvailable: false,
    storageAvailable: false,
    tabsQueryAvailable: false,
    tabsReloadAvailable: false,
    activeTabMatchesHost: false,
    activeTabUrl: '',
    removed: false,
    id: null,
    error: null,
  }
  let extension
  try {
    extension = await bounded('extension.popup.load', ses.extensions.loadExtension(extensionPath, { allowFileAccess: false }))
    result.loaded = true
    result.id = extension.id
    const hostView = createView(ses, hostWindow)
    const view = createView(ses, hostWindow)
    try {
      await bounded('extension.popup.host', hostView.webContents.loadURL(origin + '/extension/popup-host'))
      hostView.setVisible(true)
      hostView.webContents.focus()
      await wait(50)

      await bounded('extension.popup.page', view.webContents.loadURL(`chrome-extension://${extension.id}/popup.html`))
      view.setVisible(true)
      view.webContents.focus()
      await wait(250)
      const state = await bounded('extension.popup.inspect', view.webContents.executeJavaScript(`({
        runtime: document.documentElement.dataset.ndPopupRuntime || '',
        storage: document.documentElement.dataset.ndPopupStorage || '',
        tabs: document.documentElement.dataset.ndPopupTabs || '',
        tabsReload: document.documentElement.dataset.ndPopupTabsReload || '',
        activeTabUrl: document.documentElement.dataset.ndPopupActiveTabUrl || '',
        status: document.getElementById('status')?.textContent || ''
      })`))
      result.popupLoaded = state.status === 'ready'
      result.runtimeAvailable = state.runtime === 'ok'
      result.storageAvailable = state.storage === 'ok'
      result.tabsQueryAvailable = state.tabs === 'ok'
      result.tabsReloadAvailable = state.tabsReload === 'ok'
      result.activeTabUrl = state.activeTabUrl
      result.activeTabMatchesHost = typeof state.activeTabUrl === 'string' && state.activeTabUrl.startsWith(origin)
    } finally {
      destroyView(view, hostWindow)
      destroyView(hostView, hostWindow)
    }
  } catch (cause) {
    result.error = cause instanceof Error ? cause.message : String(cause)
    observations.push({ label: 'extension-mv3-action-popup', outcome: 'unsupported-or-failed', detail: result.error })
  } finally {
    if (extension?.id) {
      try {
        ses.extensions.removeExtension(extension.id)
        result.removed = !ses.extensions.getAllExtensions().some((item) => item.id === extension.id)
      } catch (cause) {
        recordFailure('extension.mv3-action-popup.remove', cause)
      }
    }
  }
  return result
}

async function probeTabs(ses, origin, hostWindow, retainedViews) {
  const points = []
  for (const count of [1, 2, 4, 8]) {
    while (retainedViews.length < count) {
      const view = createView(ses, hostWindow)
      retainedViews.push(view)
      await bounded('tabs.load', view.webContents.loadURL(origin + '/tab/' + retainedViews.length))
    }
    await wait(150)
    const metrics = app.getAppMetrics()
    const renderers = metrics.filter((item) => item.type === 'Tab' || item.type === 'Utility' || item.type === 'Other')
    points.push({
      count,
      loaded: retainedViews.slice(0, count).filter((view) => !view.webContents.isDestroyed() && view.webContents.getURL().startsWith(origin)).length,
      electronProcessCount: metrics.length,
      rendererLikeProcessCount: renderers.length,
      workingSetKiB: sumFinite(metrics.map((item) => item.memory?.workingSetSize)),
      privateBytesKiB: sumFinite(metrics.map((item) => item.memory?.privateBytes)),
    })
  }
  return { points }
}

async function probeWebMcp(ses, origin, hostWindow) {
  const view = createView(ses, hostWindow)
  try {
    await bounded('webmcp.page', view.webContents.loadURL(origin + '/webmcp'))
    const state = await bounded('webmcp.inspect', view.webContents.executeJavaScript(`({
      documentPresent: 'modelContext' in document,
      type: typeof document.modelContext
    })`))
    return {
      documentPresent: state.documentPresent === true,
      type: state.type,
      note: state.documentPresent
        ? 'A WebMCP-like document surface is visible in the current Chromium runtime; protocol behavior still needs a fixture/manual validation.'
        : 'No WebMCP document surface is enabled by default in this runtime. Treat WebMCP as capability-gated/experimental until task 0027 validates the chosen runtime path.',
    }
  } catch (cause) {
    recordFailure('webmcp.presence', cause)
    return { documentPresent: false, type: 'unknown', error: cause instanceof Error ? cause.message : String(cause) }
  } finally {
    destroyView(view, hostWindow)
  }
}

function createView(ses, hostWindow) {
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })
  view.setBounds({ x: 0, y: 0, width: 640, height: 480 })
  view.setVisible(false)
  hostWindow.contentView.addChildView(view)
  return view
}

function destroyView(view, hostWindow) {
  try { hostWindow.contentView.removeChildView(view) } catch {}
  if (!view.webContents.isDestroyed()) view.webContents.close()
}

function sumFinite(values) {
  const finite = values.filter(Number.isFinite)
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) : null
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

// Every page/extension step is bounded so a stuck probe fails by name instead of hanging the release gate.
function bounded(label, promise, ms = 15_000) {
  let timer
  const timeout = new Promise((_resolvePromise, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + ' ms')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function startFixtureServer() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      if (url.pathname === '/download') {
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="runtime-spike-download.txt"',
        })
        response.end('nd-browser-runtime-spike\n')
        return
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>ND Browser Runtime Spike</title></head>
<body>
  <h1>ND Browser Runtime Spike</h1>
  <button id="action">Action</button>
  <input aria-label="Fixture input">
  <p id="path">${escapeHtml(url.pathname)}</p>
</body>
</html>`)
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise(server))
  })
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[character]))
}
