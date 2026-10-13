/**
 * ND Pay Guard — Web View UI Controller.
 *
 * Runs inside ND's sandboxed iframe: opaque origin, no Node, no network.
 * All operations communicate strictly through the nd.webview/1 postMessage bridge.
 */

import {
  formatCurrency,
  formatDate,
  formatCycleLabel,
  formatStatusLabel,
  calculateDaysRemaining,
  determineUrgency,
  formatUrgencyText,
  filterSubscriptions,
} from './pay-guard-core.js'

// --- nd.webview/1 Bridge Client ---------------------------------------------

function createBridge() {
  let hello = null
  const pending = new Map()
  const connectQueue = []

  let retryTimer = null
  let slowTimer = null

  const stopRetries = () => {
    if (retryTimer) {
      clearInterval(retryTimer)
      retryTimer = null
    }
    if (slowTimer) {
      clearInterval(slowTimer)
      slowTimer = null
    }
  }

  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.kind === 'nd-webview:hello' && data.protocol === 'nd.webview/1') {
      hello = data
      stopRetries()
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

  // Announce readiness until host answers handshake
  let attempts = 0
  const announce = () => window.parent.postMessage({ kind: 'nd-webview:ready' }, '*')
  announce()
  retryTimer = setInterval(() => {
    if (hello) {
      stopRetries()
      return
    }
    attempts += 1
    if (attempts > 40) {
      clearInterval(retryTimer)
      retryTimer = null
      slowTimer = setInterval(() => {
        if (hello) {
          stopRetries()
          return
        }
        announce()
      }, 2000)
      return
    }
    announce()
  }, 250)

  return {
    get connected() {
      return Boolean(hello)
    },
    whenConnected(fn) {
      if (hello) fn()
      else connectQueue.push(fn)
    },
    invoke(input) {
      if (!hello) {
        return Promise.resolve({ ok: false, error: { code: 'unavailable', message: 'Connecting to ND...' } })
      }
      const requestId = crypto.randomUUID()
      return new Promise((resolve) => {
        pending.set(requestId, resolve)
        window.parent.postMessage({ kind: 'nd-webview:invoke', requestId, input }, '*')
        setTimeout(() => {
          if (pending.has(requestId)) {
            pending.delete(requestId)
            resolve({ ok: false, error: { code: 'timeout', message: 'ND host did not respond in time' } })
          }
        }, 10_000)
      })
    },
  }
}

const bridge = createBridge()

// --- UI State & Elements ----------------------------------------------------

const state = {
  subscriptions: [],
  upcoming: null,
  summary: null,
  query: '',
  filter: 'all',
  editingId: null,
}

const el = {
  summaryMonthly: document.getElementById('summary-monthly'),
  summaryAnnual: document.getElementById('summary-annual'),
  summaryActiveCount: document.getElementById('summary-active-count'),
  summaryDueSoon: document.getElementById('summary-due-soon'),
  upcomingList: document.getElementById('upcoming-list'),
  upcomingCount: document.getElementById('upcoming-count'),
  subsList: document.getElementById('subs-list'),
  searchInput: document.getElementById('search-input'),
  filterButtons: document.querySelectorAll('.filter-btn'),
  modalBackdrop: document.getElementById('modal-backdrop'),
  modalTitle: document.getElementById('modal-title'),
  modalCloseBtn: document.getElementById('modal-close-btn'),
  modalCancelBtn: document.getElementById('modal-cancel-btn'),
  subForm: document.getElementById('sub-form'),
  btnAddSub: document.getElementById('btn-add-sub'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnTestNotification: document.getElementById('btn-test-notification'),
  toasts: document.getElementById('toasts'),
  notificationBanner: document.getElementById('notification-banner'),
  notificationBannerIcon: document.getElementById('notification-banner-icon'),
  notificationBannerTitle: document.getElementById('notification-banner-title'),
  notificationBannerMessage: document.getElementById('notification-banner-message'),
  notificationBannerGuidance: document.getElementById('notification-banner-guidance'),
  notificationBannerClose: document.getElementById('notification-banner-close'),
  // Form fields
  formSubId: document.getElementById('form-sub-id'),
  formName: document.getElementById('form-name'),
  formAmount: document.getElementById('form-amount'),
  formCurrency: document.getElementById('form-currency'),
  formCycle: document.getElementById('form-cycle'),
  formRenewalDate: document.getElementById('form-renewal-date'),
  formReminderDays: document.getElementById('form-reminder-days'),
  formStatus: document.getElementById('form-status'),
  formUrl: document.getElementById('form-url'),
  formNotes: document.getElementById('form-notes'),
}

// --- Notification Banner & Toast Feedback -----------------------------------

function showNotificationBanner({ success, title, message, guidance }) {
  if (!el.notificationBanner) return
  el.notificationBanner.classList.remove('hidden', 'error', 'success')
  el.notificationBanner.classList.add(success ? 'success' : 'error')
  if (el.notificationBannerIcon) {
    el.notificationBannerIcon.textContent = success ? '✅' : '⚠️'
  }
  if (el.notificationBannerTitle) {
    el.notificationBannerTitle.textContent =
      title || (success ? 'OS Notification Delivered' : 'OS Notification Delivery Failed')
  }
  if (el.notificationBannerMessage) {
    el.notificationBannerMessage.textContent = message || ''
  }
  if (el.notificationBannerGuidance) {
    if (guidance) {
      el.notificationBannerGuidance.textContent = guidance
      el.notificationBannerGuidance.style.display = 'block'
    } else {
      el.notificationBannerGuidance.textContent = ''
      el.notificationBannerGuidance.style.display = 'none'
    }
  }
}

function hideNotificationBanner() {
  if (el.notificationBanner) {
    el.notificationBanner.classList.add('hidden')
  }
}

function showToast(message, type = 'normal') {
  if (!el.toasts) return
  const toast = document.createElement('div')
  toast.className = `toast ${type}`
  toast.textContent = message
  el.toasts.appendChild(toast)
  setTimeout(() => {
    toast.style.opacity = '0'
    toast.style.transition = 'opacity 200ms ease'
    setTimeout(() => toast.remove(), 200)
  }, type === 'error' ? 5000 : 3200)
}

// --- Data Operations --------------------------------------------------------

async function loadData() {
  const result = await bridge.invoke({ action: 'list' })
  if (!result.ok) {
    showToast(result.error?.message || 'Could not load subscriptions', 'error')
    return
  }
  const data = result.value || {}
  state.subscriptions = Array.isArray(data.subscriptions) ? data.subscriptions : []
  state.upcoming = data.upcoming || null
  state.summary = data.summary || null
  renderAll()
}

async function markPaid(id) {
  const result = await bridge.invoke({ action: 'mark-paid', id })
  if (!result.ok) {
    showToast(result.error?.message || 'Failed to mark as paid', 'error')
    return
  }
  showToast('Marked as paid! Next renewal date advanced.', 'success')
  await loadData()
}

async function deleteSubscription(id, name) {
  if (!confirm(`Are you sure you want to stop tracking "${name}"?`)) return
  const result = await bridge.invoke({ action: 'delete', id })
  if (!result.ok) {
    showToast(result.error?.message || 'Failed to delete subscription', 'error')
    return
  }
  showToast(`Deleted "${name}".`, 'normal')
  await loadData()
}

async function openExternalUrl(url) {
  if (!url) return
  const result = await bridge.invoke({ action: 'open-url', url })
  if (!result.ok) {
    showToast(result.error?.message || 'Could not open URL', 'error')
  }
}

async function sendTestNotification() {
  if (el.btnTestNotification) {
    el.btnTestNotification.disabled = true
    el.btnTestNotification.textContent = 'Testing...'
  }
  try {
    const result = await bridge.invoke({ action: 'notify-test' })
    const data = result?.value

    if (!result?.ok || !data?.delivered) {
      const errorMsg = data?.message || result?.error?.message || 'OS desktop notification could not be delivered.'
      const guidance = data?.guidance || 'Check operating system notification settings and code signature.'
      showNotificationBanner({
        success: false,
        title: 'OS Notification Delivery Failed',
        message: errorMsg,
        guidance,
      })
      showToast(errorMsg, 'error')
      return
    }

    showNotificationBanner({
      success: true,
      title: 'OS Notification Delivered',
      message: data.message || 'Test notification delivered to system notification center.',
      guidance: 'Keep ND running to receive scheduled renewal alerts on time.',
    })
    showToast(data.message || 'Test notification delivered to OS center.', 'success')
  } catch (err) {
    const errMsg = err?.message || 'Failed to trigger test notification'
    showNotificationBanner({
      success: false,
      title: 'OS Notification Error',
      message: errMsg,
      guidance: 'An unexpected error occurred while communicating with the desktop host.',
    })
    showToast(errMsg, 'error')
  } finally {
    if (el.btnTestNotification) {
      el.btnTestNotification.disabled = false
      el.btnTestNotification.innerHTML = '<span>🔔</span> Test notification'
    }
  }
}

// --- Rendering --------------------------------------------------------------

function renderSummary() {
  const summary = state.summary
  const upcoming = state.upcoming

  if (summary && summary.monthlyBurnByCurrency) {
    const currencies = Object.keys(summary.monthlyBurnByCurrency)
    if (currencies.length === 0) {
      el.summaryMonthly.textContent = '$0.00'
      el.summaryAnnual.textContent = '$0.00'
    } else {
      const monthlyStr = currencies.map((cur) => formatCurrency(summary.monthlyBurnByCurrency[cur], cur)).join(' + ')
      const annualStr = currencies.map((cur) => formatCurrency(summary.annualBurnByCurrency[cur], cur)).join(' + ')
      el.summaryMonthly.textContent = monthlyStr
      el.summaryAnnual.textContent = annualStr
    }
    el.summaryActiveCount.textContent = String(summary.activeCount || 0)
  } else {
    el.summaryMonthly.textContent = '—'
    el.summaryAnnual.textContent = '—'
    el.summaryActiveCount.textContent = String(state.subscriptions.filter((s) => s.status === 'active').length)
  }

  const dueSoon = upcoming ? upcoming.dueSoonCount : 0
  el.summaryDueSoon.textContent = String(dueSoon)
  if (dueSoon > 0) {
    el.summaryDueSoon.style.color = 'var(--warning)'
  } else {
    el.summaryDueSoon.style.color = 'var(--text)'
  }
}

function renderUpcoming() {
  const upcoming = state.upcoming?.charges || []
  el.upcomingCount.textContent = `${upcoming.length} charge${upcoming.length === 1 ? '' : 's'}`

  if (upcoming.length === 0) {
    el.upcomingList.innerHTML = '<div class="empty-state" style="padding: 16px; width: 100%;">No charges due in the next 30 days.</div>'
    return
  }

  el.upcomingList.innerHTML = ''
  for (const item of upcoming) {
    const card = document.createElement('div')
    const isUrgent = item.urgency === 'due-soon'
    const isCritical = item.urgency === 'due-today' || item.urgency === 'overdue'
    card.className = `upcoming-card ${isCritical ? 'critical' : isUrgent ? 'urgent' : ''}`

    const urgencyClass = `badge ${item.urgency}`
    const urgencyLabel = formatUrgencyText(item.daysRemaining)

    card.innerHTML = `
      <div class="upcoming-top">
        <div>
          <div class="upcoming-name" title="${item.name}">${escapeHtml(item.name)}</div>
          <div class="upcoming-meta" style="margin-top: 2px;">${formatCycleLabel(item.cycle)}</div>
        </div>
        <span class="${urgencyClass}">${urgencyLabel}</span>
      </div>
      <div>
        <div class="upcoming-cost">${formatCurrency(item.amount, item.currency)}</div>
        <div class="upcoming-meta">Renews: ${formatDate(item.nextRenewalDate)}</div>
      </div>
      <div style="display: flex; gap: 6px; margin-top: 4px;">
        <button class="sm primary btn-mark-paid" style="flex: 1; justify-content: center;" type="button" data-id="${item.id}">
          ✓ Paid
        </button>
      </div>
    `
    el.upcomingList.appendChild(card)
  }

  el.upcomingList.querySelectorAll('.btn-mark-paid').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-id')
      if (id) markPaid(id)
    })
  })
}

function renderSubscriptions() {
  const filtered = filterSubscriptions(state.subscriptions, state.query, state.filter)

  if (filtered.length === 0) {
    el.subsList.innerHTML = `
      <div class="empty-state">
        <span>No matching subscriptions found.</span>
        <span style="font-size: 11px;">Try adjusting search query or click "+ Add Subscription".</span>
      </div>
    `
    return
  }

  el.subsList.innerHTML = ''
  for (const sub of filtered) {
    const item = document.createElement('div')
    item.className = 'sub-item'

    const statusBadgeClass = `badge ${sub.status}`
    const statusLabel = formatStatusLabel(sub.status)
    const cycleLabel = formatCycleLabel(sub.cycle)
    const formattedPrice = formatCurrency(sub.amount, sub.currency)
    const renewalFormatted = formatDate(sub.nextRenewalDate)

    const urlButton = sub.url
      ? `<button class="sm btn-open-url" type="button" data-url="${escapeHtml(sub.url)}" title="Open management website">🔗 Site</button>`
      : ''

    item.innerHTML = `
      <div class="sub-info">
        <div class="sub-header">
          <span class="sub-name">${escapeHtml(sub.name)}</span>
          <span class="${statusBadgeClass}">${statusLabel}</span>
          <span class="badge upcoming">${cycleLabel}</span>
          ${sub.notes ? `<span style="font-size: 11px; color: var(--text-faint); max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(sub.notes)}">📝 ${escapeHtml(sub.notes)}</span>` : ''}
        </div>
        <div class="sub-details">
          <span><b class="sub-price">${formattedPrice}</b></span>
          <span>Next: <b>${renewalFormatted}</b></span>
          <span>Reminder: <b>${sub.reminderDays}d before</b></span>
          ${sub.lastPaidDate ? `<span>Last paid: ${formatDate(sub.lastPaidDate)}</span>` : ''}
        </div>
      </div>
      <div class="sub-actions">
        ${urlButton}
        ${sub.status === 'active' ? `<button class="sm primary btn-mark-paid" type="button" data-id="${sub.id}">Mark Paid</button>` : ''}
        <button class="sm btn-edit" type="button" data-id="${sub.id}">Edit</button>
        <button class="sm danger btn-delete" type="button" data-id="${sub.id}" data-name="${escapeHtml(sub.name)}">Delete</button>
      </div>
    `
    el.subsList.appendChild(item)
  }

  // Attach event handlers
  el.subsList.querySelectorAll('.btn-mark-paid').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id')
      if (id) markPaid(id)
    })
  })

  el.subsList.querySelectorAll('.btn-edit').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id')
      const sub = state.subscriptions.find((s) => s.id === id)
      if (sub) openModal(sub)
    })
  })

  el.subsList.querySelectorAll('.btn-delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id')
      const name = btn.getAttribute('data-name') || 'subscription'
      if (id) deleteSubscription(id, name)
    })
  })

  el.subsList.querySelectorAll('.btn-open-url').forEach((btn) => {
    btn.addEventListener('click', () => {
      const url = btn.getAttribute('data-url')
      if (url) openExternalUrl(url)
    })
  })
}

function renderAll() {
  renderSummary()
  renderUpcoming()
  renderSubscriptions()
}

function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// --- Modal Handlers ---------------------------------------------------------

function openModal(sub = null) {
  state.editingId = sub ? sub.id : null
  el.modalTitle.textContent = sub ? 'Edit Subscription' : 'Add Subscription'

  if (sub) {
    el.formSubId.value = sub.id
    el.formName.value = sub.name || ''
    el.formAmount.value = sub.amount !== undefined ? sub.amount : ''
    el.formCurrency.value = sub.currency || 'USD'
    el.formCycle.value = sub.cycle || 'monthly'
    el.formRenewalDate.value = sub.nextRenewalDate || ''
    el.formReminderDays.value = sub.reminderDays !== undefined ? sub.reminderDays : 3
    el.formStatus.value = sub.status || 'active'
    el.formUrl.value = sub.url || ''
    el.formNotes.value = sub.notes || ''
  } else {
    el.formSubId.value = ''
    el.formName.value = ''
    el.formAmount.value = ''
    el.formCurrency.value = 'USD'
    el.formCycle.value = 'monthly'
    const today = new Date().toISOString().split('T')[0]
    el.formRenewalDate.value = today
    el.formReminderDays.value = '3'
    el.formStatus.value = 'active'
    el.formUrl.value = ''
    el.formNotes.value = ''
  }

  el.modalBackdrop.classList.add('open')
  el.formName.focus()
}

function closeModal() {
  el.modalBackdrop.classList.remove('open')
  state.editingId = null
}

async function handleFormSubmit(e) {
  e.preventDefault()

  const name = el.formName.value.trim()
  const amount = Number(el.formAmount.value)
  const currency = el.formCurrency.value
  const cycle = el.formCycle.value
  const nextRenewalDate = el.formRenewalDate.value
  const reminderDays = Number(el.formReminderDays.value)
  const status = el.formStatus.value
  const url = el.formUrl.value.trim()
  const notes = el.formNotes.value.trim()

  if (!name || Number.isNaN(amount) || !nextRenewalDate) {
    showToast('Please fill in all required fields.', 'error')
    return
  }

  const payload = {
    name,
    amount,
    currency,
    cycle,
    nextRenewalDate,
    reminderDays,
    status,
    url,
    notes,
  }

  if (state.editingId) {
    const result = await bridge.invoke({
      action: 'update',
      id: state.editingId,
      ...payload,
    })
    if (!result.ok) {
      showToast(result.error?.message || 'Failed to update subscription', 'error')
      return
    }
    showToast(`Updated "${name}".`, 'success')
  } else {
    const result = await bridge.invoke({
      action: 'create',
      ...payload,
    })
    if (!result.ok) {
      showToast(result.error?.message || 'Failed to create subscription', 'error')
      return
    }
    showToast(`Added "${name}" to Pay Guard.`, 'success')
  }

  closeModal()
  await loadData()
}

// --- Event Listeners --------------------------------------------------------

el.btnAddSub.addEventListener('click', () => openModal(null))
el.btnRefresh.addEventListener('click', () => loadData())
el.btnTestNotification.addEventListener('click', () => sendTestNotification())
el.notificationBannerClose?.addEventListener('click', () => hideNotificationBanner())
el.modalCloseBtn.addEventListener('click', () => closeModal())
el.modalCancelBtn.addEventListener('click', () => closeModal())
el.subForm.addEventListener('submit', handleFormSubmit)

el.searchInput.addEventListener('input', (e) => {
  state.query = e.target.value
  renderSubscriptions()
})

el.filterButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    el.filterButtons.forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    state.filter = btn.getAttribute('data-filter') || 'all'
    renderSubscriptions()
  })
})

el.modalBackdrop.addEventListener('click', (e) => {
  if (e.target === el.modalBackdrop) closeModal()
})

// Initialize when connected
bridge.whenConnected(() => {
  void loadData()
})
