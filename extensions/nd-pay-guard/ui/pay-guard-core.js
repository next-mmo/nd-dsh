/**
 * ND Pay Guard — pure client logic and formatting.
 *
 * Runs inside the unbuilt package web view and is imported directly by
 * unit tests to verify calculation, formatting, and filtering behaviors.
 */

/**
 * Format currency amount with currency code or symbol.
 */
export function formatCurrency(amount, currency = 'USD') {
  const num = typeof amount === 'number' ? amount : Number(amount) || 0
  const cur = typeof currency === 'string' && currency.trim() ? currency.trim().toUpperCase() : 'USD'
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num)
  } catch {
    return `${cur} ${num.toFixed(2)}`
  }
}

/**
 * Format an ISO date string (YYYY-MM-DD) into a human readable string.
 */
export function formatDate(isoDate) {
  if (!isoDate || typeof isoDate !== 'string') return '—'
  const parts = isoDate.split('-').map(Number)
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return isoDate
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]))
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * Format cycle into clean display label.
 */
export function formatCycleLabel(cycle) {
  switch (cycle) {
    case 'weekly':
      return 'Weekly'
    case 'monthly':
      return 'Monthly'
    case 'yearly':
      return 'Yearly'
    case 'one-time':
      return 'One-time'
    default:
      return cycle || 'Monthly'
  }
}

/**
 * Format status into display label.
 */
export function formatStatusLabel(status) {
  switch (status) {
    case 'active':
      return 'Active'
    case 'paused':
      return 'Paused'
    case 'cancelled':
      return 'Cancelled'
    default:
      return status || 'Active'
  }
}

/**
 * Calculate calendar difference in days between two YYYY-MM-DD dates.
 */
export function calculateDaysRemaining(todayIso, targetIso) {
  if (!todayIso || !targetIso) return 0
  const t = todayIso.split('-').map(Number)
  const d = targetIso.split('-').map(Number)
  if (t.length !== 3 || d.length !== 3) return 0
  const todayUtc = Date.UTC(t[0], t[1] - 1, t[2])
  const targetUtc = Date.UTC(d[0], d[1] - 1, d[2])
  return Math.round((targetUtc - todayUtc) / (24 * 60 * 60 * 1000))
}

/**
 * Determine urgency level based on days remaining and reminder threshold.
 */
export function determineUrgency(daysRemaining, reminderDays = 3) {
  if (daysRemaining < 0) return 'overdue'
  if (daysRemaining === 0) return 'due-today'
  if (daysRemaining <= reminderDays) return 'due-soon'
  return 'upcoming'
}

/**
 * Human-readable urgency badge text.
 */
export function formatUrgencyText(daysRemaining) {
  if (daysRemaining < 0) return `${Math.abs(daysRemaining)}d overdue`
  if (daysRemaining === 0) return 'Due today'
  if (daysRemaining === 1) return 'Due tomorrow'
  return `Due in ${daysRemaining}d`
}

/**
 * Filter subscriptions by text search and status filter.
 */
export function filterSubscriptions(subscriptions, query = '', statusFilter = 'all') {
  if (!Array.isArray(subscriptions)) return []
  const q = query.trim().toLowerCase()
  const status = statusFilter.trim().toLowerCase()

  return subscriptions.filter((sub) => {
    if (status !== 'all' && sub.status !== status) return false
    if (!q) return true
    const nameMatch = sub.name && sub.name.toLowerCase().includes(q)
    const notesMatch = sub.notes && sub.notes.toLowerCase().includes(q)
    const curMatch = sub.currency && sub.currency.toLowerCase().includes(q)
    return Boolean(nameMatch || notesMatch || curMatch)
  })
}

/**
 * Compute monthly burn across active subscriptions grouped by currency.
 */
export function computeMonthlyBurn(subscriptions) {
  if (!Array.isArray(subscriptions)) return {}
  const totals = {}
  for (const sub of subscriptions) {
    if (sub.status !== 'active') continue
    const cur = (sub.currency || 'USD').toUpperCase()
    let monthly = 0
    switch (sub.cycle) {
      case 'weekly':
        monthly = sub.amount * (52 / 12)
        break
      case 'monthly':
        monthly = sub.amount
        break
      case 'yearly':
        monthly = sub.amount / 12
        break
      case 'one-time':
        monthly = 0
        break
    }
    totals[cur] = Math.round(((totals[cur] || 0) + monthly) * 100) / 100
  }
  return totals
}

/**
 * Compute annual burn across active subscriptions grouped by currency.
 */
export function computeAnnualBurn(subscriptions) {
  if (!Array.isArray(subscriptions)) return {}
  const totals = {}
  for (const sub of subscriptions) {
    if (sub.status !== 'active') continue
    const cur = (sub.currency || 'USD').toUpperCase()
    let annual = 0
    switch (sub.cycle) {
      case 'weekly':
        annual = sub.amount * 52
        break
      case 'monthly':
        annual = sub.amount * 12
        break
      case 'yearly':
        annual = sub.amount
        break
      case 'one-time':
        annual = 0
        break
    }
    totals[cur] = Math.round(((totals[cur] || 0) + annual) * 100) / 100
  }
  return totals
}
