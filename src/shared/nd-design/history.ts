import type { DesignAnyCommand, DesignCommand } from './commands.js'

export type DesignChangeSource = 'human' | 'agent'

export interface DesignHistoryEntry {
  source: DesignChangeSource
  label: string
  forward: DesignCommand[]
  inverse: DesignAnyCommand[]
  changedIds: string[]
  createdAt: number
  bytes: number
}

interface DesignHistoryPeek {
  entry: DesignHistoryEntry
  commands: DesignAnyCommand[]
}

const MAX_HISTORY_BYTES = 64 * 1024 * 1024
const MAX_HISTORY_ENTRIES = 200

/**
 * Undo stores inverse command batches, never full documents. A large agent
 * batch can still carry a large deleted subtree, so both a byte and an entry
 * cap are enforced.
 */
export class DesignHistory {
  private entries: DesignHistoryEntry[] = []
  private cursor = -1
  private bytes = 0

  push(entry: Omit<DesignHistoryEntry, 'createdAt' | 'bytes'>): void {
    if (this.cursor < this.entries.length - 1) {
      const removed = this.entries.splice(this.cursor + 1)
      for (const item of removed) this.bytes -= item.bytes
    }
    const bytes = estimateBytes(entry)
    this.entries.push({ ...entry, createdAt: Date.now(), bytes })
    this.bytes += bytes
    this.cursor = this.entries.length - 1
    this.trim()
  }

  undo(source: DesignChangeSource): DesignHistoryPeek | null {
    const entry = this.entries[this.cursor]
    if (!entry) return null
    if (source === 'agent' && entry.source !== 'agent') {
      throw new Error('ND Agent can only undo its own newest design change')
    }
    return { entry, commands: entry.inverse }
  }

  redo(source: DesignChangeSource): DesignHistoryPeek | null {
    const entry = this.entries[this.cursor + 1]
    if (!entry) return null
    if (source === 'agent' && entry.source !== 'agent') {
      throw new Error('ND Agent can only redo its own design change')
    }
    return { entry, commands: entry.forward }
  }

  commitUndo(): void {
    if (this.cursor >= 0) this.cursor -= 1
  }

  commitRedo(): void {
    if (this.cursor < this.entries.length - 1) this.cursor += 1
  }

  canUndo(): boolean {
    return this.cursor >= 0
  }

  canRedo(): boolean {
    return this.cursor < this.entries.length - 1
  }

  clear(): void {
    this.entries = []
    this.cursor = -1
    this.bytes = 0
  }

  private trim(): void {
    while (this.entries.length > MAX_HISTORY_ENTRIES || this.bytes > MAX_HISTORY_BYTES) {
      const removed = this.entries.shift()
      if (!removed) break
      this.bytes -= removed.bytes
      this.cursor = Math.max(-1, this.cursor - 1)
    }
  }
}

function estimateBytes(entry: Omit<DesignHistoryEntry, 'createdAt' | 'bytes'>): number {
  try {
    return new TextEncoder().encode(JSON.stringify(entry)).length
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}
