/**
 * Type surface of the shipped package script `ui/sunburst.js`. The package
 * stays plain JavaScript so it runs unbuilded inside the sandboxed web view;
 * this declaration keeps the repository-side unit tests type-checked.
 */

export interface DiskNode {
  /** Display name; aggregate buckets carry the "(other)" label. */
  n: string
  /** Aggregated size in bytes. */
  s: number
  /** 0 = directory, 1 = file, 2 = aggregate bucket (not actionable). */
  k: 0 | 1 | 2
  c?: DiskNode[]
  count?: number
}

export interface ArcSegment {
  node: DiskNode
  names: string[]
  depth: 0 | 1
  startAngle: number
  endAngle: number
}

export interface ChildRow {
  name: string
  size: number
  kind: 'dir' | 'file' | 'other'
  count: number
  path: string | null
}

export declare function formatBytes(bytes: number): string
export declare function otherCount(node: DiskNode | null | undefined): number
export declare function isActionable(node: DiskNode | null | undefined): boolean
export declare function absolutePath(rootPath: string, names: string[]): string | null
export declare function layoutArcs(focusNode: DiskNode, focusNames?: string[]): ArcSegment[]
export declare function hitTestArc(segments: ArcSegment[], angle: number, depth: number): ArcSegment | null
export declare function childRows(focusNode: DiskNode, rootPath: string, focusNames: string[]): ChildRow[]
export declare function nodeAtPath(rootNode: DiskNode, names: string[]): DiskNode | null
export declare function removeNodeAt(rootNode: DiskNode, names: string[]): boolean
