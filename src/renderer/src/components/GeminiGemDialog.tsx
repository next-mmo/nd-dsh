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
  title: 'Link Gemini Skill',
  description: 'Link workspace "{workspaceName}" to a Gemini skill or chat. Gemini Web chats for this project open that chat, so its instructions stay attached.',
  inputLabel: 'Gemini chat link',
  inputPlaceholder: 'https://gemini.google.com/app/fa5b05f3a25f7f76',
  hint: 'Paste the link to your Gemini chat (e.g. https://gemini.google.com/app/fa5b05f3a25f7f76).',
  openLinkLabel: 'Open gemini.google.com/customize/skills',
  openLinkUrl: 'https://gemini.google.com/customize/skills',
  saveLabel: 'Save Skill Link',
  clearLabel: 'Clear Skill',
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
