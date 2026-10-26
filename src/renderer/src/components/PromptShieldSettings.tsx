import { useEffect, useState } from 'react'
import type {
  PromptShieldAction,
  PromptShieldCustomType,
  PromptShieldSettings,
  PromptShieldState,
  PromptShieldTestResult,
} from '../../../shared/prompt-shield'
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
  rowValueText,
} from './settings-primitives'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'

interface PromptShieldSettingsProps {
  onError(message: string): void
}

const ACTIONS: PromptShieldAction[] = ['block', 'mask', 'allow']
const ACTION_LABEL: Record<PromptShieldAction, string> = { block: 'Block', mask: 'Mask', allow: 'Allow' }
const ACTION_DETAIL: Record<PromptShieldAction, string> = {
  block: 'Hold the send until you approve it',
  mask: 'Replace the value before sending',
  allow: 'Send the value unchanged',
}

export function PromptShieldSettings({ onError }: PromptShieldSettingsProps) {
  const [state, setState] = useState<PromptShieldState | null>(null)
  const [busy, setBusy] = useState(false)
  const [label, setLabel] = useState('')
  const [pattern, setPattern] = useState('')
  const [customAction, setCustomAction] = useState<PromptShieldAction>('mask')
  const [sample, setSample] = useState('')
  const [test, setTest] = useState<PromptShieldTestResult | null>(null)

  useEffect(() => {
    let mounted = true
    const apply = (value: PromptShieldState): void => { if (mounted) setState(value) }
    const unsubscribe = window.ndDshPromptShield.onChanged(apply)
    void window.ndDshPromptShield.state().then(apply).catch((cause) => onError(message(cause)))
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [onError])

  const settings = state?.settings

  const update = (next: PromptShieldSettings): void => {
    setBusy(true)
    void window.ndDshPromptShield.updateSettings(next)
      .then(setState)
      .catch((cause) => onError(message(cause)))
      .finally(() => setBusy(false))
  }

  const setAction = (categoryId: string, action: PromptShieldAction): void => {
    if (!settings) return
    const builtin = state.categories.find((category) => category.id === categoryId)?.builtin === true
    if (builtin) {
      update({ ...settings, actions: { ...settings.actions, [categoryId]: action } })
      return
    }
    update({
      ...settings,
      custom: settings.custom.map((item) => item.id === categoryId ? { ...item, action } : item),
    })
  }

  const addCustom = (): void => {
    if (!settings) return
    const trimmedLabel = label.trim()
    const trimmedPattern = pattern.trim()
    if (!trimmedLabel || !trimmedPattern) {
      onError('Give the custom type a label and a regular expression.')
      return
    }
    const custom: PromptShieldCustomType = {
      id: `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      label: trimmedLabel,
      pattern: trimmedPattern,
      action: customAction,
    }
    setLabel('')
    setPattern('')
    setCustomAction('mask')
    setTest(null)
    update({ ...settings, custom: [...settings.custom, custom] })
  }

  const removeCustom = (id: string): void => {
    if (!settings) return
    update({ ...settings, custom: settings.custom.filter((item) => item.id !== id) })
  }

  const runTest = (): void => {
    setBusy(true)
    void window.ndDshPromptShield.testText(sample)
      .then(setTest)
      .catch((cause) => onError(message(cause)))
      .finally(() => setBusy(false))
  }

  const disabled = !state || busy
  const counters = state?.counters ?? { prompted: 0, blocked: 0, masked: 0, byCategory: {} }

  return (
    <>
      <SettingsSection title="Prompt Shield" className="mt-3.5">
        <div className="space-y-1.5">
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Protect prompts in ND</strong>
              <span className={rowDesc}>
                Detect sensitive values before they leave ND and apply the action configured for each type.
                Applies to the prompt you send on every engine, text files inlined into web chats, and ND Gateway requests.
              </span>
            </div>
            <Switch
              aria-label="Protect prompts in ND"
              checked={settings?.enabled ?? true}
              disabled={disabled}
              onCheckedChange={(enabled) => settings && update({ ...settings, enabled })}
            />
          </SettingsRow>

          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Normalize invisible characters</strong>
              <span className={rowDesc}>Remove zero-width and bidirectional control characters that can hide content or break detection.</span>
            </div>
            <Switch
              aria-label="Normalize invisible characters"
              checked={settings?.normalize ?? true}
              disabled={disabled}
              onCheckedChange={(normalize) => settings && update({ ...settings, normalize })}
            />
          </SettingsRow>

          <SettingsNote>
            Masked values are replaced with a placeholder such as <code>[ND-REDACTED:api_key]</code>. Blocked prompts are held
            and shown in a review dialog before anything is sent. ND stores detection counts only, never the matched value.
          </SettingsNote>
        </div>
      </SettingsSection>

      <SettingsSection title="Detected data types">
        <div className="space-y-1.5">
          {state?.categories.map((category) => (
            <SettingsRow key={category.id}>
              <div className={rowStack}>
                <span className="flex items-center gap-2">
                  <strong className={rowTitle}>{category.label}</strong>
                  <StatusChip neutral>Default: {ACTION_LABEL[category.defaultAction]}</StatusChip>
                </span>
                <span className={rowDesc}>{category.description}</span>
                {category.pattern ? <span className={rowPathText}>{category.pattern}</span> : null}
              </div>
              <div className="flex shrink-0 gap-1">
                {ACTIONS.map((action) => (
                  <SettingsButton
                    key={action}
                    active={category.action === action}
                    disabled={disabled}
                    title={ACTION_DETAIL[action]}
                    onClick={() => setAction(category.id, action)}
                  >
                    {ACTION_LABEL[action]}
                  </SettingsButton>
                ))}
                {category.builtin ? null : (
                  <SettingsButton disabled={disabled} onClick={() => removeCustom(category.id)}>
                    Remove
                  </SettingsButton>
                )}
              </div>
            </SettingsRow>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="Custom data types">
        <div className="space-y-1.5">
          <SettingsRow className="items-start">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex min-w-0 gap-2">
                <Input
                  aria-label="Custom data type label"
                  placeholder="Label, e.g. Employee ID"
                  value={label}
                  disabled={disabled}
                  onChange={(event) => setLabel(event.target.value)}
                  className="max-w-[220px]"
                />
                <Input
                  aria-label="Custom data type regular expression"
                  placeholder="Regular expression, e.g. EMP-\d{6}"
                  value={pattern}
                  disabled={disabled}
                  onChange={(event) => setPattern(event.target.value)}
                  className="min-w-0 flex-1 font-mono text-[11px]"
                />
              </div>
              <div className="flex items-center gap-1">
                {ACTIONS.map((action) => (
                  <SettingsButton
                    key={action}
                    active={customAction === action}
                    disabled={disabled}
                    title={ACTION_DETAIL[action]}
                    onClick={() => setCustomAction(action)}
                  >
                    {ACTION_LABEL[action]}
                  </SettingsButton>
                ))}
                <SettingsButton disabled={disabled} onClick={addCustom}>Add type</SettingsButton>
              </div>
            </div>
          </SettingsRow>
        </div>
      </SettingsSection>

      <SettingsSection title="Try it">
        <div className="space-y-1.5">
          <div className="rounded-lg border border-border-soft bg-surface-1 px-[13px] py-[11px]">
            <div className={rowStack}>
              <strong className={rowTitle}>Sample text</strong>
              <span className={rowDesc}>Runs the saved rules locally. Nothing is sent anywhere.</span>
              <Textarea
                aria-label="Prompt Shield sample text"
                placeholder="Paste a sample prompt here"
                value={sample}
                disabled={disabled}
                onChange={(event) => setSample(event.target.value)}
                className="mt-1 min-h-[72px] font-mono text-[11px]"
              />
              <div className="mt-1 flex items-center gap-2">
                <SettingsButton disabled={disabled || !sample.trim()} onClick={runTest}>
                  {busy ? 'Testing…' : 'Test sample'}
                </SettingsButton>
                {test ? (
                  <span className={rowValueText}>
                    {test.findings.length === 0
                      ? 'No detections'
                      : `${test.findings.map((finding) => `${finding.label} ×${finding.count}`).join(' · ')}${test.blocked ? ' · would block' : ' · would mask'}`}
                  </span>
                ) : null}
              </div>
              {test && test.findings.length > 0 ? (
                <pre className="mt-1 max-h-[160px] overflow-auto whitespace-pre-wrap rounded-md border border-border-soft bg-meta p-2 font-mono text-[10px] text-soft">{test.text}</pre>
              ) : null}
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Activity">
        <SettingsRow>
          <div className={rowStack}>
            <strong className={rowTitle}>Detections</strong>
            <span className={rowDesc}>Counts stay on this machine. Blocked prompts were never sent.</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className={rowValueText}>{counters.prompted} prompts · {counters.masked} masked · {counters.blocked} blocked</span>
            <SettingsButton
              disabled={disabled || (counters.prompted === 0 && counters.masked === 0 && counters.blocked === 0)}
              onClick={() => {
                setBusy(true)
                void window.ndDshPromptShield.resetCounters()
                  .then(setState)
                  .catch((cause) => onError(message(cause)))
                  .finally(() => setBusy(false))
              }}
            >
              Reset
            </SettingsButton>
          </div>
        </SettingsRow>
      </SettingsSection>
    </>
  )
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
