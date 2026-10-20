import type { HarnessRunFile, HarnessRunImage } from '../shared/contracts.js'
import {
  MAX_ATTACHMENT_NAME_CHARS,
  MAX_ATTACHMENT_RELATIVE_PATH_CHARS,
  MAX_CHAT_ATTACHMENTS,
  MAX_RUN_ATTACHMENT_BYTES,
  MAX_RUN_FILE_LENGTH,
  attachmentMediaType,
} from '../shared/attachments.js'

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Renderer-supplied file bytes; validate every field and fail closed. */
export function asRunFiles(value: unknown): HarnessRunFile[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) throw new Error('files must be a non-empty list')
  if (value.length > MAX_CHAT_ATTACHMENTS) throw new Error(`Attach at most ${MAX_CHAT_ATTACHMENTS} files per message`)
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`File ${index + 1} must be an object`)
    const file = entry as Record<string, unknown>
    if (typeof file.data !== 'string' || !BASE64.test(file.data) || file.data.length > MAX_RUN_FILE_LENGTH) {
      throw new Error(`File ${index + 1} must be base64-encoded and under 10 MB`)
    }
    if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > MAX_ATTACHMENT_NAME_CHARS) {
      throw new Error(`File ${index + 1} needs a short name`)
    }
    const name = file.name.trim()
    const mediaType = typeof file.mediaType === 'string' ? attachmentMediaType(file.mediaType, name) : attachmentMediaType('', name)
    const relativePath = normalizeRelativePath(file.relativePath, index)
    return {
      data: file.data,
      mediaType,
      name,
      ...(relativePath ? { relativePath } : {}),
    }
  })
}

/** Images and files share Qoder's 20-attachment ceiling and a 25 MB byte budget. */
export function assertRunAttachmentBudget(images: HarnessRunImage[] | undefined, files: HarnessRunFile[] | undefined): void {
  const total = (images?.length ?? 0) + (files?.length ?? 0)
  if (total > MAX_CHAT_ATTACHMENTS) throw new Error(`Attach at most ${MAX_CHAT_ATTACHMENTS} items per message`)
  let bytes = 0
  for (const image of images ?? []) bytes += Math.ceil(image.data.length * 3 / 4)
  for (const file of files ?? []) bytes += Math.ceil(file.data.length * 3 / 4)
  if (bytes > MAX_RUN_ATTACHMENT_BYTES) {
    throw new Error(`Attachments must total under ${Math.floor(MAX_RUN_ATTACHMENT_BYTES / 1024 / 1024)} MB`)
  }
}

function normalizeRelativePath(value: unknown, index: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`File ${index + 1} has an invalid relative path`)
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!normalized) return undefined
  if (normalized.length > MAX_ATTACHMENT_RELATIVE_PATH_CHARS) throw new Error(`File ${index + 1} path is too long`)
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`File ${index + 1} path must stay inside the selected folder`)
  }
  return normalized
}
