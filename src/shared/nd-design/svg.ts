import type { DesignDocument, DesignNode } from './model.js'

export function serializeDesignSvg(document: DesignDocument, assets: Record<string, string> = {}): string {
  const page = document.pages[0]
  if (!page) throw new Error('ND Pencil document has no page')
  const bounds = pageBounds(document)
  const width = Math.max(1, Math.ceil(bounds.width))
  const height = Math.max(1, Math.ceil(bounds.height))
  const body: string[] = []
  for (const id of page.children) renderNode(document, id, body, assets, 0)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${round(bounds.x)} ${round(bounds.y)} ${width} ${height}" role="img">`,
    `<title>${escapeXml(document.name)}</title>`,
    ...body,
    '</svg>',
    '',
  ].join('\n')
}

export function pageBounds(document: DesignDocument): { x: number; y: number; width: number; height: number } {
  const page = document.pages[0]
  if (!page || page.children.length === 0) return { x: 0, y: 0, width: 1440, height: 900 }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const id of page.children) {
    const node = document.nodes[id]
    if (!node || node.visible === false) continue
    minX = Math.min(minX, node.x)
    minY = Math.min(minY, node.y)
    maxX = Math.max(maxX, node.x + node.width)
    maxY = Math.max(maxY, node.y + node.height)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return { x: 0, y: 0, width: 1440, height: 900 }
  const margin = 40
  return {
    x: minX - margin,
    y: minY - margin,
    width: Math.max(1, maxX - minX + margin * 2),
    height: Math.max(1, maxY - minY + margin * 2),
  }
}

function renderNode(
  document: DesignDocument,
  id: string,
  output: string[],
  assets: Record<string, string>,
  depth: number,
): void {
  if (depth > 64) return
  const node = document.nodes[id]
  if (!node || node.visible === false) return
  const opacity = node.opacity === undefined || node.opacity === 1 ? '' : ` opacity="${round(node.opacity)}"`
  const stroke = node.stroke ? ` stroke="${escapeXml(node.stroke.color)}" stroke-width="${round(node.stroke.width)}"` : ''
  const fill = node.fill?.color ?? 'none'

  switch (node.type) {
    case 'frame': {
      output.push(`<g${opacity}>`)
      if (node.fill) output.push(`<rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" fill="${escapeXml(fill)}"${stroke}${radiusAttr(node)}/>`)
      if (node.clip) {
        const clipId = `clip-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
        output.push(`<clipPath id="${clipId}"><rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}"${radiusAttr(node)}/></clipPath>`)
        output.push(`<g clip-path="url(#${clipId})">`)
      }
      for (const child of node.children ?? []) renderNode(document, child, output, assets, depth + 1)
      if (node.clip) output.push('</g>')
      output.push('</g>')
      return
    }
    case 'group':
      output.push(`<g${opacity}>`)
      for (const child of node.children ?? []) renderNode(document, child, output, assets, depth + 1)
      output.push('</g>')
      return
    case 'rect':
      output.push(`<rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" fill="${escapeXml(fill)}"${stroke}${radiusAttr(node)}${opacity}/>`)
      return
    case 'ellipse':
      output.push(`<ellipse cx="${round(node.x + node.width / 2)}" cy="${round(node.y + node.height / 2)}" rx="${round(node.width / 2)}" ry="${round(node.height / 2)}" fill="${escapeXml(fill)}"${stroke}${opacity}/>`)
      return
    case 'line':
      output.push(`<line x1="${round(node.x)}" y1="${round(node.y)}" x2="${round(node.x + node.width)}" y2="${round(node.y + node.height)}" fill="none"${stroke || ' stroke="#18181b" stroke-width="1"'}${opacity}/>`)
      return
    case 'text':
      renderText(node, output, opacity)
      return
    case 'image': {
      const href = node.src ? assets[node.src] ?? (node.src.startsWith('data:') ? node.src : undefined) : undefined
      if (href) {
        output.push(`<image x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" href="${escapeXml(href)}" preserveAspectRatio="${node.fit === 'fill' ? 'none' : node.fit === 'contain' ? 'xMidYMid meet' : 'xMidYMid slice'}"${opacity}/>`)
      } else {
        output.push(`<rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" fill="#e4e4e7"${opacity}/>`)
      }
      return
    }
  }
}

function renderText(node: DesignNode, output: string[], opacity: string): void {
  const text = node.text ?? ''
  const size = node.fontSize ?? 16
  const lineHeight = (node.lineHeight ?? 1.3) * size
  const lines = text.split('\n')
  const align = node.align === 'center' ? 'middle' : node.align === 'right' ? 'end' : 'start'
  const x = node.align === 'center' ? node.x + node.width / 2 : node.align === 'right' ? node.x + node.width : node.x
  output.push(
    `<text x="${round(x)}" y="${round(node.y + size)}" fill="${escapeXml(node.color ?? '#18181b')}" font-family="${escapeXml(node.fontFamily ?? 'Inter')}" font-size="${round(size)}" font-weight="${round(node.fontWeight ?? 400)}" text-anchor="${align}"${opacity}>`,
  )
  for (const [index, line] of lines.entries()) {
    output.push(`<tspan x="${round(x)}" dy="${index === 0 ? 0 : round(lineHeight)}">${escapeXml(line)}</tspan>`)
  }
  output.push('</text>')
}

function radiusAttr(node: DesignNode): string {
  return node.cornerRadius && node.cornerRadius > 0 ? ` rx="${round(node.cornerRadius)}"` : ''
}

function round(value: number): string {
  return String(Math.round(value * 100) / 100)
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
