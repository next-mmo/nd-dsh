import type { GeminiGemBinding } from '../../../shared/contracts'
import { WebChatBindingDialog, type WebBindingDialogSpec } from './WebChatBindingDialog'

interface GeminiGemDialogProps {
  open: boolean
  workspaceRoot?: string
  workspaceName?: string
  currentBinding: GeminiGemBinding | null
  onClose(): void
  onSaved(binding: GeminiGemBinding): void
  onCleared?(): void
  onError(message: string): void
}

const SPEC: WebBindingDialogSpec = {
  title: 'Link Gemini Skill / Google AI Studio App',
  description: 'Link workspace "{workspaceName}" to a Gemini skill or Google AI Studio app project. Web chats for this project keep instructions or app context attached.',
  inputLabel: 'Gemini chat link or AI Studio app URL',
  inputPlaceholder: 'https://gemini.google.com/app/... or https://aistudio.google.com/apps/...',
  hint: 'Paste the link to your Gemini chat or Google AI Studio app (e.g. https://aistudio.google.com/apps or https://gemini.google.com/app/fa5b05f3a25f7f76).',
  openLinkLabel: 'Create App in AI Studio (aistudio.google.com/apps)',
  openLinkUrl: 'https://aistudio.google.com/apps',
  saveLabel: 'Save Project Link',
  clearLabel: 'Clear Link',
}

export function GeminiGemDialog({
  open,
  workspaceRoot,
  workspaceName,
  currentBinding,
  onClose,
  onSaved,
  onCleared,
  onError,
}: GeminiGemDialogProps) {
  return (
    <WebChatBindingDialog
      open={open}
      workspaceName={workspaceName}
      currentRef={currentBinding?.gemUrl ?? currentBinding?.gemRef ?? null}
      spec={SPEC}
      onClose={onClose}
      onError={onError}
      onSave={async (input) => {
        const binding = await window.ndDsh.geminiWeb.setGemBinding(workspaceRoot || '', input)
        onSaved(binding)
      }}
      onClear={async () => {
        await window.ndDsh.geminiWeb.clearGemBinding(workspaceRoot || '')
        onCleared?.()
      }}
      onOpenLink={() => {
        void window.ndDsh.browser.navigate(SPEC.openLinkUrl)
      }}
    />
  )
}
