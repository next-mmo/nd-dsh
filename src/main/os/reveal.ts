import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { shell } from 'electron'

export type RevealMethod = 'explorer' | 'finder' | 'folder'

/**
 * Reveal a file in the desktop file manager with the item selected.
 *
 * `shell.showItemInFolder` is not usable here: it returns nothing, and on
 * Windows it aborts silently when the main thread's COM apartment is not
 * STA — which is what made ND's Reveal buttons appear dead while the broker
 * recorded a clean success. The native selectors below take no COM contract,
 * and opening the containing folder is the guaranteed fallback.
 */
export async function revealInFolder(path: string): Promise<{ method: RevealMethod; path: string }> {
  if (process.platform === 'win32') {
    // The selector argument is written verbatim into explorer's command line,
    // so a quote in a caller-supplied path would inject an extra argument.
    if (path.includes('"')) throw new Error('Refusing to reveal a path containing a quote')
    // explorer.exe reports failure even when it succeeds, so only a spawn
    // error counts; the quoted form is what makes paths with spaces select.
    if (await run('explorer.exe', [`/select,"${path}"`], true)) return { method: 'explorer', path }
  } else if (process.platform === 'darwin') {
    if (await run('open', ['-R', path], false)) return { method: 'finder', path }
  }
  const error = await shell.openPath(dirname(path))
  if (error) throw new Error(error)
  return { method: 'folder', path: dirname(path) }
}

function run(command: string, args: string[], verbatim: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: verbatim })
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}
