export interface DesignViewport {
  x: number
  y: number
  zoom: number
}

export interface DesignBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DesignPoint {
  x: number
  y: number
}

export const MIN_DESIGN_ZOOM = 0.05
export const MAX_DESIGN_ZOOM = 8

export function clampDesignZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_DESIGN_ZOOM, Math.max(MIN_DESIGN_ZOOM, value))
}

export function screenToCanvas(point: DesignPoint, viewport: DesignViewport): DesignPoint {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  }
}

export function canvasToScreen(point: DesignPoint, viewport: DesignViewport): DesignPoint {
  return {
    x: point.x * viewport.zoom + viewport.x,
    y: point.y * viewport.zoom + viewport.y,
  }
}

export function zoomAt(viewport: DesignViewport, nextZoom: number, screenPoint: DesignPoint): DesignViewport {
  const zoom = clampDesignZoom(nextZoom)
  const canvasPoint = screenToCanvas(screenPoint, viewport)
  return {
    zoom,
    x: screenPoint.x - canvasPoint.x * zoom,
    y: screenPoint.y - canvasPoint.y * zoom,
  }
}

export function fitDesignBounds(
  bounds: DesignBounds,
  stageWidth: number,
  stageHeight: number,
  padding = 72,
): DesignViewport {
  if (stageWidth <= 0 || stageHeight <= 0) return { x: 0, y: 0, zoom: 1 }
  const usableWidth = Math.max(1, stageWidth - padding * 2)
  const usableHeight = Math.max(1, stageHeight - padding * 2)
  const zoom = clampDesignZoom(Math.min(usableWidth / Math.max(1, bounds.width), usableHeight / Math.max(1, bounds.height), 1.5))
  return {
    zoom,
    x: (stageWidth - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (stageHeight - bounds.height * zoom) / 2 - bounds.y * zoom,
  }
}

export function panBy(viewport: DesignViewport, dx: number, dy: number): DesignViewport {
  return { ...viewport, x: viewport.x + dx, y: viewport.y + dy }
}

export function unionDesignBounds(items: DesignBounds[]): DesignBounds | null {
  if (items.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const item of items) {
    minX = Math.min(minX, item.x)
    minY = Math.min(minY, item.y)
    maxX = Math.max(maxX, item.x + item.width)
    maxY = Math.max(maxY, item.y + item.height)
  }
  return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) }
}

export function normalizeDragBounds(start: DesignPoint, end: DesignPoint): DesignBounds {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}
