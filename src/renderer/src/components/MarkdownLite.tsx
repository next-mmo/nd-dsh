import { useEffect, useState } from 'react'
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, CopyIcon, DownloadIcon, ExternalIcon } from './Icons'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { type InlineToken, parseMarkdownBlocks, tokenizeInline } from '../../../shared/markdown-lite'
import { cn } from '../lib/utils'

/** Extensions that make a bare filename (no folder prefix) worth linking. */
const BARE_FILE_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'html', 'yml', 'yaml', 'toml', 'sh', 'py', 'rs', 'go', 'svg', 'csv',
])

/** True when an inline code token plausibly names a workspace-relative file. */
function looksLikeWorkspacePath(text: string): boolean {
  if (text.length === 0 || text.length > 260 || /\s/.test(text)) return false
  if (/[\\/]/.test(text)) return /\.[A-Za-z0-9]{1,10}$/.test(text)
  const dot = text.lastIndexOf('.')
  return dot > 0 && BARE_FILE_EXTENSIONS.has(text.slice(dot + 1).toLowerCase())
}

function imageDownloadFilename(alt: string | undefined, url: string): string {
  const base = (alt || 'image')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'image'
  const dataMatch = /^data:image\/([a-z0-9+.-]+);/i.exec(url)
  if (dataMatch?.[1]) {
    const rawExt = dataMatch[1].toLowerCase()
    const ext = rawExt === 'jpeg' ? 'jpg' : rawExt === 'svg+xml' ? 'svg' : rawExt
    return base.endsWith(`.${ext}`) ? base : `${base}.${ext}`
  }
  const urlMatch = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url)
  const ext = urlMatch?.[1]?.toLowerCase() ?? 'png'
  return base.endsWith(`.${ext}`) ? base : `${base}.${ext}`
}

async function copyImageToClipboard(url: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('Image load failed'))
        img.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth || img.width || 1
      canvas.height = img.naturalHeight || img.height || 1
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(img, 0, 0)
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
        if (blob) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          return true
        }
      }
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url)
      return true
    }
  } catch {
    // Fallback if canvas/clipboard access is blocked.
  }
  return false
}

export function ImagePreviewDialog({
  open,
  onOpenChange,
  url,
  alt,
  linkUrl,
  onOpenLink,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  url: string
  alt?: string | undefined
  linkUrl?: string | undefined
  onOpenLink?: ((url: string) => void) | undefined
}) {
  const [zoomed, setZoomed] = useState(false)
  const [copied, setCopied] = useState(false)
  const title = alt?.trim() || 'Image preview'
  const externalTarget = linkUrl ?? (!url.startsWith('data:') ? url : undefined)

  const handleCopy = async (): Promise<void> => {
    const ok = await copyImageToClipboard(url)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_600)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setZoomed(false)
        onOpenChange(next)
      }}
    >
      <DialogContent className="flex max-h-[90vh] flex-col gap-3 p-4 sm:max-w-4xl">
        <DialogHeader className="pr-6">
          <DialogTitle className="truncate text-[13px] font-semibold">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            Preview image in modal dialog. Click the image to toggle zoom.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-[200px] max-h-[72vh] items-center justify-center overflow-auto rounded-lg border border-border-soft bg-surface-1/80 p-2">
          <img
            src={url}
            alt={title}
            referrerPolicy="no-referrer"
            onClick={() => setZoomed((prev) => !prev)}
            title={zoomed ? 'Click to fit to dialog' : 'Click to zoom'}
            className={cn(
              'rounded object-contain transition-transform',
              zoomed ? 'max-h-none max-w-none cursor-zoom-out' : 'max-h-[68vh] max-w-full cursor-zoom-in',
            )}
          />
        </div>
        <DialogFooter className="flex flex-row items-center justify-between gap-2 sm:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-soft transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
              onClick={() => void handleCopy()}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? 'Copied' : 'Copy image'}
            </button>
            <a
              href={url}
              download={imageDownloadFilename(alt, url)}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-soft transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
            >
              <DownloadIcon />
              Download
            </a>
            {onOpenLink && externalTarget ? (
              <button
                type="button"
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-soft transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
                title={`Open ${externalTarget} in Browser`}
                onClick={() => {
                  onOpenChange(false)
                  onOpenLink(externalTarget)
                }}
              >
                <ExternalIcon />
                {linkUrl ? 'Open link' : 'Open in Browser'}
              </button>
            ) : null}
          </div>
          <DialogClose asChild>
            <button
              type="button"
              className="cursor-pointer rounded-md border border-border px-3 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
            >
              Close
            </button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface GalleryImage {
  url: string
  alt?: string | undefined
}

/** Multi-image preview with previous/next, thumbnails, and keyboard arrows. */
export function ImageGalleryDialog({
  open,
  onOpenChange,
  images,
  startIndex = 0,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  images: GalleryImage[]
  startIndex?: number
}) {
  const [index, setIndex] = useState(startIndex)
  const [zoomed, setZoomed] = useState(false)
  const [copied, setCopied] = useState(false)
  const count = images.length
  const current = images[Math.min(index, Math.max(count - 1, 0))]

  useEffect(() => {
    if (!open) return
    setIndex(Math.min(Math.max(startIndex, 0), Math.max(count - 1, 0)))
    setZoomed(false)
    setCopied(false)
  }, [open, startIndex, count])

  useEffect(() => {
    if (!open || count < 2) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setIndex((value) => Math.max(0, value - 1))
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        setIndex((value) => Math.min(count - 1, value + 1))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, count])

  if (!current) return null
  const title = current.alt?.trim() || `Attachment ${index + 1}`
  const externalTarget = current.url.startsWith('data:') ? undefined : current.url

  const handleCopy = async (): Promise<void> => {
    const ok = await copyImageToClipboard(current.url)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_600)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setZoomed(false)
        onOpenChange(next)
      }}
    >
      <DialogContent className="flex max-h-[90vh] flex-col gap-3 p-4 sm:max-w-4xl">
        <DialogHeader className="pr-6">
          <DialogTitle className="truncate text-[13px] font-semibold">
            {count > 1 ? `${title} — ${index + 1} of ${count}` : title}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Preview attached images. Use the arrow keys or the previous and next buttons to move between files.
          </DialogDescription>
        </DialogHeader>
        <div className="relative flex min-h-[200px] max-h-[68vh] items-center justify-center overflow-auto rounded-lg border border-border-soft bg-surface-1/80 p-2">
          {count > 1 ? (
            <button
              type="button"
              aria-label="Previous attachment"
              title="Previous attachment"
              disabled={index === 0}
              onClick={() => setIndex((value) => Math.max(0, value - 1))}
              className="absolute left-2 top-1/2 z-10 grid size-8 -translate-y-1/2 place-items-center rounded-full border border-border bg-background/90 text-foreground shadow-sm transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-35 [&_svg]:size-4"
            >
              <ArrowLeftIcon />
            </button>
          ) : null}
          <img
            src={current.url}
            alt={title}
            referrerPolicy="no-referrer"
            onClick={() => setZoomed((prev) => !prev)}
            title={zoomed ? 'Click to fit to dialog' : 'Click to zoom'}
            className={cn(
              'rounded object-contain transition-transform',
              zoomed ? 'max-h-none max-w-none cursor-zoom-out' : 'max-h-[68vh] max-w-full cursor-zoom-in',
            )}
          />
          {count > 1 ? (
            <button
              type="button"
              aria-label="Next attachment"
              title="Next attachment"
              disabled={index === count - 1}
              onClick={() => setIndex((value) => Math.min(count - 1, value + 1))}
              className="absolute right-2 top-1/2 z-10 grid size-8 -translate-y-1/2 place-items-center rounded-full border border-border bg-background/90 text-foreground shadow-sm transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-35 [&_svg]:size-4"
            >
              <ArrowRightIcon />
            </button>
          ) : null}
        </div>
        {count > 1 ? (
          <div className="flex justify-center gap-1.5 overflow-x-auto">
            {images.map((image, itemIndex) => (
              <button
                key={`${itemIndex}-${image.url.slice(-24)}`}
                type="button"
                title={image.alt || `Attachment ${itemIndex + 1}`}
                onClick={() => setIndex(itemIndex)}
                className={cn(
                  'h-12 w-12 shrink-0 overflow-hidden rounded border transition-opacity',
                  itemIndex === index ? 'border-primary ring-1 ring-primary' : 'border-border-soft opacity-70 hover:opacity-100',
                )}
              >
                <img src={image.url} alt={image.alt || ''} referrerPolicy="no-referrer" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        ) : null}
        <DialogFooter className="flex flex-row items-center justify-between gap-2 sm:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-soft transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
              onClick={() => void handleCopy()}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? 'Copied' : 'Copy image'}
            </button>
            <a
              href={current.url}
              download={imageDownloadFilename(current.alt, current.url)}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-soft transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
            >
              <DownloadIcon />
              Download
            </a>
            {externalTarget ? (
              <a
                href={externalTarget}
                target="_blank"
                rel="noreferrer"
                title={`Open ${externalTarget}`}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-soft transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
              >
                <ExternalIcon />
                Open
              </a>
            ) : null}
          </div>
          <DialogClose asChild>
            <button
              type="button"
              className="cursor-pointer rounded-md border border-border px-3 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
            >
              Close
            </button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChatImage({
  token,
  onOpenLink,
}: {
  token: Extract<InlineToken, { kind: 'image' }>
  onOpenLink?: (url: string) => void
}) {
  const [failed, setFailed] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const targetUrl = token.linkUrl ?? token.url

  if (failed) {
    return (
      <span className="my-1 inline-flex items-center gap-1.5 rounded-md border border-border-soft bg-surface-1 px-2.5 py-1 text-[11px] text-faint">
        <span className="text-[12px]" aria-hidden="true">🖼️</span>
        <span className="max-w-[220px] truncate">{token.alt || 'Image'}</span>
        {onOpenLink && targetUrl ? (
          <button
            type="button"
            className="cursor-pointer text-primary underline decoration-primary/45 underline-offset-2 transition-colors hover:text-foreground"
            title={`Open ${targetUrl} in Browser`}
            onClick={() => onOpenLink(targetUrl)}
          >
            Open link
          </button>
        ) : null}
      </span>
    )
  }

  return (
    <>
      <button
        type="button"
        className="group/img my-0.5 inline-block cursor-zoom-in text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        title={token.alt ? `${token.alt} — click to preview` : 'Click to preview image'}
        onClick={() => setPreviewOpen(true)}
      >
        <img
          src={token.url}
          alt={token.alt || 'Image'}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="my-1.5 max-h-64 max-w-full rounded-md border border-border-soft bg-surface-1 object-contain shadow-xs transition-opacity group-hover/img:opacity-95"
        />
      </button>
      <ImagePreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        url={token.url}
        alt={token.alt}
        linkUrl={token.linkUrl}
        onOpenLink={onOpenLink}
      />
    </>
  )
}

/** Inline formatting: `code`, **bold**, *italic*, images → styled React nodes. */
function InlineText({ text, onOpenFile, onOpenLink }: { text: string; onOpenFile?: (path: string) => void; onOpenLink?: (url: string) => void }) {
  const tokens = tokenizeInline(text)
  return (
    <>
      {tokens.map((token, index) => {
        if (token.kind === 'image') {
          return <ChatImage key={index} token={token} {...(onOpenLink ? { onOpenLink } : {})} />
        }
        if (token.kind === 'link') {
          if (!onOpenLink) return <span key={index}>{token.text}</span>
          return (
            <button
              key={index}
              type="button"
              className="cursor-pointer text-primary underline decoration-primary/45 underline-offset-2 transition-colors hover:text-foreground"
              title={`Open ${token.url} in Browser`}
              onClick={() => onOpenLink(token.url)}
            >
              {token.text}
            </button>
          )
        }
        if (token.kind === 'code') {
          if (onOpenFile && looksLikeWorkspacePath(token.text)) {
            return (
              <button
                key={index}
                type="button"
                className="cursor-pointer rounded border border-border-soft bg-surface-1 px-[4px] py-px font-mono text-[11px] text-primary transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground"
                title={`Open ${token.text} in Files`}
                onClick={() => onOpenFile(token.text)}
              >
                {token.text}
              </button>
            )
          }
          return (
            <code key={index} className="rounded border border-border-soft bg-surface-1 px-[4px] py-px font-mono text-[11px] text-primary">
              {token.text}
            </code>
          )
        }
        if (token.kind === 'bold') return <strong key={index} className="font-semibold text-foreground">{token.text}</strong>
        if (token.kind === 'italic') return <em key={index}>{token.text}</em>
        return <span key={index}>{token.text}</span>
      })}
    </>
  )
}

function CodeBlock({ language, text }: { language: string; text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_600)
    } catch {
      // Clipboard can be denied; the code stays visible either way.
    }
  }
  return (
    <div className="group/code my-1.5 overflow-hidden rounded-lg border border-border-soft bg-surface-0">
      <div className="flex items-center justify-between border-b border-border-soft bg-surface-1 px-2 py-[3px]">
        <span className="font-mono text-[8px] uppercase tracking-[0.08em] text-faint">{language || 'code'}</span>
        <button
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[8px] font-medium text-faint opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover/code:opacity-100 [&_svg]:size-[9px]"
          onClick={() => void copy()}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="m-0 max-h-[280px] overflow-auto whitespace-pre px-2.5 py-1.5 font-mono text-[9.5px]/[1.6] text-soft">{text}</pre>
    </div>
  )
}

/** Chat-grade markdown renderer: block parser + inline tokens, no raw HTML. */
export function MarkdownLite({ text, className, onOpenFile, onOpenLink }: { text: string; className?: string; onOpenFile?: (path: string) => void; onOpenLink?: (url: string) => void }) {
  const blocks = parseMarkdownBlocks(text)
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'code':
            return <CodeBlock key={index} language={block.language} text={block.text} />
          case 'heading':
            return (
              <div
                key={index}
                className={cn(
                  'font-semibold text-foreground',
                  block.level === 1 ? 'text-[13px]' : block.level === 2 ? 'text-[12px]' : 'text-[11.5px]',
                )}
              >
                <InlineText text={block.text} {...(onOpenFile ? { onOpenFile } : {})} {...(onOpenLink ? { onOpenLink } : {})} />
              </div>
            )
          case 'bullet-list':
            return (
              <ul key={index} className="m-0 flex list-disc flex-col gap-0.5 pl-[18px]">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex} className="[overflow-wrap:anywhere] text-[12px]/[1.6] text-foreground/90">
                    <InlineText text={item} {...(onOpenFile ? { onOpenFile } : {})} {...(onOpenLink ? { onOpenLink } : {})} />
                  </li>
                ))}
              </ul>
            )
          case 'ordered-list':
            return (
              <ol key={index} className="m-0 flex list-decimal flex-col gap-0.5 pl-[18px]">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex} className="[overflow-wrap:anywhere] text-[12px]/[1.6] text-foreground/90">
                    <InlineText text={item} {...(onOpenFile ? { onOpenFile } : {})} {...(onOpenLink ? { onOpenLink } : {})} />
                  </li>
                ))}
              </ol>
            )
          case 'quote':
            return (
              <blockquote key={index} className="my-0.5 border-l-2 border-border-strong pl-2 text-[11.5px]/[1.6] text-faint">
                <InlineText text={block.text} {...(onOpenFile ? { onOpenFile } : {})} {...(onOpenLink ? { onOpenLink } : {})} />
              </blockquote>
            )
          case 'table':
            return (
              <div key={index} className="my-1 overflow-x-auto rounded-md border border-border-soft">
                <table className="w-full min-w-[280px] border-collapse text-left text-[11px]">
                  <thead className="bg-surface-1 text-[10px] font-semibold text-soft">
                    <tr>
                      {block.headers.map((header, headerIndex) => (
                        <th key={headerIndex} className="border-b border-border-soft px-2 py-1.5 align-top">
                          <InlineText text={header} {...(onOpenFile ? { onOpenFile } : {})} {...(onOpenLink ? { onOpenLink } : {})} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-b border-border-soft last:border-b-0">
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} className="px-2 py-1.5 align-top text-foreground/90">
                            <InlineText text={cell} {...(onOpenFile ? { onOpenFile } : {})} {...(onOpenLink ? { onOpenLink } : {})} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          default:
            return (
              <div key={index} className="whitespace-pre-wrap [overflow-wrap:anywhere] text-[12.5px]/[1.7] text-foreground/90">
                <InlineText text={block.text} {...(onOpenFile ? { onOpenFile } : {})} {...(onOpenLink ? { onOpenLink } : {})} />
              </div>
            )
        }
      })}
    </div>
  )
}
