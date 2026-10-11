import type { ExternalElementPickResult, ExternalElementPickView } from '../../../shared/contracts'

const PICK_TIMEOUT_MS = 60_000
const HIGHLIGHT_CLASS = 'nd-dsh-self-inspect-hover'
const ACTIVE_CLASS = 'nd-self-inspect-active'

let cancelActivePick: (() => void) | undefined

/**
 * Pick an element from ND's own renderer without crossing Electron's script
 * execution boundary. External application inspection still belongs to the
 * main-process CDP adapter; this path only reads the current document.
 */
export function pickSelfElement(): Promise<ExternalElementPickResult> {
  cancelActivePick?.()
  return new Promise((resolve) => {
    const style = document.createElement('style')
    // Radix modal dialogs lock the page down with `body { pointer-events: none }`
    // and a full-screen overlay, which makes everything outside the dialog
    // unhittable for elementFromPoint. While picking, undo that lockdown (the
    // overlay stays visible but click-through) so the dialog, its backdrop and
    // the app behind it are all equally inspectable.
    style.textContent = [
      `.${HIGHLIGHT_CLASS}{outline:2px solid #4f8cff !important;outline-offset:-1px !important;cursor:crosshair !important}`,
      `html.${ACTIVE_CLASS} body{pointer-events:auto !important}`,
      `html.${ACTIVE_CLASS} [data-slot="dialog-overlay"]{pointer-events:none !important}`,
    ].join('')
    let hovered: Element | null = null
    let settled = false

    const clearHover = (): void => {
      hovered?.classList.remove(HIGHLIGHT_CLASS)
      hovered = null
    }
    const cleanup = (): void => {
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKey, true)
      clearTimeout(timer)
      clearHover()
      style.remove()
      document.documentElement.classList.remove(ACTIVE_CLASS)
      if (cancelActivePick === cancel) cancelActivePick = undefined
    }
    const finish = (result: ExternalElementPickResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const cancel = (): void => finish({ outcome: 'canceled' })
    const onMove = (event: PointerEvent): void => {
      const element = document.elementFromPoint(event.clientX, event.clientY)
      if (element === hovered) return
      clearHover()
      if (element) {
        hovered = element
        element.classList.add(HIGHLIGHT_CLASS)
      }
    }
    const onClick = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
      const element = hovered ?? (event.target instanceof Element ? event.target : null)
      if (!element) {
        finish({ outcome: 'canceled' })
        return
      }
      try {
        const view = captureElement(element)
        const shortName = describeElement(view)
        finish({
          outcome: 'picked',
          element: view,
          targetTitle: `${document.title || 'ND-DSH'} (this app)`,
          shortName,
          hover: [shortName, view.selector, view.source, view.text].filter(Boolean).join(' · '),
          hasShot: false,
        })
      } catch (cause) {
        finish({ outcome: 'unreachable', message: cause instanceof Error ? cause.message : String(cause) })
      }
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      cancel()
    }
    // Hide the pick's pointer presses from Radix's dismiss-on-outside logic so
    // an open dialog survives being inspected instead of closing mid-pick.
    const onPointerDown = (event: PointerEvent): void => {
      event.stopPropagation()
    }
    const timer = window.setTimeout(cancel, PICK_TIMEOUT_MS)

    cancelActivePick = cancel
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)
    document.documentElement.classList.add(ACTIVE_CLASS)
    document.head.appendChild(style)
  })
}

function captureElement(element: Element): ExternalElementPickView {
  try { element.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch { /* best effort */ }
  const rect = element.getBoundingClientRect()
  const attributes = Array.from(element.attributes)
    .slice(0, 24)
    .map((attribute) => `${attribute.name}=${attribute.value.slice(0, 120)}`)
  const className = typeof element.className === 'string' ? element.className.trim() : ''
  const classes = className ? className.split(/\s+/).filter((name) => name !== HIGHLIGHT_CLASS).slice(0, 12) : undefined
  const styles: Record<string, string> = {}
  const computed = getComputedStyle(element)
  for (const property of ['display', 'position', 'color', 'background-color', 'font-size', 'font-weight', 'line-height', 'border-radius', 'padding', 'margin', 'overflow']) {
    const value = computed.getPropertyValue(property).trim()
    if (value) styles[property] = value.slice(0, 120)
  }
  const source = reactSource(element) ?? vueSource(element)
  return {
    tag: element.tagName.toLowerCase(),
    ...(element.id ? { id: element.id } : {}),
    ...(classes?.length ? { classes } : {}),
    ...(element.getAttribute('role') ? { role: element.getAttribute('role')! } : {}),
    ...(element.getAttribute('aria-label') ? { ariaLabel: element.getAttribute('aria-label')! } : {}),
    ...((element.textContent ?? '').replace(/\s+/g, ' ').trim() ? { text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) } : {}),
    attributes,
    box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    html: element.outerHTML.slice(0, 3_000),
    url: location.href,
    pageTitle: document.title,
    selector: cssPath(element),
    ...(Object.keys(styles).length ? { styles } : {}),
    ...(source ? { source } : {}),
  }
}

function cssPath(element: Element): string {
  const parts: string[] = []
  let node: Element | null = element
  let depth = 0
  while (node && depth < 10) {
    let part = node.tagName.toLowerCase()
    if (node.id) {
      parts.unshift(`${part}#${CSS.escape(node.id)}`)
      break
    }
    const parent: Element | null = node.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter((child) => child.tagName === node!.tagName)
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`
    }
    if (depth === 0 && typeof node.className === 'string' && node.className.trim()) {
      const hint = node.className.trim().split(/\s+/).filter((name) => name !== HIGHLIGHT_CLASS).slice(0, 2)
      if (hint.length) part += `.${hint.map((name) => CSS.escape(name)).join('.')}`
    }
    parts.unshift(part)
    node = parent
    depth += 1
  }
  return parts.join(' > ')
}

function reactSource(element: Element): string | undefined {
  const record = element as unknown as Record<string, unknown>
  const key = Object.keys(record).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'))
  if (!key) return undefined
  const fiber = record[key] as { _debugSource?: { fileName?: string; lineNumber?: number }; return?: { _debugSource?: { fileName?: string; lineNumber?: number } } } | undefined
  const source = fiber?._debugSource ?? fiber?.return?._debugSource
  if (!source?.fileName) return undefined
  return `${source.fileName.replace(/^(file:\/\/|webpack:\/\/)/, '')}${source.lineNumber ? `:${source.lineNumber}` : ''}`
}

function vueSource(element: Element): string | undefined {
  const record = element as unknown as Record<string, unknown>
  const key = Object.keys(record).find((name) => name.startsWith('__vueParentComponent'))
  if (!key) return undefined
  const component = record[key] as { type?: { __file?: unknown } } | undefined
  return typeof component?.type?.__file === 'string' ? component.type.__file : undefined
}

function describeElement(element: ExternalElementPickView): string {
  const id = element.id ? `#${element.id}` : ''
  const classes = element.classes?.length ? `.${element.classes.slice(0, 2).join('.')}` : ''
  return `<${element.tag}${id}${classes}>`
}
