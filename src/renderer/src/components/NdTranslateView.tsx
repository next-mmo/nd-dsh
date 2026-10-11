import { useEffect, useId, useRef, useState } from 'react'
import { ArrowLeftRight, Check, Copy, ExternalLink, History, Languages, LoaderCircle, Trash2, X } from 'lucide-react'
import type { NdContext } from '../../../shared/nd-context'
import { contextKey } from '../../../shared/nd-context'
import type { ModelProvider } from '../../../shared/contracts'
import {
  isImageDataUrl,
  isLlmProvider,
  llmProviderId,
  ND_TRANSLATE_LANGUAGES,
  ND_TRANSLATE_MAX_IMAGE_BYTES,
  ND_TRANSLATE_MAX_IMAGES,
  ND_TRANSLATE_MAX_TEXT,
  type NdBrowserTranslateProvider,
  type NdTranslateHistoryEntry,
  type NdTranslateProvider,
  type NdTranslateRequest,
  type NdTranslateResult,
} from '../../../shared/nd-translate'
import { Button } from './ui/button'
import { cn } from '../lib/utils'

const PROVIDERS: Array<{ id: NdBrowserTranslateProvider; label: string }> = [
  { id: 'google', label: 'Google Translate' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'gemini', label: 'Gemini' },
]
const SELECT_CLASS = 'h-8 rounded-md border border-border-soft bg-surface-0 px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring'
const TEXT_CLASS = 'min-h-48 w-full resize-none bg-transparent p-4 text-sm leading-relaxed text-foreground outline-none placeholder:text-faint sm:min-h-60'
const TEXT_FOCUS_CLASS = 'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong'
// Keep retry text only in this renderer's memory, scoped to the authorized context.
const browserDrafts = new Map<string, NdTranslateRequest>()
const manuallySelectedTargets = new Set<string>()

/**
 * Native select that owns its selected value. The parent observes changes
 * through onValueChange and bumps `reset` to force a new default (swap,
 * history load, provider change) without remounting or two-way state.
 */
function Select({ id, defaultValue, reset = 0, disabled, className, ariaLabel, onValueChange, children }: {
  id?: string
  defaultValue: string
  reset?: number
  disabled?: boolean
  className?: string
  ariaLabel?: string
  onValueChange(value: string): void
  children: React.ReactNode
}): React.ReactNode {
  const [selected, setSelected] = useState(defaultValue)
  const [appliedReset, setAppliedReset] = useState(reset)
  if (reset !== appliedReset) {
    setAppliedReset(reset)
    setSelected(defaultValue)
  }
  // Reflect a bumped reset in this same pass; React re-renders before commit.
  const value = reset !== appliedReset ? defaultValue : selected
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      className={cn(SELECT_CLASS, className)}
      disabled={disabled}
      value={value}
      onChange={(event) => {
        if (disabled) return
        setSelected(event.target.value)
        onValueChange(event.target.value)
      }}
    >
      {children}
    </select>
  )
}

function restoreBrowserDraft(context: NdContext): NdTranslateRequest | undefined {
  const key = contextKey(context)
  const draft = browserDrafts.get(key)
  if (!draft) return undefined

  const migrated = { ...draft }
  // Older in-memory drafts captured English as the default before Khmer was
  // added. Preserve an intentional English choice, but migrate the old default.
  if (migrated.targetLanguage === 'en' && !manuallySelectedTargets.has(key)) migrated.targetLanguage = 'km'
  // Thai was removed from the language list in favor of Khmer.
  if (migrated.sourceLanguage === 'th') migrated.sourceLanguage = 'km'
  if (migrated.targetLanguage === 'th') migrated.targetLanguage = 'km'
  browserDrafts.set(key, migrated)
  return migrated
}

async function invokeHistoryAction(context: NdContext, input: Record<string, unknown>): Promise<unknown> {
  const response = await window.ndDsh.ndExtensions.invoke({
    extensionId: 'nd.translate',
    contributionKind: 'view',
    contributionId: 'translator',
    caller: 'user',
    context,
    input,
  })
  if (!response.ok) throw new Error(response.error?.message ?? 'Translation history is unavailable.')
  return response.value
}

function asHistoryEntry(value: unknown): value is NdTranslateHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<NdTranslateHistoryEntry>
  return typeof entry.id === 'string' && typeof entry.text === 'string'
    && typeof entry.translatedText === 'string'
    && typeof entry.sourceLanguage === 'string' && typeof entry.targetLanguage === 'string'
    && typeof entry.provider === 'string' && typeof entry.createdAt === 'number'
    && (entry.model === undefined || typeof entry.model === 'string')
}

function historyLanguageLabel(code: string): string {
  return ND_TRANSLATE_LANGUAGES.find((item) => item.code === code)?.label ?? code
}

function TranslateHistory({ context, onLoad, providerLabel }: {
  context: NdContext
  onLoad(entry: NdTranslateHistoryEntry): void
  providerLabel(id: string): string
}): React.ReactNode {
  const [entries, setEntries] = useState<NdTranslateHistoryEntry[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = async (active: () => boolean): Promise<void> => {
    try {
      const value = await invokeHistoryAction(context, { action: 'history' })
      if (!active()) return
      setEntries(Array.isArray(value) ? value.filter(asHistoryEntry) : [])
      setMessage(null)
    } catch (cause) {
      if (active()) setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (active()) setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    void load(() => active)
    return () => {
      active = false
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
    // The view remounts per context; history loads once for the mounted context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const removeEntry = async (id: string): Promise<void> => {
    setRemovingId(id)
    try {
      await invokeHistoryAction(context, { action: 'clear-history', id })
      setEntries((current) => current?.filter((entry) => entry.id !== id) ?? null)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRemovingId(null)
    }
  }

  const clearAll = async (): Promise<void> => {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    setClearing(true)
    try {
      await invokeHistoryAction(context, { action: 'clear-history' })
      setEntries([])
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setClearing(false)
      setConfirmClear(false)
    }
  }

  const copyEntry = async (entry: NdTranslateHistoryEntry): Promise<void> => {
    try {
      await navigator.clipboard.writeText(entry.translatedText)
      setCopiedId(entry.id)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopiedId(null), 2000)
    } catch {
      setMessage('Clipboard access failed. Select the translation text and copy it manually.')
    }
  }

  const count = entries?.length ?? 0
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-faint" role="status">
          {loading ? 'Loading history…' : `${count.toLocaleString()} translation${count === 1 ? '' : 's'} saved in this context`}
        </span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={clearing || loading || count === 0}
          onClick={() => void clearAll()}
        >
          {clearing ? <LoaderCircle className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
          {confirmClear ? 'Confirm clear all?' : 'Clear all'}
        </Button>
      </div>
      {message ? <div role="alert" className="rounded-md border border-border-soft bg-surface-0/60 p-3 text-xs text-soft">{message}</div> : null}
      <div className="h-[26rem] space-y-2 overflow-y-auto pr-1">
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-faint"><LoaderCircle className="mr-1.5 inline size-3.5 animate-spin" />Loading…</div>
        ) : entries?.length ? entries.map((entry) => (
          <div key={entry.id} className="rounded-lg border border-border-soft bg-surface-0/50">
            <button type="button" className="block w-full px-3 pb-1.5 pt-2.5 text-left" title="Load this translation" onClick={() => onLoad(entry)}>
              <div className="flex items-center justify-between gap-2 text-[11px] text-soft">
                <span>{historyLanguageLabel(entry.sourceLanguage)} → {historyLanguageLabel(entry.targetLanguage)} · {providerLabel(entry.provider)}</span>
                <span className="shrink-0 text-faint">{new Date(entry.createdAt).toLocaleString()}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-foreground/90">{entry.translatedText}</p>
              {entry.text.trim() !== entry.translatedText.trim() ? (
                <p className="mt-0.5 line-clamp-1 text-[10px] text-faint">{entry.text}</p>
              ) : null}
            </button>
            <div className="flex items-center justify-end gap-1 px-2 pb-1.5">
              <Button type="button" size="xs" variant="ghost" disabled={removingId === entry.id} onClick={() => void copyEntry(entry)}>
                {copiedId === entry.id ? <Check className="size-3" /> : <Copy className="size-3" />}
                {copiedId === entry.id ? 'Copied' : 'Copy'}
              </Button>
              <Button type="button" size="xs" variant="ghost" disabled={removingId === entry.id} onClick={() => void removeEntry(entry.id)}>
                {removingId === entry.id ? <LoaderCircle className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                Remove
              </Button>
            </div>
          </div>
        )) : (
          <div className="flex h-full items-center justify-center rounded-md border border-border-soft px-3 text-center text-xs text-faint">
            No translations yet. Translate text to see it here.
          </div>
        )}
      </div>
    </div>
  )
}

/** ND-owned view; all provider access stays behind the installed extension broker. */
export default function NdTranslateView({ context, onOpenBrowser }: {
  context: NdContext
  onOpenBrowser?: ((tabId: string) => Promise<void>) | undefined
}): React.ReactNode {
  const id = useId()
  const [initial] = useState(() => restoreBrowserDraft(context))
  const [text, setText] = useState(initial?.text ?? '')
  const [images, setImages] = useState<string[]>([])
  const [sourceLanguage, setSourceLanguage] = useState(initial?.sourceLanguage ?? 'auto')
  const [targetLanguage, setTargetLanguage] = useState(initial?.targetLanguage ?? 'km')
  const [provider, setProvider] = useState<NdTranslateProvider>(initial?.provider ?? 'google')
  const [model, setModel] = useState(initial?.model ?? '')
  const [llmProviders, setLlmProviders] = useState<ModelProvider[]>([])
  const [selectReset, setSelectReset] = useState(0)
  const [result, setResult] = useState<NdTranslateResult | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [openingBrowser, setOpeningBrowser] = useState(false)
  const [mode, setMode] = useState<'translate' | 'history'>('translate')
  const mounted = useRef(true)
  const revision = useRef(0)
  const pending = useRef(false)
  const opening = useRef(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    mounted.current = true
    let active = true
    const providersApi = window.ndDsh?.providers
    const unsubscribe = providersApi?.onChanged((list) => {
      if (active) setLlmProviders(list.filter((item) => item.enabled))
    })
    if (providersApi) {
      void providersApi.list().then((list) => {
        if (active) setLlmProviders(list.filter((item) => item.enabled))
      }).catch(() => undefined)
    }
    return () => {
      active = false
      mounted.current = false
      revision.current += 1
      unsubscribe?.()
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [])

  const llmOptions = llmProviders.map((item) => ({
    id: `llm:${item.id}` as const,
    label: item.name || item.id,
    hasKey: Boolean(item.hasApiKey),
  }))
  const currentLlm = isLlmProvider(provider) ? llmProviders.find((item) => `llm:${item.id}` === provider) : undefined
  const llmModels = currentLlm?.models ?? []
  const resolvedModel = isLlmProvider(provider) ? (model.trim() || (llmModels.find((item) => item.id.trim())?.id.trim() ?? '')) : ''
  const providerLabel = (value: string): string =>
    PROVIDERS.find((item) => item.id === value)?.label
    ?? (isLlmProvider(value) ? (llmProviders.find((item) => `llm:${item.id}` === value)?.name || llmProviderId(value)) : value)

  const invalidate = (): void => {
    revision.current += 1
    setResult(null)
    setMessage(null)
    setCopied(false)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    browserDrafts.delete(contextKey(context))
  }

  const addPastedImages = (files: File[]): void => {
    if (opening.current) return
    const candidates = files
      .filter((file) => file.type.startsWith('image/'))
      .slice(0, ND_TRANSLATE_MAX_IMAGES)
    if (candidates.length === 0) return
    const oversized = candidates.some((file) => file.size > ND_TRANSLATE_MAX_IMAGE_BYTES)
    void Promise.all(candidates.map((file) => new Promise<string | null>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    }))).then((results) => {
      const valid = results.filter((url): url is string => url !== null && isImageDataUrl(url))
      if (!mounted.current) return
      if (oversized) setMessage(`Images must be under ${Math.floor(ND_TRANSLATE_MAX_IMAGE_BYTES / 1024 / 1024)} MB each.`)
      if (valid.length > 0) {
        invalidate()
        setImages((prev) => [...prev, ...valid].slice(0, ND_TRANSLATE_MAX_IMAGES))
      }
    })
  }

  const removeImage = (index: number): void => {
    if (opening.current) return
    invalidate()
    setImages((prev) => prev.filter((_, item) => item !== index))
  }

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    if (opening.current) return
    const items = Array.from(event.clipboardData.items)
    if (!items.some((item) => item.kind === 'file' && item.type.startsWith('image/'))) return
    event.preventDefault()
    addPastedImages(items.map((item) => item.getAsFile()).filter((file): file is File => file !== null))
  }

  const openBrowser = async (): Promise<void> => {
    const tabId = result?.browserTabId
    if (!onOpenBrowser || typeof tabId !== 'string' || !tabId.trim() || opening.current) return
    const openedRevision = revision.current
    const draft: NdTranslateRequest = { text, sourceLanguage, targetLanguage, provider, ...(resolvedModel ? { model: resolvedModel } : {}) }
    const key = contextKey(context)
    opening.current = true
    setOpeningBrowser(true)
    browserDrafts.delete(key)
    browserDrafts.set(key, draft)
    if (browserDrafts.size > 32) browserDrafts.delete(browserDrafts.keys().next().value!)
    try {
      // The successful route closes this view; retain text for the next opening.
      await onOpenBrowser(tabId)
    } catch (cause) {
      if (browserDrafts.get(key) === draft) browserDrafts.delete(key)
      if (mounted.current && openedRevision === revision.current) {
        setMessage(cause instanceof Error ? cause.message : 'The provider tab could not be opened. Translate again to create a new tab.')
      }
    } finally {
      opening.current = false
      if (mounted.current) setOpeningBrowser(false)
    }
  }

  const translate = async (): Promise<void> => {
    if (pending.current || opening.current || (!text.trim() && images.length === 0) || text.length > ND_TRANSLATE_MAX_TEXT) return
    const request: NdTranslateRequest = { text, sourceLanguage, targetLanguage, provider, ...(resolvedModel ? { model: resolvedModel } : {}), ...(images.length > 0 ? { images } : {}) }
    const submittedRevision = revision.current
    pending.current = true
    setBusy(true)
    setResult(null)
    setMessage(null)
    setCopied(false)
    try {
      const response = await window.ndDsh.ndExtensions.invoke({
        extensionId: 'nd.translate',
        contributionKind: 'view',
        contributionId: 'translator',
        caller: 'user',
        context,
        input: { ...request },
      })
      if (!mounted.current || submittedRevision !== revision.current) return
      if (!response.ok) {
        setMessage(response.error?.message ?? 'Translation failed. Please try again.')
        return
      }
      const value = response.value as Partial<NdTranslateResult> | undefined
      if (!value || typeof value !== 'object' || !['idle', 'translated', 'login-required', 'challenge', 'error', 'busy'].includes(String(value.status))) {
        setMessage('The translation provider returned an invalid response. Please try again.')
        return
      }
      if (value.status === 'translated') {
        if (typeof value.translatedText !== 'string' || !value.translatedText.trim()) {
          setMessage('The provider did not return translated text. Please try again.')
          return
        }
        // Preserve the exact submitted source and settings alongside the result.
        setResult({ ...value, ...request, status: 'translated', translatedText: value.translatedText })
        return
      }
      setResult({ ...value, ...request, status: value.status as NdTranslateResult['status'] })
      setMessage(typeof value.message === 'string' && value.message.trim()
        ? value.message
        : value.status === 'login-required'
          ? `Sign in to ${providerLabel(provider)} in the ND browser, then translate again.`
          : value.status === 'challenge'
            ? 'Complete the provider check in the ND browser, then translate again.'
            : value.status === 'busy'
              ? 'The ND browser is busy. Try again when its current task finishes.'
              : 'Translation is unavailable. Check the provider in the ND browser and try again.')
    } catch (cause) {
      if (mounted.current && submittedRevision === revision.current) {
        setMessage(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const copy = async (): Promise<void> => {
    if (result?.status !== 'translated' || !result.translatedText) return
    const copiedRevision = revision.current
    try {
      await navigator.clipboard.writeText(result.translatedText)
      if (!mounted.current || copiedRevision !== revision.current) return
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => { if (mounted.current) setCopied(false) }, 2000)
    } catch {
      if (mounted.current && copiedRevision === revision.current) {
        setMessage('Clipboard access failed. Select the translation text and copy it manually.')
      }
    }
  }

  const swap = (): void => {
    if (sourceLanguage === 'auto' || opening.current) return
    const translated = result?.status === 'translated' ? result.translatedText : undefined
    invalidate()
    setSourceLanguage(targetLanguage)
    setTargetLanguage(sourceLanguage)
    setSelectReset(selectReset + 1)
    if (translated) {
      setText(translated)
      if (translated.length > ND_TRANSLATE_MAX_TEXT) setMessage(`Shorten the text to ${ND_TRANSLATE_MAX_TEXT.toLocaleString()} characters before translating again.`)
    }
  }
  const needsBrowser = result?.status === 'login-required' || result?.status === 'challenge'

  const loadEntry = (entry: NdTranslateHistoryEntry): void => {
    if (opening.current) return
    const source = ND_TRANSLATE_LANGUAGES.some((item) => item.code === entry.sourceLanguage) ? entry.sourceLanguage : 'auto'
    const target = ND_TRANSLATE_LANGUAGES.some((item) => item.code === entry.targetLanguage && item.code !== 'auto') ? entry.targetLanguage : 'km'
    const entryProvider = isLlmProvider(entry.provider)
      ? (llmProviders.some((item) => `llm:${item.id}` === entry.provider) ? entry.provider : 'google')
      : PROVIDERS.some((item) => item.id === entry.provider) ? entry.provider : 'google'
    const entryModel = isLlmProvider(entryProvider) && typeof entry.model === 'string' && entry.model.trim()
      && llmProviders.find((item) => `llm:${item.id}` === entryProvider)?.models.some((item) => item.id === entry.model)
      ? entry.model : ''
    invalidate()
    setText(entry.text.slice(0, ND_TRANSLATE_MAX_TEXT))
    setImages([])
    setSourceLanguage(source)
    setTargetLanguage(target)
    setProvider(entryProvider)
    setModel(entryModel)
    setSelectReset(selectReset + 1)
    manuallySelectedTargets.add(contextKey(context))
    setMode('translate')
  }

  const tabClass = (active: boolean): string =>
    `inline-flex h-[calc(100%-1px)] items-center gap-1.5 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-all ${active ? 'bg-background text-foreground shadow-sm' : 'text-foreground/60 hover:text-foreground'}`

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Translate or history" className="inline-flex h-8 items-center rounded-lg bg-muted p-[3px] text-muted-foreground">
          <button type="button" role="tab" aria-selected={mode === 'translate'} className={tabClass(mode === 'translate')} onClick={() => setMode('translate')}><Languages className="size-3.5" />Translate</button>
          <button type="button" role="tab" aria-selected={mode === 'history'} className={tabClass(mode === 'history')} onClick={() => setMode('history')}><History className="size-3.5" />History</button>
        </div>
        {mode === 'translate' ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-faint" htmlFor={`${id}-provider`}>
              Provider
              <Select
                id={`${id}-provider`}
                defaultValue={provider}
                reset={selectReset}
                disabled={openingBrowser}
                onValueChange={(value) => { if (opening.current) return; invalidate(); setProvider(value as NdTranslateProvider); setModel(''); setSelectReset(selectReset + 1) }}
              >
                {PROVIDERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                {llmOptions.length > 0 ? (
                  <optgroup label="Your providers (Settings → Models)">
                    {llmOptions.map((item) => (
                      <option key={item.id} value={item.id} disabled={!item.hasKey} title={item.hasKey ? undefined : 'Add an API key in Settings → Models'}>
                        {item.label}{item.hasKey ? '' : ' (no API key)'}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {isLlmProvider(provider) && !llmOptions.some((item) => item.id === provider) ? (
                  <option value={provider} disabled>{llmProviderId(provider)} (disabled in Settings)</option>
                ) : null}
              </Select>
            </label>
            <div className={cn('flex items-center gap-2 text-xs text-faint', (!isLlmProvider(provider) || llmModels.length === 0) && 'hidden')} aria-hidden={!isLlmProvider(provider) || llmModels.length === 0}>
              <label htmlFor={`${id}-model`}>Model</label>
              <Select
                id={`${id}-model`}
                defaultValue={model || llmModels[0]?.id || ''}
                reset={selectReset}
                disabled={openingBrowser}
                onValueChange={(value) => { if (opening.current) return; invalidate(); setModel(value) }}
              >
                {llmModels.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
                {model && !llmModels.some((item) => item.id === model) ? <option value={model} disabled>{model} (unavailable)</option> : null}
              </Select>
            </div>
          </div>
        ) : null}
      </div>
      {mode === 'history' ? (
        <TranslateHistory context={context} onLoad={loadEntry} providerLabel={providerLabel} />
      ) : (
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void translate() }}>
      <div className="flex items-center gap-2">
        <Select id={`${id}-source`} className="min-w-0 flex-1" defaultValue={sourceLanguage} reset={selectReset} disabled={openingBrowser} ariaLabel="Source language" onValueChange={(value) => { if (opening.current) return; invalidate(); setSourceLanguage(value) }}>
          <option value="auto">Detect language</option>
          {ND_TRANSLATE_LANGUAGES.filter((item) => item.code !== 'auto').map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
        </Select>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Swap languages" title={sourceLanguage === 'auto' ? 'Choose a source language to swap' : 'Swap languages'} disabled={sourceLanguage === 'auto' || busy || openingBrowser} onClick={swap}><ArrowLeftRight className="size-4" /></Button>
        <Select id={`${id}-target`} className="min-w-0 flex-1" defaultValue={targetLanguage} reset={selectReset} disabled={openingBrowser} ariaLabel="Target language" onValueChange={(value) => { if (opening.current) return; manuallySelectedTargets.add(contextKey(context)); invalidate(); setTargetLanguage(value) }}>
          {ND_TRANSLATE_LANGUAGES.filter((item) => item.code !== 'auto').map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
        </Select>
      </div>
      <div className="grid overflow-hidden rounded-lg border border-border-soft bg-surface-0/50 sm:grid-cols-2">
        <div className="border-b border-border-soft sm:border-b-0 sm:border-r">
          <label htmlFor={`${id}-text`} className="block px-4 pt-3 text-xs font-medium text-soft">Original text</label>
          <textarea id={`${id}-text`} className={cn(TEXT_CLASS, TEXT_FOCUS_CLASS)} disabled={openingBrowser} placeholder="Type or paste text to translate…" value={text} maxLength={ND_TRANSLATE_MAX_TEXT} onChange={(event) => { if (opening.current) return; invalidate(); setText(event.target.value) }} onPaste={onPaste} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void translate() } }} />
          {images.length > 0 ? (
            <div className="flex flex-wrap gap-2 px-4 pb-2">
              {images.map((url, index) => (
                <div key={index} className="relative">
                  <img src={url} alt={`Pasted image ${index + 1}`} className="h-14 w-14 rounded-md border border-border-soft object-cover" />
                  <button type="button" aria-label={`Remove image ${index + 1}`} className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border border-border-soft bg-surface-3 text-faint hover:text-strong" onClick={() => removeImage(index)}>
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex items-center justify-between px-4 pb-3 text-[11px] text-faint"><span>{text.length.toLocaleString()} / {ND_TRANSLATE_MAX_TEXT.toLocaleString()}</span><Button type="button" size="xs" variant="ghost" disabled={(!text && images.length === 0) || busy || openingBrowser} onClick={() => { if (opening.current) return; invalidate(); setText(''); setImages([]) }}>Clear</Button></div>
        </div>
        <div aria-busy={busy}>
          <label htmlFor={`${id}-result`} className="block px-4 pt-3 text-xs font-medium text-soft">Translation</label>
          <textarea id={`${id}-result`} className={TEXT_CLASS} readOnly value={result?.status === 'translated' ? result.translatedText ?? '' : ''} placeholder={busy ? (isLlmProvider(provider) ? 'Translating…' : 'Translating in the ND browser…') : 'Your translation appears here'} />
          <div className="flex min-h-9 items-center justify-between gap-2 px-4 pb-3"><span className="text-[11px] text-faint" role="status">{busy ? 'Translation in progress' : result?.status === 'translated' ? 'Translation ready' : 'Ready to translate'}</span><Button type="button" size="xs" variant="ghost" disabled={result?.status !== 'translated'} onClick={() => void copy()}>{copied ? <Check className="size-3" /> : <Copy className="size-3" />}{copied ? 'Copied' : 'Copy'}</Button></div>
        </div>
      </div>
      {message ? <div role="alert" className="rounded-md border border-border-soft bg-surface-0/60 p-3 text-xs text-soft">{message}{needsBrowser ? <p className="mt-1 text-faint">The provider is open in the ND browser. Complete any sign-in or verification there, then retry.</p> : null}</div> : null}
      {onOpenBrowser && typeof result?.browserTabId === 'string' && result.browserTabId.trim() ? (
        <Button type="button" size="sm" variant="outline" disabled={busy || openingBrowser} onClick={() => void openBrowser()}>
          {openingBrowser ? <LoaderCircle className="size-3.5 animate-spin" /> : <ExternalLink className="size-3.5" />}
          {openingBrowser ? 'Opening provider…' : 'Open provider in ND browser'}
        </Button>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-md text-[11px] text-faint">{provider === 'google'
          ? 'Google Translate usually works without signing in.'
          : isLlmProvider(provider)
            ? `Uses the ${providerLabel(provider)} API key stored in Settings → Models.`
            : `${providerLabel(provider)} may require sign-in or verification in the ND browser.`} Text and pasted images are sent to the selected provider when you translate.</p>
        <Button type="submit" size="sm" disabled={busy || openingBrowser || (!text.trim() && images.length === 0) || text.length > ND_TRANSLATE_MAX_TEXT}>{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Languages className="size-3.5" />}{busy ? 'Translating…' : 'Translate'}</Button>
      </div>
      <p className="text-[10px] text-faint">Ctrl / ⌘ + Enter to translate</p>
      </form>
      )}
    </div>
  )
}
