import { useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceFile } from '../../../shared/contracts'
import { fileAccent } from '../lib/file-accents'
import { FileIcon, SparkIcon } from './Icons'
import { SelectionPromptMenu, type SelectionAction } from './SelectionPromptMenu'
import { MarkdownLite } from './MarkdownLite'
import { cn } from '../lib/utils'

type HljsApi = typeof import('highlight.js/lib/common').default

let hljsPromise: Promise<HljsApi> | undefined
const MAX_HIGHLIGHT_CHARS = 200_000

function loadHljs(): Promise<HljsApi> {
  hljsPromise ??= import('highlight.js/lib/common').then((module) => module.default)
  return hljsPromise
}

interface EditorPaneProps {
  file: WorkspaceFile | null
  onAgentPrompt?(prompt: string): void
  onOpenLink?(url: string): void
  onError?(message: string): void
}

const SELECTION_ACTIONS: SelectionAction[] = [
  { id: 'ask', label: 'Ask agent', icon: <SparkIcon /> },
  { id: 'explain', label: 'Explain', icon: <SparkIcon /> },
  { id: 'copy', label: 'Copy', icon: <FileIcon /> },
]

function languageFromPath(path: string): string {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return 'typescript'
  if (name.endsWith('.js') || name.endsWith('.jsx') || name.endsWith('.mjs') || name.endsWith('.cjs')) return 'javascript'
  if (name.endsWith('.json')) return 'json'
  if (name.endsWith('.css')) return 'css'
  if (name.endsWith('.html') || name.endsWith('.htm') || name.endsWith('.svg')) return 'xml'
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown'
  if (name.endsWith('.yml') || name.endsWith('.yaml')) return 'yaml'
  if (name.endsWith('.rs')) return 'rust'
  if (name.endsWith('.py')) return 'python'
  if (name.endsWith('.sh') || name.endsWith('.bash') || name.endsWith('.zsh')) return 'bash'
  if (name.endsWith('.sql')) return 'sql'
  if (name.endsWith('.toml') || name.endsWith('.ini')) return 'ini'
  return 'plaintext'
}

export function EditorPane({ file, onAgentPrompt, onOpenLink, onError }: EditorPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewMode, setViewMode] = useState<'code' | 'preview'>('code')
  const [hljs, setHljs] = useState<HljsApi | null>(null)

  const isMarkdown = file?.relativePath.toLowerCase().endsWith('.md') ?? false

  // Reset to code view when switching files.
  useEffect(() => {
    setViewMode('code')
  }, [file?.relativePath])

  useEffect(() => {
    if (!file || file.previewHtml !== undefined || hljs) return
    let alive = true
    void loadHljs().then((loaded) => {
      if (alive) setHljs(() => loaded)
    })
    return () => { alive = false }
  }, [file, hljs])

  const highlighted = useMemo(() => {
    if (!file || !hljs || file.previewHtml !== undefined || file.content.length > MAX_HIGHLIGHT_CHARS) return null
    const language = languageFromPath(file.relativePath)
    if (language === 'plaintext') return null
    try {
      return hljs.getLanguage(language)
        ? hljs.highlight(file.content, { language, ignoreIllegals: true }).value
        : null
    } catch {
      return null
    }
  }, [file, hljs])

  if (!file) {
    return (
      // code-editor keeps the VS Code-style ::selection treatment.
      <section className="code-editor flex h-full w-full flex-col items-center justify-center text-center text-faint">
        <div className="grid size-[58px] place-items-center rounded-[14px] border border-primary/30 bg-primary/10 font-extrabold tracking-[0.08em] text-primary">ND</div>
        <h2 className="mb-[5px] mt-4 text-[15px] text-soft">ND-DSH Coding Workspace</h2>
        <p className="mb-[18px] text-[10px]">Open a file, switch to Browser, or ask the agent to start building.</p>
        <div className="grid grid-cols-[auto_auto] items-center gap-x-5 gap-y-[7px] text-left text-[9px] text-faint [&_kbd]:rounded-[4px] [&_kbd]:border [&_kbd]:border-border-strong [&_kbd]:bg-secondary [&_kbd]:px-1.5 [&_kbd]:py-[3px] [&_kbd]:font-sans [&_kbd]:text-muted-foreground">
          <span>Open a project</span><kbd>Explorer</kbd>
          <span>Inspect the live app</span><kbd>Browser</kbd>
          <span>Delegate a task</span><kbd>Agent</kbd>
        </div>
      </section>
    )
  }

  if (file.previewHtml !== undefined) {
    return (
      <section className="flex h-full min-h-0 flex-col" aria-label={`Document ${file.relativePath}`}>
        <div className="border-b border-border-soft px-3 py-2 text-xs text-soft">
          {file.relativePath} · Content preview (page layout and images omitted)
        </div>
        <iframe title={`DOCX preview ${file.relativePath}`} sandbox="" referrerPolicy="no-referrer"
          srcDoc={file.previewHtml} className="min-h-0 w-full flex-1 border-0 bg-white" />
      </section>
    )
  }

  const lineCount = file.content.split('\n').length
  const lineNumbers = Array.from({ length: lineCount }, (_, index) => index + 1).join('\n')

  const runSelectionAction = (actionId: string, text: string): void => {
    if (actionId === 'copy') {
      void navigator.clipboard.writeText(text).catch(() => onError?.('Clipboard access is unavailable here.'))
      return
    }
    const instruction = actionId === 'explain' ? 'Explain this selected code' : 'Help me with this selected code'
    onAgentPrompt?.(`${instruction}:\n${text}`)
  }

  return (
    <section className="code-editor grid h-full w-full grid-rows-[31px_auto_minmax(0,1fr)] min-h-0 bg-surface-0" aria-label={`Editor ${file.relativePath}`}>
      <div className="flex items-center justify-between border-b border-border-soft bg-secondary">
        <div
          className="flex min-w-0 items-center gap-1.5 border-r border-border-soft px-[11px] text-[10px] text-soft [&_svg]:size-[13px]"
          title={file.relativePath}
        >
          <FileIcon style={{ color: fileAccent(file.relativePath) }} />
          <span className="truncate">{file.relativePath}</span>
        </div>
        {isMarkdown ? (
          <div className="flex items-center gap-0.5 px-1.5">
            <button
              type="button"
              onClick={() => setViewMode('code')}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                viewMode === 'code'
                  ? 'bg-primary/10 text-primary font-semibold'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              )}
            >
              Code
            </button>
            <button
              type="button"
              onClick={() => setViewMode('preview')}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                viewMode === 'preview'
                  ? 'bg-primary/10 text-primary font-semibold'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              )}
            >
              Preview
            </button>
          </div>
        ) : null}
      </div>
      {viewMode === 'preview' && isMarkdown ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[12px]/[1.65]">
          <MarkdownLite text={file.content} {...(onOpenLink ? { onOpenLink } : {})} />
        </div>
      ) : (
        <>
          {file.truncated ? (
            <div className="border-b border-warning/25 bg-warning/10 px-2.5 py-[5px] text-[9px] text-warning">Preview truncated at 1 MiB.</div>
          ) : null}
          <div className="min-h-0 overflow-auto" ref={scrollRef}>
            <div className="flex min-w-full items-start">
              <div aria-hidden="true" className="shrink-0 select-none whitespace-pre py-[13px] pr-[13px] pb-10 text-right font-mono text-[11px]/[1.62] text-code-dim">
                {lineNumbers}
              </div>
              <pre className="m-0 block min-w-0 flex-1 overflow-visible whitespace-pre pt-[13px] pr-[18px] pb-10 font-mono text-[11px]/[1.62] text-soft">
                {highlighted !== null ? <code dangerouslySetInnerHTML={{ __html: highlighted }} /> : <code>{file.content}</code>}
              </pre>
            </div>
          </div>
        </>
      )}
      <SelectionPromptMenu containerRef={scrollRef} actions={SELECTION_ACTIONS} onRun={runSelectionAction} />
    </section>
  )
}
