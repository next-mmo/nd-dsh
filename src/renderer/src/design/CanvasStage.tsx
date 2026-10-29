import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { DesignCommand, DesignDocument, DesignNode } from '../../../shared/nd-design/index.js'
import {
  createNodeForTool,
  descendantDesignIds,
  selectionDesignBounds,
  selectionRoots,
  type DesignTool,
} from './editor-state.js'
import {
  normalizeDragBounds,
  screenToCanvas,
  unionDesignBounds,
  zoomAt,
  type DesignBounds,
  type DesignPoint,
  type DesignViewport,
} from './viewport.js'

export interface CanvasStageProps {
  document: DesignDocument
  assets: Record<string, string>
  selection: string[]
  tool: DesignTool
  viewport: DesignViewport
  onViewportChange(viewport: DesignViewport): void
  onSelect(ids: string[]): void
  onApply(commands: DesignCommand[]): void
  onCreate(node: DesignNode, parentId: string | null): void
  onTextCommit(id: string, text: string): void
  onImportImage(input: { dataUrl: string; name: string; point: DesignPoint; parentId: string | null }): void
  onError(message: string): void
}

type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

type DragState =
  | { kind: 'pan'; startX: number; startY: number; viewport: DesignViewport }
  | {
      kind: 'move'
      start: DesignPoint
      roots: string[]
      positions: Map<string, DesignBounds>
      moved: boolean
    }
  | {
      kind: 'resize'
      handle: ResizeHandle
      id: string
      start: DesignPoint
      bounds: DesignBounds
    }
  | { kind: 'draw'; tool: DesignTool; start: DesignPoint }
  | null

interface TextEditState {
  id: string
  value: string
}

const SELECTION_BLUE = '#2563eb'

export function CanvasStage({
  document,
  assets,
  selection,
  tool,
  viewport,
  onViewportChange,
  onSelect,
  onApply,
  onCreate,
  onTextCommit,
  onImportImage,
  onError,
}: CanvasStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState>(null)
  const viewportRef = useRef(viewport)
  const imagePointRef = useRef<DesignPoint | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
  const [ghost, setGhost] = useState<DesignBounds | null>(null)
  const [preview, setPreviewState] = useState<Record<string, DesignBounds> | null>(null)
  const previewRef = useRef<Record<string, DesignBounds> | null>(null)
  const setPreview = (next: Record<string, DesignBounds> | null): void => {
    previewRef.current = next
    setPreviewState(next)
  }
  const [editing, setEditing] = useState<TextEditState | null>(null)
  viewportRef.current = viewport

  const selected = useMemo(() => new Set(selection), [selection])
  const selectionBounds = useMemo(() => selectionDesignBounds(document, selection), [document, selection])
  const pageChildren = document.pages[0]?.children ?? []

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return undefined
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = stage.getBoundingClientRect()
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      const current = viewportRef.current
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-event.deltaY * 0.0015)
        onViewportChange(zoomAt(current, current.zoom * factor, point))
      } else {
        const scale = event.deltaMode === 1 ? 16 : 1
        onViewportChange({
          ...current,
          x: current.x - event.deltaX * scale,
          y: current.y - event.deltaY * scale,
        })
      }
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [onViewportChange])

  useEffect(() => {
    if (!editing) return
    const textarea = textAreaRef.current
    if (!textarea) return
    textarea.focus()
    textarea.select()
  }, [editing])

  const clientPoint = (event: ReactPointerEvent): DesignPoint => {
    const rect = stageRef.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  const capture = (event: ReactPointerEvent): void => {
    stageRef.current?.setPointerCapture?.(event.pointerId)
  }

  const startPan = (event: ReactPointerEvent): void => {
    dragRef.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, viewport }
    capture(event)
    event.preventDefault()
  }

  const onStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    stageRef.current?.focus()
    if (event.button === 1 || tool === 'hand') {
      startPan(event)
      return
    }
    if (event.button !== 0) return
    if (tool === 'select') {
      onSelect([])
      startPan(event)
      return
    }
    if (tool === 'image') {
      const point = screenToCanvas(clientPoint(event), viewport)
      imagePointRef.current = point
      fileInputRef.current?.click()
      return
    }
    const point = screenToCanvas(clientPoint(event), viewport)
    dragRef.current = { kind: 'draw', tool, start: point }
    setGhost({ x: point.x, y: point.y, width: 0, height: 0 })
    capture(event)
    event.preventDefault()
  }

  const startNodeDrag = (event: ReactPointerEvent, id: string): void => {
    if (tool !== 'select') return
    event.stopPropagation()
    stageRef.current?.focus()
    if (event.button !== 0) return
    const node = document.nodes[id]
    if (!node) return
    const additive = event.shiftKey
    let next: string[]
    if (additive) {
      next = selected.has(id) ? selection.filter((item) => item !== id) : [...selection, id]
    } else {
      next = selected.has(id) ? selection : [id]
    }
    onSelect(next)
    if (!next.includes(id) || node.locked) return
    const roots = selectionRoots(document, next)
    const positions = new Map<string, DesignBounds>()
    for (const rootId of roots) {
      const root = document.nodes[rootId]
      if (!root) continue
      positions.set(rootId, { x: root.x, y: root.y, width: root.width, height: root.height })
      for (const childId of descendantDesignIds(document, rootId)) {
        const child = document.nodes[childId]
        if (child) positions.set(childId, { x: child.x, y: child.y, width: child.width, height: child.height })
      }
    }
    dragRef.current = {
      kind: 'move',
      start: screenToCanvas(clientPoint(event), viewport),
      roots,
      positions,
      moved: false,
    }
    capture(event)
    event.preventDefault()
  }

  const startResize = (event: ReactPointerEvent, handle: ResizeHandle): void => {
    if (selection.length !== 1) return
    const id = selection[0]!
    const node = document.nodes[id]
    if (!node || node.locked) return
    event.stopPropagation()
    event.preventDefault()
    stageRef.current?.focus()
    dragRef.current = {
      kind: 'resize',
      handle,
      id,
      start: screenToCanvas(clientPoint(event), viewport),
      bounds: { x: node.x, y: node.y, width: node.width, height: node.height },
    }
    capture(event)
  }

  const onStagePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.kind === 'pan') {
      onViewportChange({
        ...drag.viewport,
        x: drag.viewport.x + (event.clientX - drag.startX),
        y: drag.viewport.y + (event.clientY - drag.startY),
      })
      return
    }
    const point = screenToCanvas(clientPoint(event), viewport)
    if (drag.kind === 'move') {
      const dx = point.x - drag.start.x
      const dy = point.y - drag.start.y
      if (Math.abs(dx) < 0.2 && Math.abs(dy) < 0.2) return
      drag.moved = true
      const next: Record<string, DesignBounds> = {}
      for (const [id, bounds] of drag.positions) {
        next[id] = { ...bounds, x: bounds.x + dx, y: bounds.y + dy }
      }
      setPreview(next)
      return
    }
    if (drag.kind === 'resize') {
      const dx = point.x - drag.start.x
      const dy = point.y - drag.start.y
      let { x, y, width, height } = drag.bounds
      if (drag.handle.includes('w')) {
        x = drag.bounds.x + dx
        width = drag.bounds.width - dx
      }
      if (drag.handle.includes('e')) width = drag.bounds.width + dx
      if (drag.handle.includes('n')) {
        y = drag.bounds.y + dy
        height = drag.bounds.height - dy
      }
      if (drag.handle.includes('s')) height = drag.bounds.height + dy
      if (width < 1) {
        x = drag.bounds.x + drag.bounds.width - 1
        width = 1
      }
      if (height < 1) {
        y = drag.bounds.y + drag.bounds.height - 1
        height = 1
      }
      setPreview({ [drag.id]: { x, y, width, height } })
      return
    }
    if (drag.kind === 'draw') {
      setGhost(normalizeDragBounds(drag.start, point))
    }
  }

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    stageRef.current?.releasePointerCapture?.(event.pointerId)
    if (!drag) return
    if (drag.kind === 'move') {
      const next = previewRef.current
      if (drag.moved && next) {
        const commands = drag.roots
          .filter((id) => Boolean(next[id]))
          .map((id) => ({
            op: 'update' as const,
            id,
            patch: { x: Math.round(next[id]!.x), y: Math.round(next[id]!.y) },
          }))
        if (commands.length > 0) onApply(commands)
      }
      setPreview(null)
      return
    }
    if (drag.kind === 'resize') {
      const next = previewRef.current?.[drag.id]
      if (next) {
        onApply([{
          op: 'update',
          id: drag.id,
          patch: {
            x: Math.round(next.x),
            y: Math.round(next.y),
            width: Math.round(next.width),
            height: Math.round(next.height),
          },
        }])
      }
      setPreview(null)
      return
    }
    if (drag.kind === 'draw') {
      const point = screenToCanvas(clientPoint(event), viewport)
      const node = createNodeForTool(drag.tool, drag.start, point)
      if (node) {
        const parentId = frameAtPoint(document, drag.start)
        onCreate(node, parentId)
      } else if (drag.tool !== 'text' && drag.tool !== 'image') {
        onError('Drag on the canvas to draw a shape.')
      }
      setGhost(null)
    }
  }

  const commitText = (): void => {
    if (!editing) return
    const node = document.nodes[editing.id]
    if (node && node.text !== editing.value) onTextCommit(editing.id, editing.value)
    setEditing(null)
  }

  const onImageFile = (file: File | undefined): void => {
    const point = imagePointRef.current
    imagePointRef.current = null
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (!file || !point) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      if (!dataUrl.startsWith('data:image/')) {
        onError('Choose a PNG, JPEG, WebP, GIF, or SVG image.')
        return
      }
      onImportImage({ dataUrl, name: file.name, point, parentId: frameAtPoint(document, point) })
    }
    reader.onerror = () => onError('The image could not be read.')
    reader.readAsDataURL(file)
  }

  const editingNode = editing ? document.nodes[editing.id] : undefined
  const editingBounds = editingNode ? preview?.[editingNode.id] ?? editingNode : undefined


  return (
    <div
      ref={stageRef}
      role="application"
      aria-label="ND Pencil canvas"
      tabIndex={0}
      className="relative h-full w-full overflow-hidden outline-none"
      style={{
        touchAction: 'none',
        backgroundColor: 'var(--nd-canvas-bg)',
        backgroundImage: 'radial-gradient(circle at 1px 1px, var(--nd-canvas-dot) 1px, transparent 0)',
        backgroundSize: '20px 20px',
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
      }}
      onPointerDown={onStagePointerDown}
      onPointerMove={onStagePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          transformOrigin: '0 0',
        }}
      >
        {pageChildren.map((id) => (
          <NodeView
            key={id}
            document={document}
            nodeId={id}
            origin={{ x: 0, y: 0 }}
            assets={assets}
            preview={preview}
            selected={selected}
            tool={tool}
            zoom={viewport.zoom}
            onPointerDown={startNodeDrag}
            onEditText={(nodeId) => setEditing({ id: nodeId, value: document.nodes[nodeId]?.text ?? '' })}
          />
        ))}
        {selection.map((id) => {
          const bounds = preview?.[id] ?? boundsOf(document, id)
          if (!bounds) return null
          return (
            <div
              key={`outline-${id}`}
              style={{
                position: 'absolute',
                left: bounds.x,
                top: bounds.y,
                width: bounds.width,
                height: bounds.height,
                border: `${1 / viewport.zoom}px solid ${SELECTION_BLUE}`,
                pointerEvents: 'none',
                boxSizing: 'border-box',
                zIndex: 2,
              }}
            />
          )
        })}
        {selection.length === 1 && selectionBounds ? (
          <Transformer
            bounds={preview?.[selection[0]!] ?? selectionBounds}
            zoom={viewport.zoom}
            onStartResize={startResize}
          />
        ) : null}
        {ghost ? (
          <div
            style={{
              position: 'absolute',
              left: ghost.x,
              top: ghost.y,
              width: Math.max(1, ghost.width),
              height: Math.max(1, ghost.height),
              border: `${1 / viewport.zoom}px dashed ${SELECTION_BLUE}`,
              background: 'rgba(37, 99, 235, 0.08)',
              pointerEvents: 'none',
              zIndex: 3,
            }}
          />
        ) : null}
        {editing && editingBounds ? (
          <textarea
            ref={textAreaRef}
            value={editing.value}
            aria-label="Edit ND Pencil text"
            onChange={(event) => setEditing({ ...editing, value: event.target.value })}
            onBlur={commitText}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Escape') {
                event.preventDefault()
                setEditing(null)
              } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                commitText()
              }
            }}
            style={{
              position: 'absolute',
              left: editingBounds.x,
              top: editingBounds.y,
              width: Math.max(40, editingBounds.width),
              height: Math.max(24, editingBounds.height),
              zIndex: 5,
              resize: 'none',
              overflow: 'hidden',
              padding: 0,
              margin: 0,
              border: `${1 / viewport.zoom}px solid ${SELECTION_BLUE}`,
              outline: 'none',
              background: 'rgba(255,255,255,0.92)',
              color: editingNode?.color ?? '#18181b',
              fontFamily: editingNode?.fontFamily ?? 'Inter',
              fontSize: editingNode?.fontSize ?? 16,
              fontWeight: editingNode?.fontWeight ?? 400,
              lineHeight: editingNode?.lineHeight ?? 1.3,
              letterSpacing: editingNode?.letterSpacing ?? 0,
              textAlign: editingNode?.align ?? 'left',
            }}
          />
        ) : null}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        className="hidden"
        aria-label="Choose an image for ND Pencil"
        onChange={(event) => onImageFile(event.target.files?.[0])}
      />
    </div>
  )
}

function NodeView({
  document,
  nodeId,
  origin,
  assets,
  preview,
  selected,
  tool,
  zoom,
  onPointerDown,
  onEditText,
}: {
  document: DesignDocument
  nodeId: string
  origin: DesignPoint
  assets: Record<string, string>
  preview: Record<string, DesignBounds> | null
  selected: Set<string>
  tool: DesignTool
  zoom: number
  onPointerDown(event: ReactPointerEvent, id: string): void
  onEditText(id: string): void
}) {
  const node = document.nodes[nodeId]
  if (!node || node.visible === false) return null
  const pos = preview?.[node.id] ?? { x: node.x, y: node.y, width: node.width, height: node.height }
  const left = pos.x - origin.x
  const top = pos.y - origin.y
  const opacity = node.opacity === undefined ? undefined : node.opacity
  const interactive = tool === 'select' && !node.locked ? 'auto' : 'none'
  const common: CSSProperties = {
    position: 'absolute',
    left,
    top,
    width: Math.max(0, pos.width),
    height: Math.max(0, pos.height),
    opacity,
    zIndex: 1,
  }
  const strokeWidth = node.stroke?.width ?? 0
  const outline: CSSProperties = node.stroke
    ? { border: `${strokeWidth}px solid ${node.stroke.color}`, boxSizing: 'border-box' }
    : {}

  if (node.type === 'frame' || node.type === 'group') {
    const label = node.type === 'frame' && origin.x === 0 && origin.y === 0 && (node.width > 8 || node.height > 8)
    return (
      <>
        {label ? (
          <div
            style={{
              position: 'absolute',
              left: pos.x,
              top: pos.y - 18 / zoom,
              fontSize: 11 / zoom,
              lineHeight: 1.2,
              color: selected.has(node.id) ? SELECTION_BLUE : 'rgba(63,63,70,0.7)',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              pointerEvents: 'auto',
              cursor: 'default',
              zIndex: 2,
            }}
            onPointerDown={(event) => onPointerDown(event, node.id)}
          >
            {node.name}
          </div>
        ) : null}
        <div
          data-node-id={node.id}
          style={{
            ...common,
            background: node.fill?.color ?? 'transparent',
            ...outline,
            borderRadius: node.cornerRadius,
            overflow: node.type === 'frame' && node.clip ? 'hidden' : 'visible',
            boxShadow: node.type === 'frame' && origin.x === 0 && origin.y === 0 ? 'var(--nd-canvas-frame-shadow)' : undefined,
            pointerEvents: node.type === 'frame' ? interactive : 'none',
            cursor: node.locked ? 'default' : 'move',
          }}
          onPointerDown={(event) => {
            if (node.type === 'frame') onPointerDown(event, node.id)
          }}
          onDoubleClick={(event) => {
            if (node.type === 'text') {
              event.stopPropagation()
              onEditText(node.id)
            }
          }}
        >
          {node.type === 'group' ? <GroupHitTarget nodeId={node.id} interactive={interactive} onPointerDown={onPointerDown} /> : null}
          {(node.children ?? []).map((childId) => (
            <NodeView
              key={childId}
              document={document}
              nodeId={childId}
              origin={{ x: pos.x, y: pos.y }}
              assets={assets}
              preview={preview}
              selected={selected}
              tool={tool}
              zoom={zoom}
              onPointerDown={onPointerDown}
              onEditText={onEditText}
            />
          ))}
          {node.type === 'group' ? <GroupLabel node={node} selected={selected.has(node.id)} zoom={zoom} onPointerDown={onPointerDown} /> : null}
        </div>
      </>
    )
  }

  if (node.type === 'text') {
    return (
      <div
        data-node-id={node.id}
        style={{
          ...common,
          color: node.color ?? '#18181b',
          fontFamily: node.fontFamily ?? 'Inter',
          fontSize: node.fontSize ?? 16,
          fontWeight: node.fontWeight ?? 400,
          lineHeight: node.lineHeight ?? 1.3,
          letterSpacing: node.letterSpacing ?? 0,
          textAlign: node.align ?? 'left',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflow: 'hidden',
          pointerEvents: interactive,
          cursor: node.locked ? 'default' : 'move',
          userSelect: 'none',
        }}
        onPointerDown={(event) => onPointerDown(event, node.id)}
        onDoubleClick={(event) => {
          event.stopPropagation()
          onEditText(node.id)
        }}
      >
        {node.text ?? ''}
      </div>
    )
  }

  if (node.type === 'image') {
    const src = node.src ? assets[node.src] : undefined
    return (
      <div
        data-node-id={node.id}
        style={{ ...common, ...outline, background: '#f4f4f5', overflow: 'hidden', pointerEvents: interactive, cursor: node.locked ? 'default' : 'move' }}
        onPointerDown={(event) => onPointerDown(event, node.id)}
      >
        {src ? (
          <img
            src={src}
            alt={node.name}
            draggable={false}
            style={{ width: '100%', height: '100%', objectFit: node.fit ?? 'cover', display: 'block', pointerEvents: 'none' }}
          />
        ) : (
          <div style={{ display: 'grid', placeItems: 'center', width: '100%', height: '100%', color: '#71717a', fontSize: 12 }}>
            Image
          </div>
        )}
      </div>
    )
  }

  if (node.type === 'line') {
    return (
      <svg
        data-node-id={node.id}
        style={{ ...common, overflow: 'visible', pointerEvents: interactive, cursor: node.locked ? 'default' : 'move' }}
        onPointerDown={(event) => onPointerDown(event, node.id)}
      >
        <line
          x1={0}
          y1={0}
          x2={Math.max(1, pos.width)}
          y2={Math.max(1, pos.height)}
          stroke={node.stroke?.color ?? '#52525b'}
          strokeWidth={node.stroke?.width ?? 2}
          strokeLinecap="round"
        />
      </svg>
    )
  }

  return (
    <div
      data-node-id={node.id}
      style={{
        ...common,
        background: node.fill?.color ?? '#e4e4e7',
        ...outline,
        borderRadius: node.type === 'ellipse' ? '50%' : node.cornerRadius,
        pointerEvents: interactive,
        cursor: node.locked ? 'default' : 'move',
      }}
      onPointerDown={(event) => onPointerDown(event, node.id)}
    />
  )
}

function GroupHitTarget({
  nodeId,
  interactive,
  onPointerDown,
}: {
  nodeId: string
  interactive: CSSProperties['pointerEvents']
  onPointerDown(event: ReactPointerEvent, id: string): void
}) {
  return (
    <div
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, pointerEvents: interactive }}
      onPointerDown={(event) => {
        event.stopPropagation()
        onPointerDown(event, nodeId)
      }}
    />
  )
}

function GroupLabel({
  node,
  selected,
  zoom,
  onPointerDown,
}: {
  node: DesignNode
  selected: boolean
  zoom: number
  onPointerDown(event: ReactPointerEvent, id: string): void
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: -16 / zoom,
        fontSize: 10 / zoom,
        color: selected ? SELECTION_BLUE : 'rgba(82,82,91,0.7)',
        fontWeight: 600,
        pointerEvents: 'auto',
        whiteSpace: 'nowrap',
      }}
      onPointerDown={(event) => onPointerDown(event, node.id)}
    >
      {node.name}
    </div>
  )
}

function Transformer({
  bounds,
  zoom,
  onStartResize,
}: {
  bounds: DesignBounds
  zoom: number
  onStartResize(event: ReactPointerEvent, handle: ResizeHandle): void
}) {
  const size = 8 / zoom
  const handles: Array<{ id: ResizeHandle; x: number; y: number; cursor: string }> = [
    { id: 'nw', x: 0, y: 0, cursor: 'nwse-resize' },
    { id: 'n', x: 0.5, y: 0, cursor: 'ns-resize' },
    { id: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
    { id: 'e', x: 1, y: 0.5, cursor: 'ew-resize' },
    { id: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
    { id: 's', x: 0.5, y: 1, cursor: 'ns-resize' },
    { id: 'sw', x: 0, y: 1, cursor: 'nesw-resize' },
    { id: 'w', x: 0, y: 0.5, cursor: 'ew-resize' },
  ]
  return (
    <>
      {handles.map((handle) => (
        <div
          key={handle.id}
          role="button"
          aria-label={`Resize ${handle.id}`}
          style={{
            position: 'absolute',
            left: bounds.x + bounds.width * handle.x - size / 2,
            top: bounds.y + bounds.height * handle.y - size / 2,
            width: size,
            height: size,
            background: '#ffffff',
            border: `${1.5 / zoom}px solid ${SELECTION_BLUE}`,
            borderRadius: 2 / zoom,
            cursor: handle.cursor,
            pointerEvents: 'auto',
            zIndex: 6,
            boxSizing: 'border-box',
          }}
          onPointerDown={(event) => onStartResize(event, handle.id)}
        />
      ))}
    </>
  )
}

function boundsOf(document: DesignDocument, id: string): DesignBounds | null {
  const node = document.nodes[id]
  return node ? { x: node.x, y: node.y, width: node.width, height: node.height } : null
}

function frameAtPoint(document: DesignDocument, point: DesignPoint): string | null {
  let found: string | null = null
  const visit = (id: string): void => {
    const node = document.nodes[id]
    if (!node || node.visible === false || node.locked) return
    if (node.type === 'frame' && contains(node, point)) {
      found = id
      for (const child of node.children ?? []) visit(child)
    } else if (node.type === 'group') {
      for (const child of node.children ?? []) visit(child)
    }
  }
  for (const id of document.pages[0]?.children ?? []) visit(id)
  return found
}

function contains(node: DesignNode, point: DesignPoint): boolean {
  return point.x >= node.x && point.y >= node.y && point.x <= node.x + node.width && point.y <= node.y + node.height
}

export function designPageBounds(document: DesignDocument): DesignBounds {
  const page = document.pages[0]
  const items = (page?.children ?? [])
    .map((id) => document.nodes[id])
    .filter((node): node is DesignNode => Boolean(node) && node?.visible !== false)
    .map((node) => ({ x: node.x, y: node.y, width: node.width, height: node.height }))
  return unionDesignBounds(items) ?? { x: 0, y: 0, width: 1440, height: 900 }
}
