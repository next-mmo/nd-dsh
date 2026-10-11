import overviewSource from '../../../../docs/extensions/README.md?raw'
import authoringSource from '../../../../docs/extensions/authoring.md?raw'

/**
 * The guide is imported `?raw` so it is inlined into the renderer bundle, which
 * `electron-builder` ships via `out/**`. `docs/` itself is not packaged, so
 * reading it from disk would fail in an installed app.
 */

/**
 * `MarkdownLite` only linkifies `https?://` targets, so a repo-relative link
 * such as `[label](../../schema/nd-extension.schema.json)` would render as
 * literal bracket text. Drop the target and keep the label — labels that are
 * already backticked paths stay code spans, and prose labels read fine on their
 * own. Nothing is lost in-app because no relative target is reachable from a
 * packaged build.
 */
const REPO_LINK = /\[([^\]\n]*)\]\((?!https?:\/\/)[^)\s]*\)/g
const CODE_FENCE = /^\s*```/

function mapOutsideCodeFences(text: string, transform: (line: string) => string): string {
  let insideFence = false
  return text
    .split('\n')
    .map((line) => {
      if (CODE_FENCE.test(line)) {
        insideFence = !insideFence
        return line
      }
      return insideFence ? line : transform(line)
    })
    .join('\n')
}

export function inlineRepoLinks(markdown: string): string {
  return mapOutsideCodeFences(markdown, (line) => line.replace(REPO_LINK, (_match, label: string) => label))
}

export interface ExtensionGuideSection {
  id: string
  label: string
  text: string
}

export const EXTENSION_GUIDE_SECTIONS = [
  { id: 'overview', label: 'Overview', text: inlineRepoLinks(overviewSource) },
  { id: 'authoring', label: 'Authoring guide', text: inlineRepoLinks(authoringSource) },
] as const satisfies readonly ExtensionGuideSection[]
