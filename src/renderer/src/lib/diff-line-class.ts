export function diffLineClass(line: string): string | false {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-fainter'
  if (line.startsWith('+')) return 'bg-primary/10 text-foreground'
  if (line.startsWith('-')) return 'bg-destructive/15 text-foreground'
  if (line.startsWith('@')) return 'text-info'
  return false
}
