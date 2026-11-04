export const MAX_DOCX_BYTES = 2 * 1024 * 1024
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024

let docxDepsPromise:
  | Promise<{
      mammoth: typeof import('mammoth')
      sanitizeHtml: typeof import('sanitize-html')
      unzipSync: typeof import('fflate').unzipSync
    }>
  | undefined

function loadDocxDeps() {
  docxDepsPromise ??= Promise.all([
    import('mammoth'),
    import('sanitize-html'),
    import('fflate'),
  ]).then(([mammothModule, sanitizeModule, fflateModule]) => ({
    mammoth: mammothModule.default ?? mammothModule,
    sanitizeHtml: (sanitizeModule.default ?? sanitizeModule) as typeof import('sanitize-html'),
    unzipSync: fflateModule.unzipSync,
  }))
  return docxDepsPromise
}

/** Semantic DOCX preview, with no Office engine, network access, or active HTML. */
export async function previewDocx(buffer: Buffer): Promise<{ content: string; previewHtml: string }> {
  if (buffer.length > MAX_DOCX_BYTES) throw new Error('DOCX preview supports files up to 2 MiB.')
  const { mammoth, sanitizeHtml, unzipSync } = await loadDocxDeps()
  let entries = 0
  let expandedBytes = 0
  let hasDocument = false
  // Inspect ZIP metadata without inflating anything before Mammoth reads it.
  unzipSync(buffer, { filter(entry) {
    entries += 1
    expandedBytes += entry.originalSize
    if (entries > 2000 || expandedBytes > MAX_EXPANDED_BYTES) {
      throw new Error('DOCX archive exceeds the preview limits.')
    }
    if (entry.name === 'word/document.xml') hasDocument = true
    return false
  } })
  if (!hasDocument) throw new Error('This file is not a DOCX document.')
  const result = await mammoth.convertToHtml({ buffer }, {
    externalFileAccess: false,
    includeEmbeddedStyleMap: false,
    // Images are intentionally omitted from the semantic preview.
    convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
  })
  const html = sanitizeHtml(result.value, {
    allowedTags: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'u', 's',
      'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br', 'blockquote', 'pre', 'code', 'sup', 'sub'],
    allowedAttributes: {},
  })
  if (Buffer.byteLength(html) > MAX_EXPANDED_BYTES) throw new Error('DOCX preview output exceeds the preview limits.')
  return {
    content: sanitizeHtml(html.replace(/<\/(?:p|h[1-6]|li|tr)>/g, '$&\n'), { allowedTags: [], allowedAttributes: {} }),
    previewHtml: '<!doctype html><html><head><meta charset="utf-8">'
      + '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;">'
      + '<style>body{font:16px/1.6 system-ui;margin:32px;color:#222;background:#fff;overflow-wrap:anywhere}'
      + 'table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px}pre{white-space:pre-wrap}</style>'
      + '</head><body>' + html + '</body></html>',
  }
}
