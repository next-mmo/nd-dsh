import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyDesignCommands,
  buildDesignAgentContext,
  createDesignId,
  type DesignCommand,
  type DesignDocument,
} from '../../../shared/nd-design/index.js'
import type { DesignChangedEvent, DesignFreeformState, DesignSessionSync } from '../../../shared/design'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../components/ui/resizable'
import { CanvasStage, designPageBounds } from './CanvasStage.js'
import { isEditableTarget, selectionRoots, type DesignTool } from './editor-state.js'
import {
  DesignAgentPromptBar,
  DesignInspectorPanel,
  DesignLayersPanel,
  DesignToolbar,
} from './panels.js'
import { fitDesignBounds, zoomAt, type DesignViewport } from './viewport.js'

export interface DesignWorkspaceProps {
  active: boolean
  state: DesignFreeformState
  onState(state: DesignFreeformState): void
  onAgentPrompt(prompt: string): void
  onClose(): void
  onError(message: string): void
  onNotify?(message: string): void
}

export function DesignWorkspace({ active, state, onState, onAgentPrompt, onClose, onError, onNotify }: DesignWorkspaceProps) {
  const [document, setDocumentState] = useState<DesignDocument | null>(null)
  const [assets, setAssets] = useState<Record<string, string>>({})
  const [revision, setRevisionState] = useState(0)
  const [selection, setSelectionState] = useState<string[]>([])
  const [tool, setTool] = useState<DesignTool>('select')
  const [viewport, setViewport] = useState<DesignViewport>({ x: 0, y: 0, zoom: 1 })
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [ready, setReady] = useState(false)
  const [layersVisible, setLayersVisible] = useState(true)
  const [inspectorVisible, setInspectorVisible] = useState(true)

  const documentRef = useRef<DesignDocument | null>(null)
  const revisionRef = useRef(0)
  const selectionRef = useRef<string[]>([])
  const stageRef = useRef<HTMLDivElement | null>(null)
  const fittedDocRef = useRef<string | null>(null)
  const viewportTouchedRef = useRef(false)
  const lastStageRef = useRef({ width: 0, height: 0 })
  const queueRef = useRef<DesignCommand[]>([])
  const runningRef = useRef(false)
  const deferredRef = useRef<DesignChangedEvent | null>(null)

  const setDocument = useCallback((next: DesignDocument | null): void => {
    documentRef.current = next
    setDocumentState(next)
  }, [])

  const setRevision = useCallback((next: number): void => {
    revisionRef.current = next
    setRevisionState(next)
  }, [])

  const setSelection = useCallback((next: string[]): void => {
    selectionRef.current = next
    setSelectionState(next)
    void window.ndDshDesign.designSetSelection(next).catch(() => undefined)
  }, [])

  const applySync = useCallback((sync: DesignSessionSync): void => {
    onState(sync.state)
    if (sync.document) {
      setDocument(sync.document)
      setAssets(sync.assets)
      setRevision(sync.state.revision)
      const available = new Set(Object.keys(sync.document.nodes))
      setSelection(selectionRef.current.filter((id) => available.has(id)))
    }
  }, [onState, setDocument, setRevision, setSelection])

  const refreshSync = useCallback(async (): Promise<void> => {
    try {
      applySync(await window.ndDshDesign.designSync())
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [applySync, onError])

  useEffect(() => {
    let mounted = true
    void window.ndDshDesign.designSync()
      .then((sync) => {
        if (!mounted) return
        applySync(sync)
        setReady(true)
      })
      .catch((cause: unknown) => {
        if (mounted) onError(cause instanceof Error ? cause.message : String(cause))
      })
    const unsubscribe = window.ndDshDesign.onDesignChanged((event) => {
      onState(event.state)
      if (event.document) {
        if (runningRef.current || queueRef.current.length > 0) {
          deferredRef.current = event
          return
        }
        applySync({
          state: event.state,
          document: event.document,
          assets: event.assets ?? {},
        })
      } else if (event.state.status === 'error') {
        void refreshSync()
      }
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [applySync, onError, onState, refreshSync])

  const flush = useCallback(async (): Promise<void> => {
    if (runningRef.current || queueRef.current.length === 0) return
    const batch = queueRef.current.splice(0)
    runningRef.current = true
    try {
      const result = await window.ndDshDesign.designApply(revisionRef.current, batch)
      if (result.ok) {
        setRevision(result.revision)
        onState(result.state)
      } else {
        queueRef.current = []
        applySync(result.sync)
        onError('The canvas changed in another place. Your latest change was not applied.')
      }
    } catch (cause) {
      queueRef.current = []
      await refreshSync()
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      runningRef.current = false
      const deferred = deferredRef.current
      if (deferred?.document) {
        deferredRef.current = null
        applySync({
          state: deferred.state,
          document: deferred.document,
          assets: deferred.assets ?? {},
        })
      }
      if (queueRef.current.length > 0) void flush()
    }
  }, [applySync, onError, onState, refreshSync, setRevision])

  const apply = useCallback((commands: DesignCommand[]): void => {
    const current = documentRef.current
    if (!current || commands.length === 0) return
    try {
      const optimistic = applyDesignCommands(current, commands).document
      setDocument(optimistic)
      queueRef.current.push(...commands)
      void flush()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [flush, onError, setDocument])

  const waitForQueue = useCallback(async (): Promise<void> => {
    while (runningRef.current || queueRef.current.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }, [])

  const updateNode = useCallback((id: string, patch: Record<string, unknown>): void => {
    apply([{ op: 'update', id, patch }])
  }, [apply])

  const deleteNodes = useCallback((ids: string[]): void => {
    if (ids.length === 0) return
    apply([{ op: 'delete', ids }])
    setSelection([])
  }, [apply, setSelection])

  const save = useCallback(async (): Promise<void> => {
    try {
      await waitForQueue()
      onState(await window.ndDshDesign.designSave())
      onNotify?.('ND Pencil saved.')
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [onError, onNotify, onState, waitForQueue])

  const undo = useCallback(async (): Promise<void> => {
    try {
      await waitForQueue()
      applySync(await window.ndDshDesign.designUndo())
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [applySync, onError, waitForQueue])

  const redo = useCallback(async (): Promise<void> => {
    try {
      await waitForQueue()
      applySync(await window.ndDshDesign.designRedo())
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [applySync, onError, waitForQueue])

  const close = useCallback(async (): Promise<void> => {
    try {
      await waitForQueue()
      applySync(await window.ndDshDesign.designClose(true))
      onClose()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [applySync, onClose, onError, waitForQueue])

  const reloadFromDisk = useCallback(async (): Promise<void> => {
    const currentPath = state.documentPath
    if (!currentPath) return
    if (!window.confirm('Discard unsaved canvas changes and reload this .op file from disk?')) return
    try {
      await window.ndDshDesign.designClose(false)
      applySync(await window.ndDshDesign.designOpen(currentPath))
      onNotify?.('ND Pencil reloaded from disk.')
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [applySync, onError, onNotify, state.documentPath])

  const discardAndClose = useCallback(async (): Promise<void> => {
    if (!window.confirm('Discard unsaved canvas changes and close ND Pencil?')) return
    try {
      applySync(await window.ndDshDesign.designClose(false))
      onClose()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [applySync, onClose, onError])

  const build = useCallback(async (): Promise<void> => {
    try {
      await waitForQueue()
      if (state.dirty) onState(await window.ndDshDesign.designSave())
      const result = await window.ndDshDesign.designBuild()
      onNotify?.('Build spec prepared. Asking ND Agent to implement it…')
      onAgentPrompt(result.prompt)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [onAgentPrompt, onError, onNotify, onState, state.dirty, waitForQueue])

  const askAgent = useCallback((prompt: string): void => {
    const current = documentRef.current
    if (!current) return
    const context = buildDesignAgentContext(current, selectionRef.current, state.documentPath)
    onAgentPrompt(`${context}\n\n## User request\n${prompt}`)
  }, [onAgentPrompt, state.documentPath])

  const fit = useCallback((): void => {
    const current = documentRef.current
    if (!current || stageSize.width === 0 || stageSize.height === 0) return
    viewportTouchedRef.current = true
    setViewport(fitDesignBounds(designPageBounds(current), stageSize.width, stageSize.height))
  }, [stageSize.height, stageSize.width])

  useEffect(() => {
    const element = stageRef.current
    if (!element) return undefined
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setStageSize({ width: rect.width, height: rect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ready])

  const documentId = document?.id ?? ''
  useEffect(() => {
    if (!document || stageSize.width === 0 || stageSize.height === 0) return
    const documentChanged = fittedDocRef.current !== documentId
    const stageChanged = lastStageRef.current.width !== stageSize.width || lastStageRef.current.height !== stageSize.height
    if (!documentChanged && !stageChanged) return
    if (documentChanged) {
      fittedDocRef.current = documentId
      viewportTouchedRef.current = false
    }
    lastStageRef.current = { width: stageSize.width, height: stageSize.height }
    if (!viewportTouchedRef.current) {
      setViewport(fitDesignBounds(designPageBounds(document), stageSize.width, stageSize.height))
    }
  }, [document, documentId, stageSize.height, stageSize.width])

  useEffect(() => {
    if (!active) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return
      const meta = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (meta && key === 's') {
        event.preventDefault()
        void save()
        return
      }
      if (meta && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) void redo()
        else void undo()
        return
      }
      if (meta && key === 'g') {
        event.preventDefault()
        if (event.shiftKey) {
          const current = documentRef.current
          const id = selectionRef.current[0]
          if (current && selectionRef.current.length === 1 && current.nodes[id ?? '']?.type === 'group') {
            apply([{ op: 'ungroup', id: id! }])
          }
        } else if (selectionRef.current.length > 0) {
          apply([{ op: 'group', ids: selectionRef.current }])
        }
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectionRef.current.length > 0) {
          event.preventDefault()
          deleteNodes(selectionRef.current)
        }
        return
      }
      if (event.key === 'Escape') {
        setTool('select')
        setSelection([])
        return
      }
      if (event.key.startsWith('Arrow') && selectionRef.current.length > 0) {
        event.preventDefault()
        const step = event.shiftKey ? 10 : 1
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
        const current = documentRef.current
        if (!current) return
        const commands = selectionRoots(current, selectionRef.current)
          .map((id) => current.nodes[id])
          .filter((node): node is NonNullable<typeof node> => Boolean(node))
          .map((node) => ({ op: 'update' as const, id: node.id, patch: { x: node.x + dx, y: node.y + dy } }))
        if (commands.length > 0) apply(commands)
        return
      }
      if (!meta && !event.altKey) {
        const toolByKey: Record<string, DesignTool> = { v: 'select', h: 'hand', f: 'frame', r: 'rect', o: 'ellipse', l: 'line', t: 'text', i: 'image' }
        const nextTool = toolByKey[key]
        if (nextTool) {
          event.preventDefault()
          setTool(nextTool)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, apply, deleteNodes, redo, save, setSelection, undo])

  const zoomIn = (): void => {
    viewportTouchedRef.current = true
    setViewport(zoomAt(viewport, viewport.zoom * 1.2, { x: stageSize.width / 2, y: stageSize.height / 2 }))
  }
  const zoomOut = (): void => {
    viewportTouchedRef.current = true
    setViewport(zoomAt(viewport, viewport.zoom / 1.2, { x: stageSize.width / 2, y: stageSize.height / 2 }))
  }

  const importImage = useCallback(async ({ dataUrl, name, point, parentId }: { dataUrl: string; name: string; point: { x: number; y: number }; parentId: string | null }): Promise<void> => {
    try {
      const asset = await window.ndDshDesign.designImportAsset({ dataUrl, name })
      setAssets((current) => ({ ...current, [asset.path]: asset.dataUrl }))
      apply([{
        op: 'insert',
        parentId,
        node: {
          id: createDesignId('image'),
          type: 'image',
          name: name.replace(/\.[^.]+$/, '') || 'Image',
          x: point.x,
          y: point.y,
          width: 320,
          height: 200,
          src: asset.path,
          fit: 'cover',
        },
      }])
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [apply, onError])

  const selectedCount = selection.length
  const documentPath = state.documentPath
  const saving = state.status === 'saving'

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-surface-0">
      <DesignToolbar
        name={document?.name ?? state.documentName ?? 'ND Pencil'}
        dirty={state.dirty}
        saving={saving}
        tool={tool}
        zoom={viewport.zoom}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
        onTool={setTool}
        onUndo={() => void undo()}
        onRedo={() => void redo()}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onFit={fit}
        onSave={() => void save()}
        onBuild={() => void build()}
        onClose={() => void close()}
        layersVisible={layersVisible}
        inspectorVisible={inspectorVisible}
        onToggleLayers={() => setLayersVisible((visible) => !visible)}
        onToggleInspector={() => setInspectorVisible((visible) => !visible)}
      />

      {state.error ? (
        <div className="z-30 flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          <span className="min-w-0 truncate">{state.error}</span>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" className="rounded border border-destructive/30 px-2 py-0.5 font-semibold hover:bg-destructive/10" onClick={() => void save()}>Retry save</button>
            <button type="button" className="rounded border border-border-soft px-2 py-0.5 font-medium text-muted-foreground hover:bg-accent" onClick={() => void reloadFromDisk()}>Reload disk</button>
            <button type="button" className="rounded border border-border-soft px-2 py-0.5 font-medium text-muted-foreground hover:bg-accent" onClick={() => void discardAndClose()}>Discard & close</button>
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <ResizablePanelGroup direction={'horizontal' as const} className="h-full w-full">
          {layersVisible ? (
            <>
              <ResizablePanel defaultSize={210} minSize={168} maxSize={340} groupResizeBehavior="preserve-pixel-size">
                {document ? (
                  <DesignLayersPanel document={document} selection={selection} onSelect={setSelection} onUpdate={updateNode} />
                ) : null}
              </ResizablePanel>
              <ResizableHandle withHandle />
            </>
          ) : null}
          <ResizablePanel minSize="40%" className="relative min-h-0 min-w-0">
            <div ref={stageRef} className="relative h-full w-full">
              {document && ready ? (
                <CanvasStage
                  document={document}
                  assets={assets}
                  selection={selection}
                  tool={tool}
                  viewport={viewport}
                  onViewportChange={(next) => {
                    viewportTouchedRef.current = true
                    setViewport(next)
                  }}
                  onSelect={setSelection}
                  onApply={apply}
                  onCreate={(node, parentId) => {
                    apply([{ op: 'insert', parentId, node }])
                    setSelection([node.id])
                    setTool('select')
                  }}
                  onTextCommit={(id, text) => updateNode(id, { text })}
                  onImportImage={importImage}
                  onError={onError}
                />
              ) : (
                <div className="grid h-full w-full place-items-center bg-surface-0 text-xs text-muted-foreground">
                  <div className="flex items-center gap-2"><span className="size-2 animate-pulse rounded-full bg-primary" /> Opening ND Pencil…</div>
                </div>
              )}
              <DesignAgentPromptBar selectionCount={selectedCount} disabled={!document} onSend={askAgent} />
            </div>
          </ResizablePanel>
          {inspectorVisible ? (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={264} minSize={220} maxSize={420} groupResizeBehavior="preserve-pixel-size">
                {document ? (
                  <DesignInspectorPanel
                    document={document}
                    {...(documentPath ? { documentPath } : {})}
                    revision={revision}
                    selection={selection}
                    onUpdate={updateNode}
                    onDelete={deleteNodes}
                  />
                ) : null}
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      </div>
    </div>
  )
}
