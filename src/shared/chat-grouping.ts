import type { ThreadEntry } from './chat-types.js'

export type ToolEntry = Extract<ThreadEntry, { kind: 'tool' }>

export type ToolGroupIcon = 'tool' | 'file' | 'skill' | 'read' | 'command' | 'search' | 'reasoning' | 'browser'

export type DisplayGroup =
  | { kind: 'entry'; key: string; entry: ThreadEntry }
  | { kind: 'tool-group'; key: string; tools: ToolEntry[]; label: string; icon: ToolGroupIcon }
  | { kind: 'reasoning-group'; key: string; text: string }
  | { kind: 'context-group'; key: string; blocks: ContextBlock[] }

export interface ContextBlock {
  source: string
  text: string
}

export const SKILL_TOOL_NAMES = new Set(['skill_load', 'skill_run', 'load_skill'])
export const FS_WRITE_TOOL_NAMES = new Set(['fs_edit', 'fs_write', 'fs_write_text', 'fs_create', 'fs_apply_patch', 'fs_str_replace', 'apply_patch'])
export const FS_READ_TOOL_NAMES = new Set(['fs_read', 'fs_read_text', 'fs_cat', 'read_file'])
export const COMMAND_TOOL_NAMES = new Set(['bash', 'shell', 'shell_command', 'run_command', 'execute_command', 'command execution'])
// Codex transcripts surface file edits under the opaque "file change" name.
const FILE_CHANGE_TOOL_NAMES = new Set(['file change'])
const SEARCH_NAME_PATTERN = /grep|glob|search|explore|find/i
const COMMAND_NAME_PATTERN = /command|shell|terminal|exec|bash/i

/**
 * Collapses consecutive tool entries into typed groups. When a run contains a
 * mix of ops the run is split into sub-groups so each gets an accurate label
 * ("Read 3 files" / "Ran 2 commands").
 */
export function groupEntries(entries: ThreadEntry[]): DisplayGroup[] {
  const groups: DisplayGroup[] = []
  let i = 0
  while (i < entries.length) {
    const entry = entries[i]
    if (!entry) { i++; continue }
    if (entry.kind === 'reasoning') {
      // Merge consecutive reasoning entries into one collapsible block.
      const texts: string[] = [entry.text]
      const key = entry.id
      i++
      while (i < entries.length && entries[i]?.kind === 'reasoning') {
        texts.push((entries[i] as Extract<ThreadEntry, { kind: 'reasoning' }>).text)
        i++
      }
      groups.push({ kind: 'reasoning-group', key, text: texts.join('\n') })
      continue
    }
    if (entry.kind === 'context') {
      // The Harness injects several context blocks per turn; merge them into a
      // single internal card instead of one row per block.
      const blocks: ContextBlock[] = [{ source: entry.source, text: entry.text }]
      const key = entry.id
      i++
      while (i < entries.length && entries[i]?.kind === 'context') {
        const next = entries[i] as Extract<ThreadEntry, { kind: 'context' }>
        blocks.push({ source: next.source, text: next.text })
        i++
      }
      groups.push({ kind: 'context-group', key, blocks })
      continue
    }
    if (entry.kind !== 'tool') {
      groups.push({ kind: 'entry', key: entry.id, entry })
      i++
      continue
    }
    // Collect a run of consecutive tool entries then sub-group by type.
    const toolRun: ToolEntry[] = []
    while (i < entries.length && entries[i]?.kind === 'tool') {
      toolRun.push(entries[i] as ToolEntry)
      i++
    }
    // Sub-group by category. Adjacent same-type tools stay together; type
    // changes produce a new group.
    const subGroupOf = (t: ToolEntry): ToolGroupIcon => {
      if (t.name.startsWith('browser.') || t.name === 'nd_browser_call') return 'browser'
      if (SKILL_TOOL_NAMES.has(t.name)) return 'skill'
      if (FS_WRITE_TOOL_NAMES.has(t.name) || FILE_CHANGE_TOOL_NAMES.has(t.name)) return 'file'
      if (FS_READ_TOOL_NAMES.has(t.name)) return 'read'
      if (COMMAND_TOOL_NAMES.has(t.name) || COMMAND_NAME_PATTERN.test(t.name)) return 'command'
      if (SEARCH_NAME_PATTERN.test(t.name)) return 'search'
      return 'tool'
    }
    let j = 0
    while (j < toolRun.length) {
      const icon = subGroupOf(toolRun[j]!)
      const batch: ToolEntry[] = []
      while (j < toolRun.length && subGroupOf(toolRun[j]!) === icon) {
        batch.push(toolRun[j]!)
        j++
      }
      const n = batch.length
      const label =
        icon === 'skill' ? `Loaded ${n} skill${n === 1 ? '' : 's'}`
        : icon === 'file' ? `Edited ${n} file${n === 1 ? '' : 's'}`
        : icon === 'read' ? `Read ${n} file${n === 1 ? '' : 's'}`
        : icon === 'browser' ? `${n} browser action${n === 1 ? '' : 's'}`
        : icon === 'command' ? `Ran ${n} command${n === 1 ? '' : 's'}`
        : icon === 'search' ? `Searched ${n} file${n === 1 ? '' : 's'}`
        : `Used ${n} tool${n === 1 ? '' : 's'}`
      groups.push({ kind: 'tool-group', key: batch[0]!.id, tools: batch, label, icon })
    }
  }
  return groups
}

/**
 * Best-effort human preview for a tool call: the command line for shell
 * execs, the target path for fs tools, otherwise undefined.
 */
export function toolPreview(t: ToolEntry): string | undefined {
  const args = t.args
  if (!args || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  const command = record.command
  if (typeof command === 'string' && command.trim()) return command.trim()
  if (Array.isArray(command) && command.every((part) => typeof part === 'string') && command.length > 0) {
    return command.join(' ')
  }
  const nested = record.arguments
  if (nested && typeof nested === 'object') {
    return toolPreview({ ...t, args: nested })
  }
  const path = record.path ?? record.file_path ?? record.filePath
  if (typeof path === 'string' && path.trim()) return path.trim()
  return undefined
}

export interface FileChangeInfo {
  path: string
  action: 'add' | 'edit' | 'delete' | 'unknown'
  added: number
  removed: number
}

/**
 * Parses a file-change tool's args into per-file change info. Codex passes
 * `files` as either a map of path → {add,remove} or a list of change objects.
 */
export function parseFileChanges(args: unknown): FileChangeInfo[] {
  if (!args || typeof args !== 'object') return []
  const record = args as Record<string, unknown>
  const files = record.files ?? record.changes
  const result: FileChangeInfo[] = []
  const pushEntry = (path: string, value: unknown): void => {
    let added = 0
    let removed = 0
    let action: FileChangeInfo['action'] = 'unknown'
    if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>
      if (typeof v.add === 'number') added = v.add
      if (typeof v.remove === 'number') removed = v.remove
      if (typeof v.added === 'number') added = v.added
      if (typeof v.removed === 'number') removed = v.removed
      if (typeof v.action === 'string') {
        if (v.action.includes('add') || v.action.includes('creat')) action = 'add'
        else if (v.action.includes('edit') || v.action.includes('modif')) action = 'edit'
        else if (v.action.includes('delet') || v.action.includes('remov')) action = 'delete'
      }
    }
    if (action === 'unknown') {
      if (added > 0 && removed === 0) action = 'add'
      else if (removed > 0 && added === 0) action = 'delete'
      else if (added > 0 || removed > 0) action = 'edit'
    }
    result.push({ path, action, added, removed })
  }
  if (files && typeof files === 'object' && !Array.isArray(files)) {
    for (const [path, value] of Object.entries(files as Record<string, unknown>)) {
      pushEntry(path, value)
    }
  } else if (Array.isArray(files)) {
    for (const item of files) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>
        const path = typeof rec.path === 'string' ? rec.path : typeof rec.file === 'string' ? rec.file : ''
        if (path) pushEntry(path, item)
      } else if (typeof item === 'string') {
        pushEntry(item, null)
      }
    }
  }
  return result
}

/** Totals across a list of file changes. */
export function sumFileChanges(changes: FileChangeInfo[]): { added: number; removed: number; files: number } {
  let added = 0
  let removed = 0
  for (const c of changes) {
    added += c.added
    removed += c.removed
  }
  return { added, removed, files: changes.length }
}
