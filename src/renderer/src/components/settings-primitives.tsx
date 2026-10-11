import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../lib/utils'

/** Shared row/card styling for the settings views (pane, engines, presets, QA). */
export function SettingsSection({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('mt-[22px]', className)}>
      <h2 className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

export function SettingsRow({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div
      {...(label === undefined ? {} : { role: 'group', 'aria-label': label })}
      className={cn('flex min-w-0 items-center justify-between gap-4 rounded-lg border border-border-soft bg-surface-1 px-[13px] py-[11px]', className)}
    >
      {children}
    </div>
  )
}

export const rowStack = 'flex min-w-0 flex-col gap-[3px]'
export const rowTitle = 'text-xs font-semibold text-foreground'
export const rowDesc = 'text-[10px]/[1.45] text-faint'
export const rowPathText = 'max-w-[300px] truncate text-[10px]/[1.45] text-faint'
export const rowValueText = 'shrink-0 font-mono text-[9px] text-muted-foreground'

export function StatusChip({ good, warn, neutral, children }: { good?: boolean | undefined; warn?: boolean | undefined; neutral?: boolean | undefined; children: ReactNode }) {
  return (
    <span
      className={cn(
        'shrink-0 text-[10px] font-semibold',
        neutral ? 'text-muted-foreground' : good ? 'text-primary' : warn ? 'text-warning' : 'text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}

/** Shared on/off switch so every settings surface renders toggles the same way. */
export function SettingsSwitch({ label, checked, disabled, onCheckedChange }: {
  label: string
  checked: boolean
  disabled?: boolean
  onCheckedChange(checked: boolean): void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      className={cn(
        'relative h-[20px] w-[34px] shrink-0 rounded-full border transition-colors',
        checked ? 'border-primary bg-primary' : 'border-border-strong bg-secondary',
        'disabled:pointer-events-none disabled:opacity-45',
      )}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className={cn(
        'absolute top-[2px] size-[14px] rounded-full bg-background shadow-sm transition-[left]',
        checked ? 'left-[16px]' : 'left-[2px]',
      )} />
    </button>
  )
}

export function SettingsButton({ active, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean | undefined }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'shrink-0 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-[10px] text-soft transition-colors',
        'hover:border-(--border-focus) hover:text-foreground',
        'disabled:pointer-events-none disabled:opacity-45',
        active && 'border-primary/40 text-primary',
        className,
      )}
    />
  )
}

export function SettingsNote({ good, children }: { good?: boolean; children: ReactNode }) {
  return (
    <p className={cn('mb-2.5 mt-1.5 text-[10px]/[1.5]', good ? 'text-primary' : 'text-muted-foreground', '[&_code]:rounded-[4px] [&_code]:border [&_code]:border-border-soft [&_code]:bg-meta [&_code]:px-[5px] [&_code]:py-px [&_code]:font-mono [&_code]:text-[9px]')}>
      {children}
    </p>
  )
}
