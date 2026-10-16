import type { ChatGptProjectBinding } from '../../../shared/contracts'
import { WebChatBindingDialog, type WebBindingDialogSpec } from './WebChatBindingDialog'

interface ChatGptProjectDialogProps {
  open: boolean
  workspaceRoot?: string
  workspaceName?: string
  currentBinding: ChatGptProjectBinding | null
  onClose(): void
  onSaved(binding: ChatGptProjectBinding): void
  onCleared?(): void
  onError(message: string): void
}

const SPEC: WebBindingDialogSpec = {
  title: 'Link ChatGPT Project',
  description: 'Link workspace "{workspaceName}" to a ChatGPT Project. Chats started with ChatGPT Web will stay scoped inside this project.',
  inputLabel: 'ChatGPT Project Link or ID',
  inputPlaceholder: 'https://chatgpt.com/g/g-p-6a9bf...-todo/project or g-p-...',
  hint: 'Copy the URL from your browser bar when viewing the project on ChatGPT, or enter its ID.',
  openLinkLabel: 'Open chatgpt.com/projects',
  openLinkUrl: 'https://chatgpt.com/projects',
  saveLabel: 'Save Project Link',
  clearLabel: 'Clear Link',
}

export function ChatGptProjectDialog({
  open,
  workspaceRoot,
  workspaceName,
  currentBinding,
  onClose,
  onSaved,
  onCleared,
  onError,
}: ChatGptProjectDialogProps) {
  return (
    <WebChatBindingDialog
      open={open}
      workspaceName={workspaceName}
      currentRef={currentBinding?.chatGptProjectUrl ?? currentBinding?.chatGptProjectRef ?? null}
      spec={SPEC}
      onClose={onClose}
      onError={onError}
      onSave={async (input) => {
        const binding = await window.ndDsh.chatGptWeb.setProjectBinding(workspaceRoot || '', input)
        onSaved(binding)
      }}
      onClear={async () => {
        await window.ndDsh.chatGptWeb.clearProjectBinding(workspaceRoot || '')
        onCleared?.()
      }}
      onOpenLink={() => {
        void window.ndDsh.browser.navigate(SPEC.openLinkUrl)
      }}
    />
  )
}
