import type { DesignDocument } from './model.js'
import { pageBounds } from './svg.js'

/**
 * Text injected into a design-originated agent prompt. The tool schema is the
 * source of truth; this context is intentionally compact and only tells the
 * model which document is live and what the user is looking at.
 */
export function buildDesignAgentContext(document: DesignDocument, selection: string[], documentPath?: string): string {
  const page = document.pages[0]
  const bounds = pageBounds(document)
  const selected = selection
    .map((id) => document.nodes[id])
    .filter((node): node is NonNullable<typeof node> => Boolean(node))
  const selectedText = selected.length === 0
    ? 'No nodes selected.'
    : selected
        .slice(0, 12)
        .map((node) => {
          const text = node.text ? ` text=${JSON.stringify(node.text.slice(0, 120))}` : ''
          return `${node.type} ${JSON.stringify(node.name)} id=${node.id} @ ${Math.round(node.x)},${Math.round(node.y)} ${Math.round(node.width)}x${Math.round(node.height)}${text}`
        })
        .join('; ')
  const frames = (page?.children ?? [])
    .map((id) => document.nodes[id])
    .filter((node): node is NonNullable<typeof node> => Boolean(node))
    .slice(0, 12)
    .map((node) => `${node.type} ${JSON.stringify(node.name)} id=${node.id} ${Math.round(node.width)}x${Math.round(node.height)}`)
    .join('; ')
  return [
    '## ND Pencil design mode',
    `You are editing the live ND Pencil canvas${documentPath ? ` at ${documentPath}` : ''}. Use the nd_design tool for every canvas change; never write the .op file with workspace tools.`,
    `Document: ${JSON.stringify(document.name)} · ${Object.keys(document.nodes).length} nodes · page ${Math.round(bounds.width)}x${Math.round(bounds.height)}.`,
    `Top-level: ${frames || 'empty canvas'}.`,
    `Selection: ${selectedText}`,
    'Commands: insert {parentId,index?,node,nodes?}, update {id,patch}, delete {ids}, reorder {id,parentId?,index}, group {ids}, ungroup {id}.',
    'Node fields: id,type(frame|group|rect|ellipse|line|text|image),name,x,y,width,height,opacity,visible,locked,children,clip,fill{type:"solid",color},stroke{color,width},cornerRadius,text,fontFamily,fontSize,fontWeight,lineHeight,align,color,src,fit.',
    'Coordinates are absolute. Insert a container before its children; insert child nodes with parentId. Keep frames visually coherent and use real text, not placeholders. Use nd_design action=state if you need the current outline.',
  ].join('\n')
}
