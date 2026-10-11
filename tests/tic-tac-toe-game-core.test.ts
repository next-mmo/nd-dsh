import { describe, expect, it } from 'vitest'
import {
  applyMove,
  availableMoves,
  bestMove,
  easyMove,
  emptyBoard,
  opponentOf,
  outcomeOf,
  winnerOf,
} from '../extensions/tic-tac-toe/ui/game-core.js'

/**
 * These tests import the shipped package artifact directly, so the game the
 * user actually plays is the game under test.
 */

describe('tic-tac-toe game core', () => {
  it('detects winners along every line and reports the winning cells', () => {
    expect(winnerOf(['X', 'X', 'X', 'O', 'O', '', '', '', ''])?.line).toEqual([0, 1, 2])
    expect(winnerOf(['O', 'X', 'X', '', 'O', 'X', '', '', 'O'])?.line).toEqual([0, 4, 8])
    expect(winnerOf(['X', 'X', 'O', 'X', 'O', '', 'O', '', ''])?.line).toEqual([2, 4, 6])
    expect(winnerOf(emptyBoard())).toBeNull()
  })

  it('distinguishes playing, won, and draw outcomes', () => {
    expect(outcomeOf(emptyBoard()).status).toBe('playing')
    expect(outcomeOf(['X', 'X', 'X', 'O', 'O', '', '', '', ''])).toMatchObject({ status: 'won', player: 'X' })
    expect(outcomeOf(['X', 'X', 'O', 'O', 'O', 'X', 'X', 'O', 'X'])).toMatchObject({ status: 'draw' })
  })

  it('never lets the hard AI lose, for every human strategy', () => {
    // The AI is O and moves second; walk every X decision tree with the
    // deterministic hard AI answering — O must win or draw, never lose.
    const losses: number[][] = []
    const walk = (board: string[], xMoves: number[]): void => {
      const outcome = outcomeOf(board)
      if (outcome.status !== 'playing') {
        if (outcome.status === 'won' && outcome.player === 'X') losses.push(xMoves)
        return
      }
      for (const move of availableMoves(board)) {
        const afterX = applyMove(board, move, 'X')
        if (outcomeOf(afterX).status !== 'playing') {
          if (outcomeOf(afterX).status === 'won') losses.push([...xMoves, move])
          continue
        }
        const aiMove = bestMove(afterX, 'O')
        walk(applyMove(afterX, aiMove, 'O'), [...xMoves, move])
      }
    }
    walk(emptyBoard(), [])
    expect(losses).toEqual([])
  })

  it('takes an immediate win and blocks an immediate loss', () => {
    const board = ['O', 'O', '', 'X', 'X', '', '', '', '']
    expect(bestMove(board, 'O')).toBe(2)
    const blockable = ['X', 'X', '', '', 'O', '', '', '', '']
    expect(bestMove(blockable, 'O')).toBe(2)
    expect(easyMove(board, 'O')).toBe(2)
  })

  it('easy play still blocks an immediate threat', () => {
    const board = ['X', 'X', '', 'O', '', '', '', '', '']
    expect(easyMove(board, 'O')).toBe(2)
  })

  it('keeps player symmetry for the opponent helper', () => {
    expect(opponentOf('X')).toBe('O')
    expect(opponentOf('O')).toBe('X')
  })
})
