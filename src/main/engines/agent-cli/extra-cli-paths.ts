import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

function firstExisting(overrideName: string, candidates: string[]): string | undefined {
  const override = process.env[overrideName]
  if (override) {
    const resolved = resolve(override)
    return existsSync(resolved) ? resolved : undefined
  }
  return candidates.map((entry) => resolve(entry)).find((entry) => existsSync(entry))
}

function npmBinCandidates(name: string): string[] {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const npmBin = process.env.APPDATA ? join(process.env.APPDATA, 'npm') : join(home, '.npm-global', 'bin')
  return process.platform === 'win32'
    ? [join(npmBin, `${name}.cmd`), join(npmBin, name), join(home, '.local', 'bin', `${name}.exe`), join(home, '.local', 'bin', `${name}.cmd`), join(home, '.local', 'bin', name)]
    : [
        join(npmBin, name),
        join(home, '.local', 'bin', name),
        join('/opt/homebrew/bin', name),
        join('/home/linuxbrew/.linuxbrew/bin', name),
        join('/usr/local/bin', name),
      ]
}

function opencodeDesktopBinPaths(): string[] {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? ''
    const programFiles = process.env.ProgramFiles ?? process.env.PROGRAMFILES ?? ''
    const roots = [
      ...(localAppData
        ? [join(localAppData, 'Programs', '@opencodedesktop'), join(localAppData, 'Programs', 'opencode-desktop')]
        : []),
      ...(programFiles
        ? [join(programFiles, '@opencodedesktop'), join(programFiles, 'opencode-desktop')]
        : []),
    ]
    return roots.map((root) => join(root, 'resources', 'opencode-cli.exe'))
  }
  if (process.platform === 'darwin') {
    return [join('/Applications', 'OpenCode.app', 'Contents', 'Resources', 'opencode-cli')]
  }
  return []
}

export function opencodeBinPath(): string | undefined {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const programData = process.env.ProgramData ?? process.env.PROGRAMDATA ?? ''
  return firstExisting('ND_DSH_OPENCODE_BINARY', [
    ...(process.platform === 'win32'
      ? [
          join(home, '.opencode', 'bin', 'opencode.exe'),
          join(home, '.opencode', 'bin', 'opencode.cmd'),
          join(home, 'scoop', 'shims', 'opencode.exe'),
          join(home, 'scoop', 'shims', 'opencode.cmd'),
          ...(programData ? [join(programData, 'chocolatey', 'bin', 'opencode.exe')] : []),
        ]
      : [join(home, '.opencode', 'bin', 'opencode')]),
    ...opencodeDesktopBinPaths(),
    ...npmBinCandidates('opencode'),
  ])
}

export function gooseBinPath(): string | undefined {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  return firstExisting('ND_DSH_GOOSE_BINARY', [
    ...(process.platform === 'win32'
      ? [join(home, '.local', 'bin', 'goose.exe'), join(home, '.local', 'bin', 'goose.cmd')]
      : [join(home, '.local', 'bin', 'goose'), '/usr/local/bin/goose']),
    ...npmBinCandidates('goose'),
  ])
}

export function jcodeBinPath(): string | undefined {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const localAppData = process.env.LOCALAPPDATA ?? ''
  return firstExisting('ND_DSH_JCODE_BINARY', [
    ...(process.platform === 'win32'
      ? [
          ...(localAppData ? [join(localAppData, 'jcode', 'bin', 'jcode.exe')] : []),
          join(home, '.local', 'bin', 'jcode.exe'),
          join(home, '.local', 'bin', 'jcode.cmd'),
        ]
      : [join(home, '.local', 'bin', 'jcode')]),
    ...npmBinCandidates('jcode'),
  ])
}

export function hermesBinPath(): string | undefined {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const localAppData = process.env.LOCALAPPDATA ?? ''
  return firstExisting('ND_DSH_HERMES_BINARY', [
    ...(process.platform === 'win32'
      ? [
          ...(localAppData
            ? [
                join(localAppData, 'hermes', 'bin', 'hermes.exe'),
                join(localAppData, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
              ]
            : []),
          join(home, '.local', 'bin', 'hermes.exe'),
          join(home, '.local', 'bin', 'hermes.cmd'),
        ]
      : [join(home, '.local', 'bin', 'hermes')]),
    ...npmBinCandidates('hermes'),
  ])
}

export function minimaxBinPath(): string | undefined {
  return firstExisting('ND_DSH_MINIMAX_BINARY', npmBinCandidates('mmx'))
}
