import { describe, expect, it } from 'vitest'
import {
  calculateDaysRemaining,
  computeAnnualBurn,
  computeMonthlyBurn,
  determineUrgency,
  filterSubscriptions,
  formatCurrency,
  formatCycleLabel,
  formatDate,
  formatStatusLabel,
  formatUrgencyText,
} from '../extensions/nd-pay-guard/ui/pay-guard-core.js'

describe('ND Pay Guard UI Pure Logic (pay-guard-core.js)', () => {
  it('formats currency with symbol or code fallback', () => {
    expect(formatCurrency(10.5, 'USD')).toMatch(/\$10\.50|USD\s*10\.50/)
    expect(formatCurrency(0, 'USD')).toMatch(/\$0\.00|USD\s*0\.00/)
    expect(formatCurrency(100, 'EUR')).toContain('100.00')
    expect(formatCurrency(5000, 'JPY')).toContain('5,000')
  })

  it('formats dates consistently', () => {
    expect(formatDate('2026-10-12')).toMatch(/Oct 12, 2026|12 Oct 2026/)
    expect(formatDate('')).toBe('—')
  })

  it('formats labels for cycles and statuses', () => {
    expect(formatCycleLabel('weekly')).toBe('Weekly')
    expect(formatCycleLabel('monthly')).toBe('Monthly')
    expect(formatCycleLabel('yearly')).toBe('Yearly')
    expect(formatCycleLabel('one-time')).toBe('One-time')

    expect(formatStatusLabel('active')).toBe('Active')
    expect(formatStatusLabel('paused')).toBe('Paused')
    expect(formatStatusLabel('cancelled')).toBe('Cancelled')
  })

  it('calculates days remaining between dates', () => {
    expect(calculateDaysRemaining('2026-10-12', '2026-10-12')).toBe(0)
    expect(calculateDaysRemaining('2026-10-12', '2026-10-15')).toBe(3)
    expect(calculateDaysRemaining('2026-10-15', '2026-10-12')).toBe(-3)
  })

  it('determines urgency levels and format texts', () => {
    expect(determineUrgency(-1, 3)).toBe('overdue')
    expect(determineUrgency(0, 3)).toBe('due-today')
    expect(determineUrgency(2, 3)).toBe('due-soon')
    expect(determineUrgency(5, 3)).toBe('upcoming')

    expect(formatUrgencyText(-2)).toBe('2d overdue')
    expect(formatUrgencyText(0)).toBe('Due today')
    expect(formatUrgencyText(1)).toBe('Due tomorrow')
    expect(formatUrgencyText(5)).toBe('Due in 5d')
  })

  it('filters subscriptions by status and query', () => {
    const list = [
      { id: '1', name: 'Netflix', status: 'active', notes: '4K family' },
      { id: '2', name: 'Spotify', status: 'paused', notes: 'Duo' },
      { id: '3', name: 'GitHub Copilot', status: 'active', notes: 'Coding' },
      { id: '4', name: 'Domain', status: 'cancelled', notes: 'Old site' },
    ]

    expect(filterSubscriptions(list, '', 'all').length).toBe(4)
    expect(filterSubscriptions(list, '', 'active').length).toBe(2)
    expect(filterSubscriptions(list, '', 'paused').length).toBe(1)
    expect(filterSubscriptions(list, 'spot', 'all').map((s) => s.name)).toEqual(['Spotify'])
    expect(filterSubscriptions(list, 'coding', 'all').map((s) => s.name)).toEqual(['GitHub Copilot'])
    expect(filterSubscriptions(list, 'net', 'active').map((s) => s.name)).toEqual(['Netflix'])
    expect(filterSubscriptions(list, 'net', 'paused').length).toBe(0)
  })

  it('computes monthly and annual burn rate grouped by currency', () => {
    const list = [
      { name: 'SaaS 1', amount: 10, currency: 'USD', cycle: 'monthly', status: 'active' },
      { name: 'SaaS 2', amount: 120, currency: 'USD', cycle: 'yearly', status: 'active' },
      { name: 'Weekly Tea', amount: 7, currency: 'GBP', cycle: 'weekly', status: 'active' },
      { name: 'Paused Item', amount: 50, currency: 'USD', cycle: 'monthly', status: 'paused' },
      { name: 'One-off Ticket', amount: 200, currency: 'USD', cycle: 'one-time', status: 'active' },
    ]

    const monthly = computeMonthlyBurn(list)
    expect(monthly.USD).toBe(20) // 10 + 120/12 = 20
    expect(monthly.GBP).toBeCloseTo(7 * (52 / 12), 2)

    const annual = computeAnnualBurn(list)
    expect(annual.USD).toBe(240) // 10*12 + 120 = 240
    expect(annual.GBP).toBe(7 * 52) // 364
  })
})
