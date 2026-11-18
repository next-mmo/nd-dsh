import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../lib/utils'

/** Shared row/card styling for the settings views (pane, engines, presets, QA). */
export function SettingsSection({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('mt-[22px]', className)}>
      <h2 className="mb-2.5 px-0.5 text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

export function SettingsRow({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div
      {...(label === undefined ? {} : { role: 'group', 'aria-label': label })}
      className={cn(
        'flex min-w-0 items-center justify-between gap-4 rounded-[11px] border border-border-soft bg-surface-1 px-3.5 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.06),inset_0_1px_0_rgba(255,255,255,0.04)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.05)]',
        className,
      )}
    >
      {children}
    </div>
  )
}

export const rowStack = 'flex min-w-0 flex-col gap-[3px]'
export const rowTitle = 'text-[12.5px] font-semibold tracking-[-0.01em] text-foreground'
export const rowDesc = 'text-[11px]/[1.45] text-faint'
export const rowPathText = 'max-w-[320px] truncate text-[10.5px]/[1.45] text-faint'
export const rowValueText = 'shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground'

export function StatusChip({ good, warn, neutral, children }: { good?: boolean | undefined; warn?: boolean | undefined; neutral?: boolean | undefined; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-tight',
        neutral
          ? 'border-border-soft bg-muted text-muted-foreground'
          : good
            ? 'border-primary/25 bg-primary/10 text-primary'
            : warn
              ? 'border-warning/30 bg-warning/10 text-warning'
              : 'border-border-soft bg-muted text-muted-foreground',
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
        'relative inline-flex h-[20px] w-[36px] shrink-0 items-center rounded-full border p-[2px] transition-[background-color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35',
        checked
          ? 'border-primary/80 bg-primary shadow-[inset_0_1px_1px_rgba(0,0,0,0.12)]'
          : 'border-black/10 bg-black/[0.14] shadow-[inset_0_1px_2px_rgba(0,0,0,0.16)] dark:border-white/10 dark:bg-white/[0.16]',
        'disabled:pointer-events-none disabled:opacity-45',
      )}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className={cn(
        'pointer-events-none block size-[14px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.30),0_1px_1px_rgba(0,0,0,0.16),inset_0_0.5px_0_rgba(255,255,255,0.95)] transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]',
        checked ? 'translate-x-[16px]' : 'translate-x-0',
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
        'shrink-0 rounded-[8px] border border-border-strong/80 bg-secondary bg-gradient-to-b from-white/[0.06] to-transparent px-2.5 py-1.5 text-[11px] font-medium text-soft shadow-[0_1px_2px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.08)] transition-all duration-150',
        'hover:border-(--border-focus) hover:bg-accent hover:text-foreground active:scale-[0.985]',
        'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25',
        'disabled:pointer-events-none disabled:opacity-45 disabled:active:scale-100',
        active && 'border-primary/45 bg-primary/12 text-primary shadow-[0_1px_2px_rgba(10,132,255,0.16),inset_0_1px_0_rgba(255,255,255,0.12)]',
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
