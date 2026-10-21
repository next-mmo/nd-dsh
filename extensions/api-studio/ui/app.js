import { createBridge } from './bridge.js'
import {
  HTTP_METHODS,
  activeEnvironment,
  appendHistory,
  formatBytes,
  formatTime,
  groupOperations,
  historyEntry,
  importPostman,
  isCurlCommand,
  newEnvironment,
  newRequest,
  normalizeCollection,
  normalizeRequest,
  normalizeSpec,
  normalizeWorkspace,
  operationRequest,
  parseCurl,
  parseSpecDocument,
  prepareRequest,
  prettyJson,
  resolveTemplate,
  schemaExample,
  statusClass,
  toCurl,
  uid,
  variableMap,
} from './core.js'

const bridge = createBridge()

const state = {
  ready: false,
  workspace: normalizeWorkspace({}),
  storageEncrypted: null,
  specs: [],
  specCache: new Map(),
  specLoading: new Set(),
  specErrors: new Map(),
  view: 'collections',
  tabs: [],
  activeKey: null,
  editorTab: 'params',
  responseTab: 'body',
  response: null,
  sending: false,
  collapsedResponse: false,
  requestShare: 40,
  docSpecId: null,
  docOperationId: null,
  saveState: 'idle',
  saveTimer: null,
}

const toastEl = document.getElementById('toast')
const mainEl = document.getElementById('main')
const sidebarEl = document.getElementById('sidebar')
const envSelect = document.getElementById('env-select')
const storageChip = document.getElementById('storage-chip')
const saveStateEl = document.getElementById('save-state')
const modalEl = document.getElementById('modal')
let modalClose = null
let modalCancel = null

/* --- DOM helpers ------------------------------------------------------------ */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler)
    } else if (key === 'value') node.value = value
    else if (value === true) node.setAttribute(key, '')
    else node.setAttribute(key, String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function button(text, options = {}, onClick) {
  return el('button', {
    type: 'button',
    class: options.class ?? 'btn',
    title: options.title,
    text,
    on: onClick ? { click: onClick } : undefined,
  })
}

function methodBadge(method) {
  return el('span', { class: `method m-${method}`, text: method })
}

function cloneRequest(request) {
  return normalizeRequest(JSON.parse(JSON.stringify(request)))
}

function showToast(message, kind = 'info') {
  toastEl.textContent = message
  toastEl.className = `toast show${kind === 'error' ? ' error' : ''}`
  clearTimeout(showToast.timer)
  showToast.timer = setTimeout(() => { toastEl.className = 'toast' }, kind === 'error' ? 5200 : 2600)
}

function setSaveState(value) {
  state.saveState = value
  saveStateEl.className = `save-state ${value === 'saving' ? 'saving' : value === 'error' ? 'error' : ''}`
  saveStateEl.textContent = value === 'saving' ? 'Saving…' : value === 'error' ? 'Save failed' : value === 'saved' ? 'Saved' : ''
}

function renderStorageChip() {
  if (state.storageEncrypted === null) {
    storageChip.textContent = ''
    storageChip.className = 'chip hidden'
    return
  }
  storageChip.className = `chip${state.storageEncrypted ? '' : ' warn'}`
  storageChip.textContent = state.storageEncrypted ? 'Encrypted' : 'Unencrypted'
  storageChip.title = state.storageEncrypted
    ? 'The workspace is encrypted at rest with the OS keychain.'
    : 'This platform did not expose OS encryption; the workspace file is protected by file permissions only.'
}

function headerValue(headers, name) {
  return (headers ?? []).find((header) => header.name.toLowerCase() === name)?.value ?? ''
}

/* --- bridge + persistence --------------------------------------------------- */

async function call(action, payload = {}, timeoutMs = 15_000) {
  const result = await bridge.invoke({ action, ...payload }, timeoutMs)
  if (!result.ok) throw new Error(result.error?.message ?? 'ND could not run this action')
  return result.value
}

function scheduleSave() {
  if (!state.ready) return
  setSaveState('saving')
  clearTimeout(state.saveTimer)
  state.saveTimer = setTimeout(() => { void persistNow() }, 900)
}

let persistChain = Promise.resolve()

async function persistNow() {
  clearTimeout(state.saveTimer)
  state.saveTimer = null
  if (!state.ready) return
  // Capture the state when the save is requested, then run saves one at a
  // time so an older snapshot can never finish after a newer one.
  const serialized = JSON.stringify(state.workspace)
  const saveId = uid('save')
  const run = async () => {
    // The bridge drops messages over 262 KB, so the workspace crosses it in
    // chunks and the host reassembles and validates the payload.
    const chunkSize = 180_000
    let offset = 0
    let result = null
    for (;;) {
      const chunk = serialized.slice(offset, offset + chunkSize)
      const final = offset + chunk.length >= serialized.length
      result = await call('workspace-save', { saveId, chunk, offset, final })
      offset += chunk.length
      if (final) break
    }
    state.storageEncrypted = result?.encrypted === true
    setSaveState('saved')
    renderStorageChip()
  }
  const task = persistChain.catch(() => undefined).then(run)
  persistChain = task
  try {
    await task
  } catch (error) {
    setSaveState('error')
    showToast(`Workspace save failed: ${error.message}`, 'error')
  }
}

async function readWorkspace() {
  let offset = 0
  let text = ''
  let encrypted = null
  let warning = null
  for (;;) {
    const part = await call('workspace-read', { offset })
    text += part.chunk
    if (typeof part.encrypted === 'boolean') encrypted = part.encrypted
    if (part.warning) warning = part.warning
    if (part.done) break
    offset = part.nextOffset
  }
  return { workspace: JSON.parse(text), encrypted, warning }
}

/* --- modal ------------------------------------------------------------------ */

function mountModal(card, onCancel = null) {
  modalEl.replaceChildren(card)
  modalEl.hidden = false
  const close = () => {
    const cancel = modalCancel
    modalCancel = null
    modalClose = null
    modalEl.hidden = true
    modalEl.replaceChildren()
    modalEl.onclick = null
    cancel?.()
  }
  modalCancel = onCancel
  modalClose = close
  modalEl.onclick = (event) => { if (event.target === modalEl) close() }
}

function closeModal() {
  modalClose?.()
}

function promptText({ title, label, value = '', placeholder = '', confirmLabel = 'Save' }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      closeModal()
      resolve(result)
    }
    const error = el('div', { class: 'modal-error' })
    const input = el('input', {
      class: 'field',
      value,
      placeholder,
      on: {
        keydown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        },
      },
    })
    const submit = () => {
      const text = input.value.trim()
      if (!text) {
        error.textContent = 'Enter a value.'
        return
      }
      finish(text)
    }
    const card = el('div', { class: 'modal-card' },
      el('h3', {}, title),
      el('div', { class: 'field-row' }, el('span', { class: 'field-label', text: label }), input),
      error,
      el('div', { class: 'modal-actions' },
        button('Cancel', {}, () => finish(null)),
        button(confirmLabel, { class: 'btn primary' }, submit)))
    mountModal(card, () => finish(null))
    input.focus()
    input.select()
  })
}

function confirmAction({ title, message, confirmLabel = 'Delete' }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      closeModal()
      resolve(result)
    }
    const card = el('div', { class: 'modal-card' },
      el('h3', {}, title),
      el('div', { class: 'doc-text', text: message }),
      el('div', { class: 'modal-actions' },
        button('Cancel', {}, () => finish(false)),
        button(confirmLabel, { class: 'btn primary danger' }, () => finish(true))))
    mountModal(card, () => finish(false))
  })
}

/* --- state helpers ---------------------------------------------------------- */

function activeTab() {
  return state.tabs.find((tab) => tab.key === state.activeKey) ?? null
}

function markDirty(tab) {
  if (!tab || tab.dirty) return
  tab.dirty = true
  const node = document.querySelector(`[data-tab-key="${CSS.escape(tab.key)}"] .tab-dirty`)
  if (node) node.textContent = '•'
}

function isBlankRequest(request) {
  return !request.url.trim()
    && request.method === 'GET'
    && request.params.length === 0
    && request.pathVars.length === 0
    && request.headers.length === 0
    && request.body.mode === 'none'
    && request.auth.type === 'none'
}

function applyCurlPaste(tab, text) {
  let request
  try {
    request = parseCurl(text)
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error')
    return
  }
  if (!tab || !isBlankRequest(tab.request)) {
    newRequestTab(request)
    showToast('Pasted cURL opened as a new request')
    return
  }
  request.id = tab.key
  if (tab.request.name !== 'Untitled request') request.name = tab.request.name
  tab.request = request
  markDirty(tab)
  state.response = null
  state.editorTab = 'params'
  renderAll()
  showToast('Pasted cURL request')
}

function openSavedRequest(collection, request) {
  const tab = state.tabs.find((item) => item.key === request.id)
  if (tab) {
    tab.request = cloneRequest(request)
    tab.collectionId = collection.id
    tab.dirty = false
    state.activeKey = tab.key
  } else {
    state.tabs.push({ key: request.id, request: cloneRequest(request), collectionId: collection.id, dirty: false })
    state.activeKey = request.id
  }
  state.editorTab = 'params'
  state.response = null
  state.responseTab = 'body'
  setView('collections', false)
  renderAll()
}

function newRequestTab(seed = null) {
  const request = seed ? normalizeRequest({ ...seed, id: uid('req') }) : newRequest()
  state.tabs.push({ key: request.id, request, collectionId: null, dirty: Boolean(seed) })
  state.activeKey = request.id
  state.editorTab = 'params'
  state.response = null
  state.responseTab = 'body'
  setView('collections', false)
  renderAll()
  mainEl.querySelector('.url-input')?.focus()
}

async function closeTab(tab) {
  if (tab.dirty) {
    const confirmed = await confirmAction({
      title: 'Discard unsaved changes?',
      message: `“${tab.request.name}” has edits that were never saved to a collection.`,
      confirmLabel: 'Discard',
    })
    if (!confirmed) return
  }
  const index = state.tabs.findIndex((item) => item.key === tab.key)
  state.tabs = state.tabs.filter((item) => item.key !== tab.key)
  if (state.activeKey === tab.key) {
    state.activeKey = state.tabs[Math.max(0, index - 1)]?.key ?? state.tabs[0]?.key ?? null
  }
  renderAll()
}

function setView(view, render = true) {
  state.view = view
  if (view === 'docs' && !state.docSpecId && state.specs[0]) {
    state.docSpecId = state.specs[0].id
    void ensureSpecLoaded(state.docSpecId)
  }
  if (render) renderAll()
}

/* --- boot ------------------------------------------------------------------- */

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => setView(item.dataset.view))
})

document.getElementById('import-button').addEventListener('click', openImportModal)

envSelect.addEventListener('change', () => {
  state.workspace.activeEnvironmentId = envSelect.value || null
  scheduleSave()
  renderAll()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modalEl.hidden) {
    closeModal()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    const tab = activeTab()
    if (tab && state.view === 'collections') {
      event.preventDefault()
      void sendActive()
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    const tab = activeTab()
    if (tab && state.view === 'collections') {
      event.preventDefault()
      void saveRequest(tab)
    }
  }
})

document.addEventListener('paste', (event) => {
  if (!state.ready || !modalEl.hidden || state.view !== 'collections') return
  // Field-level paste is handled by the field so text is not hijacked.
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (!isCurlCommand(text)) return
  event.preventDefault()
  applyCurlPaste(activeTab(), text)
})

bridge.whenConnected(() => { void boot() })
bridge.start()

async function boot() {
  try {
    const [snapshot, specList] = await Promise.all([
      readWorkspace(),
      call('spec-list'),
    ])
    state.workspace = normalizeWorkspace(snapshot.workspace)
    state.storageEncrypted = snapshot.encrypted === true
    state.specs = Array.isArray(specList.specs) ? specList.specs : []
    state.ready = true
    document.getElementById('boot')?.remove()
    if (snapshot.warning) showToast(snapshot.warning, 'error')
    renderAll()
    const first = state.workspace.collections[0]?.requests[0]
    if (first) openSavedRequest(state.workspace.collections[0], first)
  } catch (error) {
    const boot = document.getElementById('boot')
    if (boot) {
      boot.replaceChildren(el('div', { class: 'empty' },
        el('strong', {}, 'API Studio could not start'),
        el('div', { class: 'doc-text', text: error.message }),
        button('Retry', { class: 'btn primary' }, () => location.reload())))
    }
  }
}

/* --- render ----------------------------------------------------------------- */

function renderAll() {
  if (!state.ready) return
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.view === state.view)
  })
  renderEnvSelect()
  renderStorageChip()
  setSaveState(state.saveState)
  renderSidebar()
  renderMain()
}

function renderEnvSelect() {
  envSelect.replaceChildren(
    el('option', { value: '', text: 'No environment' }),
    ...state.workspace.environments.map((environment) =>
      el('option', { value: environment.id, text: environment.name })),
  )
  envSelect.value = state.workspace.activeEnvironmentId ?? ''
}

function renderSidebar() {
  sidebarEl.replaceChildren()
  if (state.view === 'collections') renderCollectionsSidebar()
  else if (state.view === 'docs') renderDocsSidebar()
  else if (state.view === 'environments') renderEnvironmentsSidebar()
  else renderHistorySidebar()
}

function renderMain() {
  const existingBoot = mainEl.querySelector('.boot')
  mainEl.replaceChildren()
  if (existingBoot) mainEl.append(existingBoot)
  if (state.view === 'collections') renderCollectionsMain()
  else if (state.view === 'docs') renderDocsMain()
  else if (state.view === 'environments') renderEnvironmentsMain()
  else renderHistoryMain()
}

/* --- collections ------------------------------------------------------------ */

function renderCollectionsSidebar() {
  const head = el('div', { class: 'sidebar-head' },
    el('span', { class: 'sidebar-title', text: 'Collections' }),
    el('div', { class: 'sidebar-actions' },
      el('button', { type: 'button', class: 'icon-btn', title: 'New request', text: '+', on: { click: () => newRequestTab() } }),
      el('button', { type: 'button', class: 'icon-btn', title: 'New collection', text: '▤', on: { click: createCollection } })))
  sidebarEl.append(head)

  if (state.workspace.collections.length === 0) {
    sidebarEl.append(el('div', { class: 'sidebar-empty' },
      'Save a request into a collection to keep it. ',
      el('a', { href: '#', text: 'Import a spec', on: { click: (event) => { event.preventDefault(); openImportModal() } } }), ' to start from docs.'))
    return
  }

  for (const collection of state.workspace.collections) {
    const group = el('div', { class: 'sidebar-group' })
    group.append(el('div', { class: 'sidebar-group-head' },
      el('span', { class: 'grow', text: collection.name }),
      el('button', { type: 'button', class: 'icon-btn', title: 'Rename collection', text: '✎', on: { click: () => renameCollection(collection) } }),
      el('button', { type: 'button', class: 'icon-btn danger', title: 'Delete collection', text: '×', on: { click: () => deleteCollection(collection) } })))
    const section = el('div', { class: 'sidebar-section' })
    if (collection.requests.length === 0) {
      section.append(el('div', { class: 'sidebar-empty', text: 'No requests yet.' }))
    }
    collection.requests.forEach((request, index) => {
      const active = state.activeKey === request.id && state.view === 'collections'
      const item = el('button', {
        type: 'button',
        class: `tree-item${active ? ' active' : ''}`,
        on: { click: () => openSavedRequest(collection, request) },
      },
      methodBadge(request.method),
      el('span', { class: 'label', text: request.name, title: `${request.method} ${request.url}` }),
      el('span', { class: 'tree-actions' },
        el('span', { class: 'icon-btn', title: 'Move up', text: '↑', on: { click: (event) => { event.stopPropagation(); moveRequest(collection, index, -1) } } }),
        el('span', { class: 'icon-btn', title: 'Move down', text: '↓', on: { click: (event) => { event.stopPropagation(); moveRequest(collection, index, 1) } } }),
        el('span', { class: 'icon-btn', title: 'Rename request', text: '✎', on: { click: (event) => { event.stopPropagation(); void renameRequest(collection, request) } } }),
        el('span', { class: 'icon-btn danger', title: 'Delete request', text: '×', on: { click: (event) => { event.stopPropagation(); void deleteRequest(collection, request) } } })))
      section.append(item)
    })
    group.append(section)
    sidebarEl.append(group)
  }
}

async function createCollection() {
  const name = await promptText({ title: 'New collection', label: 'Collection name', placeholder: 'User Service', confirmLabel: 'Create' })
  if (!name) return
  const collection = normalizeCollection({ name })
  state.workspace.collections.push(collection)
  scheduleSave()
  renderAll()
}

async function renameCollection(collection) {
  const name = await promptText({ title: 'Rename collection', label: 'Collection name', value: collection.name })
  if (!name) return
  collection.name = name
  scheduleSave()
  renderAll()
}

async function deleteCollection(collection) {
  const confirmed = await confirmAction({
    title: 'Delete collection?',
    message: `“${collection.name}” and its ${collection.requests.length} saved request(s) will be removed from the workspace.`,
  })
  if (!confirmed) return
  state.workspace.collections = state.workspace.collections.filter((item) => item.id !== collection.id)
  for (const tab of state.tabs) {
    if (tab.collectionId === collection.id) {
      tab.collectionId = null
      tab.dirty = true
    }
  }
  scheduleSave()
  renderAll()
}

async function renameRequest(collection, request) {
  const name = await promptText({ title: 'Rename request', label: 'Request name', value: request.name })
  if (!name) return
  request.name = name
  const tab = state.tabs.find((item) => item.key === request.id)
  if (tab) tab.request.name = name
  scheduleSave()
  renderAll()
}

async function deleteRequest(collection, request) {
  const confirmed = await confirmAction({
    title: 'Delete request?',
    message: `“${request.name}” will be removed from “${collection.name}”.`,
  })
  if (!confirmed) return
  collection.requests = collection.requests.filter((item) => item.id !== request.id)
  for (const tab of state.tabs) {
    if (tab.key === request.id) {
      tab.collectionId = null
      tab.dirty = true
    }
  }
  scheduleSave()
  renderAll()
}

function moveRequest(collection, index, delta) {
  const target = index + delta
  if (target < 0 || target >= collection.requests.length) return
  const [request] = collection.requests.splice(index, 1)
  collection.requests.splice(target, 0, request)
  scheduleSave()
  renderAll()
}

function renderCollectionsMain() {
  const tab = activeTab()
  if (!tab) {
    mainEl.append(el('div', { class: 'empty' },
      el('strong', {}, 'No request open'),
      el('div', {}, 'Paste a cURL command here, start a request, import an OpenAPI spec, or open a saved request.'),
      el('div', { class: 'row' },
        button('New request', { class: 'btn primary' }, () => newRequestTab()),
        button('Import', {}, openImportModal))))
    return
  }
  mainEl.append(renderTabstrip(), renderEditorShell(tab))
}

function renderTabstrip() {
  const strip = el('div', { class: 'tabstrip' })
  for (const tab of state.tabs) {
    const active = tab.key === state.activeKey
    const item = el('button', {
      type: 'button',
      class: `tab${active ? ' active' : ''}`,
      dataset: { tabKey: tab.key },
      title: `${tab.request.method} ${tab.request.url}`,
      on: { click: () => { state.activeKey = tab.key; renderAll() } },
    },
    methodBadge(tab.request.method),
    el('span', { class: 'tab-label', text: tab.request.name }),
    el('span', { class: 'tab-dirty', text: tab.dirty ? '•' : '' }),
    el('span', {
      class: 'icon-btn',
      title: 'Close tab',
      text: '×',
      on: { click: (event) => { event.stopPropagation(); void closeTab(tab) } },
    }))
    strip.append(item)
  }
  strip.append(el('button', {
    type: 'button',
    class: 'icon-btn',
    title: 'New request',
    text: '+',
    on: { click: () => newRequestTab() },
  }))
  return strip
}

function renderEditorShell(tab) {
  const shell = el('div', { class: `editor-shell${state.collapsedResponse ? ' response-collapsed' : ''}` })
  shell.style.setProperty('--request-share', `${state.requestShare}%`)
  shell.append(renderRequestPane(tab), renderPaneSplitter(shell), renderResponsePane(tab))
  return shell
}

const MIN_REQUEST_SHARE = 15
const MAX_REQUEST_SHARE = 85

function renderPaneSplitter(shell) {
  const handle = el('div', {
    class: 'pane-splitter',
    role: 'separator',
    'aria-orientation': 'horizontal',
    'aria-label': 'Resize request and response panels',
    'aria-valuemin': String(MIN_REQUEST_SHARE),
    'aria-valuemax': String(MAX_REQUEST_SHARE),
    'aria-valuenow': String(Math.round(state.requestShare)),
    tabindex: '0',
    title: 'Drag to resize; double-click for 60% response',
  })

  const apply = (share) => {
    state.requestShare = Math.min(MAX_REQUEST_SHARE, Math.max(MIN_REQUEST_SHARE, share))
    shell.style.setProperty('--request-share', `${state.requestShare}%`)
    handle.setAttribute('aria-valuenow', String(Math.round(state.requestShare)))
  }

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || state.collapsedResponse) return
    event.preventDefault()
    handle.setPointerCapture(event.pointerId)
    handle.classList.add('dragging')
    document.body.classList.add('resizing-rows')
    const rect = shell.getBoundingClientRect()
    const move = (moveEvent) => {
      if (rect.height > 0) apply(((moveEvent.clientY - rect.top) / rect.height) * 100)
    }
    const finish = () => {
      handle.classList.remove('dragging')
      document.body.classList.remove('resizing-rows')
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', finish)
      handle.removeEventListener('pointercancel', finish)
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)
  })

  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    apply(state.requestShare + (event.key === 'ArrowDown' ? 4 : -4))
  })
  handle.addEventListener('dblclick', () => apply(40))
  return handle
}

function renderRequestPane(tab) {
  const request = tab.request
  const pane = el('div', { class: 'request-pane' })

  const methodSelect = el('select', {
    class: 'method-select',
    on: {
      change: (event) => {
        request.method = event.target.value
        markDirty(tab)
        renderAll()
      },
    },
  }, ...HTTP_METHODS.map((method) => el('option', { value: method, text: method })))
  methodSelect.value = request.method

  const urlInput = el('input', {
    class: 'url-input',
    placeholder: '{{baseUrl}}/api/users',
    title: 'Paste a cURL command to fill the request',
    value: request.url,
    spellcheck: 'false',
    on: {
      input: (event) => { request.url = event.target.value; markDirty(tab) },
      paste: (event) => {
        const text = event.clipboardData?.getData('text/plain') ?? ''
        if (!isCurlCommand(text)) return
        event.preventDefault()
        applyCurlPaste(tab, text)
      },
    },
  })

  const send = el('button', {
    type: 'button',
    class: 'btn primary send-btn',
    text: state.sending ? 'Sending…' : 'Send',
    disabled: state.sending,
    on: { click: () => void sendActive() },
  })

  const tabs = [
    ['params', 'Params', request.params.length],
    ['path', 'Path', request.pathVars.length],
    ['headers', 'Headers', request.headers.length],
    ['body', 'Body', request.body.mode === 'none' ? 0 : 1],
    ['auth', 'Auth', request.auth.type === 'none' ? 0 : 1],
  ]

  const editorTabs = el('div', { class: 'editor-tabs' },
    ...tabs.map(([id, label, count]) => el('button', {
      type: 'button',
      class: `editor-tab${state.editorTab === id ? ' active' : ''}`,
      on: { click: () => { state.editorTab = id; renderAll() } },
    }, label, count ? el('span', { class: 'count', text: String(count) }) : null)),
    el('span', { class: 'spacer' }),
    el('button', {
      type: 'button',
      class: 'btn small',
      text: tab.collectionId ? 'Save' : 'Save to…',
      title: 'Save this request into a collection (Ctrl/Cmd+S)',
      on: { click: () => void saveRequest(tab) },
    }),
    el('button', {
      type: 'button',
      class: 'btn small ghost',
      text: 'cURL',
      title: 'Copy as cURL',
      on: { click: () => void copyAsCurl(tab) },
    }))

  pane.append(
    el('div', { class: 'urlbar' }, methodSelect, urlInput, send),
    editorTabs,
    renderEditorBody(tab),
  )
  return pane
}

function renderEditorBody(tab) {
  const body = el('div', { class: 'editor-body' })
  const request = tab.request
  if (state.editorTab === 'params') renderParams(body, tab)
  else if (state.editorTab === 'path') renderPathVars(body, tab)
  else if (state.editorTab === 'headers') renderHeaders(body, tab)
  else if (state.editorTab === 'body') renderBodyEditor(body, tab)
  else renderAuthEditor(body, tab)
  return body
}

function kvEditor(rows, tab, options = {}) {
  const container = el('div', { class: 'kv-table' })
  if (!rows.length) container.append(el('div', { class: 'response-empty', text: options.empty ?? 'No entries.' }))
  rows.forEach((row, index) => {
    const enabled = el('input', {
      type: 'checkbox',
      checked: row.enabled,
      on: {
        change: (event) => {
          row.enabled = event.target.checked
          rowNode.classList.toggle('disabled', !row.enabled)
          markDirty(tab)
        },
      },
    })
    const key = el('input', {
      class: 'kv-input',
      value: row.key,
      placeholder: options.keyPlaceholder ?? 'key',
      spellcheck: 'false',
      on: { input: (event) => { row.key = event.target.value; markDirty(tab) } },
    })
    const value = el('input', {
      class: 'kv-input value',
      value: row.value,
      placeholder: options.valuePlaceholder ?? 'value',
      spellcheck: 'false',
      on: { input: (event) => { row.value = event.target.value; markDirty(tab) } },
    })
    const rowNode = el('div', { class: `kv-row${row.enabled ? '' : ' disabled'}` },
      enabled, key, value,
      el('button', {
        type: 'button',
        class: 'icon-btn danger',
        title: 'Remove row',
        text: '×',
        on: {
          click: () => {
            rows.splice(index, 1)
            markDirty(tab)
            renderAll()
          },
        },
      }))
    container.append(rowNode)
  })
  container.append(el('div', { class: 'editor-toolbar' },
    button(options.addLabel ?? 'Add row', { class: 'btn small' }, () => {
      rows.push({ id: uid('row'), key: '', value: '', enabled: true })
      markDirty(tab)
      renderAll()
    })))
  return container
}

function renderParams(body, tab) {
  const request = tab.request
  body.append(
    el('div', { class: 'editor-toolbar' },
      el('span', { text: 'Query parameters are appended to the URL. Values support {{variables}}.' })),
    kvEditor(request.params, tab, { keyPlaceholder: 'limit', valuePlaceholder: '10', addLabel: 'Add parameter' }))
}

function renderPathVars(body, tab) {
  const request = tab.request
  body.append(
    el('div', { class: 'editor-toolbar' },
      el('span', { text: 'Path variables replace {name} segments in the URL.' }),
      el('span', { class: 'spacer' }),
      button('Detect from URL', { class: 'btn small' }, () => {
        const names = [...request.url.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map((match) => match[1])
        for (const name of names) {
          if (!request.pathVars.some((row) => row.key === name)) {
            request.pathVars.push({ id: uid('pv'), key: name, value: '', enabled: true })
          }
        }
        markDirty(tab)
        renderAll()
      })),
    kvEditor(request.pathVars, tab, { keyPlaceholder: 'id', valuePlaceholder: '123', addLabel: 'Add path variable' }))
}

function renderHeaders(body, tab) {
  const request = tab.request
  body.append(
    el('div', { class: 'editor-toolbar' },
      el('span', { text: 'Authorization and Content-Type are added from the Auth and Body tabs when missing.' })),
    kvEditor(request.headers, tab, { keyPlaceholder: 'Accept', valuePlaceholder: 'application/json', addLabel: 'Add header' }))
}

function renderBodyEditor(body, tab) {
  const request = tab.request
  const modes = ['none', 'json', 'text', 'form', 'multipart']
  body.append(el('div', { class: 'editor-toolbar' },
    el('span', { text: 'Body mode' }),
    el('div', { class: 'segmented' }, ...modes.map((mode) => el('button', {
      type: 'button',
      class: request.body.mode === mode ? 'active' : '',
      text: mode === 'none' ? 'None' : mode,
      on: {
        click: () => {
          request.body.mode = mode
          markDirty(tab)
          renderAll()
        },
      },
    }))),
    el('span', { class: 'spacer' }),
    request.body.mode === 'json'
      ? button('Format JSON', { class: 'btn small' }, () => {
        try {
          request.body.text = JSON.stringify(JSON.parse(request.body.text || '{}'), null, 2)
          markDirty(tab)
          renderAll()
        } catch (error) {
          showToast(`Body is not valid JSON: ${error.message}`, 'error')
        }
      })
      : null))

  if (request.body.mode === 'none') {
    body.append(el('div', { class: 'response-empty', text: 'This request sends no body.' }))
    return
  }
  if (request.body.mode === 'form' || request.body.mode === 'multipart') {
    body.append(kvEditor(request.body.fields, tab, {
      keyPlaceholder: 'field',
      valuePlaceholder: 'value',
      addLabel: 'Add field',
      empty: 'No fields.',
    }))
    if (request.body.mode === 'multipart') {
      body.append(el('div', { class: 'hint' }, 'Multipart is text-field only; file parts need a filesystem picker, which a sandboxed view does not have.'))
    }
    return
  }
  body.append(el('textarea', {
    class: 'textarea',
    spellcheck: 'false',
    placeholder: request.body.mode === 'json' ? '{\n  "name": "Alice"\n}' : 'Plain text body',
    value: request.body.text,
    on: { input: (event) => { request.body.text = event.target.value; markDirty(tab) } },
  }))
  if (request.body.text.length > 120_000) {
    body.append(el('div', { class: 'truncated-note', text: 'This body is over the 120 KB runner limit; shorten it before sending.' }))
  }
}

function renderAuthEditor(body, tab) {
  const auth = tab.request.auth
  const types = ['none', 'bearer', 'basic', 'apikey']
  body.append(el('div', { class: 'editor-toolbar' },
    el('span', { text: 'Auth' }),
    el('div', { class: 'segmented' }, ...types.map((type) => el('button', {
      type: 'button',
      class: auth.type === type ? 'active' : '',
      text: type === 'apikey' ? 'API key' : type,
      on: {
        click: () => {
          auth.type = type
          markDirty(tab)
          renderAll()
        },
      },
    })))))

  if (auth.type === 'none') {
    body.append(el('div', { class: 'response-empty', text: 'No authorization is applied.' }))
    return
  }
  const field = (label, key, placeholder, type = 'text') => {
    const input = el('input', {
      class: 'field',
      type,
      value: auth[key],
      placeholder,
      spellcheck: 'false',
      on: { input: (event) => { auth[key] = event.target.value; markDirty(tab) } },
    })
    body.append(el('div', { class: 'field-row' }, el('span', { class: 'field-label', text: label }), input))
  }
  if (auth.type === 'bearer') field('Bearer token', 'token', '{{token}}')
  if (auth.type === 'basic') {
    field('Username', 'username', '{{username}}')
    field('Password', 'password', '{{password}}', 'password')
  }
  if (auth.type === 'apikey') {
    field('Header or query name', 'key', 'X-API-Key')
    field('Value', 'value', '{{apiKey}}')
    const addTo = el('select', {
      class: 'field',
      on: { change: (event) => { auth.addTo = event.target.value; markDirty(tab) } },
    },
    el('option', { value: 'header', text: 'Header' }),
    el('option', { value: 'query', text: 'Query parameter' }))
    addTo.value = auth.addTo
    body.append(el('div', { class: 'field-row' }, el('span', { class: 'field-label', text: 'Add to' }), addTo))
  }
  body.append(el('div', { class: 'hint' }, 'Use {{variables}} so secrets live in an environment instead of the request.'))
}

function renderResponsePane(tab) {
  const pane = el('div', { class: 'response-pane' })
  const response = state.response
  const head = el('div', { class: 'response-head' })
  head.append(el('button', {
    type: 'button',
    class: 'response-collapse',
    text: state.collapsedResponse ? '▸ Response' : '▾ Response',
    title: state.collapsedResponse ? 'Expand response' : 'Collapse response',
    on: {
      click: () => {
        state.collapsedResponse = !state.collapsedResponse
        document.querySelector('.editor-shell')?.classList.toggle('response-collapsed', state.collapsedResponse)
        renderMain()
      },
    },
  }))

  if (state.sending) {
    head.append(el('div', { class: 'response-meta' }, el('span', { text: 'Waiting for the server…' })))
  } else if (!response) {
    head.append(el('div', { class: 'response-meta' }, el('span', { text: 'No response yet' })))
  } else if (response.ok) {
    const res = response.response
    head.append(el('div', { class: 'response-meta' },
      el('span', { class: `status-pill ${statusClass(res.status)}`, text: `${res.status} ${res.statusText}`.trim() }),
      el('span', { text: `${res.durationMs} ms` }),
      el('span', { text: formatBytes(res.bytes) }),
      res.truncated ? el('span', { class: 'truncated-note', text: 'truncated' }) : null))
    head.append(el('div', { class: 'response-tabs' },
      el('button', {
        type: 'button', class: `response-tab${state.responseTab === 'body' ? ' active' : ''}`, text: 'Body',
        on: { click: () => { state.responseTab = 'body'; renderResponseOnly() } },
      }),
      el('button', {
        type: 'button', class: `response-tab${state.responseTab === 'headers' ? ' active' : ''}`, text: `Headers ${res.headers.length}`,
        on: { click: () => { state.responseTab = 'headers'; renderResponseOnly() } },
      })))
    head.append(button('Copy', { class: 'btn small ghost', title: 'Copy the response body' }, () => copyResponse(res)))
  } else {
    head.append(el('div', { class: 'response-meta' }, el('span', { class: 'status-pill status-5xx', text: 'Request failed' })))
  }
  pane.append(head, renderResponseBody())
  return pane
}

function renderResponseOnly() {
  const pane = document.querySelector('.response-pane')
  if (!pane) {
    renderMain()
    return
  }
  const tab = activeTab()
  if (!tab) return
  pane.replaceWith(renderResponsePane(tab))
}

function renderResponseBody() {
  const container = el('div', { class: 'response-body' })
  const response = state.response
  if (state.sending) {
    container.append(el('div', { class: 'response-empty', text: 'Sending request…' }))
    return container
  }
  if (!response) {
    container.append(el('div', { class: 'response-empty', text: 'Send a request to see its status, headers, timing, and body.' }))
    return container
  }
  if (!response.ok) {
    container.append(el('div', { class: 'response-error', text: response.error }))
    return container
  }
  const res = response.response
  if (state.responseTab === 'headers') {
    const table = el('table', { class: 'headers-table' })
    for (const header of res.headers) {
      table.append(el('tr', {}, el('td', { text: header.name }), el('td', { text: header.value })))
    }
    container.append(table)
    return container
  }
  const contentType = headerValue(res.headers, 'content-type').toLowerCase()
  if (res.bodyEncoding === 'base64') {
    if (contentType.startsWith('image/')) {
      container.append(el('img', {
        class: 'image-preview',
        src: `data:${contentType.split(';')[0]};base64,${res.body}`,
        alt: 'Response image',
      }))
    } else {
      container.append(el('div', { class: 'response-empty', text: `Binary response (${formatBytes(res.bytes)}). Copy it if you need the base64 payload.` }))
      container.append(el('pre', { text: res.body }))
    }
    if (res.truncated) container.append(el('div', { class: 'truncated-note', text: 'The response was larger than the 100 KB display cap.' }))
    return container
  }
  const json = prettyJson(res.body)
  if (json !== null) {
    container.append(renderJsonTree(json, ''))
  } else if (res.body.trim()) {
    container.append(el('pre', { text: res.body }))
  } else {
    container.append(el('div', { class: 'response-empty', text: 'The response body is empty.' }))
  }
  if (res.truncated) container.append(el('div', { class: 'truncated-note', text: 'The response was larger than the 100 KB display cap; it was cut off.' }))
  return container
}

function renderJsonTree(value, key) {
  const budget = { left: 900 }
  return jsonNode(value, key, 0, budget)
}

function jsonNode(value, key, depth, budget) {
  if (budget.left <= 0) return scalarNode('…', 'jt-null', key)
  budget.left -= 1
  if (value === null) return scalarNode('null', 'jt-null', key)
  if (typeof value === 'string') return scalarNode(JSON.stringify(value), 'jt-string', key)
  if (typeof value === 'number') return scalarNode(String(value), 'jt-number', key)
  if (typeof value === 'boolean') return scalarNode(String(value), 'jt-boolean', key)
  if (Array.isArray(value)) {
    if (value.length === 0) return scalarNode('[]', 'jt-brace', key)
    const details = el('details', { open: depth < 2 })
    details.append(el('summary', {},
      key ? el('span', { class: 'jt-key', text: `${key}: ` }) : null,
      el('span', { class: 'jt-brace', text: `[${value.length}]` })))
    const limit = Math.min(value.length, 80)
    for (let index = 0; index < limit; index += 1) {
      details.append(el('div', { class: 'jt-row' }, jsonNode(value[index], String(index), depth + 1, budget)))
    }
    if (value.length > limit) details.append(el('div', { class: 'jt-row muted', text: `… ${value.length - limit} more` }))
    return details
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) return scalarNode('{}', 'jt-brace', key)
    const details = el('details', { open: depth < 2 })
    details.append(el('summary', {},
      key ? el('span', { class: 'jt-key', text: `${key}: ` }) : null,
      el('span', { class: 'jt-brace', text: `{${entries.length}}` })))
    for (const [name, child] of entries.slice(0, 120)) {
      details.append(el('div', { class: 'jt-row' }, jsonNode(child, name, depth + 1, budget)))
    }
    if (entries.length > 120) details.append(el('div', { class: 'jt-row muted', text: `… ${entries.length - 120} more` }))
    return details
  }
  return scalarNode(String(value), 'jt-null', key)
}

function scalarNode(text, className, key) {
  return el('span', {},
    key ? el('span', { class: 'jt-key', text: `${key}: ` }) : null,
    el('span', { class: className, text }))
}

/* --- request actions -------------------------------------------------------- */

async function sendActive() {
  const tab = activeTab()
  if (!tab || state.sending) return
  const variables = variableMap(state.workspace)
  const prepared = prepareRequest(tab.request, variables)
  if (!prepared.url) {
    showToast('Enter a request URL first.', 'error')
    return
  }
  if (!/^https?:\/\//i.test(prepared.url)) {
    showToast('The URL must start with http:// or https://.', 'error')
    return
  }
  if (prepared.missing.length) {
    showToast(`Resolve these variables before sending: ${prepared.missing.join(', ')}`, 'error')
    return
  }
  const unfilled = tab.request.pathVars.filter((row) =>
    row.enabled && !resolveTemplate(row.value, variables).text.trim())
  if (unfilled.length) {
    showToast(`Fill these path variables before sending: ${unfilled.map((row) => row.key).join(', ')}`, 'error')
    return
  }
  const placeholder = prepared.url.match(/\{[A-Za-z0-9_.-]+\}/)
  if (placeholder) {
    showToast(`The URL still contains the path placeholder ${placeholder[0]}; add it in the Path tab or remove it.`, 'error')
    return
  }
  const auth = tab.request.auth
  const hasValue = (value) => Boolean(resolveTemplate(value, variables).text.trim())
  if (auth.type === 'bearer' && !hasValue(auth.token)) {
    showToast('Enter a bearer token or switch Auth to None.', 'error')
    return
  }
  if (auth.type === 'basic' && (!hasValue(auth.username) || !hasValue(auth.password))) {
    showToast('Enter both the username and password or switch Auth to None.', 'error')
    return
  }
  if (auth.type === 'apikey' && (!hasValue(auth.key) || !hasValue(auth.value))) {
    showToast('Enter both the API key name and value or switch Auth to None.', 'error')
    return
  }
  if (prepared.body && prepared.body.length > 120_000) {
    showToast('Request bodies are limited to 120 KB by the extension bridge in this version.', 'error')
    return
  }

  state.sending = true
  state.response = null
  renderResponseOnly()
  const sendButton = document.querySelector('.send-btn')
  if (sendButton) {
    sendButton.disabled = true
    sendButton.textContent = 'Sending…'
  }

  const sentRequest = {
    ...tab.request,
    url: prepared.url,
    headers: prepared.headers.map((header) => ({ id: uid('hdr'), key: header.name, value: header.value, enabled: true })),
    body: { ...tab.request.body, text: prepared.body ?? '' },
  }

  try {
    const response = await call('execute', { request: sentRequest }, 40_000)
    state.response = { ok: true, request: tab.request, response }
    state.workspace.history = appendHistory(state.workspace, historyEntry({
      request: tab.request,
      environmentId: state.workspace.activeEnvironmentId,
      response,
    }))
    scheduleSave()
  } catch (error) {
    state.response = { ok: false, error: error.message }
  } finally {
    state.sending = false
    renderResponseOnly()
    const sendButtonAfter = document.querySelector('.send-btn')
    if (sendButtonAfter) {
      sendButtonAfter.disabled = false
      sendButtonAfter.textContent = 'Send'
    }
  }
}

async function copyResponse(res) {
  try {
    await call('copy', { text: res.body })
    showToast('Response copied')
  } catch (error) {
    showToast(error.message, 'error')
  }
}

async function copyAsCurl(tab) {
  const prepared = prepareRequest(tab.request, variableMap(state.workspace))
  try {
    await call('copy', { text: toCurl(prepared) })
    showToast(prepared.missing.length ? `Copied; unresolved: ${prepared.missing.join(', ')}` : 'Copied as cURL')
  } catch (error) {
    showToast(error.message, 'error')
  }
}

async function saveRequest(tab) {
  if (!tab) return
  let collection = state.workspace.collections.find((item) => item.id === tab.collectionId)
  if (collection) {
    const index = collection.requests.findIndex((item) => item.id === tab.request.id)
    if (index >= 0) {
      collection.requests[index] = cloneRequest(tab.request)
    } else {
      collection.requests.push(cloneRequest(tab.request))
    }
    tab.dirty = false
    scheduleSave()
    showToast(`Saved to ${collection.name}`)
    renderAll()
    return
  }

  const result = await saveRequestDialog(tab)
  if (!result) return
  if (result.collectionId === '__new__') {
    collection = normalizeCollection({ name: result.newCollectionName })
    state.workspace.collections.push(collection)
  } else {
    collection = state.workspace.collections.find((item) => item.id === result.collectionId)
  }
  if (!collection) return
  const request = cloneRequest({ ...tab.request, name: result.name })
  request.id = tab.request.id
  collection.requests.push(request)
  tab.request.name = result.name
  tab.collectionId = collection.id
  tab.dirty = false
  await persistNow()
  showToast(`Saved to ${collection.name}`)
  renderAll()
}

function saveRequestDialog(tab) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      closeModal()
      resolve(value)
    }
    const error = el('div', { class: 'modal-error' })
    const name = el('input', {
      class: 'field',
      value: tab.request.name === 'Untitled request' ? '' : tab.request.name,
      placeholder: 'Get users',
    })
    const select = el('select', { class: 'field' },
      ...state.workspace.collections.map((collection) => el('option', { value: collection.id, text: collection.name })),
      el('option', { value: '__new__', text: 'New collection…' }))
    const newCollection = el('input', { class: 'field', placeholder: 'User Service' })
    const newCollectionRow = el('div', { class: 'field-row' }, el('span', { class: 'field-label', text: 'Collection name' }), newCollection)
    newCollectionRow.classList.toggle('hidden', state.workspace.collections.length > 0)
    if (state.workspace.collections.length === 0) select.value = '__new__'
    select.addEventListener('change', () => {
      newCollectionRow.classList.toggle('hidden', select.value !== '__new__')
    })
    const submit = () => {
      const requestName = name.value.trim()
      if (!requestName) {
        error.textContent = 'Give the request a name.'
        return
      }
      if (select.value === '__new__' && !newCollection.value.trim()) {
        error.textContent = 'Give the new collection a name.'
        return
      }
      finish({
        name: requestName,
        collectionId: select.value,
        newCollectionName: newCollection.value.trim(),
      })
    }
    const card = el('div', { class: 'modal-card' },
      el('h3', {}, 'Save request'),
      el('div', { class: 'field-row' }, el('span', { class: 'field-label', text: 'Request name' }), name),
      el('div', { class: 'field-row' }, el('span', { class: 'field-label', text: 'Collection' }), select),
      newCollectionRow,
      error,
      el('div', { class: 'modal-actions' },
        button('Cancel', {}, () => finish(null)),
        button('Save', { class: 'btn primary' }, submit)))
    mountModal(card, () => finish(null))
    name.focus()
  })
}

/* --- environments ----------------------------------------------------------- */

function renderEnvironmentsSidebar() {
  sidebarEl.append(el('div', { class: 'sidebar-head' },
    el('span', { class: 'sidebar-title', text: 'Environments' }),
    el('div', { class: 'sidebar-actions' },
      el('button', {
        type: 'button', class: 'icon-btn', title: 'New environment', text: '+',
        on: {
          click: () => {
            const environment = newEnvironment()
            state.workspace.environments.push(environment)
            state.workspace.activeEnvironmentId = environment.id
            scheduleSave()
            renderAll()
          },
        },
      }))))
  const section = el('div', { class: 'sidebar-section' })
  for (const environment of state.workspace.environments) {
    const active = environment.id === state.workspace.activeEnvironmentId
    section.append(el('button', {
      type: 'button',
      class: `tree-item${active ? ' active' : ''}`,
      on: {
        click: () => {
          state.workspace.activeEnvironmentId = environment.id
          scheduleSave()
          renderAll()
        },
      },
    },
    el('span', { class: 'label', text: environment.name }),
    el('span', { class: 'sub', text: `${environment.variables.length} vars` }),
    active ? el('span', { class: 'sub', text: 'active' }) : null))
  }
  sidebarEl.append(section)
  sidebarEl.append(el('div', { class: 'sidebar-empty' }, 'Variables are referenced as ',
    el('code', { class: 'mono', text: '{{name}}' }), ' in URLs, headers, bodies, and auth.'))
}

function renderEnvironmentsMain() {
  const environment = activeEnvironment(state.workspace)
  if (!environment) {
    mainEl.append(el('div', { class: 'empty' }, el('strong', {}, 'No environment'), button('New environment', { class: 'btn primary' }, () => {
      const next = newEnvironment()
      state.workspace.environments.push(next)
      state.workspace.activeEnvironmentId = next.id
      scheduleSave()
      renderAll()
    })))
    return
  }
  const editor = el('div', { class: 'env-editor' })
  const name = el('input', {
    class: 'field',
    value: environment.name,
    on: {
      input: (event) => { environment.name = event.target.value; scheduleSave() },
      change: () => renderSidebar(),
    },
  })
  editor.append(
    el('div', { class: 'env-name-row' }, name,
      button('Delete environment', { class: 'btn danger small' }, async () => {
        const confirmed = await confirmAction({
          title: 'Delete environment?',
          message: `“${environment.name}” and its variables will be removed.`,
        })
        if (!confirmed) return
        state.workspace.environments = state.workspace.environments.filter((item) => item.id !== environment.id)
        if (state.workspace.activeEnvironmentId === environment.id) {
          state.workspace.activeEnvironmentId = state.workspace.environments[0]?.id ?? null
        }
        scheduleSave()
        renderAll()
      })),
    el('div', { class: 'section-label', text: 'Variables' }),
    renderVariableTable(environment),
    el('div', { class: 'hint' }, 'Secret values are hidden in the editor and encrypted with the workspace when the OS keychain is available. Changing the active environment immediately changes {{variable}} resolution.'),
  )
  mainEl.append(editor)
}

function renderVariableTable(environment) {
  const table = el('div', { class: 'variable-table' })
  environment.variables.forEach((variable, index) => {
    const enabled = el('input', {
      type: 'checkbox',
      checked: variable.enabled,
      on: { change: (event) => { variable.enabled = event.target.checked; scheduleSave() } },
    })
    const key = el('input', {
      class: 'kv-input',
      value: variable.key,
      placeholder: 'baseUrl',
      spellcheck: 'false',
      on: { input: (event) => { variable.key = event.target.value; scheduleSave() } },
    })
    const value = el('input', {
      class: 'kv-input',
      type: variable.secret ? 'password' : 'text',
      value: variable.value,
      placeholder: 'http://localhost:8080',
      spellcheck: 'false',
      on: { input: (event) => { variable.value = event.target.value; scheduleSave() } },
    })
    const secret = el('label', { class: 'secret-toggle' },
      el('input', {
        type: 'checkbox',
        checked: variable.secret,
        on: {
          change: (event) => {
            variable.secret = event.target.checked
            value.type = variable.secret ? 'password' : 'text'
            scheduleSave()
          },
        },
      }), 'secret')
    const row = el('div', { class: 'variable-row' },
      enabled, key, value, secret,
      el('button', {
        type: 'button', class: 'icon-btn danger', title: 'Remove variable', text: '×',
        on: {
          click: () => {
            environment.variables.splice(index, 1)
            scheduleSave()
            renderAll()
          },
        },
      }))
    table.append(row)
  })
  table.append(button('Add variable', { class: 'btn small' }, () => {
    environment.variables.push({ id: uid('var'), key: '', value: '', enabled: true, secret: false })
    scheduleSave()
    renderAll()
  }))
  return table
}

/* --- history ---------------------------------------------------------------- */

function renderHistorySidebar() {
  sidebarEl.append(el('div', { class: 'sidebar-head' },
    el('span', { class: 'sidebar-title', text: 'History' }),
    el('div', { class: 'sidebar-actions' },
      el('button', {
        type: 'button',
        class: 'icon-btn danger',
        title: 'Clear history',
        text: '×',
        on: {
          click: async () => {
            if (!state.workspace.history.length) return
            const confirmed = await confirmAction({ title: 'Clear history?', message: 'Every recorded request will be removed.' })
            if (!confirmed) return
            state.workspace.history = []
            scheduleSave()
            renderAll()
          },
        },
      }))))
  sidebarEl.append(el('div', { class: 'sidebar-empty' },
    `${state.workspace.history.length} recorded request(s). Authorization headers, cookies, and auth secrets are stripped before anything is written to disk.`))
}

function renderHistoryMain() {
  if (!state.workspace.history.length) {
    mainEl.append(el('div', { class: 'empty' },
      el('strong', {}, 'No requests yet'),
      el('div', {}, 'Send a request and its method, status, timing, and size land here — without its credentials.')))
    return
  }
  const scroll = el('div', { class: 'doc-scroll' })
  const table = el('table', { class: 'history-table' },
    el('thead', {}, el('tr', {},
      el('th', { text: 'Time' }), el('th', { text: 'Method' }), el('th', { text: 'Status' }),
      el('th', { text: 'Time' }), el('th', { text: 'Size' }), el('th', { text: 'URL' }))))
  const body = el('tbody')
  for (const entry of state.workspace.history) {
    const row = el('tr', {
      on: {
        click: () => {
          newRequestTab({ ...entry.request, name: `${entry.method} ${entry.url}` })
          showToast('History is redacted; re-enter any credentials.')
        },
      },
    },
    el('td', { class: 'history-time', text: formatTime(entry.at) }),
    el('td', {}, methodBadge(entry.method)),
    el('td', {}, el('span', { class: `status-pill ${statusClass(entry.status)}`, text: entry.status ? String(entry.status) : '—' })),
    el('td', { text: `${entry.durationMs} ms` }),
    el('td', { text: formatBytes(entry.bytes) }),
    el('td', { class: 'history-url', text: entry.url, title: entry.url }))
    body.append(row)
  }
  table.append(body)
  scroll.append(table)
  mainEl.append(scroll)
}

/* --- docs ------------------------------------------------------------------- */

function renderDocsSidebar() {
  sidebarEl.append(el('div', { class: 'sidebar-head' },
    el('span', { class: 'sidebar-title', text: 'Specifications' }),
    el('div', { class: 'sidebar-actions' },
      el('button', { type: 'button', class: 'icon-btn', title: 'Import a specification', text: '+', on: { click: openImportModal } }))))

  if (state.specs.length === 0) {
    sidebarEl.append(el('div', { class: 'sidebar-empty' },
      'Import an OpenAPI 3.0/3.1 document or a Spring Boot ',
      el('code', { class: 'mono', text: '/v3/api-docs' }),
      ' URL.'))
    return
  }

  const specList = el('div', { class: 'sidebar-section' })
  const selectSpec = (meta) => {
    state.docSpecId = meta.id
    state.docOperationId = null
    void ensureSpecLoaded(meta.id)
    renderAll()
  }
  for (const meta of state.specs) {
    const loadedTitle = state.specCache.get(meta.id)?.title
    specList.append(el('div', {
      class: `tree-item${meta.id === state.docSpecId ? ' active' : ''}`,
      role: 'button',
      tabindex: '0',
      on: {
        click: () => selectSpec(meta),
        keydown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          selectSpec(meta)
        },
      },
    },
    el('span', { class: 'label', text: loadedTitle || meta.name, title: meta.sourceUrl ?? meta.name }),
    el('button', {
      type: 'button', class: 'icon-btn danger', title: 'Delete specification', text: '×',
      on: {
        click: (event) => {
          event.stopPropagation()
          void deleteSpec(meta)
        },
      },
    })))
  }
  sidebarEl.append(specList)

  const spec = state.docSpecId ? state.specCache.get(state.docSpecId) : null
  if (!spec) {
    const error = state.docSpecId ? state.specErrors.get(state.docSpecId) : null
    if (error) {
      sidebarEl.append(el('div', { class: 'sidebar-empty' },
        error,
        el('div', { class: 'row' }, button('Retry', { class: 'btn small' }, () => {
          state.specErrors.delete(state.docSpecId)
          void ensureSpecLoaded(state.docSpecId)
        }))))
    } else if (state.docSpecId && !state.specLoading.has(state.docSpecId)) {
      void ensureSpecLoaded(state.docSpecId)
      sidebarEl.append(el('div', { class: 'sidebar-empty', text: 'Loading operations…' }))
    } else {
      sidebarEl.append(el('div', { class: 'sidebar-empty', text: 'Loading operations…' }))
    }
    return
  }

  const search = el('input', {
    class: 'search-input',
    placeholder: 'Search endpoints',
    spellcheck: 'false',
    value: state.docSearch,
  })
  const list = el('div', { class: 'sidebar-section' })
  if (spec.operations.length === 0) {
    list.append(el('div', { class: 'sidebar-empty', text: 'This document has no operations.' }))
  }
  for (const [tag, operations] of groupOperations(spec.operations)) {
    const group = el('div', { class: 'tag-group' })
    group.append(el('div', { class: 'tag-head', text: tag }))
    for (const operation of operations) {
      const item = el('button', {
        type: 'button',
        class: 'op-item',
        dataset: { search: `${operation.method} ${operation.path} ${operation.summary} ${operation.operationId}`.toLowerCase() },
        on: {
          click: () => {
            state.docOperationId = operation.id
            renderAll()
          },
        },
      },
      methodBadge(operation.method),
      el('span', { class: 'op-path', text: operation.path }),
      el('span', { class: 'op-summary', text: operation.summary || operation.operationId }))
      group.append(item)
    }
    list.append(group)
  }
  const filterOperations = () => {
    const query = search.value.trim().toLowerCase()
    for (const item of list.querySelectorAll('.op-item')) {
      item.classList.toggle('hidden', Boolean(query) && !item.dataset.search.includes(query))
    }
  }
  search.addEventListener('input', () => {
    state.docSearch = search.value
    filterOperations()
  })
  sidebarEl.append(search, list)
  filterOperations()
}

function renderDocsMain() {
  if (state.specs.length === 0) {
    mainEl.append(el('div', { class: 'empty' },
      el('strong', {}, 'No API documentation yet'),
      el('div', {}, 'Paste an OpenAPI document or point API Studio at a running service.'),
      button('Import a specification', { class: 'btn primary' }, openImportModal)))
    return
  }
  const spec = state.docSpecId ? state.specCache.get(state.docSpecId) : null
  if (!spec) {
    mainEl.append(el('div', { class: 'empty', text: state.specErrors.get(state.docSpecId) ?? 'Loading specification…' }))
    return
  }
  const operation = spec.operations.find((item) => item.id === state.docOperationId)
  mainEl.append(operation ? renderOperationDetail(spec, operation) : renderSpecOverview(spec))
}

function renderSpecOverview(spec) {
  const scroll = el('div', { class: 'doc-scroll' })
  const meta = state.specs.find((item) => item.id === spec.id)
  scroll.append(el('div', { class: 'spec-head' },
    el('div', { class: 'grow' },
      el('h2', {}, spec.title),
      el('div', { class: 'spec-sub' }, `${spec.openapi} · ${spec.operations.length} operations${spec.version ? ` · v${spec.version}` : ''}`)),
    meta ? button('Delete', { class: 'btn danger small' }, () => void deleteSpec(meta)) : null))
  if (meta?.sourceUrl) {
    scroll.append(el('div', { class: 'spec-sub' }, 'Imported from ',
      el('span', { class: 'mono', text: meta.sourceUrl })))
  }
  if (spec.description) scroll.append(el('div', { class: 'doc-text' }, spec.description))
  scroll.append(el('div', { class: 'section-label', text: 'Base URL' }))
  scroll.append(el('div', { class: 'schema-block', text: spec.baseUrl || 'No server URL in the document. Set a baseUrl variable in an environment, or edit the request URL after Try It Out.' }))
  if (spec.servers.length) {
    scroll.append(el('div', { class: 'section-label', text: 'Servers' }))
    scroll.append(el('div', { class: 'schema-block', text: spec.servers.map((server) => server.url).filter(Boolean).join('\n') }))
  }
  const tags = [...new Set(spec.operations.flatMap((operation) => operation.tags))].sort()
  if (tags.length) {
    scroll.append(el('div', { class: 'section-label', text: 'Tags' }))
    scroll.append(el('div', { class: 'doc-text', text: tags.join(' · ') }))
  }
  const schemas = Object.entries(spec.components.schemas ?? {})
  if (schemas.length) {
    scroll.append(el('div', { class: 'section-label', text: `Schemas (${schemas.length})` }))
    for (const [name, schema] of schemas.slice(0, 60)) {
      const details = el('details', { class: 'schema-item' })
      details.append(el('summary', { text: name }))
      details.append(el('div', { class: 'schema-block', text: safeJson(schemaExample(schema, spec.components)) }))
      scroll.append(details)
    }
  }
  const security = Object.entries(spec.securitySchemes ?? {})
  if (security.length) {
    scroll.append(el('div', { class: 'section-label', text: 'Security schemes' }))
    scroll.append(el('div', { class: 'doc-text', text: security.map(([name, scheme]) => `${name}${scheme && typeof scheme === 'object' ? ` (${scheme.type ?? 'scheme'})` : ''}`).join('\n') }))
  }
  return scroll
}

function renderOperationDetail(spec, operation) {
  const scroll = el('div', { class: 'doc-scroll op-detail' })
  scroll.append(el('div', { class: 'spec-head' },
    el('div', { class: 'grow' },
      el('div', { class: 'op-title' }, methodBadge(operation.method), el('span', { class: 'op-path-code', text: operation.path }),
        operation.deprecated ? el('span', { class: 'chip warn', text: 'deprecated' }) : null),
      el('h2', {}, operation.summary || operation.operationId || `${operation.method} ${operation.path}`)),
    button('Try it out', { class: 'btn primary small' }, () => {
      const request = operationRequest(spec, operation, state.workspace)
      state.docOperationId = operation.id
      newRequestTab(request)
    })))
  if (operation.description) scroll.append(el('div', { class: 'doc-text' }, operation.description))

  const server = operation.servers.find((entry) => entry?.url)?.url
  if (server) {
    scroll.append(el('div', { class: 'section-label', text: 'Server' }))
    scroll.append(el('div', { class: 'schema-block', text: server }))
  }

  if (operation.parameters.length) {
    scroll.append(el('div', { class: 'section-label', text: 'Parameters' }))
    const table = el('table', { class: 'param-table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Name' }), el('th', { text: 'In' }), el('th', { text: 'Type' }),
        el('th', { text: 'Required' }), el('th', { text: 'Description' }))))
    const body = el('tbody')
    for (const parameter of operation.parameters) {
      if (!parameter?.name) continue
      body.append(el('tr', {},
        el('td', { class: 'param-name', text: parameter.name }),
        el('td', { text: parameter.in ?? '' }),
        el('td', { text: parameter.schema?.type ?? parameter.type ?? '' }),
        el('td', { text: parameter.required ? 'yes' : '' }),
        el('td', { text: parameter.description ?? '' })))
    }
    table.append(body)
    scroll.append(table)
  }

  if (operation.requestBody) {
    scroll.append(el('div', { class: 'section-label', text: 'Request body' }))
    const content = operation.requestBody.content ?? {}
    for (const [type, media] of Object.entries(content)) {
      const example = media?.example !== undefined ? media.example : schemaExample(media?.schema, spec.components)
      scroll.append(el('div', { class: 'spec-sub', text: type }))
      scroll.append(el('div', { class: 'schema-block', text: safeJson(example) }))
    }
  }

  const responses = Object.entries(operation.responses ?? {})
  if (responses.length) {
    scroll.append(el('div', { class: 'section-label', text: 'Responses' }))
    for (const [status, response] of responses) {
      const details = el('details', { class: 'response-block' })
      details.append(el('summary', {}, el('span', { class: 'status-pill ' + statusClass(Number(status)), text: status }), ' ', String(response?.description ?? '')))
      const content = response?.content ?? {}
      for (const [type, media] of Object.entries(content)) {
        const example = media?.example !== undefined ? media.example : schemaExample(media?.schema, spec.components)
        details.append(el('div', { class: 'spec-sub', text: type }))
        details.append(el('div', { class: 'schema-block', text: safeJson(example) }))
      }
      scroll.append(details)
    }
  }
  return scroll
}

function safeJson(value) {
  if (value === undefined || value === null) return ''
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

async function ensureSpecLoaded(id) {
  if (!id || state.specCache.has(id) || state.specLoading.has(id) || state.specErrors.has(id)) {
    return state.specCache.get(id) ?? null
  }
  state.specLoading.add(id)
  try {
    let offset = 0
    let text = ''
    for (;;) {
      const chunk = await call('spec-read', { id, offset })
      text += chunk.chunk
      if (chunk.done) break
      offset = chunk.nextOffset
    }
    const spec = normalizeSpec(parseSpecDocument(text))
    spec.id = id
    state.specCache.set(id, spec)
  } catch (error) {
    state.specErrors.set(id, `Could not load this specification: ${error.message}`)
  } finally {
    state.specLoading.delete(id)
    if (state.view === 'docs') renderAll()
  }
  return state.specCache.get(id) ?? null
}

async function deleteSpec(meta) {
  const confirmed = await confirmAction({
    title: 'Delete specification?',
    message: `“${meta.name}” will be removed. Saved requests that came from it stay in your collections.`,
  })
  if (!confirmed) return
  try {
    await call('spec-delete', { id: meta.id })
    state.specs = state.specs.filter((item) => item.id !== meta.id)
    state.specCache.delete(meta.id)
    state.specErrors.delete(meta.id)
    if (state.docSpecId === meta.id) {
      state.docSpecId = state.specs[0]?.id ?? null
      state.docOperationId = null
      if (state.docSpecId) void ensureSpecLoaded(state.docSpecId)
    }
    renderAll()
  } catch (error) {
    showToast(error.message, 'error')
  }
}

async function refreshSpecs() {
  const list = await call('spec-list')
  state.specs = Array.isArray(list.specs) ? list.specs : []
}

/* --- import ----------------------------------------------------------------- */

function openImportModal() {
  let settled = false
  let mode = 'openapi'
  const finish = () => {
    if (settled) return
    settled = true
    closeModal()
  }
  const error = el('div', { class: 'modal-error' })
  const tabs = el('div', { class: 'modal-tabs' })
  const content = el('div')
  const name = el('input', { class: 'field', placeholder: 'User Service API' })
  const paste = el('textarea', { class: 'textarea', spellcheck: 'false', placeholder: '{ "openapi": "3.0.1", "paths": { … } }' })
  const url = el('input', { class: 'field', placeholder: 'http://localhost:8080/v3/api-docs' })
  const urlRow = el('div', { class: 'field-row hidden' }, el('span', { class: 'field-label', text: 'Specification URL' }), url)
  const sourceToggle = el('div', { class: 'segmented' },
    el('button', { type: 'button', class: 'active', text: 'Paste', on: { click: () => setSource('paste') } }),
    el('button', { type: 'button', text: 'URL', on: { click: () => setSource('url') } }))
  const openapiPane = el('div', {},
    el('div', { class: 'field-row' }, el('span', { class: 'field-label', text: 'Name (optional)' }), name),
    el('div', { class: 'field-row' }, el('span', { class: 'field-label', text: 'Source' }), sourceToggle),
    paste,
    urlRow)
  const postmanPane = el('div', { class: 'hidden' },
    el('div', { class: 'hint' }, 'Paste a Postman Collection v2.1 export. Folders are flattened into “folder / request” names.'),
    el('textarea', { class: 'textarea import-text', spellcheck: 'false', placeholder: '{ "info": { "schema": "…v2.1…" }, "item": [ … ] }' }))
  const curlPane = el('div', { class: 'hidden' },
    el('div', { class: 'hint' }, 'Paste a curl command; it opens as a request you can send and save.'),
    el('textarea', { class: 'textarea import-text', spellcheck: 'false', placeholder: "curl -X POST https://api.example.com/users -H 'Content-Type: application/json' -d '{\"name\":\"Alice\"}'" }))

  let source = 'paste'
  function setSource(next) {
    source = next
    paste.classList.toggle('hidden', source !== 'paste')
    urlRow.classList.toggle('hidden', source !== 'url')
    sourceToggle.querySelectorAll('button').forEach((item, index) => {
      item.classList.toggle('active', (index === 0) === (source === 'paste'))
    })
  }
  function setMode(next) {
    mode = next
    openapiPane.classList.toggle('hidden', mode !== 'openapi')
    postmanPane.classList.toggle('hidden', mode !== 'postman')
    curlPane.classList.toggle('hidden', mode !== 'curl')
    tabs.querySelectorAll('button').forEach((item) => item.classList.toggle('active', item.dataset.mode === mode))
    error.textContent = ''
  }
  for (const [id, label] of [['openapi', 'OpenAPI'], ['postman', 'Postman'], ['curl', 'cURL']]) {
    tabs.append(el('button', {
      type: 'button',
      class: `modal-tab${id === mode ? ' active' : ''}`,
      dataset: { mode: id },
      text: label,
      on: { click: () => setMode(id) },
    }))
  }
  content.append(openapiPane, postmanPane, curlPane)

  const run = async () => {
    error.textContent = ''
    try {
      if (mode === 'openapi') {
        if (source === 'url') {
          if (!url.value.trim()) throw new Error('Enter the specification URL.')
          const meta = await call('spec-import', { url: url.value.trim(), ...(name.value.trim() ? { name: name.value.trim() } : {}) }, 45_000)
          finish()
          await afterSpecImport(meta)
          return
        }
        const text = paste.value
        if (!text.trim()) throw new Error('Paste an OpenAPI document.')
        if (text.length > 200_000) throw new Error('Specifications larger than 200,000 characters must be imported from a URL.')
        const meta = await call('spec-import', { document: text, ...(name.value.trim() ? { name: name.value.trim() } : {}) })
        finish()
        await afterSpecImport(meta)
      } else if (mode === 'postman') {
        const text = postmanPane.querySelector('textarea').value
        const parsed = JSON.parse(text)
        const imported = importPostman(parsed)
        state.workspace.collections.push(...imported.collections)
        state.workspace.environments.push(...imported.environments)
        if (!state.workspace.activeEnvironmentId) state.workspace.activeEnvironmentId = imported.environments[0]?.id ?? null
        await persistNow()
        finish()
        renderAll()
        const first = imported.collections[0]?.requests[0]
        if (first) openSavedRequest(imported.collections[0], first)
        showToast(`Imported ${imported.collections.reduce((total, collection) => total + collection.requests.length, 0)} request(s)`)
      } else {
        const text = curlPane.querySelector('textarea').value
        const request = parseCurl(text)
        finish()
        newRequestTab(request)
        showToast('cURL imported')
      }
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const card = el('div', { class: 'modal-card' },
    el('h3', {}, 'Import'),
    tabs,
    content,
    error,
    el('div', { class: 'modal-actions' },
      button('Cancel', {}, finish),
      button('Import', { class: 'btn primary' }, () => void run())))
  mountModal(card, finish)
  paste.focus()
}

async function afterSpecImport(meta) {
  try {
    await refreshSpecs()
    state.docSpecId = meta.id
    state.docOperationId = null
    setView('docs', false)
    await ensureSpecLoaded(meta.id)
    if (state.specErrors.has(meta.id)) {
      await call('spec-delete', { id: meta.id }).catch(() => undefined)
      state.specs = state.specs.filter((item) => item.id !== meta.id)
      state.docSpecId = state.specs[0]?.id ?? null
      showToast(state.specErrors.get(meta.id) ?? 'The specification could not be parsed.', 'error')
      state.specErrors.delete(meta.id)
      renderAll()
      return
    }
    renderAll()
    const count = state.specCache.get(meta.id)?.operations.length ?? 0
    showToast(`Imported ${count} operation${count === 1 ? '' : 's'}`)
  } catch (error) {
    showToast(error.message, 'error')
  }
}
