import type { CoreClient } from './core-client.js'

export interface CoreWorkspaceEntry {
  name: string
  path: string
  isFile: boolean
  isDirectory: boolean
  isSymlink: boolean
  size: number
}

export interface CoreWorkspaceListing {
  root: string
  path: string
  entries: CoreWorkspaceEntry[]
  truncated: boolean
  maxEntries: number
}

export interface CoreWorkspaceFile {
  root: string
  path: string
  data: string
  size: number
  truncated: boolean
  maxBytes: number
  byteSize: number
}

export interface CoreWorkspaceIndex {
  root: string
  entries: Array<{ path: string; isDirectory: boolean }>
  truncated: boolean
  maxEntries: number
  durationMs: number
}

/**
 * The workspace filesystem as nd-core implements it: a bounded listing, a bounded
 * read, and a bounded breadth-first path index, all resolving inside the active
 * workspace root and all reporting whether a bound was hit.
 */
export interface WorkspaceFileSystem {
  list(root: string, relativePath: string, maxEntries?: number): Promise<CoreWorkspaceListing>
  read(root: string, relativePath: string, maxBytes?: number): Promise<CoreWorkspaceFile>
  readBinary?(root: string, relativePath: string, maxBytes: number): Promise<{ data: number[]; truncated: boolean }>
  index(root: string, maxEntries: number, skipNames: readonly string[]): Promise<CoreWorkspaceIndex>
}

/**
 * The single bound nd-core applies to a listing regardless of what a caller asks
 * for, mirrored here so the product can request the whole bounded window and then
 * apply its own filtering without silently losing entries.
 */
export const CORE_WORKSPACE_LIST_HARD_MAX = 4096

export interface CoreArtifactFingerprint {
  path: string
  kind: 'file' | 'directory'
  size: number
  sha256: string
}

export type CoreArtifactFingerprinter = (
  root: string,
  paths: readonly string[],
) => Promise<CoreArtifactFingerprint[]>

/** Hashing up to 1 GiB of declared artifact evidence is slow but bounded. */
const CORE_ARTIFACT_FINGERPRINT_TIMEOUT_MS = 10 * 60_000

/**
 * Artifact receipts are produced by nd-core's `workspace.fingerprint-artifacts`:
 * the walk, the bounds, and the digest layout live in Rust so the desktop main
 * process never hashes declared evidence itself.
 */
export function createCoreArtifactFingerprint(
  core: Pick<CoreClient, 'request'>,
): CoreArtifactFingerprinter {
  return async (root, paths) => {
    const result = await core.request<{ artifacts: CoreArtifactFingerprint[] }>(
      'workspace.fingerprint-artifacts',
      { root, paths: [...paths] },
      CORE_ARTIFACT_FINGERPRINT_TIMEOUT_MS,
    )
    return result.artifacts
  }
}

export function createCoreWorkspaceFileSystem(
  core: Pick<CoreClient, 'request'>,
): WorkspaceFileSystem {
  return {
    async readBinary(root, relativePath, maxBytes) {
      return await core.request<{ data: number[]; truncated: boolean }>(
        'workspace.read-binary', { root, path: relativePath, maxBytes }, 15_000,
      )
    },
    async list(root, relativePath, maxEntries) {
      const listing = await core.request<CoreWorkspaceListing>(
        'workspace.list',
        {
          root,
          path: relativePath,
          ...(maxEntries === undefined ? {} : { maxEntries }),
        },
        15_000,
      )
      return listing
    },
    async read(root, relativePath, maxBytes) {
      const file = await core.request<CoreWorkspaceFile>(
        'workspace.read',
        {
          root,
          path: relativePath,
          ...(maxBytes === undefined ? {} : { maxBytes }),
        },
        15_000,
      )
      return file
    },
    async index(root, maxEntries, skipNames) {
      return await core.request<CoreWorkspaceIndex>(
        'workspace.index',
        { root, maxEntries, skipNames: [...skipNames] },
        15_000,
      )
    },
  }
}
