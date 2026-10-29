import { useEffect, useState, type ReactNode } from 'react'
import {
  Circle,
  Eye,
  EyeOff,
  Frame,
  Group,
  Hand,
  Image as ImageIcon,
  Lock,
  Minus,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Redo2,
  Save,
  Sparkles,
  Square,
  Type,
  Undo2,
  Unlock,
  Wand2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { DesignDocument, DesignNode } from '../../../shared/nd-design/index.js'
import { cn } from '../lib/utils'
import { hexColor, type DesignTool } from './editor-state.js'

export function DesignToolbar({
  name,
  dirty,
  saving,
  tool,
  zoom,
  canUndo,
  canRedo,
  onTool,
  onUndo,
  onRedo,
  onZoomIn,
  onZoomOut,
  onFit,
  onSave,
  onBuild,
  onClose,
  layersVisible,
  inspectorVisible,
  onToggleLayers,
  onToggleInspector,
}: {
  name: string
  dirty: boolean
  saving: boolean
  tool: DesignTool
  zoom: number
  canUndo: boolean
  canRedo: boolean
  layersVisible: boolean
  inspectorVisible: boolean
  onTool(tool: DesignTool): void
  onUndo(): void
  onRedo(): void
  onZoomIn(): void
  onZoomOut(): void
  onFit(): void
  onSave(): void
  onBuild(): void
  onClose(): void
  onToggleLayers(): void
  onToggleInspector(): void
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border-soft bg-surface-1 px-2.5">
      <div className="flex min-w-0 items-center gap-2 pr-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-[10px] font-black tracking-tight text-primary">ND</span>
        <span className="truncate text-xs font-semibold text-strong">{name || 'ND Pencil'}</span>
        {dirty ? (
          <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-amber-600 dark:text-amber-400">Unsaved</span>
        ) : saving ? (
          <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold text-primary">Saving…</span>
        ) : (
          <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">Saved</span>
        )}
      </div>

      <div className="h-5 w-px bg-border-soft" />

      <div className="flex items-center gap-0.5 px-1">
        <ToolButton active={tool === 'select'} label="Select (V)" onClick={() => onTool('select')}><MousePointer2 className="size-3.5" /></ToolButton>
        <ToolButton active={tool === 'hand'} label="Pan (H)" onClick={() => onTool('hand')}><Hand className="size-3.5" /></ToolButton>
        <ToolButton active={tool === 'frame'} label="Frame (F)" onClick={() => onTool('frame')}><Frame className="size-3.5" /></ToolButton>
        <ToolButton active={tool === 'rect'} label="Rectangle (R)" onClick={() => onTool('rect')}><Square className="size-3.5" /></ToolButton>
        <ToolButton active={tool === 'ellipse'} label="Ellipse (O)" onClick={() => onTool('ellipse')}><Circle className="size-3.5" /></ToolButton>
        <ToolButton active={tool === 'line'} label="Line (L)" onClick={() => onTool('line')}><Minus className="size-3.5" /></ToolButton>
        <ToolButton active={tool === 'text'} label="Text (T)" onClick={() => onTool('text')}><Type className="size-3.5" /></ToolButton>
        <ToolButton active={tool === 'image'} label="Image (I)" onClick={() => onTool('image')}><ImageIcon className="size-3.5" /></ToolButton>
      </div>

      <div className="h-5 w-px bg-border-soft" />

      <div className="flex items-center gap-0.5 px-1">
        <ToolButton label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}><Undo2 className="size-3.5" /></ToolButton>
        <ToolButton label="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo}><Redo2 className="size-3.5" /></ToolButton>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <ToolButton active={layersVisible} label={layersVisible ? 'Hide layers' : 'Show layers'} onClick={onToggleLayers}><PanelLeft className="size-3.5" /></ToolButton>
        <ToolButton active={inspectorVisible} label={inspectorVisible ? 'Hide inspector' : 'Show inspector'} onClick={onToggleInspector}><PanelRight className="size-3.5" /></ToolButton>
        <div className="flex items-center gap-0.5 rounded-md border border-border-soft bg-surface-2 px-0.5">
          <ToolButton label="Zoom out" onClick={onZoomOut}><ZoomOut className="size-3.5" /></ToolButton>
          <button type="button" className="min-w-10 px-1 text-[10px] font-semibold text-muted-foreground hover:text-strong" title="Fit canvas" onClick={onFit}>
            {Math.round(zoom * 100)}%
          </button>
          <ToolButton label="Zoom in" onClick={onZoomIn}><ZoomIn className="size-3.5" /></ToolButton>
        </div>
        <button
          type="button"
          onClick={onSave}
          className="flex h-7 items-center gap-1 rounded-md border border-border-soft bg-surface-2 px-2 text-[11px] font-semibold text-strong hover:bg-accent"
          title="Save (Ctrl+S)"
        >
          <Save className="size-3.5" /> Save
        </button>
        <button
          type="button"
          onClick={onBuild}
          className="flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90"
          title="Build this design into the active project"
        >
          <Wand2 className="size-3.5" /> Build into App
        </button>
        <ToolButton label="Close canvas" onClick={onClose}><X className="size-3.5" /></ToolButton>
      </div>
    </div>
  )
}

function ToolButton({
  active,
  disabled,
  label,
  onClick,
  children,
}: {
  active?: boolean
  disabled?: boolean
  label: string
  onClick(): void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-strong disabled:opacity-35',
        active && 'bg-primary/10 text-primary',
      )}
    >
      {children}
    </button>
  )
}

export function DesignLayersPanel({
  document,
  selection,
  onSelect,
  onUpdate,
}: {
  document: DesignDocument
  selection: string[]
  onSelect(ids: string[]): void
  onUpdate(id: string, patch: Record<string, unknown>): void
}) {
  const selected = new Set(selection)
  const page = document.pages[0]
  if (!page) return null
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border-soft px-3">
        <span className="text-[10px] font-bold uppercase tracking-widest text-faint">Layers</span>
        <span className="text-[10px] text-muted-foreground">{Object.keys(document.nodes).length}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        <div className="mb-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-faint">{page.name}</div>
        {[...page.children].reverse().map((id) => (
          <LayerRow
            key={id}
            document={document}
            nodeId={id}
            depth={0}
            selected={selected}
            onSelect={onSelect}
            onUpdate={onUpdate}
          />
        ))}
        {page.children.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">Draw a frame or ask the agent for a screen.</p>
        ) : null}
      </div>
    </div>
  )
}

function LayerRow({
  document,
  nodeId,
  depth,
  selected,
  onSelect,
  onUpdate,
}: {
  document: DesignDocument
  nodeId: string
  depth: number
  selected: Set<string>
  onSelect(ids: string[]): void
  onUpdate(id: string, patch: Record<string, unknown>): void
}) {
  const node = document.nodes[nodeId]
  if (!node) return null
  const isSelected = selected.has(node.id)
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={isSelected}
        onClick={(event) => {
          if (event.shiftKey) {
            const next = isSelected ? [...selected].filter((id) => id !== node.id) : [...selected, node.id]
            onSelect(next)
          } else {
            onSelect([node.id])
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect([node.id])
          }
        }}
        className={cn(
          'group flex h-7 cursor-default items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent',
          isSelected && 'bg-primary/10 text-primary',
          node.visible === false && 'opacity-45',
        )}
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {node.type === 'frame' ? <Frame className="size-3" /> : node.type === 'group' ? <Group className="size-3" /> : node.type === 'text' ? <Type className="size-3" /> : node.type === 'image' ? <ImageIcon className="size-3" /> : node.type === 'ellipse' ? <Circle className="size-3" /> : node.type === 'line' ? <Minus className="size-3" /> : <Square className="size-3" />}
        </span>
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <button
          type="button"
          title={node.visible === false ? 'Show layer' : 'Hide layer'}
          className="flex size-5 shrink-0 items-center justify-center rounded opacity-0 hover:bg-surface-2 group-hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            onUpdate(node.id, { visible: node.visible === false })
          }}
        >
          {node.visible === false ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
        </button>
        <button
          type="button"
          title={node.locked ? 'Unlock layer' : 'Lock layer'}
          className="flex size-5 shrink-0 items-center justify-center rounded opacity-0 hover:bg-surface-2 group-hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            onUpdate(node.id, { locked: !node.locked })
          }}
        >
          {node.locked ? <Lock className="size-3" /> : <Unlock className="size-3" />}
        </button>
      </div>
      {node.children ? [...node.children].reverse().map((childId) => (
        <LayerRow
          key={childId}
          document={document}
          nodeId={childId}
          depth={depth + 1}
          selected={selected}
          onSelect={onSelect}
          onUpdate={onUpdate}
        />
      )) : null}
    </>
  )
}

export function DesignInspectorPanel({
  document,
  documentPath,
  revision,
  selection,
  onUpdate,
  onDelete,
}: {
  document: DesignDocument
  documentPath?: string
  revision: number
  selection: string[]
  onUpdate(id: string, patch: Record<string, unknown>): void
  onDelete(ids: string[]): void
}) {
  const nodes = selection.map((id) => document.nodes[id]).filter((node): node is DesignNode => Boolean(node))
  if (nodes.length === 0) {
    return (
      <InspectorShell title="Design">
        <div className="flex flex-col gap-3 p-3 text-xs">
          <div className="rounded-lg border border-border-soft bg-surface-1 p-3">
            <div className="text-[10px] font-bold uppercase tracking-widest text-primary">ND Pencil</div>
            <div className="mt-1 text-sm font-semibold text-strong">{document.name}</div>
            <div className="mt-1 break-all text-[10px] text-faint">{documentPath ?? 'Unsaved document'}</div>
          </div>
          <Property label="Nodes" value={String(Object.keys(document.nodes).length)} />
          <Property label="Revision" value={String(revision)} />
          <Property label="Format" value=".op · v2" />
          {document.meta?.migration ? <MigrationReport document={document} /> : null}
          <p className="rounded-md border border-dashed border-border-soft p-2.5 text-[11px] leading-relaxed text-muted-foreground">
            Select a layer to edit its properties, or ask the agent below to generate or change a screen.
          </p>
        </div>
      </InspectorShell>
    )
  }
  if (nodes.length > 1) {
    return (
      <InspectorShell title={`${nodes.length} selected`}>
        <div className="flex flex-col gap-3 p-3 text-xs">
          <p className="text-muted-foreground">Drag any selected node to move the group together, or use the layer list to refine the selection.</p>
          <button type="button" className="rounded-md border border-destructive/30 px-2 py-1.5 text-[11px] font-semibold text-destructive hover:bg-destructive/10" onClick={() => onDelete(nodes.map((node) => node.id))}>
            Delete selection
          </button>
        </div>
      </InspectorShell>
    )
  }
  const node = nodes[0]!
  return (
    <InspectorShell title={node.type === 'frame' ? 'Frame' : node.type === 'group' ? 'Group' : node.type === 'text' ? 'Text' : node.type === 'image' ? 'Image' : node.type === 'line' ? 'Line' : 'Shape'}>
      <div className="flex flex-col gap-3 p-3 text-xs">
        <Field label="Name">
          <input
            key={`${node.id}-${node.name}`}
            defaultValue={node.name}
            onBlur={(event) => {
              const value = event.target.value.trim()
              if (value && value !== node.name) onUpdate(node.id, { name: value })
            }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
            className="h-7 w-full rounded border border-border-soft bg-surface-2 px-2 text-[11px] text-strong outline-none focus:border-primary/50"
          />
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <NumberField label="X" value={node.x} onChange={(value) => onUpdate(node.id, { x: value })} />
          <NumberField label="Y" value={node.y} onChange={(value) => onUpdate(node.id, { y: value })} />
          <NumberField label="W" value={node.width} min={1} onChange={(value) => onUpdate(node.id, { width: value })} />
          <NumberField label="H" value={node.height} min={1} onChange={(value) => onUpdate(node.id, { height: value })} />
        </div>

        <OpacityField value={node.opacity ?? 1} onChange={(value) => onUpdate(node.id, { opacity: value })} />

        {node.type !== 'text' && node.type !== 'line' && node.type !== 'image' ? (
          <>
            <ColorField label="Fill" value={node.fill?.color} onChange={(value) => onUpdate(node.id, { fill: value ? { type: 'solid', color: value } : null })} />
            <ColorField label="Stroke" value={node.stroke?.color} onChange={(value) => onUpdate(node.id, { stroke: value ? { color: value, width: node.stroke?.width ?? 1 } : null })} />
            {node.stroke ? <NumberField label="Stroke width" value={node.stroke.width} min={0} onChange={(value) => onUpdate(node.id, { stroke: { color: node.stroke?.color ?? '#a1a1aa', width: value } })} /> : null}
            <NumberField label="Corner radius" value={node.cornerRadius ?? 0} min={0} onChange={(value) => onUpdate(node.id, { cornerRadius: value })} />
          </>
        ) : null}

        {node.type === 'text' ? (
          <>
            <Field label="Text">
              <textarea
                key={`${node.id}-${node.text}`}
                defaultValue={node.text ?? ''}
                onBlur={(event) => { if (event.target.value !== node.text) onUpdate(node.id, { text: event.target.value }) }}
                className="min-h-16 w-full resize-y rounded border border-border-soft bg-surface-2 p-2 text-[11px] text-strong outline-none focus:border-primary/50"
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Font">
                <select
                  value={node.fontFamily ?? 'Inter'}
                  onChange={(event) => onUpdate(node.id, { fontFamily: event.target.value })}
                  className="h-7 w-full rounded border border-border-soft bg-surface-2 px-1 text-[11px] text-strong outline-none"
                >
                  <option>Inter</option>
                  <option>Geist</option>
                  <option>system-ui</option>
                  <option>Arial</option>
                  <option>Georgia</option>
                  <option>monospace</option>
                </select>
              </Field>
              <NumberField label="Size" value={node.fontSize ?? 16} min={1} onChange={(value) => onUpdate(node.id, { fontSize: value })} />
              <NumberField label="Weight" value={node.fontWeight ?? 400} min={100} onChange={(value) => onUpdate(node.id, { fontWeight: value })} />
              <NumberField label="Line height" value={node.lineHeight ?? 1.3} min={0.5} onChange={(value) => onUpdate(node.id, { lineHeight: value })} />
            </div>
            <Field label="Align">
              <div className="flex gap-1">
                {(['left', 'center', 'right'] as const).map((align) => (
                  <button
                    key={align}
                    type="button"
                    onClick={() => onUpdate(node.id, { align })}
                    className={cn('flex-1 rounded border border-border-soft px-2 py-1 text-[10px] capitalize', node.align === align ? 'bg-primary/10 text-primary' : 'bg-surface-2 text-muted-foreground')}
                  >
                    {align}
                  </button>
                ))}
              </div>
            </Field>
            <ColorField label="Text color" value={node.color} onChange={(value) => onUpdate(node.id, { color: value ?? '#18181b' })} />
          </>
        ) : null}

        {node.type === 'image' ? (
          <>
            <Property label="Source" value={node.src ?? 'None'} />
            <Field label="Fit">
              <select
                value={node.fit ?? 'cover'}
                onChange={(event) => onUpdate(node.id, { fit: event.target.value })}
                className="h-7 w-full rounded border border-border-soft bg-surface-2 px-1 text-[11px] text-strong outline-none"
              >
                <option value="cover">Cover</option>
                <option value="contain">Contain</option>
                <option value="fill">Fill</option>
              </select>
            </Field>
          </>
        ) : null}

        {node.type === 'frame' ? (
          <label className="flex items-center justify-between rounded border border-border-soft bg-surface-1 px-2 py-1.5 text-[11px] text-muted-foreground">
            Clip content
            <input type="checkbox" checked={node.clip !== false} onChange={(event) => onUpdate(node.id, { clip: event.target.checked })} />
          </label>
        ) : null}

        <div className="flex items-center gap-2">
          <button type="button" className="flex-1 rounded border border-border-soft px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent" onClick={() => onUpdate(node.id, { visible: node.visible === false })}>
            {node.visible === false ? 'Show' : 'Hide'}
          </button>
          <button type="button" className="flex-1 rounded border border-border-soft px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent" onClick={() => onUpdate(node.id, { locked: !node.locked })}>
            {node.locked ? 'Unlock' : 'Lock'}
          </button>
        </div>
        <button type="button" className="rounded-md border border-destructive/30 px-2 py-1.5 text-[11px] font-semibold text-destructive hover:bg-destructive/10" onClick={() => onDelete([node.id])}>
          Delete node
        </button>
      </div>
    </InspectorShell>
  )
}

function InspectorShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <header className="flex h-9 shrink-0 items-center border-b border-border-soft px-3">
        <span className="text-[10px] font-bold uppercase tracking-widest text-faint">{title}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">{label}</span>
      {children}
    </label>
  )
}

function NumberField({ label, value, min, onChange }: { label: string; value: number; min?: number; onChange(value: number): void }) {
  const [draft, setDraft] = useState(String(Math.round(value * 100) / 100))
  useEffect(() => {
    setDraft(String(Math.round(value * 100) / 100))
  }, [value])
  const commit = (): void => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const next = min === undefined ? parsed : Math.max(min, parsed)
    if (next !== value) onChange(next)
    setDraft(String(next))
  }
  return (
    <Field label={label}>
      <input
        type="number"
        value={draft}
        min={min}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
        className="h-7 w-full rounded border border-border-soft bg-surface-2 px-2 text-[11px] text-strong outline-none focus:border-primary/50"
      />
    </Field>
  )
}

function OpacityField({ value, onChange }: { value: number; onChange(value: number): void }) {
  const [draft, setDraft] = useState(Math.round(value * 100))
  useEffect(() => { setDraft(Math.round(value * 100)) }, [value])
  const commit = (): void => {
    const next = Math.max(0, Math.min(100, draft)) / 100
    if (next !== value) onChange(next)
  }
  return (
    <Field label={`Opacity ${draft}%`}>
      <input
        type="range"
        min={0}
        max={100}
        value={draft}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="w-full accent-primary"
      />
    </Field>
  )
}

function ColorField({ label, value, onChange }: { label: string; value?: string | undefined; onChange(value: string | null): void }) {
  const [draft, setDraft] = useState(hexColor(value))
  useEffect(() => { setDraft(hexColor(value)) }, [value])
  const commit = (): void => {
    if (draft !== hexColor(value)) onChange(draft)
  }
  return (
    <Field label={label}>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          className="h-7 w-9 cursor-pointer rounded border border-border-soft bg-surface-2 p-0.5"
          aria-label={`${label} color`}
        />
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{value ?? 'None'}</span>
        <button type="button" className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent" onClick={() => onChange(null)}>None</button>
      </div>
    </Field>
  )
}

function Property({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium text-strong" title={value}>{value}</span>
    </div>
  )
}

function MigrationReport({ document }: { document: DesignDocument }) {
  const migration = document.meta?.migration
  if (!migration) return null
  const dropped = Object.entries(migration.dropped)
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-[10px] text-amber-700 dark:text-amber-300">
      <div className="font-semibold">Legacy .op imported</div>
      <div className="mt-1 leading-relaxed">Unsupported features: {dropped.length > 0 ? dropped.map(([kind, count]) => `${kind} ×${count}`).join(', ') : 'none reported'}.</div>
      {migration.approximate.length > 0 ? <div className="mt-1 leading-relaxed">{migration.approximate.length} size approximation(s); review the canvas before Build into App.</div> : null}
      <div className="mt-1 leading-relaxed">The original file was backed up before the first save.</div>
    </div>
  )
}

export function DesignAgentPromptBar({
  selectionCount,
  disabled,
  onSend,
}: {
  selectionCount: number
  disabled?: boolean
  onSend(prompt: string): void
}) {
  const [value, setValue] = useState('')
  const [expanded, setExpanded] = useState(false)
  const send = (): void => {
    const text = value.trim()
    if (!text || disabled) return
    setValue('')
    setExpanded(false)
    onSend(text)
  }
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-6">
      <div className="pointer-events-auto w-[min(620px,100%)] rounded-xl border border-border-strong bg-surface-1/95 p-2 shadow-xl backdrop-blur">
        <div className="flex items-start gap-2">
          <span className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Sparkles className="size-3.5" />
          </span>
          <textarea
            value={value}
            rows={expanded ? 4 : 1}
            placeholder={selectionCount > 0 ? `Edit the ${selectionCount} selected layer${selectionCount === 1 ? '' : 's'} or describe a screen…` : 'Describe a screen or edit this canvas…'}
            onChange={(event) => setValue(event.target.value)}
            onFocus={() => setExpanded(true)}
            onBlur={() => { if (!value.trim()) setExpanded(false) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            }}
            className="max-h-40 min-h-7 w-full resize-none bg-transparent py-1 text-xs text-strong outline-none placeholder:text-muted-foreground/70"
            aria-label="Ask ND Agent to edit the canvas"
          />
          <button
            type="button"
            onClick={send}
            disabled={disabled || !value.trim()}
            className="mt-0.5 flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground disabled:opacity-40"
          >
            <Sparkles className="size-3" /> Send
          </button>
        </div>
        <div className="flex items-center justify-between px-8 pb-0.5 text-[9px] text-faint">
          <span>ND Agent edits the live canvas. Enter sends, Shift+Enter adds a line.</span>
          <span>{selectionCount > 0 ? `${selectionCount} selected` : 'No selection'}</span>
        </div>
      </div>
    </div>
  )
}
