import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { ExternalIcon } from './Icons'

export interface WebBindingDialogSpec {
  title: string
  /** {workspaceName} describes which workspace gets bound. */
  description: string
  inputLabel: string
  inputPlaceholder: string
  hint: string
  openLinkLabel: string
  openLinkUrl: string
  saveLabel: string
  clearLabel: string
}

interface WebChatBindingDialogProps {
  open: boolean
  workspaceName?: string | undefined
  /** Current binding reference shown as the initial input value. */
  currentRef: string | null
  spec: WebBindingDialogSpec
  onSave(input: string): Promise<void>
  onClear(): Promise<void>
  onOpenLink(): void
  onClose(): void
  onError(message: string): void
}

/**
 * Shared web-chat binding dialog: link the active workspace to a ChatGPT
 * Project or a Gemini Gem. All provider-specific text and API calls come from
 * the spec/wrappers so the interaction stays one narrow contract.
 */
export function WebChatBindingDialog({
  open,
  workspaceName,
  currentRef,
  spec,
  onSave,
  onClear,
  onOpenLink,
  onClose,
  onError,
}: WebChatBindingDialogProps) {
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) setInput(currentRef ?? '')
  }, [open, currentRef])

  const handleSave = async () => {
    const trimmed = input.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      await onSave(trimmed)
      onClose()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    setSaving(true)
    try {
      await onClear()
      onClose()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ExternalIcon className="size-4 text-primary" />
            <span>{spec.title}</span>
          </DialogTitle>
          <DialogDescription>
            {workspaceName ? spec.description.replace('{workspaceName}', workspaceName) : spec.description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">
              {spec.inputLabel}
            </label>
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={spec.inputPlaceholder}
              className="font-mono text-xs"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleSave()
                }
              }}
            />
            <p className="text-[11px] text-faint">{spec.hint}</p>
          </div>

          <div className="flex items-center justify-between pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs text-soft"
              onClick={onOpenLink}
              title={spec.openLinkLabel}
            >
              <ExternalIcon className="size-3" />
              <span>{spec.openLinkLabel}</span>
            </Button>
            {currentRef ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-xs text-destructive hover:text-destructive"
                onClick={() => void handleClear()}
                disabled={saving}
              >
                {spec.clearLabel}
              </Button>
            ) : null}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <DialogClose asChild>
            <Button variant="outline" size="sm" disabled={saving}>Cancel</Button>
          </DialogClose>
          <Button
            size="sm"
            disabled={saving || !input.trim()}
            onClick={() => void handleSave()}
          >
            {saving ? 'Saving…' : spec.saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
