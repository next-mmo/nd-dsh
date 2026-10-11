import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

export type TicTacToeOutcome = 'win' | 'loss' | 'draw'

/** Host-side validation for bridge inputs: the broker relays, the host checks. */
export function asTicTacToeOutcome(value: unknown): TicTacToeOutcome {
  if (value === 'win' || value === 'loss' || value === 'draw') return value
  throw new Error('Outcome must be win, loss, or draw')
}

export interface TicTacToeStats {
  wins: number
  losses: number
  draws: number
  /** Consecutive wins; a draw keeps it, a loss clears it. */
  streak: number
  bestStreak: number
  updatedAt: number
}

interface Snapshot {
  version: 1
  stats: TicTacToeStats
}

const DEFAULTS: TicTacToeStats = { wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0, updatedAt: 0 }

/**
 * Durable scoreboard for the 3D Tic-Tac-Toe web view. One JSON file in
 * userData, written atomically; a corrupt file falls back to defaults because
 * a game scoreboard is never worth failing an extension view over.
 */
export class TicTacToeStatsStore {
  private loaded = false
  private value: TicTacToeStats = { ...DEFAULTS }
  private saveChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async get(): Promise<TicTacToeStats> {
    await this.load()
    return structuredClone(this.value)
  }

  async record(outcome: TicTacToeOutcome): Promise<TicTacToeStats> {
    await this.load()
    if (outcome === 'win') {
      this.value.wins += 1
      this.value.streak += 1
      this.value.bestStreak = Math.max(this.value.bestStreak, this.value.streak)
    } else if (outcome === 'loss') {
      this.value.losses += 1
      this.value.streak = 0
    } else {
      this.value.draws += 1
    }
    this.value.updatedAt = Date.now()
    await this.persist()
    return structuredClone(this.value)
  }

  async reset(): Promise<TicTacToeStats> {
    await this.load()
    this.value = { ...DEFAULTS, updatedAt: Date.now() }
    await this.persist()
    return structuredClone(this.value)
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<Snapshot>
      if (parsed?.version === 1 && validStats(parsed.stats)) {
        this.value = { ...DEFAULTS, ...parsed.stats }
      }
    } catch {
      // Missing or unreadable: start from defaults.
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    const snapshot: Snapshot = { version: 1, stats: this.value }
    const payload = `${JSON.stringify(snapshot, null, 2)}\n`
    const operation = this.saveChain.catch(() => undefined).then(async () => {
      await fs.mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temp, payload, { encoding: 'utf8', mode: 0o600 })
        await fs.rename(temp, this.filePath)
      } catch (cause) {
        await fs.rm(temp, { force: true }).catch(() => undefined)
        throw cause
      }
    })
    this.saveChain = operation
    await operation
  }
}

function validStats(value: unknown): value is TicTacToeStats {
  if (!value || typeof value !== 'object') return false
  const stats = value as Partial<TicTacToeStats>
  return [stats.wins, stats.losses, stats.draws, stats.streak, stats.bestStreak, stats.updatedAt]
    .every((field) => typeof field === 'number' && Number.isFinite(field) && field >= 0)
}
