import { useMemo, useState } from 'react'
import { Camera, Clipboard, Copy, Download, FolderOpen, MessageSquare, Search, StickyNote, Trash2 } from 'lucide-react'
import type { NdCaptureResultView, NdHomeStateView } from '../../../shared/nd-invocations'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card } from './ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'

interface Props {
  state: NdHomeStateView
  busy: boolean
  onError(message: string): void
  onChanged(): Promise<void>
  onCaptureScreen(): Promise<void>
  onCaptureArea(): Promise<void>
  onCopyCapture(captureId: string): Promise<void>
  onExportCapture(captureId: string): Promise<void>
  onAskWithCapture(capture: NdCaptureResultView, prompt: string): Promise<void>
  onOpenChat(sessionId: string): void
  onStartChat(prompt?: string): Promise<void>
}

function formatWhen(at: number): string {
  return new Date(at).toLocaleString()
}

/**
 * Personal: the space that works before any company or project exists.
 * Notes, captures, and chats here are personal ND records in ND-managed
 * storage; company/project notes stay in the organization store.
 */
export function HomeView({
  state,
  busy,
  onError,
  onChanged,
  onCaptureScreen,
  onCaptureArea,
  onCopyCapture,
  onExportCapture,
  onAskWithCapture,
  onOpenChat,
  onStartChat,
}: Props): React.ReactNode {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<{ id: string; title: string; body: string; tags: string } | null>(null)
  const [preview, setPreview] = useState<{ capture: NdCaptureResultView; askPrompt: string } | null>(null)
  const [chatPrompt, setChatPrompt] = useState('')

  const notes = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return state.notes
    return state.notes.filter((note) =>
      note.title.toLowerCase().includes(needle)
      || note.body.toLowerCase().includes(needle)
      || note.tags.some((tag) => tag.toLowerCase().includes(needle)))
  }, [state.notes, query])

  const saveNote = async (): Promise<void> => {
    if (!draft.trim()) return
    try {
      await window.ndDsh.home.createNote({ body: draft })
      setDraft('')
      await onChanged()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const saveEditing = async (): Promise<void> => {
    if (!editing) return
    try {
      await window.ndDsh.home.updateNote(editing.id, {
        body: editing.body,
        title: editing.title,
        tags: editing.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      })
      setEditing(null)
      await onChanged()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const openPreview = async (captureId: string): Promise<void> => {
    try {
      const capture = await window.ndDsh.home.readCapture(captureId)
      if (!capture) {
        onError('That capture is no longer available.')
        return
      }
      setPreview({ capture, askPrompt: '' })
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Personal</h2>
          <p className="text-xs text-faint">
            Notes, captures, and chats — stored in ND-managed user storage, independent of any company or project.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void window.ndDsh.home.revealStorage().catch((cause) => onError(String(cause)))}>
            <FolderOpen className="size-3.5" /> Reveal storage
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void onCaptureScreen()}>
            <Camera className="size-3.5" /> Capture screen
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void onCaptureArea()}>
            <Clipboard className="size-3.5" /> Capture area
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="flex min-h-0 flex-col gap-3 border-border-soft p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">Personal notes</span>
            <Badge variant="secondary">{state.notes.length}</Badge>
          </div>
          <div className="flex items-start gap-2">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Write a note…"
              className="min-h-[72px] flex-1 resize-y text-sm"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void saveNote()
              }}
            />
            <Button size="sm" disabled={!draft.trim()} onClick={() => void saveNote()}>
              Save
            </Button>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search personal notes"
              className="h-8 pl-7 text-xs"
            />
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {notes.length === 0 ? (
              <p className="text-xs text-faint">No notes yet. Notes you save from the launcher or here appear instantly.</p>
            ) : notes.map((note) => (
              <div key={note.id} className="rounded-md border border-border-soft bg-surface-0/40 p-2.5">
                {editing?.id === note.id ? (
                  <div className="space-y-2">
                    <Input value={editing.title} onChange={(event) => setEditing({ ...editing, title: event.target.value })} className="h-7 text-xs" />
                    <Textarea value={editing.body} onChange={(event) => setEditing({ ...editing, body: event.target.value })} className="min-h-[64px] text-xs" />
                    <Input value={editing.tags} onChange={(event) => setEditing({ ...editing, tags: event.target.value })} placeholder="tags, comma separated" className="h-7 text-xs" />
                    <div className="flex gap-2">
                      <Button size="sm" className="h-7" onClick={() => void saveEditing()}>Save</Button>
                      <Button size="sm" variant="ghost" className="h-7" onClick={() => setEditing(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                        <StickyNote className="size-3.5 text-primary" /> {note.title}
                      </span>
                      <span className="shrink-0 text-[10px] text-faint">{formatWhen(note.updatedAt)}</span>
                    </div>
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-soft">{note.body}</p>
                    <div className="mt-2 flex items-center gap-2">
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setEditing({ id: note.id, title: note.title, body: note.body, tags: note.tags.join(', ') })}>Edit</Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px] text-destructive"
                        onClick={() => void window.ndDsh.home.deleteNote(note.id).then(onChanged).catch((cause) => onError(String(cause)))}
                      >
                        Delete
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </Card>

        <div className="flex min-h-0 flex-col gap-4">
          <Card className="flex min-h-0 flex-col gap-3 border-border-soft p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">Captures</span>
              <Badge variant="secondary">{state.captures.length}</Badge>
            </div>
            <p className="text-[11px] text-faint">Captures stay local in ND storage until you attach, copy, export, or ask ND about one.</p>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {state.captures.length === 0 ? (
                <p className="text-xs text-faint">No captures yet. Use Capture screen or Capture area.</p>
              ) : state.captures.map((capture) => (
                <div key={capture.id} className="flex items-center justify-between gap-2 rounded-md border border-border-soft bg-surface-0/40 p-2">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void openPreview(capture.id)}>
                    <span className="block truncate text-xs font-medium text-foreground">{capture.name}</span>
                    <span className="block text-[10px] text-faint">{capture.displayLabel} · {formatWhen(capture.createdAt)}{capture.attachedSessionId ? ' · attached' : ''}</span>
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px] text-destructive"
                    onClick={() => void window.ndDsh.home.deleteCapture(capture.id).then(onChanged).catch((cause) => onError(String(cause)))}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              ))}
            </div>
          </Card>

          <Card className="flex min-h-0 flex-col gap-3 border-border-soft p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">Personal chats</span>
              <Badge variant="secondary">{state.chats.length}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={chatPrompt}
                onChange={(event) => setChatPrompt(event.target.value)}
                placeholder="Ask ND anything…"
                className="h-8 flex-1 text-xs"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && chatPrompt.trim()) {
                    const prompt = chatPrompt.trim()
                    setChatPrompt('')
                    void onStartChat(prompt)
                  }
                }}
              />
              <Button size="sm" disabled={!chatPrompt.trim()} onClick={() => { const prompt = chatPrompt.trim(); setChatPrompt(''); void onStartChat(prompt) }}>
                <MessageSquare className="size-3.5" /> Ask
              </Button>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {state.chats.length === 0 ? (
                <p className="text-xs text-faint">Personal chats run in a managed per-chat folder and stay bound to Personal.</p>
              ) : state.chats.map((chat) => (
                <div key={chat.chatId} className="flex items-center justify-between gap-2 rounded-md border border-border-soft bg-surface-0/40 p-2">
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground">{chat.title}</span>
                    <span className="block truncate text-[10px] text-faint">{chat.workDir}</span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    disabled={!chat.sessionId}
                    onClick={() => chat.sessionId && onOpenChat(chat.sessionId)}
                  >
                    Open
                  </Button>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Dialog open={preview !== null} onOpenChange={(open) => { if (!open) setPreview(null) }}>
        <DialogContent className="max-w-2xl border-border-strong bg-surface-1">
          <DialogHeader>
            <DialogTitle>{preview?.capture.displayLabel} capture</DialogTitle>
            <DialogDescription>
              This capture is local to Personal. Nothing is uploaded to a model until you explicitly ask ND about it.
            </DialogDescription>
          </DialogHeader>
          {preview ? (
            <div className="space-y-3">
              <img
                src={`data:image/png;base64,${preview.capture.data}`}
                alt="Capture preview"
                className="max-h-[320px] w-full rounded-md border border-border-soft object-contain"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void onCopyCapture(preview.capture.captureId)}>
                  <Copy className="size-3.5" /> Copy
                </Button>
                <Button size="sm" variant="outline" onClick={() => void onExportCapture(preview.capture.captureId)}>
                  <Download className="size-3.5" /> Export
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={preview.askPrompt}
                  onChange={(event) => setPreview({ ...preview, askPrompt: event.target.value })}
                  placeholder="What should ND look for in this capture?"
                  className="h-8 flex-1 text-xs"
                />
                <Button
                  size="sm"
                  disabled={!preview.askPrompt.trim() || busy}
                  onClick={() => void onAskWithCapture(preview.capture, preview.askPrompt.trim())}
                >
                  Ask ND
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
