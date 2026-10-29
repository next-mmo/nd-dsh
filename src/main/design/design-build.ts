import type { DesignDocument } from '../../shared/nd-design/index.js'

export function buildDesignPrompt(document: DesignDocument, specPath: string, svgPath: string): string {
  const migration = document.meta?.migration
  return [
    `Build the ND Pencil design "${document.name}" into the active project's real application source.`,
    '',
    `Design spec: ${specPath}`,
    `Visual reference: ${svgPath}`,
    '',
    'The .op document is design intent, not production source. Read the spec, map its frames, layout, text, colors, and assets to the project’s real HTML/React/shadcn/native source, reuse existing components and design tokens, preserve accessibility and responsive behavior, start or reuse the project runtime, and verify the result in the live app.',
    'Do not replace production source with a detached generated mockup. Show the real source diff and verification result.',
    ...(migration
      ? ['', 'This design was imported from a legacy Freeform document. Treat dropped/approximated features as unavailable unless the spec includes them.']
      : []),
  ].join('\n')
}
