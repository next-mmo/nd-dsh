import { useEffect, useState } from 'react'
import type { RouterExternalApiState, RouterState } from '../../../shared/router'
import {
  SettingsButton,
  SettingsNote,
  SettingsRow,
  SettingsSection,
  StatusChip,
  rowDesc,
  rowPathText,
  rowStack,
  rowTitle,
} from './settings-primitives'

interface RouterExternalApiProps {
  state: RouterState | null
  onError(message: string): void
  embedded?: boolean
}

export function RouterExternalApi({ state, onError, embedded = false }: RouterExternalApiProps) {
  const [info, setInfo] = useState<RouterExternalApiState | null>(null)
  const [key, setKey] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    void window.ndDshRouter.externalKeyState()
      .then((next) => { if (mounted) setInfo(next) })
      .catch((cause) => { if (mounted) onError(message(cause)) })
    return () => { mounted = false }
  }, [onError])

  const safeMode = info?.safeMode ?? state?.safeMode ?? false
  useEffect(() => {
    if (safeMode) setKey(null)
  }, [safeMode])

  const endpoint = info?.endpoint || state?.endpoint || ''
  const sampleCombo = state?.combos[0]?.name ?? 'my-route'
  const curl = endpoint
    ? `curl ${endpoint}/v1/chat/completions \\\n  -H "Authorization: Bearer <external key>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${sampleCombo}","messages":[{"role":"user","content":"Hello"}]}'`
    : ''

  const reveal = (): void => {
    setBusy('reveal')
    void window.ndDshRouter.revealExternalKey()
      .then((next) => {
        setInfo(next)
        setKey(next.key)
      })
      .catch((cause) => onError(message(cause)))
      .finally(() => setBusy(null))
  }

  const copy = (value: string, label: string): void => {
    void navigator.clipboard.writeText(value)
      .then(() => {
        setCopied(label)
        window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1_500)
      })
      .catch(() => onError('Clipboard access is unavailable here.'))
  }

  const rotate = (): void => {
    if (!window.confirm('Rotate the external API key? Any local app using the old key will be rejected.')) return
    setBusy('rotate')
    void window.ndDshRouter.rotateExternalKey()
      .then((next) => {
        setInfo(next)
        setKey(next.key)
        setCopied(null)
      })
      .catch((cause) => onError(message(cause)))
      .finally(() => setBusy(null))
  }

  const content = (
    <div className="space-y-1.5">
        <SettingsRow>
          <div className={rowStack}>
            <span className="flex items-center gap-2">
              <strong className={rowTitle}>Local OpenAI-compatible endpoint</strong>
              <StatusChip good={Boolean(endpoint)}>{endpoint ? 'Loopback' : 'Unavailable'}</StatusChip>
            </span>
            <span className={rowDesc}>
              For apps on this machine only. Point them at this endpoint with the external key below. The key is created by ND,
              stays in OS-backed storage, and is separate from every provider key.
            </span>
            {endpoint ? <span className={rowPathText}>{endpoint}/v1</span> : <span className={rowDesc}>Start ND Router before calling this endpoint.</span>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {endpoint ? <SettingsButton onClick={() => copy(`${endpoint}/v1`, 'endpoint')}>{copied === 'endpoint' ? 'Copied' : 'Copy endpoint'}</SettingsButton> : null}
          </div>
        </SettingsRow>

        <SettingsRow>
          <div className={rowStack}>
            <span className="flex items-center gap-2">
              <strong className={rowTitle}>External API key</strong>
              {safeMode ? <StatusChip warn>Closed by Safe Mode</StatusChip> : null}
              {info && !safeMode ? <StatusChip warn={!info.persisted}>{info.persisted ? 'Saved' : 'This session only'}</StatusChip> : null}
            </span>
            <span className={rowPathText}>{safeMode ? 'External credential is rejected' : key ?? 'ndr_ext_••••••••••••'}</span>
            {info && !info.persisted && !safeMode ? (
              <span className={rowDesc}>OS-backed secure storage is unavailable, so this key changes when ND restarts.</span>
            ) : null}
            <span className={rowDesc}>
              {safeMode
                ? 'Turn Safe Mode off in the Router Overview to hand this credential to local apps. Web lanes are also closed while Safe Mode is on.'
                : 'Hidden web combos are still callable by name. Every web request opens a fresh ChatGPT/Gemini/DeepSeek conversation; old conversations remain in that account.'}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <SettingsButton disabled={!endpoint || busy !== null || safeMode} onClick={() => {
              if (key) {
                setKey(null)
                return
              }
              reveal()
            }}>{busy === 'reveal' ? 'Loading…' : key ? 'Hide' : 'Reveal'}</SettingsButton>
            <SettingsButton
              disabled={!endpoint || busy !== null || safeMode}
              onClick={() => {
                if (key) return copy(key, 'key')
                setBusy('copy')
                void window.ndDshRouter.revealExternalKey()
                  .then((next) => {
                    setInfo(next)
                    setKey(next.key)
                    copy(next.key, 'key')
                  })
                  .catch((cause) => onError(message(cause)))
                  .finally(() => setBusy(null))
              }}
            >
              {copied === 'key' ? 'Copied' : 'Copy key'}
            </SettingsButton>
            <SettingsButton disabled={!endpoint || busy !== null || safeMode} onClick={rotate}>{busy === 'rotate' ? 'Rotating…' : 'Rotate'}</SettingsButton>
          </div>
        </SettingsRow>

        <SettingsNote>
          {key ? 'Keep this key private; any local process that has it can spend your routed capacity. ' : ''}
          Use a combo name as <code>model</code> (or send <code>x-nd-route-combo</code>) or a <code>provider/model</code> id.
          {state && state.combos.length > 0 ? ` Routes: ${state.combos.map((combo) => combo.name).join(', ')}.` : ''}
        </SettingsNote>

        {curl ? (
          <SettingsRow className="items-start">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className={rowTitle}>Request example</span>
              <pre className="max-h-40 overflow-auto rounded-md border border-border-soft bg-surface-1 px-2.5 py-2 font-mono text-[10px] leading-[1.5] text-soft">{curl}</pre>
            </div>
            <SettingsButton onClick={() => copy(curl, 'curl')}>{copied === 'curl' ? 'Copied' : 'Copy curl'}</SettingsButton>
          </SettingsRow>
        ) : null}
    </div>
  )
  return embedded ? content : <SettingsSection title="External API">{content}</SettingsSection>
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}