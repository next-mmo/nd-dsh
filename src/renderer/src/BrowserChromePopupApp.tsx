import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  BROWSER_CHROME_POPUP_GUTTER,
  type BrowserChromePopupAction,
  type BrowserChromePopupModel,
} from '../../shared/browser-chrome-popup'
import { BrowserChromeMenu } from './components/browser-chrome-menus'

const CARD_WIDTH: Record<BrowserChromePopupModel['kind'], number> = {
  extensions: 320,
  profiles: 272,
}

/**
 * The browser chrome popup surface (#/browser-popup): a transparent native
 * view stacked above the embedded page, like Chrome's toolbar bubbles. It
 * holds no state of its own — main relays the primary renderer's view model
 * here and relays user intents back — and it reports its card size so the
 * native view hugs the card plus a shadow gutter.
 */
export default function BrowserChromePopupApp() {
  const surface = window.ndDsh.browserChromePopupSurface
  const [model, setModel] = useState<BrowserChromePopupModel | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void surface?.getModel().then((initial) => { if (initial) setModel(initial) })
    return surface?.onModel(setModel)
  }, [surface])

  // The themed body is opaque; this surface must stay see-through around the card.
  useEffect(() => {
    const roots = [document.documentElement, document.body, document.getElementById('root')]
      .filter((element): element is HTMLElement => element !== null)
    roots.forEach((element) => element.classList.add('browser-chrome-popup-mode'))
    return () => roots.forEach((element) => element.classList.remove('browser-chrome-popup-mode'))
  }, [])

  useEffect(() => {
    if (!model) return
    document.documentElement.dataset.theme = model.theme
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', model.theme)
  }, [model?.theme])

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card || !surface) return
    const report = (): void => {
      void surface.resize({ width: card.offsetWidth, height: card.offsetHeight }).catch(() => undefined)
    }
    const observer = new ResizeObserver(report)
    observer.observe(card)
    report()
    return () => observer.disconnect()
  }, [model, surface])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void surface?.close().catch(() => undefined)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [surface])

  const dispatch = (action: BrowserChromePopupAction): void => {
    void surface?.action(action).catch(() => undefined)
  }

  if (!model || !surface) return null
  return (
    <div className="browser-chrome-popup-mode fixed inset-0 overflow-hidden font-sans">
      <div
        ref={cardRef}
        role="dialog"
        aria-label={model.kind === 'extensions' ? 'Extensions' : 'Browser profiles'}
        className="absolute flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_6px_18px_rgba(0,0,0,0.2)]"
        style={{ left: BROWSER_CHROME_POPUP_GUTTER, top: BROWSER_CHROME_POPUP_GUTTER, width: CARD_WIDTH[model.kind] }}
      >
        <BrowserChromeMenu model={model} onAction={dispatch} />
      </div>
    </div>
  )
}
