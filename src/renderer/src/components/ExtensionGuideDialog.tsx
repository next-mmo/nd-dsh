import { useState } from 'react'
import { BookOpen, Download, RefreshCw } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { MarkdownLite } from './MarkdownLite'
import { EXTENSION_GUIDE_SECTIONS } from '../lib/extension-guide'
import { cn } from '../lib/utils'

const FIRST_SECTION_ID = EXTENSION_GUIDE_SECTIONS[0].id

/**
 * The bundled extension developer guide. Content is inlined at build time (see
 * `lib/extension-guide`), so it reads identically in dev and in an installed app.
 * The header also hands the reader a complete starter project as a ZIP, built
 * and saved by the trusted main process.
 */
export default function ExtensionGuideDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [sectionId, setSectionId] = useState<string>(FIRST_SECTION_ID)
  const [starterBusy, setStarterBusy] = useState(false)
  const [starterError, setStarterError] = useState<string | null>(null)
  const [starterSavedPath, setStarterSavedPath] = useState<string | null>(null)
  const section = EXTENSION_GUIDE_SECTIONS.find((entry) => entry.id === sectionId) ?? EXTENSION_GUIDE_SECTIONS[0]

  const downloadStarter = async (): Promise<void> => {
    setStarterBusy(true)
    setStarterError(null)
    setStarterSavedPath(null)
    try {
      const result = await window.ndDsh.ndExtensions.exportStarterKit()
      if (!result) return // save dialog cancelled
      if (result.saved && result.path) setStarterSavedPath(result.path)
      else setStarterError('The starter kit could not be saved.')
    } catch (cause) {
      setStarterError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStarterBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-full min-w-0 flex-col gap-4 overflow-hidden border-border-strong bg-surface-1 p-0 sm:max-w-3xl md:max-w-4xl">
        <DialogHeader className="space-y-1.5 border-b border-border-soft px-6 pb-4 pt-6 text-left">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <DialogTitle className="flex items-center gap-2 text-base">
              <BookOpen className="size-4 text-primary" aria-hidden="true" /> Extension developer guide
            </DialogTitle>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-xs"
              disabled={starterBusy}
              onClick={() => void downloadStarter()}
              title="Download a complete, installable starter extension as a ZIP — unzip, git init, and make it yours"
            >
              {starterBusy ? <RefreshCw className="mr-1.5 size-3.5 animate-spin" /> : <Download className="mr-1.5 size-3.5" />}
              Download starter ZIP
            </Button>
          </div>
          <DialogDescription className="text-xs leading-5">
            How ND extensions are packaged, validated, installed, and governed. Bundled with this build of ND.
          </DialogDescription>
          {starterSavedPath ? (
            <p className="text-xs text-primary" role="status">
              Starter saved to <span className="font-mono">{starterSavedPath}</span> — unzip it, then Extensions → Install local…
            </p>
          ) : null}
          {starterError ? (
            <p className="text-xs text-destructive" role="alert">{starterError}</p>
          ) : null}
        </DialogHeader>

        <nav aria-label="Guide sections" className="flex shrink-0 items-center gap-1 px-6">
          <div className="flex items-center gap-1 rounded-full border border-border-soft bg-surface-0/60 p-1">
            {EXTENSION_GUIDE_SECTIONS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={entry.id === section.id}
                onClick={() => setSectionId(entry.id)}
                className={cn(
                  'inline-flex h-8 items-center rounded-full px-3.5 text-xs font-medium transition-colors',
                  entry.id === section.id ? 'bg-primary/15 text-primary shadow-sm' : 'text-faint hover:bg-accent hover:text-foreground',
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 pb-6 pt-2">
          <MarkdownLite text={section.text} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
