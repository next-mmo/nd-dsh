import { cn } from '../lib/utils'

/** Chrome-style identity chip: colored disc + first letter of the profile name. */
export function BrowserProfileAvatar({ name, color, size = 22, className }: {
  name: string
  color: string
  size?: number
  className?: string
}) {
  const initial = (name.trim().charAt(0) || 'N').toUpperCase()
  return (
    <span
      aria-hidden="true"
      className={cn('grid shrink-0 place-items-center rounded-full font-semibold text-white', className)}
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        fontSize: Math.max(9, Math.round(size * 0.46)),
      }}
    >
      {initial}
    </span>
  )
}
