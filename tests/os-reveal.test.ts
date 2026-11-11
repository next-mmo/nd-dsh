import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * ND's Reveal controls used to look dead because Electron's
 * `shell.showItemInFolder` returns nothing and aborts silently when the main
 * thread's COM apartment is not STA. These tests pin the replacement contract:
 * the native selector runs first, the folder open is the fallback, and a real
 * failure is thrown instead of swallowed.
 */
const state = vi.hoisted(() => ({
  spawn: [] as { command: string; args: string[]; options: Record<string, unknown> }[],
  spawnFails: false,
  openPath: [] as string[],
  openPathError: '',
}))

vi.mock('electron', () => ({
  shell: {
    openPath: async (path: string) => {
      state.openPath.push(path)
      return state.openPathError
    },
  },
}))

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    state.spawn.push({ command, args, options })
    const handlers: Record<string, (arg?: unknown) => void> = {}
    const child = {
      once: (event: string, fn: (arg?: unknown) => void) => { handlers[event] = fn },
      unref: () => undefined,
    }
    setTimeout(() => {
      if (state.spawnFails) handlers.error?.(new Error('spawn explorer.exe ENOENT'))
      else handlers.spawn?.()
    }, 0)
    return child
  },
}))

const { revealInFolder } = await import('../src/main/os/reveal.js')

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
function onPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { ...platform, value })
}

afterEach(() => {
  onPlatform('win32')
  state.spawn = []
  state.spawnFails = false
  state.openPath = []
  state.openPathError = ''
})

const BS = String.fromCharCode(92)
const spaced = ['C:', 'Program Files', 'ND.log'].join(BS)

it('selects the item with explorer on Windows, quoting the path', async () => {
  onPlatform('win32')
  const result = await revealInFolder(spaced)
  expect(result).toEqual({ method: 'explorer', path: spaced })
  expect(state.spawn).toEqual([{
    command: 'explorer.exe',
    args: [`/select,"${spaced}"`],
    options: { detached: true, stdio: 'ignore', windowsVerbatimArguments: true },
  }])
  expect(state.openPath).toEqual([])
})

it('refuses to build an explorer command line from a path carrying a quote', async () => {
  onPlatform('win32')
  await expect(revealInFolder(['C:', 'nd" /select,x'].join(BS))).rejects.toThrow(/quote/)
  expect(state.spawn).toEqual([])
})

it('falls back to opening the folder when explorer cannot be spawned', async () => {
  onPlatform('win32')
  state.spawnFails = true
  const result = await revealInFolder(spaced)
  expect(result).toEqual({ method: 'folder', path: ['C:', 'Program Files'].join(BS) })
  expect(state.openPath).toEqual([['C:', 'Program Files'].join(BS)])
})

it('selects the item with open -R on macOS', async () => {
  onPlatform('darwin')
  const result = await revealInFolder('/tmp/nd/notes.md')
  expect(result).toEqual({ method: 'finder', path: '/tmp/nd/notes.md' })
  expect(state.spawn.map((call) => [call.command, call.args])).toEqual([['open', ['-R', '/tmp/nd/notes.md']]])
  expect(state.openPath).toEqual([])
})

it('opens the containing folder on Linux without spawning a selector', async () => {
  onPlatform('linux')
  const result = await revealInFolder('/tmp/nd/notes.md')
  expect(result).toEqual({ method: 'folder', path: '/tmp/nd' })
  expect(state.spawn).toEqual([])
  expect(state.openPath).toEqual(['/tmp/nd'])
})

it('throws the desktop error when even the folder refuses to open', async () => {
  onPlatform('linux')
  state.openPathError = 'No application knows how to open this folder'
  await expect(revealInFolder('/tmp/nd/notes.md')).rejects.toThrow(/No application knows/)
})
