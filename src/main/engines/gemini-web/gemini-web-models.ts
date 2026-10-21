import type { EngineModelOption } from '../../../shared/contracts.js'

const MODE_BUTTON_SELECTOR = 'bard-mode-switcher button[data-test-id="bard-mode-menu-button"]'
const MODE_ITEM_SELECTOR = 'gem-menu-item[data-mode-id]'
const MODE_MENU_TIMEOUT_MS = 2_500
const MODE_APPLY_TIMEOUT_MS = 3_000

/**
 * Seed catalog for ND's picker before the live Gemini menu has been read.
 * Gemini's own menu replaces this list the first time ND switches models,
 * because availability and labels depend on the signed-in account.
 */
export const GEMINI_MODE_FALLBACK: EngineModelOption[] = [
  { id: '3.5 Flash-Lite', name: '3.5 Flash-Lite' },
  { id: '3.8 Flash', name: '3.8 Flash' },
  { id: '3.1 Pro', name: '3.1 Pro' },
  { id: '4 Argon', name: '4 Argon' },
]

export type GeminiModeSwitchFailure =
  | 'picker-missing'
  | 'menu-missing'
  | 'unknown-model'
  | 'not-applied'

export type GeminiModeSwitchResult =
  | { ok: true; changed: boolean; current: string; options: string[] }
  | { ok: false; reason: GeminiModeSwitchFailure; current?: string; options?: string[] }

/**
 * Gemini's composer pill shows a short name ("Argon", "Flash-Lite") while the
 * menu entry carries the version ("4 Argon", "3.5 Flash-Lite"), so a match is
 * either exact or a whole-word suffix of the other label.
 */
const MODE_HELPERS = `
  const normalizeMode = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const modeMatches = (candidate, desired) => {
    const left = normalizeMode(candidate);
    const right = normalizeMode(desired);
    return Boolean(left && right) && (left === right || left.endsWith(' ' + right) || right.endsWith(' ' + left));
  };
  const modeButton = () => document.querySelector(${JSON.stringify(MODE_BUTTON_SELECTOR)});
  const readModeLabel = (button) => {
    const text = button?.querySelector?.('.picker-primary-text')?.textContent
      || button?.getAttribute?.('aria-label')?.replace(/^Open mode picker, currently\\s*/i, '')
      || '';
    return String(text).trim();
  };
  const readModeItems = () => Array.from(document.querySelectorAll(${JSON.stringify(MODE_ITEM_SELECTOR)}))
    .map((el) => ({
      el,
      label: String(el.querySelector?.('.label')?.textContent || el.getAttribute?.('aria-label') || el.textContent || '')
        .replace(/\\s+/g, ' ').trim(),
    }))
    .filter((item) => item.label);
  const waitForMode = async (probe, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = probe();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  };
  const closeModeMenu = (button) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    if (button?.getAttribute?.('aria-expanded') === 'true') document.body?.click?.();
  };
`

export function geminiModeSelectScript(model: string): string {
  return `(async () => {
  ${MODE_HELPERS}
  const desired = ${JSON.stringify(model)};
  const button = modeButton();
  if (!button || typeof button.click !== 'function') return { ok: false, reason: 'picker-missing' };
  const before = readModeLabel(button);
  if (modeMatches(before, desired)) return { ok: true, changed: false, current: before, options: [] };
  if (button.getAttribute?.('aria-expanded') !== 'true') button.click();
  const items = await waitForMode(() => {
    const found = readModeItems();
    return found.length > 0 ? found : undefined;
  }, ${MODE_MENU_TIMEOUT_MS});
  if (!items) {
    closeModeMenu(button);
    return { ok: false, reason: 'menu-missing', current: readModeLabel(button) };
  }
  const options = items.map((item) => item.label);
  const selected = items.find((item) => /(?:^|\\s)selected(?:\\s|$)/.test(String(item.el.className || '')));
  if (selected && modeMatches(selected.label, desired)) {
    closeModeMenu(button);
    return { ok: true, changed: false, current: selected.label, options };
  }
  const target = items.find((item) => modeMatches(item.label, desired));
  if (!target) {
    closeModeMenu(button);
    return { ok: false, reason: 'unknown-model', current: readModeLabel(button), options };
  }
  target.el.click();
  const applied = await waitForMode(() => {
    const next = readModeLabel(button);
    return modeMatches(next, desired) ? next : undefined;
  }, ${MODE_APPLY_TIMEOUT_MS});
  if (!applied) {
    closeModeMenu(button);
    return { ok: false, reason: 'not-applied', current: readModeLabel(button), options };
  }
  if (button.getAttribute?.('aria-expanded') === 'true') closeModeMenu(button);
  return { ok: true, changed: true, current: applied, options };
})()`
}

export function geminiModeOptions(labels: readonly string[]): EngineModelOption[] {
  const seen = new Set<string>()
  const options: EngineModelOption[] = []
  for (const label of labels) {
    const name = label.replace(/\s+/g, ' ').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    options.push({ id: name, name })
  }
  return options
}

export function readGeminiModeSwitchResult(value: unknown): GeminiModeSwitchResult | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const options = Array.isArray(record.options)
    ? record.options.filter((option): option is string => typeof option === 'string' && option.trim() !== '')
    : []
  if (record.ok === true && typeof record.changed === 'boolean' && typeof record.current === 'string') {
    return { ok: true, changed: record.changed, current: record.current, options }
  }
  if (record.ok === false && isFailureReason(record.reason)) {
    return {
      ok: false,
      reason: record.reason,
      ...(typeof record.current === 'string' ? { current: record.current } : {}),
      ...(options.length > 0 ? { options } : {}),
    }
  }
  return undefined
}

function isFailureReason(value: unknown): value is GeminiModeSwitchFailure {
  return value === 'picker-missing' || value === 'menu-missing' || value === 'unknown-model' || value === 'not-applied'
}
