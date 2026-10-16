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
  title: 'Link Gemini Gem',
  description: 'Link workspace "{workspaceName}" to a Gemini Gem. Chats started with Gemini Web will run inside that Gem so its instructions stay attached to the project.',
  inputLabel: 'Gemini Gem Link',
  inputPlaceholder: 'https://gemini.google.com/gem/...',
  hint: 'Copy the URL from the Gem you created for this project, or open the Gems library to create one.',
  openLinkLabel: 'Open gemini.google.com/gems',
  openLinkUrl: 'https://gemini.google.com/gems',
  saveLabel: 'Save Gem Link',
  clearLabel: 'Clear Gem',
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
