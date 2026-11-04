/**
 * Browser chrome popups: toolbar menus (Extensions, Profiles) that must paint
 * above the live embedded page. Like Chrome's bubbles they render in their own
 * native surface — a transparent `WebContentsView` stacked above the tab views —
 * instead of a DOM portal that the page's native view would cover.
 *
 * The popup renderer is deliberately dumb: the primary renderer sends it a
 * plain view model and receives user intents back as actions, which it then
 * executes through its existing trusted APIs. The popup itself is admitted to
 * nothing but this contract.
 */

export const BROWSER_CHROME_POPUP_IPC = {
  open: 'browser-chrome-popup:open',
  update: 'browser-chrome-popup:update',
  close: 'browser-chrome-popup:close',
  /** Popup renderer only: fetch current model on mount without waiting for push event. */
  getModel: 'browser-chrome-popup:get-model',
  /** Popup renderer only: report its card size so the native view fits it. */
  resize: 'browser-chrome-popup:resize',
  /** Popup renderer only: forward a user intent to the primary renderer. */
  action: 'browser-chrome-popup:action',
  modelEvent: 'browser-chrome-popup:model-event',
  actionEvent: 'browser-chrome-popup:action-event',
  closedEvent: 'browser-chrome-popup:closed-event',
} as const

export const BROWSER_CHROME_POPUP_ROUTE = 'browser-popup'
/** Transparent gutter around the card so its CSS shadow is not clipped by the view edge. */
export const BROWSER_CHROME_POPUP_GUTTER = 14

export type BrowserChromePopupKind = 'extensions' | 'profiles'
export type BrowserChromePopupTheme = 'light' | 'dark'

export interface BrowserChromePopupAnchor {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserChromePopupExtensionItem {
  id: string
  title: string
  subtitle: string
  enabled: boolean
  canOpen: boolean
}

export interface BrowserChromePopupProfileItem {
  id: string
  name: string
  color: string
  tabCount: number
  isDefault: boolean
  active: boolean
}

export type BrowserChromePopupModel =
  | {
    kind: 'extensions'
    theme: BrowserChromePopupTheme
    extensions: BrowserChromePopupExtensionItem[]
    developerMode: boolean
    canManage: boolean
  }
  | {
    kind: 'profiles'
    theme: BrowserChromePopupTheme
    profiles: BrowserChromePopupProfileItem[]
    canManage: boolean
  }

export type BrowserChromePopupAction =
  | { type: 'extension-open'; id: string }
  | { type: 'extension-toggle'; id: string; enabled: boolean }
  | { type: 'extension-load-unpacked' }
  | { type: 'profile-select'; id: string }
  | { type: 'profile-create' }
  | { type: 'open-settings' }

export interface BrowserChromePopupOpenRequest {
  anchor: BrowserChromePopupAnchor
  model: BrowserChromePopupModel
}

export interface BrowserChromePopupSize {
  width: number
  height: number
}

/** Primary renderer API. Absent outside the desktop shell (UI preview). */
export interface BrowserChromePopupDesktopApi {
  /** Resolves false when the request toggles a popup that light-dismiss just closed. */
  open(request: BrowserChromePopupOpenRequest): Promise<boolean>
  update(model: BrowserChromePopupModel): Promise<void>
  close(): Promise<void>
  onAction(listener: (action: BrowserChromePopupAction) => void): () => void
  onClosed(listener: (kind: BrowserChromePopupKind) => void): () => void
}

/** Popup renderer API: the only surface the popup renderer drives. */
export interface BrowserChromePopupSurfaceApi {
  getModel(): Promise<BrowserChromePopupModel | null>
  resize(size: BrowserChromePopupSize): Promise<void>
  action(action: BrowserChromePopupAction): Promise<void>
  close(): Promise<void>
  onModel(listener: (model: BrowserChromePopupModel | null) => void): () => void
}

const MAX_ITEMS = 200
const MAX_TEXT = 256

function text(value: unknown, label: string, max = MAX_TEXT): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value.length > max ? value.slice(0, max) : value
}

function id(value: unknown, label: string): string {
  const result = text(value, label)
  if (!result) throw new Error(`${label} cannot be empty`)
  return result
}

function finite(value: unknown, label: string, min: number, max: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite`)
  return Math.min(max, Math.max(min, number))
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`)
  if (value.length > MAX_ITEMS) throw new Error(`${label} has too many entries`)
  return value
}

export function asBrowserChromePopupAnchor(value: unknown): BrowserChromePopupAnchor {
  const input = record(value, 'Popup anchor')
  return {
    x: finite(input.x, 'Anchor x', -100_000, 100_000),
    y: finite(input.y, 'Anchor y', -100_000, 100_000),
    width: finite(input.width, 'Anchor width', 0, 100_000),
    height: finite(input.height, 'Anchor height', 0, 100_000),
  }
}

export function asBrowserChromePopupOpenRequest(value: unknown): BrowserChromePopupOpenRequest {
  const input = record(value, 'Popup request')
  return { anchor: asBrowserChromePopupAnchor(input.anchor), model: asBrowserChromePopupModel(input.model) }
}

export function asBrowserChromePopupSize(value: unknown): BrowserChromePopupSize {
  const input = record(value, 'Popup size')
  return {
    width: finite(input.width, 'Popup width', 1, 4_000),
    height: finite(input.height, 'Popup height', 1, 4_000),
  }
}

export function asBrowserChromePopupModel(value: unknown): BrowserChromePopupModel {
  const input = record(value, 'Popup model')
  const theme: BrowserChromePopupTheme = input.theme === 'light' ? 'light' : 'dark'
  if (input.kind === 'extensions') {
    return {
      kind: 'extensions',
      theme,
      developerMode: input.developerMode === true,
      canManage: input.canManage === true,
      extensions: list(input.extensions, 'Extensions').map((entry) => {
        const item = record(entry, 'Extension')
        return {
          id: id(item.id, 'Extension id'),
          title: text(item.title, 'Extension title'),
          subtitle: text(item.subtitle, 'Extension subtitle'),
          enabled: item.enabled === true,
          canOpen: item.canOpen === true,
        }
      }),
    }
  }
  if (input.kind === 'profiles') {
    return {
      kind: 'profiles',
      theme,
      canManage: input.canManage === true,
      profiles: list(input.profiles, 'Profiles').map((entry) => {
        const item = record(entry, 'Profile')
        const color = text(item.color, 'Profile color', 32)
        return {
          id: id(item.id, 'Profile id'),
          name: text(item.name, 'Profile name'),
          color: /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#65717b',
          tabCount: Math.round(finite(item.tabCount, 'Profile tab count', 0, 100_000)),
          isDefault: item.isDefault === true,
          active: item.active === true,
        }
      }),
    }
  }
  throw new Error('Unknown browser popup kind')
}

export function asBrowserChromePopupAction(value: unknown): BrowserChromePopupAction {
  const input = record(value, 'Popup action')
  switch (input.type) {
    case 'extension-open':
      return { type: 'extension-open', id: id(input.id, 'Extension id') }
    case 'extension-toggle':
      return { type: 'extension-toggle', id: id(input.id, 'Extension id'), enabled: input.enabled === true }
    case 'profile-select':
      return { type: 'profile-select', id: id(input.id, 'Profile id') }
    case 'extension-load-unpacked':
    case 'profile-create':
    case 'open-settings':
      return { type: input.type }
    default:
      throw new Error('Unknown browser popup action')
  }
}

/** Actions that leave the popup's job done, so the popup closes after forwarding them. */
export function browserChromePopupActionDismisses(action: BrowserChromePopupAction): boolean {
  return action.type !== 'extension-toggle'
}

/**
 * Card placement: right-aligned under the anchor like Chrome's toolbar
 * bubbles, flipped above when there is no room below, and clamped inside the
 * window. Returned bounds include the transparent shadow gutter.
 */
export function browserChromePopupBounds(
  anchor: BrowserChromePopupAnchor,
  card: BrowserChromePopupSize,
  content: { width: number; height: number },
  gap = 6,
): { x: number; y: number; width: number; height: number } {
  const gutter = BROWSER_CHROME_POPUP_GUTTER
  const edge = 4
  const maxCardWidth = Math.max(1, content.width - edge * 2)
  const cardWidth = Math.min(Math.round(card.width), maxCardWidth)
  const below = content.height - (anchor.y + anchor.height + gap) - edge
  const above = anchor.y - gap - edge
  const placeAbove = card.height > below && above > below
  const room = Math.max(1, placeAbove ? above : below)
  const cardHeight = Math.min(Math.round(card.height), room)
  let cardX = Math.round(anchor.x + anchor.width - cardWidth)
  cardX = Math.min(Math.max(edge, cardX), content.width - edge - cardWidth)
  const cardY = Math.round(placeAbove ? anchor.y - gap - cardHeight : anchor.y + anchor.height + gap)
  return {
    x: cardX - gutter,
    y: cardY - gutter,
    width: cardWidth + gutter * 2,
    height: cardHeight + gutter * 2,
  }
}
