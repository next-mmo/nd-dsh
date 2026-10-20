export interface StateView {
  window?: { id?: string; title?: string }
  textMode?: 'full' | 'diff' | 'none'
  stats?: {
    nodes?: number
    truncated?: boolean
    elapsedMs?: number
    changed?: number
    added?: number
    removed?: number
  }
  screenshotUnavailable?: string
  screenshots?: Array<{ url?: string }>
  accessibility?: {
    tree?: string
    focusedElement?: string
  } | null
}

export function selectionValue(appId: string, windowId: string): string
export function parseSelection(value: string): { app: string; windowId: string } | null
export function windowLabel(window: { title?: string; focused?: boolean; minimized?: boolean }, index: number): string
export function describeState(state: StateView | null | undefined): string
export function treeText(state: StateView | null | undefined): string
export function safeScreenshotUrl(state: StateView | null | undefined): string
