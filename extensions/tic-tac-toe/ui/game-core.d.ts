/**
 * Type surface of the shipped package script `ui/game-core.js`. The package
 * stays plain JavaScript so it runs unbuilded inside the sandboxed web view;
 * this declaration keeps the repository-side unit tests type-checked.
 */

export declare const EMPTY: string
export declare const WIN_LINES: number[][]

export declare function emptyBoard(): string[]
export declare function opponentOf(player: string): string
export declare function applyMove(board: string[], index: number, player: string): string[]
export declare function winnerOf(board: string[]): { player: string; line: number[] } | null
export declare function availableMoves(board: string[]): number[]
export declare function outcomeOf(
  board: string[],
): { status: 'playing' | 'won' | 'draw'; player: string; line: number[] | null }
export declare function bestMove(board: string[], ai?: string): number
export declare function easyMove(board: string[], ai?: string): number
