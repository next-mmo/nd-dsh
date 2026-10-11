/**
 * Pure tic-tac-toe game logic for the ND 3D Tic-Tac-Toe web view.
 *
 * Plain JavaScript on purpose: this file ships inside the package and runs
 * unbuilt in the sandboxed web view, so the repository's unit tests import
 * the exact artifact the game plays with (typed via game-core.d.ts). Board
 * cells are index 0..8 in reading order:
 *
 *   0 | 1 | 2
 *   ---------
 *   3 | 4 | 5
 *   ---------
 *   6 | 7 | 8
 */

export const EMPTY = ''

export const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
]

export function emptyBoard() {
  return Array(9).fill(EMPTY)
}

export function opponentOf(player) {
  return player === 'X' ? 'O' : 'X'
}

export function applyMove(board, index, player) {
  const next = board.slice()
  next[index] = player
  return next
}

export function winnerOf(board) {
  for (const line of WIN_LINES) {
    const [a, b, c] = line
    if (board[a] !== EMPTY && board[a] === board[b] && board[a] === board[c]) {
      return { player: board[a], line }
    }
  }
  return null
}

export function availableMoves(board) {
  return board.flatMap((cell, index) => (cell === EMPTY ? [index] : []))
}

export function outcomeOf(board) {
  const win = winnerOf(board)
  if (win) return { status: 'won', player: win.player, line: win.line }
  if (isFull(board)) return { status: 'draw', player: EMPTY, line: null }
  return { status: 'playing', player: EMPTY, line: null }
}

function isFull(board) {
  return board.every((cell) => cell !== EMPTY)
}

/**
 * Perfect play via exhaustive minimax. Every tic-tac-toe tree fits easily in
 * memory-time, so "hard" is literally unbeatable.
 */
export function bestMove(board, ai = 'O') {
  const human = opponentOf(ai)
  let bestScore = -Infinity
  let bestChoice = -1
  // Shuffle among equally good moves so the opening does not repeat verbatim.
  for (const move of shuffled(availableMoves(board))) {
    const score = minimaxScore(applyMove(board, move, ai), ai, human, human, 1)
    if (score > bestScore) {
      bestScore = score
      bestChoice = move
    }
  }
  return bestChoice
}

function minimaxScore(board, ai, human, turn, depth) {
  const outcome = outcomeOf(board)
  if (outcome.status === 'won') return outcome.player === ai ? 10 - depth : depth - 10
  if (outcome.status === 'draw') return 0
  const moves = availableMoves(board)
  if (turn === ai) {
    let best = -Infinity
    for (const move of moves) {
      best = Math.max(best, minimaxScore(applyMove(board, move, ai), ai, human, human, depth + 1))
    }
    return best
  }
  let best = Infinity
  for (const move of moves) {
    best = Math.min(best, minimaxScore(applyMove(board, move, human), ai, human, ai, depth + 1))
  }
  return best
}

/**
 * Casual play: always takes an immediate win, always blocks an immediate
 * loss, otherwise moves at random. Beatable on purpose.
 */
export function easyMove(board, ai = 'O') {
  const moves = availableMoves(board)
  if (moves.length === 0) return -1
  const human = opponentOf(ai)
  for (const player of [ai, human]) {
    for (const move of moves) {
      if (winnerOf(applyMove(board, move, player))) return move
    }
  }
  return moves[Math.floor(Math.random() * moves.length)]
}

function shuffled(values) {
  const out = values.slice()
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
