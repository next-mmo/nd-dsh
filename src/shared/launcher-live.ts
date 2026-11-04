/**
 * Live launcher state: everything currently alive that the Quick Launcher can
 * jump back into — running chats and agent runs, background keep-alive views,
 * open browser tabs — plus the saved workspace folders the user can switch to.
 *
 * The main process aggregates this snapshot from engines, the harness, the
 * browser platform, and the workspace registry; keep-alive views are owned by
 * the main-window renderer and arrive through a bounded report.
 */

import { asNdContext, isNdContext, type NdContext } from './nd-context.js'

export type LauncherLiveItemKind = 'chat' | 'run' | 'keepalive' | 'tab'

export interface LauncherLiveItem {
  id: string
  kind: LauncherLiveItemKind
  title: string
  /** Short right-side label: Chat, Agent, Background, Tab. */
  status: string
  context?: NdContext
  sessionId?: string
  runId?: string
  viewKey?: string
  tabId?: string
  url?: string
  updatedAt?: number
}

/** One alive web view retained by the extension keep-alive manager. */
export interface LauncherKeepaliveView {
  key: string
  extensionId: string
  viewId: string
  title: string
  context: NdContext
  backgrounded: boolean
}

export interface LauncherSavedWorkspace {
  id: string
  name: string
  root: string
  lastOpenedAt?: number
}

export interface LauncherWorkspaceView {
  activeRoot: string
  activeId?: string
  saved: LauncherSavedWorkspace[]
}

export interface LauncherLiveState {
  version: 1
  items: LauncherLiveItem[]
  workspace: LauncherWorkspaceView
  updatedAt: number
}

export interface LauncherDesktopApi {
  /** Snapshot for the launcher's Active and Workspaces groups; polled while open. */
  live(): Promise<LauncherLiveState>
  /** Main-window renderer publishes its retained extension views. */
  reportKeepalive(views: LauncherKeepaliveView[]): Promise<void>
}

const MAX_REPORTED_VIEWS = 32

function boundedText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

/** The report is renderer-owned, so it stays bounded and shape-checked in main. */
export function asLauncherKeepaliveReport(value: unknown): LauncherKeepaliveView[] {
  if (!Array.isArray(value)) return []
  const views: LauncherKeepaliveView[] = []
  for (const entry of value.slice(0, MAX_REPORTED_VIEWS)) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const key = boundedText(record.key, 256)
    const extensionId = boundedText(record.extensionId, 128)
    const viewId = boundedText(record.viewId, 128)
    const title = boundedText(record.title, 200)
    if (!key || !extensionId || !viewId || !title || !isNdContext(record.context)) continue
    views.push({
      key,
      extensionId,
      viewId,
      title,
      context: asNdContext(record.context),
      backgrounded: record.backgrounded === true,
    })
  }
  return views
}
