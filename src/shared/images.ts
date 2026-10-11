/** Shared vocabulary for user-pasted chat/translate images. */
export const MAX_PASTED_IMAGES = 3
/** Pasted-image byte cap (~6 MB); the data-URL length cap below is its base64 inflation. */
export const MAX_PASTED_IMAGE_BYTES = 6_000_000
export const MAX_PASTED_IMAGE_LENGTH = MAX_PASTED_IMAGE_BYTES * 4 / 3
const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/

export function isImageDataUrl(value: string): boolean {
  return typeof value === 'string' && value.length <= MAX_PASTED_IMAGE_LENGTH && IMAGE_DATA_URL.test(value)
}

export function imageMediaType(value: string): string | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,/.exec(value)
  return match?.[1]
}
