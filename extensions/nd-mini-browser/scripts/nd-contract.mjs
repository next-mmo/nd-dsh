/**
 * Shared `nd.extension/1` contract checks for the ND YouTube Mini scaffold.
 *
 * The authoritative rules live in the ND-DSH runtime
 * (`src/shared/extension-package.ts`, executed from the repository root with
 * `node scripts/validate-nd-extension.mjs <package-folder>`). This module
 * mirrors only the invariants this package relies on so the package can verify
 * itself inside an isolated worktree with zero installed dependencies.
 *
 * When the package starts using another ND host method, add it to
 * `HOST_PERMISSIONS` below with the permission the runtime requires, and
 * confirm the mapping with the repository validator.
 */

export const PROTOCOL = 'nd.extension/1'
export const API_VERSION = 1
export const CONTEXTS = ['personal', 'company', 'project']

/**
 * ND host methods this package may reference, mapped to the permission the
 * runtime installer requires to be declared for them. Keys must stay within
 * `ND_HOST_METHODS` in `src/shared/extension-package.ts`.
 */
export const HOST_PERMISSIONS = {
  'minibrowser.session.list': 'minibrowser.read',
  'minibrowser.link.list': 'minibrowser.read',
  'minibrowser.tab.open': 'minibrowser.write',
  'minibrowser.tab.activate': 'minibrowser.write',
  'minibrowser.tab.close': 'minibrowser.write',
  'minibrowser.link.save': 'minibrowser.write',
  'minibrowser.link.remove': 'minibrowser.write',
}

const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/
const CONTRIBUTION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * Concrete credential shapes this package must never contain. These match
 * secret *values*, not the words "key" or "token" in documentation.
 */
export const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /(?:api[_-]?key|secret|password|passwd|credential|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
]

/** Return the secret-shaped matches found in one file's text. */
export function findSecrets(text) {
  return SECRET_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => String(pattern))
}

function isContext(value) {
  return typeof value === 'string' && CONTEXTS.includes(value)
}

/**
 * Validate a parsed manifest against the invariants this package relies on.
 * Returns a list of human-readable issues; an empty list means the manifest
 * passes every check.
 */
export function validateManifest(manifest) {
  const issues = []
  const add = (message) => issues.push(message)

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['manifest must be a JSON object']
  }
  if (manifest.protocol !== PROTOCOL) add(`protocol must be "${PROTOCOL}"`)
  if (manifest.apiVersion !== API_VERSION) add(`apiVersion must be ${API_VERSION}`)
  if (typeof manifest.id !== 'string' || !PACKAGE_ID_PATTERN.test(manifest.id)) {
    add('id must be a lowercase package id such as "nd.youtube-mini"')
  }
  for (const field of ['name', 'description']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) add(`${field} is required`)
  }
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) {
    add('version must be MAJOR.MINOR.PATCH with an optional -prerelease suffix')
  }

  if (!Array.isArray(manifest.contexts) || manifest.contexts.length === 0 || !manifest.contexts.every(isContext)) {
    add(`contexts must list at least one of: ${CONTEXTS.join(', ')}`)
  } else {
    for (const field of ['permissions', 'settings']) {
      if (manifest[field] !== undefined && !Array.isArray(manifest[field])) {
        add(`${field} must be an array`)
      }
    }
    if (manifest.executable !== undefined) {
      add('this declarative package must not declare an executable runtime')
    }
    checkContributions(manifest, add)
  }
  return issues
}

function checkContributions(manifest, add) {
  const contributions = manifest.contributions
  if (!contributions || typeof contributions !== 'object' || Array.isArray(contributions)) {
    add('contributions is required')
    return
  }
  const packageContexts = manifest.contexts
  const commands = Array.isArray(contributions.commands) ? contributions.commands : null
  const views = Array.isArray(contributions.views) ? contributions.views : null
  if (!commands) { add('contributions.commands must be an array'); return }
  if (!views) { add('contributions.views must be an array'); return }
  if (commands.length === 0) add('the package must declare at least one command contribution')
  if (views.length === 0) add('the package must declare at least one view contribution')

  const ids = new Set()
  const requiredPermissions = new Set()
  const claim = (path, id) => {
    if (typeof id !== 'string' || !CONTRIBUTION_ID_PATTERN.test(id)) {
      add(`${path}.id must use lowercase letters, numbers, dots, dashes, or underscores`)
      return
    }
    if (ids.has(id)) add(`duplicate contribution id across the package: ${id}`)
    ids.add(id)
  }
  const checkHost = (path, host) => {
    const permission = typeof host === 'string' && Object.hasOwn(HOST_PERMISSIONS, host)
      ? HOST_PERMISSIONS[host]
      : undefined
    if (!permission) {
      add(`${path}.host "${String(host)}" is not in this package's ND host allowlist`)
      return
    }
    requiredPermissions.add(permission)
  }
  const checkContexts = (path, contexts) => {
    if (contexts === undefined) return
    if (!Array.isArray(contexts) || !contexts.every(isContext)) {
      add(`${path}.contexts must list only: ${CONTEXTS.join(', ')}`)
      return
    }
    const widened = contexts.filter((kind) => !packageContexts.includes(kind))
    if (widened.length > 0) add(`${path}.contexts must stay within the package contexts: ${widened.join(', ')}`)
  }

  commands.forEach((command, index) => {
    const path = `contributions.commands[${index}]`
    if (!command || typeof command !== 'object') { add(`${path} must be an object`); return }
    claim(`${path}`, command.id)
    if (typeof command.title !== 'string' || !command.title.trim()) add(`${path}.title is required`)
    checkHost(path, command.host)
    checkContexts(path, command.contexts)
    if (command.openViewId !== undefined && !views.some((view) => view && view.id === command.openViewId)) {
      add(`${path}.openViewId must name a view in this package`)
    }
  })

  views.forEach((view, index) => {
    const path = `contributions.views[${index}]`
    if (!view || typeof view !== 'object') { add(`${path} must be an object`); return }
    claim(`${path}`, view.id)
    if (typeof view.title !== 'string' || !view.title.trim()) add(`${path}.title is required`)
    if (view.kind === 'web') {
      // Package-shipped UI: no data host; the entry names the web view's html
      // document (checked for existence by the typecheck script) and every
      // privileged operation must be a declared action.
      if (typeof view.entry !== 'string' || !view.entry.endsWith('.html')
        || view.entry.startsWith('/') || view.entry.includes('..') || view.entry.includes('\\')) {
        add(`${path}.entry must be a package-relative html path such as "ui/index.html"`)
      }
      if (view.itemTitleKey !== undefined) add(`${path}.itemTitleKey is not used by web views`)
      if (view.host !== undefined) add(`${path}.host is not used by web views`)
    } else {
      if (view.kind !== undefined && view.kind !== 'list' && view.kind !== 'detail') {
        add(`${path}.kind must be "list", "detail", or "web"`)
      }
      if (typeof view.itemTitleKey !== 'string' || !view.itemTitleKey.trim()) add(`${path}.itemTitleKey is required`)
      checkHost(path, view.host)
    }
    checkContexts(path, view.contexts)
    const actions = Array.isArray(view.actions) ? view.actions : []
    for (const action of actions) {
      const actionPath = `${path}.actions[${actions.indexOf(action)}]`
      if (!action || typeof action !== 'object') { add(`${actionPath} must be an object`); continue }
      claim(actionPath, action.id)
      if (typeof action.title !== 'string' || !action.title.trim()) add(`${actionPath}.title is required`)
      checkHost(actionPath, action.host)
    }
  })

  const declared = new Set(Array.isArray(manifest.permissions) ? manifest.permissions : [])
  for (const permission of requiredPermissions) {
    if (!declared.has(permission)) add(`contributions require the "${permission}" permission`)
  }
}
