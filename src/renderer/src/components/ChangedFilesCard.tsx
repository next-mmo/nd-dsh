import { useEffect, useMemo, useState } from 'react'
import { ChevronDownIcon, RotateIcon } from './Icons'
import { diffLineClass } from '../lib/diff-line-class'
import { fileAccent } from '../lib/file-accents'
import { cn } from '../lib/utils'

interface ChangedFilesCardProps {
  files: string[]
  onOpenFile?(path: string): void
  onError(message: string): void
}

interface DiffStats {
  adds: number
  dels: number
}

function diffStats(patch: string): DiffStats {
  let adds = 0
  let dels = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) adds++
    else if (line.startsWith('-')) dels++
  }
  return { adds, dels }
}

/**
 * Chat-side summary of the files the current thread changed: per-file
 * add/delete counts, an inline review diff, open-in-editor, and an undo
 * (git discard) action for the agent's edits.
 */
export function ChangedFilesCard({ files, onOpenFile, onError }: ChangedFilesCardProps) {
  const [open, setOpen] = useState(true)
  const [patches, setPatches] = useState<Record<string, string>>({})
  const [reviewed, setReviewed] = useState<Set<string>>(new Set())
  const [confirmUndo, setConfirmUndo] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [undone, setUndone] = useState(false)

  // A new edit in the thread changes the file set; forget stale patches,
  // review state, and any completed undo so the card reflects the fresh turn.
  const filesKey = useMemo(() => files.join('\n'), [files])
  useEffect(() => {
    setPatches({})
    setReviewed(new Set())
    setConfirmUndo(false)
    setUndoing(false)
    setUndone(false)
  }, [filesKey])

  // Diffs load when the card is expanded; totals stay hidden until ready so
  // the header never flickers a partial count.
  useEffect(() => {
    if (!open) return
    let mounted = true
    void Promise.all(files.map(async (file) => {
      try {
        return [file, await window.ndDsh.git.diff(file)] as const
      } catch (cause) {
        if (mounted) onError(cause instanceof Error ? cause.message : String(cause))
        return [file, ''] as const
      }
    })).then((entries) => {
      if (mounted) setPatches(Object.fromEntries(entries))
    })
    return () => {
      mounted = false
    }
  }, [open, filesKey, files, onError])

  useEffect(() => {
    if (!confirmUndo) return
    const timer = window.setTimeout(() => setConfirmUndo(false), 4_000)
    return () => window.clearTimeout(timer)
  }, [confirmUndo])

  if (undone) return null

  const loaded = Object.keys(patches).length
  const totals = Object.entries(patches).reduce<DiffStats>(
    (acc, [, patch]) => {
      const stats = diffStats(patch)
      return { adds: acc.adds + stats.adds, dels: acc.dels + stats.dels }
    },
    { adds: 0, dels: 0 },
  )
  const patchesReady = loaded === files.length

  const undo = async (): Promise<void> => {
    if (!confirmUndo) {
      setConfirmUndo(true)
      return
    }
    setUndoing(true)
    try {
      await window.ndDsh.git.discard(files)
      setUndone(true)
    } catch (cause) {
      setUndoing(false)
      setConfirmUndo(false)
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const toggleReview = (file: string): void => {
    setReviewed((current) => {
      const next = new Set(current)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }

  return (
    <div className="mx-3 my-1.5 rounded-lg border border-border-soft bg-surface-1 text-[11px]">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-px text-left transition-colors hover:text-foreground [&_svg]:size-3 [&_svg]:shrink-0"
          onClick={() => setOpen((v) => !v)}
          title={open ? 'Collapse changed files' : 'Expand changed files'}
        >
          <ChevronDownIcon className={cn('text-faint transition-transform', !open && '-rotate-90')} />
          <span className="shrink-0 font-semibold text-foreground">
            {files.length} file{files.length === 1 ? '' : 's'} changed
          </span>
          {patchesReady && (totals.adds > 0 || totals.dels > 0) ? (
            <span className="flex shrink-0 gap-1.5 font-mono text-[10px]">
              <span className="text-primary">+{totals.adds}</span>
              <span className="text-destructive">-{totals.dels}</span>
            </span>
          ) : null}
        </button>
        <button
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-medium transition-colors [&_svg]:size-[9px]',
            confirmUndo
              ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
              : 'border-border-strong text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
          disabled={undoing}
          title="Revert the agent's edits to these files (git discard; new files are deleted)"
          onClick={() => void undo()}
        >
          <RotateIcon />
          {undoing ? 'Undoing…' : confirmUndo ? 'Confirm undo' : 'Undo'}
        </button>
      </div>

      {open ? (
        <div className="flex flex-col gap-px px-1.5 pb-1.5">
          {files.map((file) => {
            const separator = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
            const name = separator === -1 ? file : file.slice(separator + 1)
            const dir = separator === -1 ? '' : file.slice(0, separator + 1)
            const patch = patches[file]
            const stats = patch !== undefined ? diffStats(patch) : null
            const expanded = reviewed.has(file)
            return (
              <div key={file} className="rounded-[6px] bg-surface-0/60">
                <div className="flex items-center gap-1.5 px-1 py-[3px]">
                  <span className="size-[7px] shrink-0 rounded-[2px]" style={{ backgroundColor: fileAccent(file) }} />
                  <span className="min-w-0 truncate text-[10px]">
                    <span className="font-medium text-foreground">{name}</span>
                    {dir ? <span className="text-faint">{dir}</span> : null}
                  </span>
                  {stats ? (
                    <span className="flex shrink-0 gap-1 font-mono text-[9px]">
                      {stats.adds > 0 ? <span className="text-primary">+{stats.adds}</span> : null}
                      {stats.dels > 0 ? <span className="text-destructive">-{stats.dels}</span> : null}
                    </span>
                  ) : null}
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    <button
                      className={cn(
                        'cursor-pointer rounded-md border px-1.5 py-0.5 text-[9px] font-medium transition-colors',
                        expanded
                          ? 'border-primary/40 bg-primary/10 text-primary'
                          : 'border-border-strong text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                      onClick={() => toggleReview(file)}
                    >
                      {expanded ? 'Hide' : 'Review'}
                    </button>
                    {onOpenFile ? (
                      <button
                        className="cursor-pointer rounded-md border border-border-strong px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        onClick={() => onOpenFile(file)}
                        title={`Open ${file}`}
                      >
                        Open
                      </button>
                    ) : null}
                  </span>
                </div>
                {expanded ? (
                  patch === undefined ? (
                    <div className="px-2 pb-1.5 text-[9px] text-faint">Loading diff…</div>
                  ) : patch.trim() === '' ? (
                    <div className="px-2 pb-1.5 text-[9px] text-faint">No textual changes (new or binary file).</div>
                  ) : (
                    // code-editor keeps the VS Code-style ::selection treatment.
                    <pre className="code-editor m-0 max-h-[220px] overflow-auto border-t border-border-soft whitespace-pre bg-surface-0 px-2 py-1 font-mono text-[9px]/[1.5] text-soft">
                      {patch.split('\n').map((line, index) => (
                        <span key={index} className={cn('block', diffLineClass(line))}>{`${line}\n`}</span>
                      ))}
                    </pre>
                  )
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
