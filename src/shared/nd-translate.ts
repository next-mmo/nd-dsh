import { MAX_PASTED_IMAGE_BYTES, MAX_PASTED_IMAGE_LENGTH, MAX_PASTED_IMAGES } from './images.js'
export { isImageDataUrl, imageMediaType } from './images.js'

export const ND_TRANSLATE_ID = 'nd.translate'
export const ND_TRANSLATE_MAX_TEXT = 5_000
export const ND_TRANSLATE_MAX_IMAGES = MAX_PASTED_IMAGES
/** Pasted-image byte cap (~6 MB); the data-URL length cap below is its base64 inflation. */
export const ND_TRANSLATE_MAX_IMAGE_BYTES = MAX_PASTED_IMAGE_BYTES
export const ND_TRANSLATE_MAX_IMAGE_LENGTH = MAX_PASTED_IMAGE_LENGTH
export type NdBrowserTranslateProvider = 'google' | 'chatgpt' | 'gemini'
/** A Settings → Models LLM provider, referenced as `llm:<providerId>`. */
export type NdTranslateLlmProvider = `llm:${string}`
export type NdTranslateProvider = NdBrowserTranslateProvider | NdTranslateLlmProvider

export function isBrowserTranslateProvider(provider: string): provider is NdBrowserTranslateProvider {
  return provider === 'google' || provider === 'chatgpt' || provider === 'gemini'
}

export function isLlmProvider(provider: string): provider is NdTranslateLlmProvider {
  return provider.startsWith('llm:') && provider.length > 'llm:'.length
}

export function llmProviderId(provider: string): string {
  return provider.slice('llm:'.length)
}

export const ND_TRANSLATE_LANGUAGES = [
  { code: 'auto', label: 'Detect language' }, { code: 'en', label: 'English' },
  { code: 'km', label: 'Khmer' }, { code: 'zh-CN', label: 'Chinese (Simplified)' },
  { code: 'zh-TW', label: 'Chinese (Traditional)' }, { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' }, { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' }, { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' }, { code: 'pt', label: 'Portuguese' },
  { code: 'ru', label: 'Russian' }, { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' }, { code: 'vi', label: 'Vietnamese' },
  { code: 'id', label: 'Indonesian' }, { code: 'nl', label: 'Dutch' },
  { code: 'tr', label: 'Turkish' }, { code: 'uk', label: 'Ukrainian' },
] as const

export interface NdTranslateRequest {
  text: string
  sourceLanguage: string
  targetLanguage: string
  provider: NdTranslateProvider
  /** LLM provider model override; defaults to the provider's first model. */
  model?: string
  /** Pasted images as data URLs; LLM providers only, never persisted to history. */
  images?: string[]
}

export interface NdTranslateResult extends NdTranslateRequest {
  status: 'idle' | 'translated' | 'login-required' | 'challenge' | 'error' | 'busy'
  translatedText?: string
  message?: string
  browserTabId?: string
  url?: string
}

export interface NdTranslateHistoryEntry {
  id: string
  text: string
  translatedText: string
  sourceLanguage: string
  targetLanguage: string
  provider: NdTranslateProvider
  /** The LLM model that produced the translation, when one was selected. */
  model?: string
  createdAt: number
}

/** Trusted, provider-specific DOM observation; never a generic renderer script. */
export interface NdTranslatePage {
  url: string
  text?: string
  loginRequired?: boolean
  challenge?: boolean
  pending?: boolean
  complete?: boolean
  error?: string
}
