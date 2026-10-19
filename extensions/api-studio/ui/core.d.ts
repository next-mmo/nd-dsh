export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
export type BodyMode = 'none' | 'json' | 'text' | 'form' | 'multipart'
export type AuthType = 'none' | 'bearer' | 'basic' | 'apikey'

export declare const HTTP_METHODS: readonly HttpMethod[]
export declare const BODY_MODES: readonly BodyMode[]
export declare const AUTH_TYPES: readonly AuthType[]

export interface StudioRow {
  id: string
  key: string
  value: string
  enabled: boolean
}

export interface StudioVariable extends StudioRow {
  secret: boolean
}

export interface StudioAuth {
  type: AuthType
  token: string
  username: string
  password: string
  key: string
  value: string
  addTo: 'header' | 'query'
}

export interface StudioBody {
  mode: BodyMode
  text: string
  fields: StudioRow[]
}

export interface StudioRequest {
  id: string
  name: string
  method: HttpMethod
  url: string
  pathVars: StudioRow[]
  params: StudioRow[]
  headers: StudioRow[]
  body: StudioBody
  auth: StudioAuth
  specId?: string
  operationId?: string
}

export interface StudioCollection {
  id: string
  name: string
  requests: StudioRequest[]
}

export interface StudioEnvironment {
  id: string
  name: string
  variables: StudioVariable[]
}

export interface StudioHistoryEntry {
  id: string
  at: number
  environmentId: string | null
  method: HttpMethod
  url: string
  status: number
  statusText: string
  durationMs: number
  bytes: number
  request: StudioRequest
}

export interface StudioWorkspace {
  version: 1
  collections: StudioCollection[]
  environments: StudioEnvironment[]
  activeEnvironmentId: string | null
  history: StudioHistoryEntry[]
}

export interface PreparedRequest {
  url: string
  method: HttpMethod
  headers: { name: string; value: string }[]
  body?: string
  missing: string[]
}

export interface SpecParameter {
  name?: string
  in?: string
  required?: boolean
  example?: unknown
  schema?: Record<string, unknown>
}

export interface SpecOperation {
  id: string
  method: HttpMethod
  path: string
  summary: string
  description: string
  tags: string[]
  operationId: string
  deprecated: boolean
  parameters: SpecParameter[]
  requestBody: { content?: Record<string, { example?: unknown; schema?: unknown }> } | null
  responses: Record<string, unknown>
  servers: { url?: string; variables?: Record<string, { default?: unknown }> }[]
  security: unknown
}

export interface NormalizedSpec {
  title: string
  version: string
  description: string
  openapi: string
  baseUrl: string
  servers: { url?: string }[]
  securitySchemes: Record<string, unknown>
  components: { schemas?: Record<string, Record<string, unknown>> }
  operations: SpecOperation[]
  raw: Record<string, unknown>
  id?: string
}

export declare function uid(prefix?: string): string
export declare function emptyBody(): StudioBody
export declare function emptyAuth(): StudioAuth
export declare function newRequest(overrides?: Partial<StudioRequest> & { body?: Partial<StudioBody>; auth?: Partial<StudioAuth> }): StudioRequest
export declare function normalizeRequest(input?: unknown): StudioRequest
export declare function newEnvironment(name?: string): StudioEnvironment
export declare function normalizeEnvironment(input?: unknown): StudioEnvironment
export declare function normalizeCollection(input?: unknown): StudioCollection
export declare function normalizeHistory(input?: unknown): StudioHistoryEntry
export declare function normalizeWorkspace(input?: unknown): StudioWorkspace
export declare function activeEnvironment(workspace: StudioWorkspace): StudioEnvironment | null
export declare function variableMap(workspace: StudioWorkspace): Map<string, string>
export declare function resolveTemplate(value: unknown, variables: Map<string, string>): { text: string; missing: string[] }
export declare function applyPathVars(url: string, pathVars: StudioRow[], variables: Map<string, string>, missing?: Set<string>): string
export declare function buildUrl(request: StudioRequest, variables?: Map<string, string>): { url: string; missing: string[] }
export declare function buildHeaders(request: StudioRequest, variables: Map<string, string>, bodyContentType?: string): { headers: { name: string; value: string }[]; missing: string[] }
export declare function prepareRequest(request: StudioRequest, variables?: Map<string, string>): PreparedRequest
export declare function redactRequestForHistory(request: StudioRequest): StudioRequest
export declare function historyEntry(input: { request: StudioRequest; environmentId?: string | null; response: { status: number; statusText: string; durationMs: number; bytes: number } }): StudioHistoryEntry
export declare function appendHistory(workspace: StudioWorkspace, entry: StudioHistoryEntry): StudioHistoryEntry[]
export declare function parseSpecDocument(text: string): Record<string, unknown>
export declare function dereference(document: unknown, value: unknown, depth?: number): unknown
export declare function normalizeSpec(document: unknown): NormalizedSpec
export declare function schemaExample(schema: unknown, components?: { schemas?: Record<string, Record<string, unknown>> }, depth?: number): unknown
export declare function contentExample(content: unknown, components?: { schemas?: Record<string, Record<string, unknown>> }): unknown
export declare function operationRequest(specification: NormalizedSpec, operation: SpecOperation, workspace: StudioWorkspace): StudioRequest
export declare function groupOperations(operations: SpecOperation[]): [string, SpecOperation[]][]
export declare function statusClass(status: number): string
export declare function formatBytes(bytes: number): string
export declare function formatTime(timestamp: number): string
export declare function prettyJson(text: unknown): unknown
export declare function toCurl(prepared: PreparedRequest): string
export declare function parseCurl(input: string): StudioRequest
export declare function importPostman(collection: unknown): { collections: StudioCollection[]; environments: StudioEnvironment[] }
export declare function findRequest(workspace: StudioWorkspace, requestId: string): { collection: StudioCollection; request: StudioRequest } | null
