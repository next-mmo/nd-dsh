/** Shared chat-attachment limits and text detection. */
export const MAX_CHAT_ATTACHMENTS = 20
export const MAX_RUN_FILE_BYTES = 10 * 1024 * 1024
export const MAX_RUN_FILE_LENGTH = Math.ceil(MAX_RUN_FILE_BYTES / 3) * 4
export const MAX_RUN_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENT_NAME_CHARS = 160
export const MAX_ATTACHMENT_RELATIVE_PATH_CHARS = 1_024
export const MAX_INLINE_TEXT_FILE_CHARS = 48_000
export const MAX_INLINE_TEXT_TOTAL_CHARS = 120_000

const TEXT_MEDIA_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/sql',
  'application/graphql',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-python',
  'application/x-ruby',
  'application/x-php',
  'application/x-perl',
  'application/x-lua',
  'application/x-httpd-php',
])

const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'mdx', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini',
  'cfg', 'conf', 'csv', 'tsv', 'log', 'html', 'htm', 'xhtml', 'css', 'scss', 'less', 'sass',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'py', 'rb', 'php', 'lua', 'pl', 'r',
  'go', 'rs', 'java', 'kt', 'kts', 'swift', 'cs', 'fs', 'fsx', 'c', 'h', 'cc', 'cpp', 'cxx',
  'hpp', 'hh', 'm', 'mm', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'graphql',
  'gql', 'xml', 'xsl', 'xslt', 'svg', 'vue', 'svelte', 'astro', 'env', 'gitignore', 'dockerfile',
])

export function isTextAttachment(mediaType: string, name: string): boolean {
  const normalizedType = mediaType.trim().toLowerCase()
  if (normalizedType.startsWith('text/')) return true
  if (TEXT_MEDIA_TYPES.has(normalizedType)) return true
  if (normalizedType.endsWith('+json') || normalizedType.endsWith('+xml')) return true
  const extension = fileExtension(name)
  return extension !== '' && TEXT_EXTENSIONS.has(extension)
}

export function fileExtension(name: string): string {
  const base = name.replaceAll('\\', '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : ''
}

export function attachmentMediaType(mediaType: string, name: string): string {
  const trimmed = mediaType.trim()
  if (/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(trimmed)) return trimmed.slice(0, 200)
  const extension = fileExtension(name)
  return extension ? `application/${extension}`.slice(0, 200) : 'application/octet-stream'
}

export function formatAttachmentBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
