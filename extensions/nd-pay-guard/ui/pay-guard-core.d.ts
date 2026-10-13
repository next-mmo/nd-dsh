export function formatCurrency(amount: number, currency?: string): string
export function formatDate(isoDate: string): string
export function formatCycleLabel(cycle: string): string
export function formatStatusLabel(status: string): string
export function calculateDaysRemaining(todayIso: string, targetIso: string): number
export function determineUrgency(daysRemaining: number, reminderDays?: number): 'overdue' | 'due-today' | 'due-soon' | 'upcoming'
export function formatUrgencyText(daysRemaining: number): string
export function filterSubscriptions<T extends { name: string; notes?: string; currency?: string; status: string }>(
  subscriptions: T[],
  query?: string,
  statusFilter?: string,
): T[]
export function computeMonthlyBurn(subscriptions: Array<{ status: string; amount: number; currency?: string; cycle: string }>): Record<string, number>
export function computeAnnualBurn(subscriptions: Array<{ status: string; amount: number; currency?: string; cycle: string }>): Record<string, number>
