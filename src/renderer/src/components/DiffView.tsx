import { useEffect, useState } from 'react'
import { CloseIcon } from './Icons'
import { ScmStatusChip } from './scm-status-chip'
import { diffLineClass } from '../lib/diff-line-class'
import { cn } from '../lib/utils'

export { diffLineClass }

interface DiffViewProps {
  relativePath: string
  staged: boolean
  onClose(): void
  onError(message: string): void
}

/** Read-only unified diff rendered from `git diff` output for one file. */
export function DiffView({ relativePath, staged, onClose, onError }: DiffViewProps) {  const [patch, setPatch] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    setPatch(null)
    void window.ndDsh.git.diff(relativePath, staged)
      .then((result) => {
        if (mounted) setPatch(result)
      })
      .catch((cause) => {
        if (!mounted) return
        setPatch('')
        onError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      mounted = false
    }
  }, [relativePath, staged, onError])

  return (
    // code-editor keeps the VS Code-style ::selection treatment.
    <div className="code-editor relative grid h-full w-full grid-rows-[31px_auto_minmax(0,1fr)] bg-surface-0">
      <div className="flex border-b border-border-soft bg-secondary">
        <div className="flex items-center gap-1.5 border-r border-border-soft px-[11px] text-[10px] text-soft">
          <ScmStatusChip kind={staged ? 'added' : 'modified'} label={staged ? 'S' : 'D'} />
          <span title={relativePath}>{`Diff · ${relativePath}${staged ? ' (staged)' : ''}`}</span>
        </div>
        <button
          className="ml-auto mr-1.5 my-1 grid size-[22px] shrink-0 place-items-center rounded-[5px] text-faint transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3"
          title="Close diff"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      {patch === null ? (
        <div className="grid min-h-0 place-items-center">
          <div className="size-[34px] animate-spin rounded-full border border-border-strong border-t-primary" />
        </div>
      ) : patch.trim() === '' ? (
        <div className="p-3 text-[10px]/[1.45] text-faint">No textual changes.</div>
      ) : (
        <div className="min-h-0 overflow-auto">
          <pre className="m-0 overflow-visible whitespace-pre bg-surface-0 px-4 pb-10 pt-3 font-mono text-[11px]/[1.62] text-soft">
            {patch.split('\n').map((line, index) => (
              <span key={index} className={cn('block', diffLineClass(line))}>{`${line}\n`}</span>
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}
