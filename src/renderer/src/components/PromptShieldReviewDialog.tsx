import type { PromptShieldBlockedPayload } from '../../../shared/prompt-shield'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'

interface PromptShieldReviewDialogProps {
  open: boolean
  payload: PromptShieldBlockedPayload | null
  busy?: boolean
  onClose(): void
  onSendMasked(): void
  onSendOnce(): void
}

/**
 * Shown when Prompt Shield holds a turn. The payload carries categories and a
 * masked preview only; the original values stay in the composer/run request.
 */
export function PromptShieldReviewDialog({
  open,
  payload,
  busy = false,
  onClose,
  onSendMasked,
  onSendOnce,
}: PromptShieldReviewDialogProps) {
  const findings = payload?.findings ?? []
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Prompt Shield blocked this message</DialogTitle>
          <DialogDescription>
            Sensitive data configured to block was detected. Nothing has been sent yet.
          </DialogDescription>
        </DialogHeader>

        {findings.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {findings.map((finding) => (
              <span
                key={`${finding.categoryId}:${finding.action}`}
                className="rounded-md border border-border-soft bg-meta px-2 py-1 text-[10px] font-semibold text-soft"
              >
                {finding.label} ×{finding.count}
              </span>
            ))}
          </div>
        ) : null}

        {payload?.preview ? (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Masked preview</span>
            <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap rounded-md border border-border-soft bg-meta p-2 font-mono text-[10px]/[1.5] text-soft">
              {payload.preview}{payload.previewTruncated ? '\n…' : ''}
            </pre>
          </div>
        ) : null}

        <p className="text-[10px]/[1.5] text-faint">
          You can change which data types block, mask, or pass in Settings → General → Privacy.
        </p>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Edit message</Button>
          <Button variant="secondary" disabled={busy} onClick={onSendOnce}>Send anyway</Button>
          <Button disabled={busy} onClick={onSendMasked}>{busy ? 'Sending…' : 'Send masked'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
