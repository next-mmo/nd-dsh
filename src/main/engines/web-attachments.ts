import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessRunImage } from '../../shared/contracts.js'

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

export interface StagedWebImages {
  directory: string
  files: string[]
}

/**
 * Web chat composers accept attachments only through a real file input, so
 * pasted images are materialized once in a private temp directory for CDP.
 */
export function stageWebImages(images: readonly HarnessRunImage[]): StagedWebImages {
  const directory = mkdtempSync(join(tmpdir(), 'nd-web-attach-'))
  const files = images.map((image, index) => {
    const extension = IMAGE_EXTENSIONS[image.mediaType] ?? 'png'
    const stem = (image.name ?? '')
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 48)
    const path = join(directory, `${stem || 'pasted-image'}-${index + 1}.${extension}`)
    writeFileSync(path, Buffer.from(image.data, 'base64'), { mode: 0o600 })
    return path
  })
  return { directory, files }
}

export function discardWebImages(staged: StagedWebImages | undefined): void {
  if (!staged) return
  try {
    rmSync(staged.directory, { recursive: true, force: true })
  } catch {
    // Best effort: a file still held by the uploader, or a forced app exit,
    // can leave the directory behind; never fail the turn for temp cleanup.
  }
}
