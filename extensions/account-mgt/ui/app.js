/**
 * Account Manager web view.
 *
 * Runs in ND's sandboxed iframe: no network and no Node. Account metadata
 * persists through the declared nd.webview/1 actions; site and mailbox links
 * navigate ND's visible browser. Credentials and verification codes are never
 * accepted here.
 */
const CHATGPT_SIGNUP_URL = 'https://chatgpt.com/auth/login'
const DEFAULT_MAILBOX_URL = 'https://www.mailticking.com/'

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
        }, 10_000)
      })
    },
  }
}

const bridge = createBridge()

const STATUS_LABELS = {
  planned: 'Planned',
  'awaiting-code': 'Awaiting code',
  active: 'Active',
  disabled: 'Disabled',
}

const els = {
  connection: document.getElementById('connection'),
  notice: document.getElementById('notice'),
  newAccount: document.getElementById('new-account'),
  registerGpt: document.getElementById('register-gpt'),
  registerPanel: document.getElementById('register-panel'),
  registerCancel: document.getElementById('register-cancel'),
  registerEmail: document.getElementById('register-email'),
  registerMailbox: document.getElementById('register-mailbox'),
  registerSave: document.getElementById('register-save'),
  registerOpenSignup: document.getElementById('register-open-signup'),
  registerOpenMailbox: document.getElementById('register-open-mailbox'),
  registerMarkActive: document.getElementById('register-mark-active'),
  stepMailbox: document.getElementById('step-mailbox'),
  stepSignup: document.getElementById('step-signup'),
  stepActive: document.getElementById('step-active'),
  editorPanel: document.getElementById('editor-panel'),
  editorTitle: document.getElementById('editor-title'),
  editorCancel: document.getElementById('editor-cancel'),
  editorForm: document.getElementById('editor-form'),
  editService: document.getElementById('edit-service'),
  editEmail: document.getElementById('edit-email'),
  editUsername: document.getElementById('edit-username'),
  editStatus: document.getElementById('edit-status'),
  editSite: document.getElementById('edit-site'),
  editMailbox: document.getElementById('edit-mailbox'),
  editNotes: document.getElementById('edit-notes'),
  empty: document.getElementById('empty'),
  accounts: document.getElementById('accounts'),
}

const state = {
  accounts: [],
  editor: null,
  register: { accountId: null },
  busy: false,
}

let noticeTimer = null

function setNotice(message, tone = '') {
  els.notice.textContent = message
  els.notice.className = `notice ${tone}`.trim()
  els.notice.hidden = false
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { els.notice.hidden = true }, 6_000)
}

async function invoke(action, input = {}) {
  const result = await bridge.invoke({ action, ...input })
  if (!result.ok) throw new Error(result.error?.message || 'The action failed.')
  return result.value
}

function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function fieldValue(element) {
  return typeof element.value === 'string' ? element.value.trim() : ''
}

function accountById(id) {
  return state.accounts.find((account) => account.id === id)
}

async function refresh() {
  const rows = await invoke('list')
  state.accounts = Array.isArray(rows) ? rows : []
  renderAccounts()
}

function makeButton(label, className, onClick) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  if (className) button.className = className
  button.addEventListener('click', onClick)
  return button
}

function addDetail(list, label, value, className) {
  if (!value) return
  const term = document.createElement('dt')
  term.textContent = label
  const detail = document.createElement('dd')
  detail.textContent = value
  if (className) detail.className = className
  list.append(term, detail)
}

function renderAccounts() {
  els.accounts.replaceChildren()
  els.empty.hidden = state.accounts.length > 0

  for (const account of state.accounts) {
    const card = document.createElement('article')
    card.className = 'card'

    const head = document.createElement('div')
    head.className = 'card-head'
    const identity = document.createElement('div')
    const title = document.createElement('h2')
    title.textContent = account.service
    const email = document.createElement('p')
    email.className = 'email'
    email.textContent = account.email
    identity.append(title, email)
    const badge = document.createElement('span')
    badge.className = `badge ${account.status}`
    badge.textContent = STATUS_LABELS[account.status] ?? account.status
    head.append(identity, badge)

    const detail = document.createElement('dl')
    detail.className = 'detail'
    addDetail(detail, 'Username', account.username)
    addDetail(detail, 'Site', account.siteUrl)
    addDetail(detail, 'Mailbox', account.mailboxUrl)
    addDetail(detail, 'Notes', account.notes, 'notes')

    const actions = document.createElement('div')
    actions.className = 'card-actions'
    if (account.siteUrl) {
      actions.append(makeButton('Open site', '', () => { void openUrl(account.siteUrl, 'site') }))
    }
    if (account.mailboxUrl) {
      actions.append(makeButton('Open mailbox', '', () => { void openUrl(account.mailboxUrl, 'mailbox') }))
    }
    if (account.status !== 'active') {
      actions.append(makeButton('Mark active', '', () => { void markActive(account) }))
    }
    actions.append(makeButton('Edit', '', () => openEditor(account)))
    actions.append(makeButton('Delete', 'danger', () => { void deleteAccount(account) }))

    card.append(head, detail, actions)
    els.accounts.append(card)
  }

  syncRegisterSteps()
}

async function openUrl(url, kind) {
  if (!isHttpUrl(url)) {
    setNotice('That link is not an http(s) URL.', 'error')
    return false
  }
  try {
    await invoke(kind === 'mailbox' ? 'open-mailbox' : 'open-site', { url })
    setNotice(kind === 'mailbox' ? "Mailbox opened in ND's browser." : "Site opened in ND's browser.", 'ok')
    return true
  } catch (error) {
    setNotice(error.message, 'error')
    return false
  }
}

async function markActive(account) {
  if (state.busy) return
  state.busy = true
  try {
    await invoke('update', { id: account.id, status: 'active' })
    await refresh()
    setNotice('Account marked active.', 'ok')
  } catch (error) {
    setNotice(error.message, 'error')
  } finally {
    state.busy = false
  }
}

async function deleteAccount(account) {
  if (state.busy) return
  const confirmed = window.confirm(`Delete the record for ${account.email}?\n\nThis only removes the local record; the account itself is unchanged.`)
  if (!confirmed) return
  state.busy = true
  try {
    const result = await invoke('delete', { id: account.id })
    await refresh()
    setNotice(result?.deleted ? 'Account record deleted.' : 'That record was already gone.', 'ok')
  } catch (error) {
    setNotice(error.message, 'error')
  } finally {
    state.busy = false
  }
}

function openEditor(account) {
  state.editor = { id: account?.id ?? null }
  els.editorTitle.textContent = account ? 'Edit account' : 'New account'
  els.editService.value = account?.service ?? ''
  els.editEmail.value = account?.email ?? ''
  els.editUsername.value = account?.username ?? ''
  els.editStatus.value = account?.status ?? 'planned'
  els.editSite.value = account?.siteUrl ?? ''
  els.editMailbox.value = account?.mailboxUrl ?? ''
  els.editNotes.value = account?.notes ?? ''
  els.editorPanel.hidden = false
  els.registerPanel.hidden = true
  els.editService.focus()
}

function closeEditor() {
  state.editor = null
  els.editorPanel.hidden = true
}

async function saveEditor(event) {
  event.preventDefault()
  if (state.busy) return
  const payload = {
    service: fieldValue(els.editService),
    email: fieldValue(els.editEmail),
    username: fieldValue(els.editUsername),
    status: fieldValue(els.editStatus) || 'planned',
    siteUrl: fieldValue(els.editSite),
    mailboxUrl: fieldValue(els.editMailbox),
    notes: fieldValue(els.editNotes),
  }
  if (!payload.service) { setNotice('Service is required.', 'error'); return }
  if (!payload.email) { setNotice('Email is required.', 'error'); return }
  if (payload.siteUrl && !isHttpUrl(payload.siteUrl)) { setNotice('Site URL must be http(s).', 'error'); return }
  if (payload.mailboxUrl && !isHttpUrl(payload.mailboxUrl)) { setNotice('Mailbox URL must be http(s).', 'error'); return }

  state.busy = true
  try {
    if (state.editor?.id) {
      await invoke('update', { id: state.editor.id, ...payload })
    } else {
      await invoke('create', payload)
    }
    closeEditor()
    await refresh()
    setNotice('Account saved.', 'ok')
  } catch (error) {
    setNotice(error.message, 'error')
  } finally {
    state.busy = false
  }
}

function syncRegisterSteps() {
  const account = state.register.accountId ? accountById(state.register.accountId) : undefined
  const status = account?.status
  const saved = Boolean(account)

  els.stepMailbox.classList.toggle('done', saved)
  els.stepMailbox.classList.toggle('current', !saved)
  els.stepSignup.classList.toggle('done', status === 'awaiting-code' || status === 'active')
  els.stepSignup.classList.toggle('current', saved && status !== 'awaiting-code' && status !== 'active')
  els.stepActive.classList.toggle('done', status === 'active')
  els.stepActive.classList.toggle('current', status === 'awaiting-code')

  els.registerEmail.disabled = saved
  els.registerMailbox.disabled = saved
  els.registerSave.disabled = saved || state.busy
  els.registerOpenSignup.disabled = !saved || state.busy
  els.registerOpenMailbox.disabled = !saved || state.busy
  els.registerMarkActive.disabled = !saved || state.busy
}

function startRegister() {
  if (state.busy) return
  state.register.accountId = null
  els.registerEmail.value = ''
  els.registerMailbox.value = DEFAULT_MAILBOX_URL
  closeEditor()
  els.registerPanel.hidden = false
  syncRegisterSteps()
  els.registerEmail.focus()
}

async function registerSave() {
  if (state.busy) return
  const email = fieldValue(els.registerEmail)
  const mailboxUrl = fieldValue(els.registerMailbox)
  if (!email) { setNotice('Enter the mailbox email address first.', 'error'); return }
  if (mailboxUrl && !isHttpUrl(mailboxUrl)) { setNotice('Mailbox URL must be http(s).', 'error'); return }

  state.busy = true
  try {
    const account = await invoke('create', {
      service: 'ChatGPT',
      email,
      mailboxUrl,
      siteUrl: CHATGPT_SIGNUP_URL,
      status: 'planned',
      notes: 'Created by the guided ChatGPT registration flow.',
    })
    state.register.accountId = account.id
    await refresh()
    if (mailboxUrl) await openUrl(mailboxUrl, 'mailbox')
    setNotice('Mailbox record saved. Open the mailbox and create the address if needed.', 'ok')
  } catch (error) {
    setNotice(error.message, 'error')
  } finally {
    state.busy = false
    syncRegisterSteps()
  }
}

async function registerOpenSignup() {
  if (state.busy) return
  const account = state.register.accountId ? accountById(state.register.accountId) : undefined
  if (!account) { setNotice('Save the mailbox step first.', 'error'); return }
  state.busy = true
  try {
    const opened = await openUrl(account.siteUrl || CHATGPT_SIGNUP_URL, 'site')
    if (opened) {
      await invoke('update', { id: account.id, status: 'awaiting-code' })
      await refresh()
    }
  } catch (error) {
    setNotice(error.message, 'error')
  } finally {
    state.busy = false
    syncRegisterSteps()
  }
}

async function registerMarkActive() {
  if (state.busy) return
  const account = state.register.accountId ? accountById(state.register.accountId) : undefined
  if (!account) { setNotice('Save the mailbox step first.', 'error'); return }
  state.busy = true
  try {
    await invoke('update', { id: account.id, status: 'active' })
    await refresh()
    setNotice('ChatGPT account marked active.', 'ok')
    els.registerPanel.hidden = true
  } catch (error) {
    setNotice(error.message, 'error')
  } finally {
    state.busy = false
    syncRegisterSteps()
  }
}

els.newAccount.addEventListener('click', () => openEditor(null))
els.registerGpt.addEventListener('click', startRegister)
els.editorCancel.addEventListener('click', closeEditor)
els.editorForm.addEventListener('submit', (event) => { void saveEditor(event) })
els.registerCancel.addEventListener('click', () => {
  els.registerPanel.hidden = true
  state.register.accountId = null
})
els.registerSave.addEventListener('click', () => { void registerSave() })
els.registerOpenSignup.addEventListener('click', () => { void registerOpenSignup() })
els.registerOpenMailbox.addEventListener('click', () => {
  const account = state.register.accountId ? accountById(state.register.accountId) : undefined
  if (account?.mailboxUrl) void openUrl(account.mailboxUrl, 'mailbox')
})
els.registerMarkActive.addEventListener('click', () => { void registerMarkActive() })

bridge.whenConnected(async () => {
  els.connection.hidden = true
  try {
    await refresh()
  } catch (error) {
    setNotice(error.message, 'error')
  }
})

bridge.start()
