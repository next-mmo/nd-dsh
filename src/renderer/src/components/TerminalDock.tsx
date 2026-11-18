import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalPaneLayout, TerminalSessionState, TerminalSnapshot, TerminalSplitDirection } from '../../../shared/terminal'
import { cn } from '../lib/utils'

interface Props {
  open: boolean
  sessionId: string | null
  cwd?: string
  onOpenChange(open: boolean): void
  onError(message: string): void
}
const HEIGHT_KEY = 'nd-dsh:terminal-height'
const MIN_HEIGHT = 150, MAX_HEIGHT = 520, DEFAULT_HEIGHT = 250
type LayoutBranch = 'first' | 'second'

export function TerminalDock({ open, sessionId, cwd, onOpenChange, onError }: Props) {
  // The terminal bridge is desktop-only. Keep the localhost UI preview usable
  // when the native desktop PTY service is not available.
  const terminalApi = typeof window.ndDshTerminal === 'undefined' ? null : window.ndDshTerminal
  const [state, setState] = useState<TerminalSessionState | null>(null)
  const [loading, setLoading] = useState(false)
  const [height, setHeight] = useState(() => {
    try {
      return clampHeight(Number(localStorage.getItem(HEIGHT_KEY)) || DEFAULT_HEIGHT)
    } catch {
      return DEFAULT_HEIGHT
    }
  })
  const drag = useRef<{ y: number; height: number } | null>(null)
  const fail = useCallback((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)), [onError])
  const apply = useCallback(async (operation: Promise<TerminalSessionState>) => { try { const next = await operation; setState(next); return next } catch (cause) { fail(cause); return null } }, [fail])

  useEffect(() => {
    setState(null)
    if (!open || !sessionId || !terminalApi) return
    let alive = true
    setLoading(true)
    void terminalApi.state(sessionId).then(async (next) => {
      if (next.terminals.length === 0) next = await terminalApi.create({ sessionId, ...(cwd ? { cwd } : {}) })
      if (alive) setState(next)
    }).catch(fail).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [cwd, fail, open, sessionId, terminalApi])

  useEffect(() => {
    if (!open || !sessionId || !terminalApi) return
    const offState = terminalApi.onState((event) => { if (event.sessionId === sessionId) setState(event.state) })
    const offOutput = terminalApi.onOutput((event) => {
      if (event.sessionId !== sessionId) return
      setState((current) => current ? { ...current, terminals: current.terminals.map((terminal) => terminal.id === event.terminalId && event.seq > terminal.outputSeq ? { ...terminal, outputSeq: event.seq, updatedAt: Date.now(), buffer: `${terminal.buffer}${event.data}`.slice(-512 * 1024) } : terminal) } : current)
    })
    return () => { offState(); offOutput() }
  }, [open, sessionId, terminalApi])

  const selectTerminal = useCallback(async (terminalId: string) => {
    if (!sessionId || !state || !terminalApi) return
    const visiblePane = paneForTerminal(state.layout, terminalId)
    if (visiblePane) { await apply(terminalApi.setLayout(sessionId, state.layout, visiblePane, terminalId)); return }
    const paneId = state.activePaneId ?? firstPane(state.layout)
    const layout = paneId ? replacePane(state.layout, paneId, terminalId) : { type: 'leaf' as const, paneId: crypto.randomUUID(), terminalId }
    await apply(terminalApi.setLayout(sessionId, layout, paneId ?? firstPane(layout), terminalId))
  }, [apply, sessionId, state, terminalApi])

  const createTerminal = useCallback(async () => {
    if (!sessionId || !terminalApi) return
    const created = await apply(terminalApi.create({ sessionId, ...(cwd ? { cwd } : {}) }))
    if (!created?.activeTerminalId) return
    const paneId = created.activePaneId ?? firstPane(created.layout)
    const layout = paneId ? replacePane(created.layout, paneId, created.activeTerminalId) : { type: 'leaf' as const, paneId: crypto.randomUUID(), terminalId: created.activeTerminalId }
    await apply(terminalApi.setLayout(sessionId, layout, paneId ?? firstPane(layout), created.activeTerminalId))
  }, [apply, cwd, sessionId, terminalApi])

  const split = useCallback(async (direction: TerminalSplitDirection) => {
    if (!sessionId || !state || !terminalApi) return
    const paneId = state.activePaneId ?? firstPane(state.layout)
    if (!paneId || !state.layout) { await createTerminal(); return }
    const created = await apply(terminalApi.create({ sessionId, ...(cwd ? { cwd } : {}) }))
    if (!created?.activeTerminalId) return
    const newPane = crypto.randomUUID()
    const layout = splitPane(created.layout, paneId, { type: 'leaf', paneId: newPane, terminalId: created.activeTerminalId }, direction)
    await apply(terminalApi.setLayout(sessionId, layout, newPane, created.activeTerminalId))
  }, [apply, createTerminal, cwd, sessionId, state, terminalApi])

  const persistSplitRatio = useCallback((path: readonly LayoutBranch[], ratio: number) => {
    if (!sessionId || !state?.layout) return
    const layout = updateSplitRatio(state.layout, path, ratio)
    if (terminalApi) void apply(terminalApi.setLayout(sessionId, layout, state.activePaneId, state.activeTerminalId))
  }, [apply, sessionId, state, terminalApi])

  const active = state?.terminals.find((terminal) => terminal.id === state.activeTerminalId)
  const byId = useMemo(() => new Map(state?.terminals.map((terminal) => [terminal.id, terminal]) ?? []), [state?.terminals])
  if (!open) return null
  return <section className="relative shrink-0 border-t border-border-strong bg-surface-0" style={{ height }} aria-label="Session terminal">
    <div className="absolute inset-x-0 -top-[3px] z-20 h-[6px] cursor-row-resize touch-none" onPointerDown={(event) => startDrag(event, drag, height)} onPointerMove={(event) => moveDrag(event, drag, setHeight)} onPointerUp={(event) => endDrag(event, drag, height)} onPointerCancel={(event) => endDrag(event, drag, height)} />
    <div className="flex h-8 items-center gap-1 border-b border-border-soft bg-sidebar px-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
        {(state?.terminals ?? []).map((terminal) => <div key={terminal.id} className={cn('group flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[10px]', terminal.id === state?.activeTerminalId ? 'border-primary/25 bg-primary/[0.08] text-foreground' : 'border-transparent text-faint hover:bg-accent hover:text-foreground')}>
          <button className="flex min-w-0 items-center gap-1" onClick={() => void selectTerminal(terminal.id)} onDoubleClick={() => { const title = window.prompt('Terminal title', terminal.title)?.trim(); if (title && sessionId && terminalApi) void apply(terminalApi.rename(sessionId, terminal.id, title)) }} title={`${terminal.title}\n${terminal.cwd}\n${terminal.shell || 'starting'}`}>
            <span className={cn('size-1.5 rounded-full', terminal.status === 'running' ? 'bg-primary' : terminal.status === 'starting' ? 'bg-info' : terminal.status === 'error' ? 'bg-destructive' : 'bg-faint')} /><span className="max-w-[130px] truncate">{terminal.title}</span>
          </button>
          <button className="grid size-4 place-items-center rounded text-xs text-fainter opacity-0 hover:bg-accent group-hover:opacity-100" title="Close terminal" onClick={() => { if (sessionId && terminalApi) void apply(terminalApi.close(sessionId, terminal.id)) }}>×</button>
        </div>)}
        <button className="grid size-6 shrink-0 place-items-center rounded-md text-sm text-faint hover:bg-accent hover:text-foreground" title="New terminal" onClick={() => void createTerminal()}>+</button>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 text-[10px] text-faint">
        {active && active.status !== 'running' ? <button className="rounded px-1.5 py-1 hover:bg-accent hover:text-foreground" onClick={() => { if (sessionId && terminalApi) void apply(terminalApi.restart(sessionId, active.id)) }}>Restart</button> : null}
        <button className="rounded px-1.5 py-1 font-mono hover:bg-accent hover:text-foreground" title="Split left/right" onClick={() => void split('horizontal')}>▯▯</button>
        <button className="rounded px-1.5 py-1 font-mono hover:bg-accent hover:text-foreground" title="Split top/bottom" onClick={() => void split('vertical')}>▤</button>
        <button className="grid size-6 place-items-center rounded text-sm hover:bg-accent hover:text-foreground" title="Hide terminal" onClick={() => onOpenChange(false)}>×</button>
      </div>
    </div>
    <div className="h-[calc(100%-32px)] min-h-0 overflow-hidden">
      {loading && !state ? <div className="grid h-full place-items-center text-[10px] text-faint">Starting terminal…</div> : !sessionId ? <div className="grid h-full place-items-center text-[10px] text-faint">Select a chat to open its isolated terminal.</div> : state?.layout ? <Layout key={sessionId} layout={state.layout} sessionId={sessionId} byId={byId} activePaneId={state.activePaneId} activate={(paneId, terminalId) => { if (terminalApi && (state.activePaneId !== paneId || state.activeTerminalId !== terminalId)) void apply(terminalApi.setLayout(sessionId, state.layout, paneId, terminalId)) }} persistRatio={persistSplitRatio} path={[]} onError={fail} /> : <div className="grid h-full place-items-center"><button className="rounded border border-border-strong px-3 py-1.5 text-[11px]" onClick={() => void createTerminal()}>New terminal</button></div>}
    </div>
  </section>
}

function Layout({ layout, sessionId, byId, activePaneId, activate, persistRatio, path, onError }: { layout: TerminalPaneLayout; sessionId: string; byId: ReadonlyMap<string, TerminalSnapshot>; activePaneId: string | null; activate(pane: string, terminal: string): void; persistRatio(path: readonly LayoutBranch[], ratio: number): void; path: readonly LayoutBranch[]; onError(cause: unknown): void }) {
  if (layout.type === 'leaf') {
    const snapshot = byId.get(layout.terminalId)
    return snapshot ? <Surface sessionId={sessionId} snapshot={snapshot} active={activePaneId === layout.paneId} focus={() => activate(layout.paneId, layout.terminalId)} onError={onError} /> : null
  }
  const ratio = layout.ratio ?? 0.5
  return <Group
    orientation={layout.direction}
    className="h-full w-full"
    defaultLayout={{ first: ratio * 100, second: (1 - ratio) * 100 }}
    onLayoutChanged={(next, meta) => {
      const first = next.first
      if (meta.isUserInteraction && typeof first === 'number') persistRatio(path, Math.max(0.1, Math.min(0.9, first / 100)))
    }}
  >
    <Panel id="first" minSize="10%" className="min-h-0 min-w-0 overflow-hidden"><Layout layout={layout.first} sessionId={sessionId} byId={byId} activePaneId={activePaneId} activate={activate} persistRatio={persistRatio} path={[...path, 'first']} onError={onError} /></Panel>
    <Separator className={cn('shrink-0 touch-none bg-border-strong hover:bg-primary', layout.direction === 'horizontal' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize')} />
    <Panel id="second" minSize="10%" className="min-h-0 min-w-0 overflow-hidden"><Layout layout={layout.second} sessionId={sessionId} byId={byId} activePaneId={activePaneId} activate={activate} persistRatio={persistRatio} path={[...path, 'second']} onError={onError} /></Panel>
  </Group>
}

function Surface({ sessionId, snapshot, active, focus, onError }: { sessionId: string; snapshot: TerminalSnapshot; active: boolean; focus(): void; onError(cause: unknown): void }) {
  const host = useRef<HTMLDivElement>(null), terminalRef = useRef<Terminal | null>(null), seq = useRef(snapshot.outputSeq)
  useEffect(() => {
    const terminalApi = typeof window.ndDshTerminal === 'undefined' ? null : window.ndDshTerminal
    if (!host.current || !terminalApi) return
    let disposed = false
    const terminal = new Terminal({ cursorBlink: true, fontSize: 12, lineHeight: 1.2, scrollback: 10000, allowTransparency: true, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', theme: { background: 'rgba(0,0,0,0)' } })
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current); terminal.write(snapshot.buffer); terminalRef.current = terminal; seq.current = snapshot.outputSeq
    const data = terminal.onData((value) => { void terminalApi.write(sessionId, snapshot.id, value).catch(onError) })
    const resize = terminal.onResize(({ cols, rows }) => { void terminalApi.resize(sessionId, snapshot.id, cols, rows).catch(onError) })
    const off = terminalApi.onOutput((event) => { if (!disposed && event.sessionId === sessionId && event.terminalId === snapshot.id && event.seq > seq.current) { seq.current = event.seq; terminal.write(event.data) } })
    const observer = new ResizeObserver(() => { try { fit.fit() } catch {} }); observer.observe(host.current)
    const frame = requestAnimationFrame(() => { if (disposed) return; try { fit.fit() } catch {}; if (active) terminal.focus() })
    void terminalApi.state(sessionId).then((latest) => { if (disposed) return; const current = latest.terminals.find((item) => item.id === snapshot.id); if (!current || current.outputSeq <= seq.current) return; if (current.buffer.startsWith(snapshot.buffer)) terminal.write(current.buffer.slice(snapshot.buffer.length)); else { terminal.reset(); terminal.write(current.buffer) }; seq.current = current.outputSeq }).catch(onError)
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); off(); data.dispose(); resize.dispose(); terminal.dispose(); terminalRef.current = null }
  }, [sessionId, snapshot.id])
  useEffect(() => { if (active) terminalRef.current?.focus() }, [active])
  return <div ref={host} className={cn('h-full w-full overflow-hidden p-1.5', active && 'ring-1 ring-inset ring-primary/20')} onPointerDown={focus} />
}

function paneForTerminal(layout: TerminalPaneLayout | null, terminalId: string): string | null { if (!layout) return null; return layout.type === 'leaf' ? layout.terminalId === terminalId ? layout.paneId : null : paneForTerminal(layout.first, terminalId) ?? paneForTerminal(layout.second, terminalId) }
function firstPane(layout: TerminalPaneLayout | null): string | null { return !layout ? null : layout.type === 'leaf' ? layout.paneId : firstPane(layout.first) }
function replacePane(layout: TerminalPaneLayout | null, paneId: string, terminalId: string): TerminalPaneLayout | null { if (!layout) return null; if (layout.type === 'leaf') return layout.paneId === paneId ? { ...layout, terminalId } : layout; return { ...layout, first: replacePane(layout.first, paneId, terminalId) ?? layout.first, second: replacePane(layout.second, paneId, terminalId) ?? layout.second } }
function splitPane(layout: TerminalPaneLayout | null, paneId: string, leaf: Extract<TerminalPaneLayout, { type: 'leaf' }>, direction: TerminalSplitDirection): TerminalPaneLayout | null { if (!layout) return leaf; if (layout.type === 'leaf') return layout.paneId === paneId ? { type: 'split', direction, first: layout, second: leaf, ratio: 0.5 } : layout; return { ...layout, first: splitPane(layout.first, paneId, leaf, direction) ?? layout.first, second: splitPane(layout.second, paneId, leaf, direction) ?? layout.second } }
function updateSplitRatio(layout: TerminalPaneLayout, path: readonly LayoutBranch[], ratio: number): TerminalPaneLayout {
  if (layout.type === 'leaf') return layout
  if (path.length === 0) return { ...layout, ratio }
  const [branch, ...rest] = path
  return branch === 'first'
    ? { ...layout, first: updateSplitRatio(layout.first, rest, ratio) }
    : { ...layout, second: updateSplitRatio(layout.second, rest, ratio) }
}
function clampHeight(value: number): number { return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(value))) }
function startDrag(event: ReactPointerEvent<HTMLDivElement>, ref: React.MutableRefObject<{ y: number; height: number } | null>, height: number): void { ref.current = { y: event.clientY, height }; event.currentTarget.setPointerCapture(event.pointerId) }
function moveDrag(event: ReactPointerEvent<HTMLDivElement>, ref: React.MutableRefObject<{ y: number; height: number } | null>, setHeight: (value: number) => void): void { if (ref.current) setHeight(clampHeight(ref.current.height + ref.current.y - event.clientY)) }
function endDrag(event: ReactPointerEvent<HTMLDivElement>, ref: React.MutableRefObject<{ y: number; height: number } | null>, height: number): void { if (!ref.current) return; ref.current = null; try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {} try { localStorage.setItem(HEIGHT_KEY, String(height)) } catch {} }
