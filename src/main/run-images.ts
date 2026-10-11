import type { HarnessRunImage } from '../shared/contracts.js'
import { MAX_PASTED_IMAGE_LENGTH, MAX_PASTED_IMAGES } from '../shared/images.js'

const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Pasted chat images ride the prompt as base64 payloads; renderer input, so fail closed. */
export function asRunImages(value: unknown): HarnessRunImage[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) throw new Error('images must be a non-empty list')
  if (value.length > MAX_PASTED_IMAGES) throw new Error(`Attach at most ${MAX_PASTED_IMAGES} images per message`)
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Image ${index + 1} must be an object`)
    const image = entry as Record<string, unknown>
    if (typeof image.mediaType !== 'string' || !MEDIA_TYPES.includes(image.mediaType)) {
      throw new Error(`Image ${index + 1} must be a PNG, JPEG, WebP, or GIF`)
    }
    if (typeof image.data !== 'string' || !BASE64.test(image.data) || image.data.length > MAX_PASTED_IMAGE_LENGTH) {
      throw new Error(`Image ${index + 1} must be base64-encoded and under 6 MB`)
    }
    if (image.name !== undefined && (typeof image.name !== 'string' || !image.name.trim() || image.name.length > 128)) {
      throw new Error(`Image ${index + 1} name must be a short non-empty string`)
    }
    return {
      data: image.data,
      mediaType: image.mediaType,
      ...(typeof image.name === 'string' && image.name.trim() ? { name: image.name.trim() } : {}),
    } as HarnessRunImage
  })
}
