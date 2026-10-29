export const NINE_ROUTER_IPC = {
  state: 'router:9router-state',
  discover: 'router:9router-discover',
  connect: 'router:9router-connect',
  pickInstall: 'router:9router-install',
  prepare: 'router:9router-prepare',
  start: 'router:9router-start',
  stop: 'router:9router-stop',
  dashboardOpen: 'router:9router-dashboard-open',
  dashboardBounds: 'router:9router-dashboard-bounds',
  dashboardClose: 'router:9router-dashboard-close',
} as const

export interface NineRouterState {
  installed: boolean
  running: boolean
  managed: boolean
  trusted: boolean
  signingKeyConfigured: boolean
  endpoint?: string
  version?: string
  lastError?: string
}
export interface NineRouterModel {
  id: string
  ownedBy?: string
}
export interface NineRouterConnectInput {
  baseUrl: string
  apiKey: string
}
export interface NineRouterDesktopApi {
  nineRouterState(): Promise<NineRouterState>
  nineRouterDiscover(input: NineRouterConnectInput): Promise<NineRouterModel[]>
  nineRouterConnect(input: NineRouterConnectInput): Promise<{ connected: number; endpoint: string }>
  nineRouterInstall(): Promise<NineRouterState>
  nineRouterPrepare(password: string): Promise<NineRouterState>
  nineRouterStart(): Promise<NineRouterState>
  nineRouterStop(): Promise<NineRouterState>
  nineRouterDashboardOpen(baseUrl: string): Promise<void>
  nineRouterDashboardBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>
  nineRouterDashboardClose(): Promise<void>
}
