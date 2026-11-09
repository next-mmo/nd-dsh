/**
 * ND Access web view.
 *
 * Sandboxed iframe: no network, no Node. Secrets are typed here only to be
 * handed to the sealed store once; they are never read back, never logged, and
 * never copied to the clipboard. Agents and CLI are refused in the host layer.
 */
function createBridge() {
  let hello = null
  const pending = new Map()
  const connectQueue = []

  const applyTheme = (theme) => {
    const effective = theme === 'light' ? 'light' : 'dark'
    document.documentElement.dataset.theme = effective
    const meta = document.querySelector('meta[name="color-scheme"]')
    if (meta) meta.setAttribute('content', effective)
  }

  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.kind === 'nd-webview:hello' && data.protocol === 'nd.webview/1') {
      if (data.theme) applyTheme(data.theme)
      hello = data
      while (connectQueue.length > 0) connectQueue.shift()()
      return
    }
    if (data.kind === 'nd-webview:theme' && data.protocol === 'nd.webview/1') {
      if (data.theme) applyTheme(data.theme)
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
        }, 25_000)
      })
    },
  }
}

const bridge = createBridge()

const els = {
  connection: document.getElementById('connection'),
  notice: document.getElementById('notice'),
  editorPanel: document.getElementById('editor-panel'),
  editorTitle: document.getElementById('editor-title'),
  editorCancel: document.getElementById('editor-cancel'),
  editorForm: document.getElementById('editor-form'),
  editEmail: document.getElementById('edit-email'),
  editLabel: document.getElementById('edit-label'),
  editPassword: document.getElementById('edit-password'),
  editTotp: document.getElementById('edit-totp'),
  passwordHint: document.getElementById('password-hint'),
  mailPanel: document.getElementById('mail-panel'),
  mailTitle: document.getElementById('mail-title'),
  mailSubtitle: document.getElementById('mail-subtitle'),
  mailBody: document.getElementById('mail-body'),
  mailClose: document.getElementById('mail-close'),
  empty: document.getElementById('empty'),
  accounts: document.getElementById('accounts'),
}

const state = {
  accounts: [],
  editor: null,
  timers: new Set(),
  busy: false,
}

let noticeTimer = null

function setNotice(message, tone = '') {
  els.notice.textContent = message
  els.notice.className = `notice ${tone}`.trim()
  els.notice.hidden = false
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { els.notice.hidden = true }, 7_000)
}

async function invoke(action, input = {}) {
  const result = await bridge.invoke({ action, ...input })
  if (!result.ok) throw new Error(result.error?.message || 'The action failed.')
  return result.value
}

function clearTimers() {
  for (const timer of state.timers) clearInterval(timer)
  state.timers.clear()
}

function fieldValue(element) {
  return typeof element.value === 'string' ? element.value.trim() : ''
}

function makeButton(label, className, onClick) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  if (className) button.className = className
  button.addEventListener('click', onClick)
  return button
}

function accountById(id) {
  return state.accounts.find((account) => account.id === id)
}

async function refresh() {
  const rows = await invoke('list')
  state.accounts = Array.isArray(rows) ? rows : []
  renderAccounts()
}

function renderAccounts() {
  clearTimers()
  els.accounts.replaceChildren()
  els.empty.hidden = state.accounts.length > 0

  for (const account of state.accounts) {
    const card = document.createElement('article')
    card.className = 'card'

    const head = document.createElement('div')
    head.className = 'card-head'
    const identity = document.createElement('div')
    const email = document.createElement('p')
    email.className = 'card-email'
    email.textContent = account.email
    identity.append(email)
    if (account.label) {
      const label = document.createElement('p')
      label.className = 'card-label'
      label.textContent = account.label
      identity.append(label)
    }
    const badges = document.createElement('div')
    badges.className = 'badges'
    const mailbox = document.createElement('span')
    mailbox.className = `badge ${account.hasPassword ? 'on' : ''}`
    mailbox.textContent = 'Mailbox'
    badges.append(mailbox)
    if (account.hasTotp) {
      const totp = document.createElement('span')
      totp.className = 'badge on'
      totp.textContent = '2FA'
      badges.append(totp)
    }
    head.append(identity, badges)

    const actions = document.createElement('div')
    actions.className = 'card-actions'
    if (account.hasTotp) actions.append(makeButton('2FA code', '', () => { void showCode(account, slot) }))
    actions.append(makeButton('Inbox', '', () => { void openInbox(account) }))
    actions.append(makeButton('Edit', '', () => openEditor(account)))
    actions.append(makeButton('Delete', 'danger', () => { void removeAccount(account) }))

    const slot = document.createElement('div')
    slot.className = 'code-slot'
    slot.hidden = true

    card.append(head, actions, slot)
    els.accounts.append(card)
  }
}

async function showCode(account, slot) {
  const existing = slot.querySelector('.code-value')
  if (existing) {
    slot.hidden = true
    if (slot._timer) clearInterval(slot._timer)
    return
  }
  slot.hidden = false
  slot.replaceChildren(document.createTextNode('Generating…'))
  try {
    const result = await invoke('totp', { id: account.id })
    slot.replaceChildren()
    const value = document.createElement('div')
    value.className = 'code-value'
    value.textContent = result.code
    const meta = document.createElement('div')
    meta.className = 'code-meta'
    const warn = document.createElement('div')
    warn.className = 'code-warn'
    warn.textContent = 'Visible only in this ND view. Not available to agents or CLI.'
    slot.append(value, meta, warn)

    const expiresAt = Date.now() + Number(result.remaining) * 1_000
    const tick = () => {
      const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000))
      meta.textContent = `${left}s left · ${result.period}s period`
      if (left <= 0) {
        clearInterval(slot._timer)
        slot._timer = null
        if (!slot.hidden) void showCode(account, slot)
      }
    }
    tick()
    slot._timer = setInterval(tick, 1_000)
    state.timers.add(slot._timer)
  } catch (error) {
    slot.replaceChildren(document.createTextNode(error.message))
  }
}

function openEditor(account) {
  state.editor = account?.id ?? null
  els.editorTitle.textContent = account ? 'Edit account' : 'Add account'
  els.editEmail.value = account?.email ?? ''
  els.editEmail.disabled = Boolean(account)
  els.editLabel.value = account?.label ?? ''
  els.editPassword.value = ''
  els.editTotp.value = ''
  els.editPassword.required = !account
  els.passwordHint.textContent = account
    ? 'Leave blank to keep the saved app password.'
    : 'Use a Google App Password, not the account password.'
  els.editorPanel.hidden = false
  els.mailPanel.hidden = true
  clearTimers()
  els.editEmail.focus()
}

function closeEditor() {
  state.editor = null
  els.editorPanel.hidden = true
}

async function saveEditor(event) {
  event.preventDefault()
  if (state.busy) return
  const editing = state.editor
  const email = fieldValue(els.editEmail)
  const label = fieldValue(els.editLabel)
  const password = fieldValue(els.editPassword)
  const totp = fieldValue(els.editTotp)
  if (!email) { setNotice('Mailbox email is required.', 'error'); return }
  if (!editing && !password) { setNotice('Gmail app password is required.', 'error'); return }

  state.busy = true
  try {
    if (editing) {
      await invoke('update', {
        id: editing,
        label,
        ...(password ? { appPassword: password } : {}),
        ...(totp ? { totpSecret: totp } : {}),
      })
    } else {
      await invoke('create', {
        email,
        label,
        appPassword: password,
        ...(totp ? { totpSecret: totp } : {}),
      })
    }
    closeEditor()
    await refresh()
    setNotice(editing ? 'Account updated.' : 'Account saved. Secrets are sealed on this device.', 'ok')
  } catch (error) {
    setNotice(error.message, 'error')
  } finally {
    state.busy = false
  }
}

async function removeAccount(account) {
  if (state.busy) return
  const confirmed = window.confirm(`Delete ND Access for ${account.email}?\n\nThe sealed app password and 2FA secret are removed from this device.`)
  if (!confirmed) return
  state.busy = true
  try {
    await invoke('delete', { id: account.id })
    await refresh()
    setNotice('Account removed.', 'ok')
  } catch (error) {
    setNotice(error.message, 'error')
  } finally {
    state.busy = false
  }
}

async function openInbox(account) {
  clearTimers()
  closeEditor()
  els.mailPanel.hidden = false
  els.mailTitle.textContent = 'Inbox'
  els.mailSubtitle.textContent = account.email
  els.mailBody.replaceChildren(document.createTextNode('Reading the inbox…'))
  try {
    const inbox = await invoke('inbox', { id: account.id, limit: 15 })
    renderInbox(account, inbox)
  } catch (error) {
    els.mailBody.replaceChildren(document.createTextNode(error.message))
  }
}

function renderInbox(account, inbox) {
  els.mailBody.replaceChildren()
  els.mailSubtitle.textContent = `${account.email} · ${inbox.total} message${inbox.total === 1 ? '' : 's'}`
  if (!inbox.messages || inbox.messages.length === 0) {
    els.mailBody.append(document.createTextNode('This inbox is empty.'))
    return
  }
  for (const message of inbox.messages) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'mail-row'
    const subject = document.createElement('span')
    subject.className = 'mail-subject'
    subject.textContent = message.subject || '(no subject)'
    const meta = document.createElement('span')
    meta.className = 'mail-meta'
    meta.textContent = [message.from, message.date].filter(Boolean).join(' · ')
    row.append(subject, meta)
    row.addEventListener('click', () => { void openMessage(account, message.uid) })
    els.mailBody.append(row)
  }
}

async function openMessage(account, uid) {
  els.mailTitle.textContent = 'Message'
  els.mailSubtitle.textContent = account.email
  els.mailBody.replaceChildren(document.createTextNode('Opening the message…'))
  try {
    const message = await invoke('message', { id: account.id, uid })
    els.mailBody.replaceChildren()
    const head = document.createElement('div')
    head.className = 'mail-head'
    const subject = document.createElement('strong')
    subject.textContent = message.subject || '(no subject)'
    const from = document.createElement('span')
    from.textContent = message.from
    const date = document.createElement('span')
    date.textContent = message.date
    head.append(subject, from, date)
    const back = makeButton('← Back to inbox', 'ghost', () => { void openInbox(account) })
    const body = document.createElement('pre')
    body.className = 'mail-text'
    body.textContent = message.text || '(no text body)'
    els.mailBody.append(back, head, body)
  } catch (error) {
    els.mailBody.replaceChildren(document.createTextNode(error.message))
  }
}

document.getElementById('new-account').addEventListener('click', () => openEditor(null))
els.editorCancel.addEventListener('click', closeEditor)
els.editorForm.addEventListener('submit', (event) => { void saveEditor(event) })
els.mailClose.addEventListener('click', () => {
  els.mailPanel.hidden = true
  clearTimers()
})

bridge.whenConnected(async () => {
  els.connection.hidden = true
  try {
    await refresh()
  } catch (error) {
    setNotice(error.message, 'error')
  }
})

bridge.start()
