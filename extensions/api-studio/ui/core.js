/**
 * API Studio pure logic: workspace normalization, variable and request
 * preparation, OpenAPI operation extraction, cURL/Postman import, and
 * redaction. No DOM and no bridge calls live here, so the rules are directly
 * unit-testable in Node.
 */
import { load as parseYaml } from './vendor/js-yaml.mjs'

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
export const BODY_MODES = ['none', 'json', 'text', 'form', 'multipart']
export const AUTH_TYPES = ['none', 'bearer', 'basic', 'apikey']

const MAX_HISTORY = 100
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'api-key',
])

export function uid(prefix = 'id') {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${random}`.slice(0, 64)
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function bool(value, fallback = true) {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return []
  return rows.filter((row) => row && typeof row === 'object').slice(0, 500).map((row) => ({
    id: typeof row.id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(row.id) ? row.id : uid('row'),
    key: str(row.key),
    value: str(row.value),
    enabled: bool(row.enabled),
  }))
}

export function emptyBody() {
  return { mode: 'none', text: '', fields: [] }
}

export function emptyAuth() {
  return { type: 'none', token: '', username: '', password: '', key: '', value: '', addTo: 'header' }
}

export function newRequest(overrides = {}) {
  return normalizeRequest({
    id: uid('req'),
    name: 'Untitled request',
    method: 'GET',
    url: '',
    ...overrides,
  })
}

export function normalizeRequest(input = {}) {
  const value = input && typeof input === 'object' ? input : {}
  const body = value.body && typeof value.body === 'object' ? value.body : {}
  const auth = value.auth && typeof value.auth === 'object' ? value.auth : {}
  const method = str(value.method, 'GET').toUpperCase()
  const bodyMode = BODY_MODES.includes(body.mode) ? body.mode : 'none'
  const authType = AUTH_TYPES.includes(auth.type) ? auth.type : 'none'
  const request = {
    id: typeof value.id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value.id) ? value.id : uid('req'),
    name: str(value.name, 'Untitled request') || 'Untitled request',
    method: HTTP_METHODS.includes(method) ? method : 'GET',
    url: str(value.url),
    pathVars: normalizeRows(value.pathVars),
    params: normalizeRows(value.params),
    headers: normalizeRows(value.headers),
    body: {
      mode: bodyMode,
      text: str(body.text),
      fields: normalizeRows(body.fields),
    },
    auth: {
      type: authType,
      token: str(auth.token),
      username: str(auth.username),
      password: str(auth.password),
      key: str(auth.key),
      value: str(auth.value),
      addTo: auth.addTo === 'query' ? 'query' : 'header',
    },
  }
  if (str(value.specId)) request.specId = str(value.specId)
  if (str(value.operationId)) request.operationId = str(value.operationId)
  return request
}

export function newEnvironment(name = 'New environment') {
  return { id: uid('env'), name, variables: [] }
}

export function normalizeEnvironment(input = {}) {
  const value = input && typeof input === 'object' ? input : {}
  return {
    id: typeof value.id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value.id) ? value.id : uid('env'),
    name: str(value.name, 'Environment') || 'Environment',
    variables: (Array.isArray(value.variables) ? value.variables : [])
      .slice(0, 200)
      .filter((row) => row && typeof row === 'object')
      .map((row) => ({
        id: typeof row.id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(row.id) ? row.id : uid('var'),
        key: str(row.key),
        value: str(row.value),
        enabled: bool(row.enabled),
        secret: bool(row.secret, false),
      })),
  }
}

export function normalizeCollection(input = {}) {
  const value = input && typeof input === 'object' ? input : {}
  return {
    id: typeof value.id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value.id) ? value.id : uid('col'),
    name: str(value.name, 'Collection') || 'Collection',
    requests: Array.isArray(value.requests) ? value.requests.slice(0, 500).map(normalizeRequest) : [],
  }
}

export function normalizeHistory(input = {}) {
  const value = input && typeof input === 'object' ? input : {}
  return {
    id: typeof value.id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value.id) ? value.id : uid('hist'),
    at: Number.isFinite(value.at) ? value.at : Date.now(),
    environmentId: typeof value.environmentId === 'string' ? value.environmentId : null,
    method: HTTP_METHODS.includes(str(value.method).toUpperCase()) ? str(value.method).toUpperCase() : 'GET',
    url: str(value.url),
    status: Number.isFinite(value.status) ? value.status : 0,
    statusText: str(value.statusText),
    durationMs: Number.isFinite(value.durationMs) ? value.durationMs : 0,
    bytes: Number.isFinite(value.bytes) ? value.bytes : 0,
    request: redactRequestForHistory(normalizeRequest(value.request)),
  }
}

export function normalizeWorkspace(input) {
  const value = input && typeof input === 'object' ? input : {}
  const environments = Array.isArray(value.environments) && value.environments.length
    ? value.environments.slice(0, 50).map(normalizeEnvironment)
    : [newEnvironment('Local')]
  // Explicit null means "No environment"; a missing id falls back to the first.
  let activeEnvironmentId
  if (typeof value.activeEnvironmentId === 'string') {
    activeEnvironmentId = environments.some((environment) => environment.id === value.activeEnvironmentId)
      ? value.activeEnvironmentId
      : environments[0]?.id ?? null
  } else if (value.activeEnvironmentId === null) {
    activeEnvironmentId = null
  } else {
    activeEnvironmentId = environments[0]?.id ?? null
  }
  return {
    version: 1,
    collections: Array.isArray(value.collections) ? value.collections.slice(0, 100).map(normalizeCollection) : [],
    environments,
    activeEnvironmentId,
    history: Array.isArray(value.history) ? value.history.slice(0, MAX_HISTORY).map(normalizeHistory) : [],
  }
}

export function activeEnvironment(workspace) {
  return workspace?.environments?.find((environment) => environment.id === workspace.activeEnvironmentId) ?? null
}

export function variableMap(workspace) {
  const map = new Map()
  const environment = activeEnvironment(workspace)
  for (const row of environment?.variables ?? []) {
    if (row.enabled !== false && row.key.trim()) map.set(row.key.trim(), row.value)
  }
  return map
}

export function resolveTemplate(value, variables) {
  const missing = new Set()
  const text = String(value ?? '').replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (match, name) => {
    if (variables.has(name)) return variables.get(name)
    missing.add(name)
    return match
  })
  return { text, missing: [...missing] }
}

function resolveWith(value, variables, missing) {
  const resolved = resolveTemplate(value, variables)
  for (const name of resolved.missing) missing.add(name)
  return resolved.text
}

export function applyPathVars(url, pathVars, variables, missing = new Set()) {
  let output = String(url ?? '')
  for (const row of pathVars ?? []) {
    if (row.enabled === false || !row.key.trim()) continue
    const value = encodeURIComponent(resolveWith(row.value, variables, missing))
    output = output.split(`{${row.key.trim()}}`).join(value)
    output = output.split(`{{${row.key.trim()}}}`).join(value)
  }
  return output
}

export function buildUrl(request, variables = new Map()) {
  const missing = new Set()
  let url = resolveWith(request.url, variables, missing).trim()
  url = applyPathVars(url, request.pathVars, variables, missing)
  const query = []
  for (const row of request.params ?? []) {
    if (row.enabled === false || !row.key.trim()) continue
    query.push([
      resolveWith(row.key, variables, missing).trim(),
      resolveWith(row.value, variables, missing),
    ])
  }
  const auth = request.auth ?? {}
  if (auth.type === 'apikey' && auth.addTo === 'query' && str(auth.key).trim()) {
    query.push([resolveWith(auth.key, variables, missing).trim(), resolveWith(auth.value, variables, missing)])
  }
  if (query.length) {
    const encoded = query
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&')
    const hashIndex = url.indexOf('#')
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
    const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url
    url = `${base}${base.includes('?') ? '&' : '?'}${encoded}${hash}`
  }
  return { url, missing: [...missing] }
}

function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function multipartBody(fields, variables, missing) {
  const boundary = `----NDApiStudio${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
  const lines = []
  for (const row of fields ?? []) {
    if (row.enabled === false || !row.key.trim()) continue
    const name = row.key.trim().replace(/"/g, '%22')
    lines.push(`--${boundary}`)
    lines.push(`Content-Disposition: form-data; name="${name}"`)
    lines.push('')
    lines.push(resolveWith(row.value, variables, missing))
  }
  lines.push(`--${boundary}--`)
  lines.push('')
  return { body: lines.join('\r\n'), contentType: `multipart/form-data; boundary=${boundary}` }
}

export function buildHeaders(request, variables, bodyContentType) {
  const missing = new Set()
  const headers = []
  for (const row of request.headers ?? []) {
    if (row.enabled === false || !row.key.trim()) continue
    headers.push({
      name: resolveWith(row.key, variables, missing).trim(),
      value: resolveWith(row.value, variables, missing),
    })
  }
  const has = (name) => headers.some((header) => header.name.toLowerCase() === name)
  const auth = request.auth ?? {}
  if (auth.type === 'bearer' && !has('authorization')) {
    headers.push({ name: 'Authorization', value: `Bearer ${resolveWith(auth.token, variables, missing)}` })
  }
  if (auth.type === 'basic' && !has('authorization')) {
    const credentials = `${resolveWith(auth.username, variables, missing)}:${resolveWith(auth.password, variables, missing)}`
    headers.push({ name: 'Authorization', value: `Basic ${base64Utf8(credentials)}` })
  }
  if (auth.type === 'apikey' && auth.addTo !== 'query' && str(auth.key).trim() && !has(str(auth.key).toLowerCase())) {
    headers.push({
      name: resolveWith(auth.key, variables, missing).trim(),
      value: resolveWith(auth.value, variables, missing),
    })
  }
  if (bodyContentType && !has('content-type')) headers.push({ name: 'Content-Type', value: bodyContentType })
  return { headers, missing: [...missing] }
}

export function prepareRequest(request, variables = new Map()) {
  const missing = new Set()
  const built = buildUrl(request, variables)
  for (const name of built.missing) missing.add(name)

  const body = request.body ?? emptyBody()
  let bodyText
  let bodyContentType
  if (body.mode === 'json') {
    bodyText = resolveWith(body.text, variables, missing)
    bodyContentType = 'application/json'
  } else if (body.mode === 'text') {
    bodyText = resolveWith(body.text, variables, missing)
    bodyContentType = 'text/plain; charset=utf-8'
  } else if (body.mode === 'form') {
    const params = new URLSearchParams()
    for (const row of body.fields ?? []) {
      if (row.enabled === false || !row.key.trim()) continue
      params.append(resolveWith(row.key, variables, missing).trim(), resolveWith(row.value, variables, missing))
    }
    bodyText = params.toString()
    bodyContentType = 'application/x-www-form-urlencoded'
  } else if (body.mode === 'multipart') {
    const multipart = multipartBody(body.fields, variables, missing)
    bodyText = multipart.body
    bodyContentType = multipart.contentType
  }

  const headerResult = buildHeaders(request, variables, bodyContentType)
  for (const name of headerResult.missing) missing.add(name)

  return {
    url: built.url,
    method: request.method,
    headers: headerResult.headers,
    body: bodyText,
    missing: [...missing],
  }
}

export function redactRequestForHistory(request) {
  const auth = request.auth ?? emptyAuth()
  return {
    ...request,
    auth: { ...auth, token: '', password: '', value: '' },
    headers: (request.headers ?? []).filter((header) => !SENSITIVE_HEADERS.has(header.key.trim().toLowerCase())),
    params: auth.type === 'apikey' && auth.addTo === 'query'
      ? (request.params ?? []).map((param) => param.key === auth.key ? { ...param, value: '' } : param)
      : request.params ?? [],
  }
}

export function historyEntry({ request, environmentId, response }) {
  return normalizeHistory({
    id: uid('hist'),
    at: Date.now(),
    environmentId: environmentId ?? null,
    method: request.method,
    url: request.url,
    status: response.status,
    statusText: response.statusText,
    durationMs: response.durationMs,
    bytes: response.bytes,
    request: redactRequestForHistory(request),
  })
}

export function appendHistory(workspace, entry) {
  return [entry, ...workspace.history.filter((item) => item.id !== entry.id)].slice(0, MAX_HISTORY)
}

export function parseSpecDocument(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) throw new Error('The specification is empty')
  if (trimmed[0] === '{' || trimmed[0] === '[') return JSON.parse(trimmed)
  try {
    return parseYaml(trimmed)
  } catch (error) {
    throw new Error(`The specification is not valid YAML or JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function decodePointerSegment(segment) {
  return decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~')
}

export function dereference(document, value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 20) return value
  if (typeof value.$ref !== 'string' || !value.$ref.startsWith('#/')) return value
  let node = document
  for (const segment of value.$ref.slice(2).split('/')) {
    node = node?.[decodePointerSegment(segment)]
  }
  return dereference(document, node, depth + 1)
}

function serverUrl(specification, servers) {
  const server = Array.isArray(servers) ? servers[0] : null
  if (!server || typeof server.url !== 'string') return ''
  return server.url.replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, name) => {
    const variable = server.variables?.[name]
    return variable && variable.default !== undefined ? String(variable.default) : match
  })
}

export function normalizeSpec(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('The document is not an OpenAPI object')
  }
  const openapi = String(document.openapi ?? '')
  const swagger = String(document.swagger ?? '')
  const isOpenApi3 = /^3\./.test(openapi)
  const isSwagger2 = /^2\./.test(swagger)
  if (!isOpenApi3 && !isSwagger2) {
    throw new Error('API Studio supports OpenAPI 3.0, OpenAPI 3.1, and Swagger 2.0 documents')
  }

  const legacyServers = isSwagger2
    ? [{ url: `${document.schemes?.[0] ?? 'http'}://${document.host ?? 'localhost'}${document.basePath ?? ''}` }]
    : document.servers
  const baseUrl = serverUrl(document, legacyServers)
  const operations = []

  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (!item || typeof item !== 'object') continue
    const sharedParameters = Array.isArray(item.parameters) ? item.parameters : []
    for (const method of HTTP_METHODS) {
      const operation = item[method.toLowerCase()]
      if (!operation || typeof operation !== 'object') continue
      const parameters = [...sharedParameters, ...(Array.isArray(operation.parameters) ? operation.parameters : [])]
        .map((parameter) => dereference(document, parameter))
        .filter(Boolean)
      operations.push({
        id: `${method} ${path}`,
        method,
        path,
        summary: str(operation.summary),
        description: str(operation.description),
        tags: Array.isArray(operation.tags) && operation.tags.length ? operation.tags.map(String) : ['default'],
        operationId: str(operation.operationId),
        deprecated: operation.deprecated === true,
        parameters,
        requestBody: dereference(document, operation.requestBody) ?? null,
        responses: operation.responses && typeof operation.responses === 'object'
          ? Object.fromEntries(Object.entries(operation.responses).map(([status, value]) => [status, dereference(document, value)]))
          : {},
        servers: Array.isArray(operation.servers) ? operation.servers : legacyServers,
        security: operation.security ?? document.security ?? [],
      })
    }
  }

  operations.sort((left, right) => left.path.localeCompare(right.path)
    || HTTP_METHODS.indexOf(left.method) - HTTP_METHODS.indexOf(right.method))

  return {
    title: str(document.info?.title, 'API'),
    version: str(document.info?.version),
    description: str(document.info?.description),
    openapi: openapi || `Swagger ${swagger}`,
    baseUrl,
    servers: Array.isArray(legacyServers) ? legacyServers : [],
    securitySchemes: document.components?.securitySchemes ?? document.securityDefinitions ?? {},
    components: isSwagger2 ? { schemas: document.definitions ?? {} } : document.components ?? {},
    operations,
    raw: document,
  }
}

export function schemaExample(schema, components = {}, depth = 0) {
  if (schema === undefined || schema === null || typeof schema !== 'object') return null
  if (depth > 6) return null
  if (schema.$ref && typeof schema.$ref === 'string') {
    const name = schema.$ref.split('/').pop()
    const target = components.schemas?.[name]
    return target ? schemaExample(target, components, depth + 1) : {}
  }
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
  if (Array.isArray(schema.allOf)) {
    const merged = {}
    for (const part of schema.allOf) {
      const example = schemaExample(part, components, depth + 1)
      if (example && typeof example === 'object' && !Array.isArray(example)) Object.assign(merged, example)
    }
    return merged
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) return schemaExample(schema.oneOf[0], components, depth + 1)
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) return schemaExample(schema.anyOf[0], components, depth + 1)
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== 'null') : schema.type
  if (type === 'object' || schema.properties) {
    const output = {}
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      output[name] = schemaExample(property, components, depth + 1)
    }
    return output
  }
  if (type === 'array') return [schemaExample(schema.items, components, depth + 1)]
  if (type === 'integer' || type === 'number') return 0
  if (type === 'boolean') return false
  if (schema.format === 'date') return '2026-01-01'
  if (schema.format === 'date-time') return '2026-01-01T00:00:00Z'
  if (schema.format === 'email') return 'user@example.com'
  if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000000'
  return 'string'
}

export function contentExample(content, components) {
  if (!content || typeof content !== 'object') return null
  const entry = content['application/json'] ?? Object.values(content)[0]
  if (!entry) return null
  if (entry.example !== undefined) return entry.example
  if (entry.schema) return schemaExample(entry.schema, components)
  return null
}

function parameterValue(parameter) {
  if (parameter.example !== undefined) return parameter.example
  if (parameter.schema?.example !== undefined) return parameter.schema.example
  if (parameter.schema?.default !== undefined) return String(parameter.schema.default)
  if (Array.isArray(parameter.schema?.enum) && parameter.schema.enum.length) return String(parameter.schema.enum[0])
  return ''
}

export function operationRequest(specification, operation, workspace) {
  const variables = variableMap(workspace)
  const server = serverUrl(specification.raw, operation.servers) || specification.baseUrl
  const useEnvironmentBase = variables.has('baseUrl')
  const base = useEnvironmentBase ? '{{baseUrl}}' : server.replace(/\/$/, '')
  const pathVars = []
  const params = []
  const headers = []
  for (const parameter of operation.parameters) {
    if (!parameter || typeof parameter.name !== 'string') continue
    if (parameter.in === 'path') {
      pathVars.push({ id: uid('pv'), key: parameter.name, value: '', enabled: true })
    } else if (parameter.in === 'query') {
      params.push({ id: uid('prm'), key: parameter.name, value: String(parameterValue(parameter)), enabled: true })
    } else if (parameter.in === 'header') {
      headers.push({ id: uid('hdr'), key: parameter.name, value: String(parameterValue(parameter)), enabled: parameter.required === true })
    }
  }
  const bodyParameter = operation.parameters.find((parameter) => parameter?.in === 'body')
  const example = contentExample(operation.requestBody?.content, specification.components)
    ?? (bodyParameter ? schemaExample(bodyParameter.schema, specification.components) : null)
  const jsonContent = Boolean(operation.requestBody?.content?.['application/json']) || Boolean(bodyParameter)
  return normalizeRequest({
    name: operation.summary || operation.operationId || `${operation.method} ${operation.path}`,
    method: operation.method,
    url: `${base}${operation.path}`,
    pathVars,
    params,
    headers,
    body: example === null
      ? emptyBody()
      : { mode: jsonContent ? 'json' : 'text', text: JSON.stringify(example, null, 2), fields: [] },
    auth: emptyAuth(),
    specId: specification.id ?? '',
    operationId: operation.operationId || operation.id,
  })
}

export function groupOperations(operations) {
  const groups = new Map()
  for (const operation of operations) {
    const tag = operation.tags[0] || 'default'
    if (!groups.has(tag)) groups.set(tag, [])
    groups.get(tag).push(operation)
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
}

export function statusClass(status) {
  if (!Number.isFinite(status) || status === 0) return 'status-0'
  if (status < 200) return 'status-1xx'
  if (status < 300) return 'status-2xx'
  if (status < 400) return 'status-3xx'
  if (status < 500) return 'status-4xx'
  return 'status-5xx'
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export function formatTime(timestamp) {
  const value = Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) return ''
  try {
    return new Date(value).toLocaleString()
  } catch {
    return ''
  }
}

export function prettyJson(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function shellQuote(value) {
  const text = String(value ?? '')
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(text)) return text
  return `'${text.replace(/'/g, `'\\''`)}'`
}

export function toCurl(prepared) {
  const parts = [`curl -X ${shellQuote(prepared.method)} ${shellQuote(prepared.url)}`]
  for (const header of prepared.headers ?? []) {
    parts.push(`-H ${shellQuote(`${header.name}: ${header.value}`)}`)
  }
  if (prepared.body) parts.push(`--data-raw ${shellQuote(prepared.body)}`)
  return parts.join(' \\\n  ')
}

const CURL_COMMAND = /^(?:\$\s+)?curl(?:\.exe)?(?:\s|$)/i

export function isCurlCommand(input) {
  return CURL_COMMAND.test(String(input ?? '').replace(/^\uFEFF/, '').trimStart())
}

function normalizeCurlInput(input) {
  const text = String(input ?? '')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .replace(/^\$\s+/, '')
  // Chrome's "Copy as cURL (cmd)" wraps every argument in ^"…"^ and escapes
  // special characters with a caret. Decode the carets; the quote tokenizer
  // then sees ordinary double quotes.
  if (/\^"/.test(text)) {
    return text
      .replace(/\^(\r?\n)(\r?\n)?/g, (_match, _first, second) => (second ? '\n' : ' '))
      .replace(/\^([\s\S])/g, '$1')
  }
  // POSIX shells join lines with a backslash; PowerShell uses a backtick.
  return text
    .replace(/\\(\r?\n)/g, ' ')
    .replace(/`(\r?\n)/g, ' ')
}

const ANSI_ESCAPES = {
  n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07', '0': '\0', '\\': '\\', "'": "'", '"': '"',
}

function tokenizeCurl(input) {
  const tokens = []
  let current = ''
  let quote = null
  let ansi = false
  let started = false
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (quote) {
      if (character === quote) {
        quote = null
        ansi = false
      } else if (character === '\\' && index + 1 < input.length && (ansi || quote === '"')) {
        const escaped = input[index + 1]
        if (ansi) {
          if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(input.slice(index + 2, index + 6))) {
            current += String.fromCharCode(Number.parseInt(input.slice(index + 2, index + 6), 16))
            index += 5
          } else {
            current += ANSI_ESCAPES[escaped] ?? `\\${escaped}`
            index += 1
          }
        } else if ('"\\$`'.includes(escaped) || escaped === '\n') {
          current += escaped
          index += 1
        } else {
          current += character
        }
      } else {
        current += character
      }
      continue
    }
    if (character === '$' && (input[index + 1] === "'" || input[index + 1] === '"')) {
      index += 1
      quote = input[index]
      ansi = true
      started = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      started = true
      continue
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += character
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

export function parseCurl(input) {
  const tokens = tokenizeCurl(normalizeCurlInput(input))
  if (!/^curl(?:\.exe)?$/i.test(tokens[0] ?? '')) throw new Error('Paste a command that starts with curl')
  let method = ''
  let url = ''
  let body = ''
  let json = false
  const headers = []
  const auth = emptyAuth()

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    const next = () => tokens[++index] ?? ''
    if (token === '-X' || token === '--request') method = next().toUpperCase()
    else if (token === '-H' || token === '--header') {
      const header = next()
      const separator = header.indexOf(':')
      if (separator > 0) {
        const name = header.slice(0, separator).trim()
        const value = header.slice(separator + 1).trim()
        if (name) headers.push({ id: uid('hdr'), key: name, value, enabled: true })
      } else if (header.endsWith(';') && header.slice(0, -1).trim()) {
        // cURL sends "Name;" as a header with an empty value.
        headers.push({ id: uid('hdr'), key: header.slice(0, -1).trim(), value: '', enabled: true })
      }
    } else if (token === '-b' || token === '--cookie') {
      // Chrome copies browser session cookies (the usual auth for web APIs)
      // as -b; a value without "=" is a cookie file, which a sandboxed view
      // cannot read.
      const value = next()
      if (value.includes('=')) {
        const existing = headers.find((header) => header.key.toLowerCase() === 'cookie')
        if (existing) existing.value = `${existing.value}; ${value}`
        else headers.push({ id: uid('hdr'), key: 'Cookie', value, enabled: true })
      }
    } else if (token === '-A' || token === '--user-agent') {
      headers.push({ id: uid('hdr'), key: 'User-Agent', value: next(), enabled: true })
    } else if (token === '-e' || token === '--referer') {
      headers.push({ id: uid('hdr'), key: 'Referer', value: next(), enabled: true })
    } else if (token === '--oauth2-bearer') {
      headers.push({ id: uid('hdr'), key: 'Authorization', value: `Bearer ${next()}`, enabled: true })
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode'].includes(token)) {
      const value = next()
      body = body ? `${body}&${value}` : value
    } else if (token === '--json') {
      body = next()
      json = true
    } else if (token === '-u' || token === '--user') {
      const [username, ...rest] = next().split(':')
      auth.type = 'basic'
      auth.username = username ?? ''
      auth.password = rest.join(':')
    } else if (token === '--url') {
      url = next()
    } else if (!token.startsWith('-') && !url) {
      url = token
    }
  }
  if (!url) throw new Error('The cURL command has no URL')
  const contentType = headers.find((header) => header.key.toLowerCase() === 'content-type')?.value ?? ''
  const mode = body ? (json || contentType.includes('json') ? 'json' : 'text') : 'none'
  return normalizeRequest({
    name: 'Imported cURL request',
    method: method || (body ? 'POST' : 'GET'),
    url,
    headers,
    body: { mode, text: body, fields: [] },
    auth,
  })
}

function postmanHeaders(request) {
  const headers = Array.isArray(request?.header) ? request.header : []
  return headers
    .filter((header) => header && !header.disabled && header.key)
    .map((header) => ({ id: uid('hdr'), key: String(header.key), value: String(header.value ?? ''), enabled: true }))
}

function postmanUrl(request) {
  const url = request?.url
  if (typeof url === 'string') return url
  if (!url || typeof url !== 'object') return ''
  if (typeof url.raw === 'string') return url.raw
  const host = Array.isArray(url.host) ? url.host.join('.') : String(url.host ?? '')
  const path = Array.isArray(url.path) ? url.path.join('/') : String(url.path ?? '')
  const query = Array.isArray(url.query)
    ? url.query.filter((item) => item && !item.disabled && item.key)
      .map((item) => `${encodeURIComponent(item.key)}=${encodeURIComponent(item.value ?? '')}`).join('&')
    : ''
  return `${url.protocol ? `${url.protocol}://` : ''}${host}${path ? `/${path}` : ''}${query ? `?${query}` : ''}`
}

function postmanBody(body) {
  if (!body || typeof body !== 'object' || body.mode === 'none') return emptyBody()
  if (body.mode === 'raw') {
    const language = body.options?.raw?.language
    return { mode: language === 'json' ? 'json' : 'text', text: String(body.raw ?? ''), fields: [] }
  }
  if (body.mode === 'urlencoded') {
    return {
      mode: 'form',
      text: '',
      fields: (body.urlencoded ?? []).filter((item) => item && !item.disabled && item.key)
        .map((item) => ({ id: uid('fld'), key: String(item.key), value: String(item.value ?? ''), enabled: true })),
    }
  }
  if (body.mode === 'formdata') {
    return {
      mode: 'multipart',
      text: '',
      fields: (body.formdata ?? []).filter((item) => item && !item.disabled && item.key && item.type !== 'file')
        .map((item) => ({ id: uid('fld'), key: String(item.key), value: String(item.value ?? ''), enabled: true })),
    }
  }
  return emptyBody()
}

function postmanAuth(auth) {
  const output = emptyAuth()
  if (!auth || typeof auth !== 'object') return output
  const value = (key) => {
    const entry = Array.isArray(auth[auth.type]) ? auth[auth.type].find((item) => item.key === key) : null
    return entry ? String(entry.value ?? '') : ''
  }
  if (auth.type === 'bearer') {
    output.type = 'bearer'
    output.token = value('token')
  } else if (auth.type === 'basic') {
    output.type = 'basic'
    output.username = value('username')
    output.password = value('password')
  } else if (auth.type === 'apikey') {
    output.type = 'apikey'
    output.key = value('key')
    output.value = value('value')
    output.addTo = value('in') === 'query' ? 'query' : 'header'
  }
  return output
}

export function importPostman(collection) {
  if (!collection || typeof collection !== 'object' || !Array.isArray(collection.item)) {
    throw new Error('This is not a Postman Collection v2.1 export')
  }
  if (collection.info?.schema && !String(collection.info.schema).includes('v2.1')) {
    throw new Error('Only Postman Collection v2.1 is supported')
  }
  const requests = []
  const walk = (items, prefix, depth = 0) => {
    if (!Array.isArray(items) || depth > 8) return
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const name = prefix ? `${prefix} / ${String(item.name ?? 'Request')}` : String(item.name ?? 'Request')
      if (Array.isArray(item.item)) {
        walk(item.item, name, depth + 1)
        continue
      }
      if (!item.request) continue
      const request = item.request
      requests.push(normalizeRequest({
        name: name.slice(0, 160),
        method: request.method ?? 'GET',
        url: postmanUrl(request),
        headers: postmanHeaders(request),
        body: postmanBody(request.body),
        auth: postmanAuth(request.auth),
      }))
    }
  }
  walk(collection.item, '')

  const environments = []
  if (Array.isArray(collection.variable) && collection.variable.length) {
    environments.push(normalizeEnvironment({
      name: `${String(collection.info?.name ?? 'Collection')} variables`,
      variables: collection.variable.filter((item) => item && item.key).map((item) => ({
        id: uid('var'),
        key: String(item.key),
        value: String(item.value ?? ''),
        enabled: true,
        secret: item.type === 'secret',
      })),
    }))
  }

  return {
    collections: [normalizeCollection({
      name: String(collection.info?.name ?? 'Imported Postman collection'),
      requests,
    })],
    environments,
  }
}

export function findRequest(workspace, requestId) {
  for (const collection of workspace.collections) {
    const request = collection.requests.find((item) => item.id === requestId)
    if (request) return { collection, request }
  }
  return null
}
