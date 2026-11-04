import { useEffect, useMemo, useState } from 'react'
import type { RouterExternalKey, RouterPlaygroundMessage } from '../../../shared/router'
import { CheckIcon, CloseIcon, CopyIcon, EyeIcon, EyeOffIcon, SpinnerIcon, TerminalIcon } from './Icons'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { StatusChip } from './settings-primitives'

export interface RouterCurlDialogProps {
  open: boolean
  onClose: () => void
  route: string
  resolvedModel?: string | null | undefined
  resolvedProvider?: string | null | undefined
  resolvedCombo?: string | null | undefined
  messages?: Array<{ role: string; content: string }> | undefined
  currentPrompt?: string | undefined
  endpoint?: string | undefined
  onError?: ((message: string) => void) | undefined
}

export function RouterCurlDialog({
  open,
  onClose,
  route,
  resolvedModel,
  resolvedProvider,
  resolvedCombo,
  messages,
  currentPrompt,
  endpoint: initialEndpoint,
  onError,
}: RouterCurlDialogProps) {
  if (!open) return null

  const [keyInfo, setKeyInfo] = useState<RouterExternalKey | null>(null)
  const [loading, setLoading] = useState(false)
  const [revealedKey, setRevealedKey] = useState(true)
  const [includeStream, setIncludeStream] = useState(true)
  const [includeHistory, setIncludeHistory] = useState(false)
  const [copiedTarget, setCopiedTarget] = useState<'curl' | 'url' | 'key' | null>(null)

  useEffect(() => {
    if (!open) return
    let mounted = true
    setLoading(true)

    const fetchKey = async () => {
      try {
        if (window.ndDshRouter?.revealExternalKey) {
          const info = await window.ndDshRouter.revealExternalKey()
          if (mounted) setKeyInfo(info)
        }
      } catch (cause) {
        if (mounted) {
          onError?.(cause instanceof Error ? cause.message : String(cause))
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }

    void fetchKey()
    return () => {
      mounted = false
    }
  }, [open, onError])

  const modelIdentifier = useMemo(() => {
    if (route.startsWith('combo:')) {
      return route.slice('combo:'.length).trim()
    }
    if (route.startsWith('model:')) {
      return route.slice('model:'.length).trim()
    }
    if (resolvedCombo) {
      return resolvedCombo
    }
    if (resolvedProvider && resolvedModel) {
      return `${resolvedProvider}/${resolvedModel}`
    }
    return route || 'default'
  }, [route, resolvedCombo, resolvedProvider, resolvedModel])

  const routeType = useMemo(() => {
    if (route.startsWith('combo:') || resolvedCombo) return 'Combo Route'
    if (route.startsWith('model:')) return 'Direct Provider Model'
    return 'Route'
  }, [route, resolvedCombo])

  const endpoint = (keyInfo?.endpoint || initialEndpoint || 'http://127.0.0.1:4000').replace(/\/+$/, '')
  const apiUrl = `${endpoint}/v1/chat/completions`

  const payloadMessages = useMemo(() => {
    if (includeHistory && messages && messages.length > 0) {
      const history = messages.map((m) => ({ role: m.role, content: m.content }))
      if (currentPrompt?.trim()) {
        history.push({ role: 'user', content: currentPrompt.trim() })
      }
      return history
    }
    if (currentPrompt?.trim()) {
      return [{ role: 'user', content: currentPrompt.trim() }]
    }
    if (messages && messages.length > 0) {
      return messages.map((m) => ({ role: m.role, content: m.content }))
    }
    return [{ role: 'user', content: 'Hello' }]
  }, [includeHistory, messages, currentPrompt])

  const jsonPayload = useMemo(() => {
    const body: Record<string, unknown> = {
      model: modelIdentifier,
      messages: payloadMessages,
    }
    if (includeStream) {
      body.stream = true
    }
    return JSON.stringify(body, null, 2)
  }, [modelIdentifier, payloadMessages, includeStream])

  const actualKey = keyInfo?.key || '<YOUR_ND_ROUTER_KEY>'
  const displayKey = revealedKey ? actualKey : 'ndr_ext_••••••••••••'

  const fullCurlCommand = useMemo(() => {
    const escapedJson = jsonPayload.replace(/'/g, "'\\''")
    return `curl ${apiUrl} \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${actualKey}" \\\n  -d '${escapedJson}'`
  }, [apiUrl, actualKey, jsonPayload])

  const displayCurlCommand = useMemo(() => {
    const escapedJson = jsonPayload.replace(/'/g, "'\\''")
    return `curl ${apiUrl} \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${displayKey}" \\\n  -d '${escapedJson}'`
  }, [apiUrl, displayKey, jsonPayload])

  const copyToClipboard = async (text: string, target: 'curl' | 'url' | 'key') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedTarget(target)
      setTimeout(() => {
        setCopiedTarget((current) => (current === target ? null : current))
      }, 1600)
    } catch {
      onError?.('Clipboard access is unavailable.')
    }
  }

  const safeMode = keyInfo?.safeMode ?? false

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader className="gap-1">
          <div className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
              <TerminalIcon className="size-4" />
            </span>
            <DialogTitle>Playground Model cURL</DialogTitle>
            <StatusChip neutral>{routeType}</StatusChip>
            {safeMode ? <StatusChip warn>Safe Mode On</StatusChip> : null}
          </div>
          <DialogDescription>
            One-click cURL request to call <code>{modelIdentifier}</code> through ND Router loopback endpoint.
          </DialogDescription>
        </DialogHeader>

        {safeMode ? (
          <div className="rounded-md border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">
            <strong>Safe Mode is enabled:</strong> External API credentials and web lanes are closed until Safe Mode is
            disabled in the ND Router Overview.
          </div>
        ) : null}

        <div className="flex flex-col gap-3 py-1">
          {/* Options Row */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-soft bg-surface-1/70 px-2.5 py-1.5 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex cursor-pointer items-center gap-1.5 text-soft select-none hover:text-foreground">
                <input
                  type="checkbox"
                  className="rounded border-border-soft"
                  checked={includeStream}
                  onChange={(e) => setIncludeStream(e.target.checked)}
                />
                <span>Stream response (<code>stream: true</code>)</span>
              </label>

              {messages && messages.length > 0 ? (
                <label className="flex cursor-pointer items-center gap-1.5 text-soft select-none hover:text-foreground">
                  <input
                    type="checkbox"
                    className="rounded border-border-soft"
                    checked={includeHistory}
                    onChange={(e) => setIncludeHistory(e.target.checked)}
                  />
                  <span>Include message history ({messages.length})</span>
                </label>
              ) : null}
            </div>

            <button
              type="button"
              className="flex items-center gap-1 text-[11px] font-medium text-faint transition-colors hover:text-foreground"
              onClick={() => setRevealedKey((v) => !v)}
              title={revealedKey ? 'Mask API key' : 'Show actual API key'}
            >
              {revealedKey ? <EyeOffIcon className="size-3" /> : <EyeIcon className="size-3" />}
              <span>{revealedKey ? 'Mask key' : 'Show key'}</span>
            </button>
          </div>

          {/* cURL Command Code Block */}
          <div className="relative rounded-lg border border-border bg-surface-0 shadow-xs">
            <div className="flex items-center justify-between border-b border-border-soft/60 bg-surface-1/50 px-3 py-1.5">
              <span className="text-[10px] font-mono text-faint">bash / curl</span>
              <button
                type="button"
                className="flex h-6 items-center gap-1 rounded border border-border-soft bg-background px-2 text-[10.5px] font-medium text-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-95"
                onClick={() => void copyToClipboard(fullCurlCommand, 'curl')}
                aria-label="Copy cURL snippet"
              >
                {copiedTarget === 'curl' ? (
                  <>
                    <CheckIcon className="size-3 text-emerald-500" />
                    <span className="font-semibold text-emerald-500">Copied cURL!</span>
                  </>
                ) : (
                  <>
                    <CopyIcon className="size-3 text-faint" />
                    <span>Copy cURL</span>
                  </>
                )}
              </button>
            </div>

            <pre className="max-h-[220px] overflow-auto p-3 font-mono text-[11px] leading-relaxed text-foreground select-text [scrollbar-width:thin]">
              <code>{displayCurlCommand}</code>
            </pre>
          </div>

          {/* Quick Details: Endpoint & Key */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="flex flex-col justify-between rounded-md border border-border-soft bg-surface-1/40 p-2">
              <div className="min-w-0">
                <span className="text-[10px] font-semibold text-faint">POST Endpoint</span>
                <p className="truncate font-mono text-[11px] text-foreground" title={apiUrl}>
                  {apiUrl}
                </p>
              </div>
              <div className="pt-1.5">
                <button
                  type="button"
                  className="flex h-5 items-center gap-1 rounded border border-border-soft bg-background px-1.5 text-[9.5px] font-medium text-soft hover:bg-accent hover:text-foreground"
                  onClick={() => void copyToClipboard(apiUrl, 'url')}
                >
                  {copiedTarget === 'url' ? <CheckIcon className="size-2.5 text-emerald-500" /> : <CopyIcon className="size-2.5" />}
                  <span>{copiedTarget === 'url' ? 'Copied' : 'Copy URL'}</span>
                </button>
              </div>
            </div>

            <div className="flex flex-col justify-between rounded-md border border-border-soft bg-surface-1/40 p-2">
              <div className="min-w-0">
                <span className="text-[10px] font-semibold text-faint">External API Key</span>
                <p className="truncate font-mono text-[11px] text-foreground" title={revealedKey ? actualKey : 'Hidden'}>
                  {loading ? (
                    <span className="flex items-center gap-1 text-faint">
                      <SpinnerIcon className="size-2.5 animate-spin" /> Loading...
                    </span>
                  ) : (
                    displayKey
                  )}
                </p>
              </div>
              <div className="pt-1.5">
                <button
                  type="button"
                  className="flex h-5 items-center gap-1 rounded border border-border-soft bg-background px-1.5 text-[9.5px] font-medium text-soft hover:bg-accent hover:text-foreground disabled:opacity-40"
                  disabled={loading || !keyInfo?.key}
                  onClick={() => void copyToClipboard(actualKey, 'key')}
                >
                  {copiedTarget === 'key' ? <CheckIcon className="size-2.5 text-emerald-500" /> : <CopyIcon className="size-2.5" />}
                  <span>{copiedTarget === 'key' ? 'Copied' : 'Copy Key'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="mt-2 flex-row items-center justify-between gap-2 sm:justify-between">
          <span className="text-[10px] text-faint">
            Target model: <strong className="text-foreground">{modelIdentifier}</strong>
          </span>

          <div className="flex items-center gap-2">
            <DialogClose asChild>
              <button
                type="button"
                className="flex h-7 items-center rounded-md border border-border-soft bg-background px-3 text-xs font-medium text-soft transition-colors hover:bg-accent hover:text-foreground"
              >
                Close
              </button>
            </DialogClose>

            <button
              type="button"
              className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 active:scale-95"
              onClick={() => void copyToClipboard(fullCurlCommand, 'curl')}
            >
              {copiedTarget === 'curl' ? (
                <>
                  <CheckIcon className="size-3.5" />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <CopyIcon className="size-3.5" />
                  <span>Copy cURL Command</span>
                </>
              )}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
