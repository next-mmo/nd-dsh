import { describe, expect, it } from 'vitest'
import {
  absolutePath,
  childRows,
  formatBytes,
  hitTestArc,
  isActionable,
  layoutArcs,
  nodeAtPath,
  otherCount,
  removeNodeAt,
  type DiskNode,
} from '../extensions/disk-cleaner/ui/sunburst.js'

/**
 * These tests import the shipped package artifact directly, so the layout and
 * sizing the user actually sees is the code under test.
 */

const tree: DiskNode = {
  n: 'root',
  s: 3_000,
  k: 0,
  c: [
    {
      n: 'movies',
      s: 2_000,
      k: 0,
      c: [
        { n: 'feature.mkv', s: 1_500, k: 1 },
        { n: '(other)', s: 500, k: 2, count: 12 },
      ],
    },
    { n: 'notes.txt', s: 600, k: 1 },
    { n: 'music', s: 400, k: 0, c: [{ n: 'song.mp3', s: 400, k: 1 }] },
  ],
}

describe('disk-cleaner sunburst helpers', () => {
  it('formats bytes the way the UI reads them', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.00 KB')
    expect(formatBytes(4.5 * 1024 * 1024)).toBe('4.50 MB')
    expect(formatBytes(120 * 1024 * 1024 * 1024)).toBe('120 GB')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
  })

  it('lays inner-ring siblings out proportionally and tiling the full circle', () => {
    const segments = layoutArcs(tree, [])
    const inner = segments.filter((segment) => segment.depth === 0)
    expect(inner.map((segment) => segment.names[0])).toEqual(['movies', 'notes.txt', 'music'])
    // 3000 total, so sweeps are exact fractions of the circle.
    expect(inner[0]!.endAngle - inner[0]!.startAngle).toBeCloseTo((2_000 / 3_000) * Math.PI * 2, 6)
    expect(inner[1]!.endAngle - inner[1]!.startAngle).toBeCloseTo((600 / 3_000) * Math.PI * 2, 6)
    // Siblings tile the circle exactly: no gaps, no overlap.
    expect(inner[0]!.startAngle).toBeCloseTo(-Math.PI / 2, 6)
    expect(inner[2]!.endAngle).toBeCloseTo(-Math.PI / 2 + Math.PI * 2, 6)
  })

  it('keeps outer-ring children inside their parent sweep', () => {
    const segments = layoutArcs(tree, [])
    const outer = segments.filter((segment) => segment.depth === 1)
    const movies = segments.find((segment) => segment.depth === 0 && segment.names[0] === 'movies')!
    const feature = outer.find((segment) => segment.names[1] === 'feature.mkv')!
    const bucket = outer.find((segment) => segment.node.k === 2)!
    expect(feature.startAngle).toBeCloseTo(movies.startAngle, 6)
    expect(bucket.endAngle).toBeCloseTo(movies.endAngle, 6)
    expect(feature.endAngle).toBeCloseTo(bucket.startAngle, 6)
    // The bucket is visible but informational: it names no path.
    expect(isActionable(bucket.node)).toBe(false)
    expect(otherCount(bucket.node)).toBe(12)
  })

  it('hit-tests the segment under an angle at the right ring depth', () => {
    const segments = layoutArcs(tree, [])
    const inner = segments.filter((segment) => segment.depth === 0)
    const at = (segment: (typeof inner)[number], atEnd = false) =>
      atEnd ? segment.endAngle - 1e-6 : segment.startAngle + 1e-6
    expect(hitTestArc(segments, at(inner[0]!), 0)?.names).toEqual(['movies'])
    expect(hitTestArc(segments, at(inner[1]!), 0)?.names).toEqual(['notes.txt'])
    expect(hitTestArc(segments, at(inner[2]!), 0)?.names).toEqual(['music'])
    // The same angle resolves to the outer ring's own segment at depth 1…
    expect(hitTestArc(segments, at(inner[0]!), 1)?.names).toEqual(['movies', 'feature.mkv'])
    // …and nothing exists at a ring depth that is not drawn.
    expect(hitTestArc(segments, at(inner[0]!), 5)).toBeNull()
    expect(hitTestArc([], 0, 0)).toBeNull()
  })

  it('rebuilds absolute paths from names and refuses aggregate buckets', () => {
    expect(absolutePath('/scan/root', ['movies', 'feature.mkv'])).toBe('/scan/root/movies/feature.mkv')
    expect(absolutePath('/scan/root/', ['a'])).toBe('/scan/root/a')
    expect(absolutePath('/scan/root', [])).toBeNull()
    const rows = childRows(tree, '/scan/root', [])
    expect(rows.map((row) => row.name)).toEqual(['movies', 'notes.txt', 'music'])
    expect(rows[0]!.path).toBe('/scan/root/movies')
    expect(rows[0]!.kind).toBe('dir')
    expect(rows[1]!.path).toBe('/scan/root/notes.txt')
    const moviesRows = childRows(nodeAtPath(tree, ['movies'])!, '/scan/root', ['movies'])
    const bucket = moviesRows.find((row) => row.kind === 'other')!
    expect(bucket.path).toBeNull()
    expect(bucket.count).toBe(12)
  })

  it('resolves and removes nodes, keeping ancestor sizes honest', () => {
    expect(nodeAtPath(tree, ['movies'])?.s).toBe(2_000)
    expect(nodeAtPath(tree, ['missing'])).toBeNull()

    expect(removeNodeAt(tree, ['movies', 'feature.mkv'])).toBe(true)
    // The file is gone and every ancestor lost exactly its size.
    expect(nodeAtPath(tree, ['movies'])?.s).toBe(500)
    expect(tree.s).toBe(1_500)
    expect(childRows(nodeAtPath(tree, ['movies'])!, '/r', ['movies']).map((row) => row.name)).toEqual(['(other)'])
    // Removing again is a no-op failure, never a double subtraction.
    expect(removeNodeAt(tree, ['movies', 'feature.mkv'])).toBe(false)
    expect(tree.s).toBe(1_500)
    expect(removeNodeAt(tree, [])).toBe(false)
  })
})
