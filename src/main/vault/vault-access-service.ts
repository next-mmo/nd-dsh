import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { delimiter, dirname, isAbsolute, resolve } from 'node:path'
import { contextKey, describeContext, type NdContext } from '../../shared/nd-context.js'
import { PERSONAL_PROJECT_ID, type OrganizationSnapshot } from '../../shared/organization.js'
import type { CoreVault } from '../core/core-vault.js'
import { killProcessTree } from '../engines/agent-cli/agent-cli-support.js'
import type { InvocationBroker } from '../extensions/invocation-broker.js'
import type { InvocationStateStore } from '../extensions/invocation-state.js'
import type { ExtensionPackageStore } from '../extensions/package-store.js'
import { isWithinWorkspace, sessionInWorkspace } from '../workspace/path-utils.js'
import {
  extractTemplateRefs,
  formatVaultRef,
  parseVaultRef,
  replaceTemplateRefs,
  type VaultEnvEntry,
  type VaultRef,
  type VaultRefField,
} from './vault-refs.js'

export const PASSWORD_VAULT_EXTENSION_ID = 'nd.password-vault'

const CLI_SCRIPT = 'nd-vault-cli.mjs'
const MAX_BODY_BYTES = 4 * 1024 * 1024
const MAX_TEMPLATE_BYTES = 1024 * 1024
const MAX_ENV_ENTRIES = 128
const MAX_ENTRIES_PER_COMMAND = 64
const MAX_COMMAND_ARGS = 64
const MAX_ARG_LENGTH = 4_096
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_CONCURRENT_RUNS = 4
const MAX_PENDING_APPROVALS = 8
const APPROVAL_TIMEOUT_MS = 120_000
const DEFAULT_RUN_TIMEOUT_MS = 600_000
const MAX_RUN_TIMEOUT_MS = 3_600_000
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const CONTROL_ENV = /^(ND_DSH_|DSH_|ND_VAULT_)/i

export type VaultAuditDecision = 'allowed' | 'denied' | 'approval-required'

export class VaultAccessError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'VaultAccessError'
  }
}

interface VaultEntrySummary {
  id: string
  title: string
  username: string
  url: string
  updatedAt: number
}

interface ResolvedEntry {
  id: string
  title: string
  fields: Set<VaultRefField>
}

interface ResolvedRefs {
  entries: ResolvedEntry[]
  /** Exact reference text -> entry id. */
  byRaw: Map<string, string>
}

export interface VaultAccessOrganizationPort {
  state(): Promise<Pick<OrganizationSnapshot, 'activeProjectId' | 'projects' | 'runs'>>
  policy?(companyId: string, action: string): Promise<'allow' | 'ask' | 'deny'>
}

export interface VaultAccessServiceOptions {
  coreVault: Pick<CoreVault, 'list' | 'get'>
  vaultPath: string
  packages: Pick<ExtensionPackageStore, 'activeManifest'>
  state: Pick<InvocationStateStore, 'activation' | 'settingsFor' | 'findGrant' | 'consumeGrant' | 'recordAudit'>
  broker: Pick<InvocationBroker, 'requestAccess' | 'cancelAccess'>
  organization: VaultAccessOrganizationPort
  workspace: { state(): { root: string } }
  ownsWorktree(cwd: string): boolean
  userDataPath: string
  /** Dev project root or packaged resources root; contains scripts/nd-vault-cli.mjs. */
  resourceRoot: string
  /** Plain Node executable used by the generated shims. */
  nodeBin: string
  platform?: NodeJS.Platform
  spawnProcess?: typeof spawn
  log?: (line: string) => void
}

/**
 * Loopback broker for the secure ND vault CLI.
 *
 * The agent never receives a secret. It sends references and a command (or a
 * template and an output path); this service checks activation, policy, and
 * per-entry grants, resolves values inside the desktop process, and either
 * executes the command with those values in its environment or writes the
 * injected file. Values never enter the HTTP response, the CLI, or the agent.
 */
export class VaultAccessService {
  private server: Server | undefined
  private port = 0
  private startPromise: Promise<void> | undefined
  private readonly token = randomBytes(32).toString('hex')
  private readonly cliPath: string
  private readonly binDir: string
  private readonly platform: NodeJS.Platform
  private running = 0
  private readonly pending = new Set<string>()
  private readonly children = new Set<ChildProcess>()

  constructor(private readonly options: VaultAccessServiceOptions) {
    this.platform = options.platform ?? process.platform
    this.cliPath = resolve(options.resourceRoot, 'scripts', CLI_SCRIPT)
    this.binDir = resolve(options.userDataPath, 'nd-vault-bin')
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startInternal().catch((error) => {
      this.startPromise = undefined
      throw error
    })
    return this.startPromise
  }

  private async startInternal(): Promise<void> {
    await this.prepareShims()
    const server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })
    // A vault command may legitimately run for minutes; the CLI aborts on its
    // own timeout and the run handler kills the child.
    server.requestTimeout = 0
    server.headersTimeout = 30_000
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })
    const address = server.address()
    if (!address || typeof address !== 'object') {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      throw new Error('The ND vault broker could not resolve its loopback port')
    }
    this.server = server
    this.port = address.port
    server.on('error', (error) => {
      this.log(`[vault] loopback server error: ${message(error)}`)
    })
  }

  async dispose(): Promise<void> {
    for (const approvalId of [...this.pending]) {
      void this.options.broker.cancelAccess(approvalId, 'ND is shutting down')
    }
    this.pending.clear()
    for (const child of [...this.children]) {
      void killProcessTree(child)
    }
    this.children.clear()
    const server = this.server
    this.server = undefined
    this.port = 0
    this.startPromise = undefined
    if (!server) return
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /**
   * Environment injected into shell-capable agents. It is returned as a value,
   * never written to process.env, so user terminals and unrelated children do
   * not inherit the token.
   */
  environment(): NodeJS.ProcessEnv {
    if (!this.port || !existsSync(this.cliPath)) return {}
    const pathKey = process.env.PATH !== undefined ? 'PATH' : process.env.Path !== undefined ? 'Path' : 'PATH'
    const current = process.env[pathKey] ?? ''
    const parts = current.split(delimiter).filter(Boolean)
    const path = parts.includes(this.binDir) ? current : [this.binDir, ...parts].join(delimiter)
    return {
      ND_DSH_VAULT_URL: `http://127.0.0.1:${this.port}`,
      ND_DSH_VAULT_TOKEN: this.token,
      ND_DSH_VAULT_CLI: this.cliPath,
      ND_DSH_VAULT_BIN: this.binDir,
      [pathKey]: path,
    }
  }

  async hint(): Promise<string | undefined> {
    if (!this.port || !existsSync(this.cliPath)) return undefined
    const manifest = await this.options.packages.activeManifest(PASSWORD_VAULT_EXTENSION_ID)
    if (!manifest) return undefined
    return [
      '<nd-vault-cli>',
      'Password Vault is available through the `nd-vault` CLI on PATH (also $ND_DSH_VAULT_CLI). Use it instead of asking for secret values:',
      '  nd-vault list --refs',
      '  nd-vault run --env TOKEN=ndvault://<entry>/secret -- <command>',
      '  nd-vault inject --in <template> --out <file>',
      'Never print, echo, or pass secret values on command lines; never run env/printenv with vault references; prefer run and delete resolved files. Each use needs the user’s approval in ND.',
      '</nd-vault-cli>',
    ].join('\n')
  }

  private async prepareShims(): Promise<void> {
    if (!existsSync(this.cliPath)) {
      this.log(`[vault] CLI script is missing: ${this.cliPath}`)
      return
    }
    await fs.mkdir(this.binDir, { recursive: true })
    const node = this.options.nodeBin
    // Windows command shells resolve .cmd through PATHEXT; Git Bash and POSIX
    // resolve the extensionless script through its shebang. Ship both.
    const cmd = `@echo off\r\n"${node}" "${this.cliPath}" %*\r\n`
    const sh = `#!/bin/sh\nexec "${escapePosix(node)}" "${escapePosix(this.cliPath)}" "$@"\n`
    await writeIfChanged(resolve(this.binDir, 'nd-vault.cmd'), cmd)
    await writeIfChanged(resolve(this.binDir, 'nd-vault'), sh, this.platform === 'win32' ? undefined : 0o755)
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.assertRequestAllowed(req)
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const method = req.method ?? 'GET'
      if (method === 'GET' && url.pathname === '/v1/status') return await this.handleStatus(url, res)
      if (method === 'GET' && url.pathname === '/v1/list') return await this.handleList(url, res)
      if (method === 'POST' && url.pathname === '/v1/run') return await this.handleRun(req, res)
      if (method === 'POST' && url.pathname === '/v1/inject') return await this.handleInject(req, res)
      throw new VaultAccessError('not-found', 'Unknown ND vault route', 404)
    } catch (error) {
      const failure = error instanceof VaultAccessError
        ? error
        : new VaultAccessError('failed', message(error), 500)
      if (!res.headersSent) {
        sendJson(res, failure.status, { ok: false, error: { code: failure.code, message: failure.message } })
      } else if (!res.writableEnded && !res.destroyed) {
        res.end()
      }
      if (failure.status >= 500) this.log(`[vault] ${failure.message}`)
    }
  }

  private assertRequestAllowed(req: IncomingMessage): void {
    // A browser page must never be able to call the vault broker, even on
    // loopback. Reject every Origin and every host we did not bind.
    if (req.headers.origin) throw new VaultAccessError('forbidden', 'Browser origins are not allowed', 403)
    if ((req.headers.host ?? '') !== `127.0.0.1:${this.port}`) {
      throw new VaultAccessError('forbidden', 'Unexpected Host header', 403)
    }
    const authorization = req.headers.authorization ?? ''
    if (!safeEqual(authorization, `Bearer ${this.token}`)) {
      throw new VaultAccessError('unauthorized', 'A valid ND vault token is required', 401)
    }
    if (req.method === 'POST') {
      const type = String(req.headers['content-type'] ?? '').toLowerCase()
      if (!type.startsWith('application/json')) {
        throw new VaultAccessError('invalid', 'Content-Type must be application/json', 415)
      }
    }
  }

  private async handleStatus(url: URL, res: ServerResponse): Promise<void> {
    const cwd = this.requireCwd(url.searchParams.get('cwd'))
    const { context, manifest } = await this.authorize(cwd)
    sendJson(res, 200, {
      ok: true,
      context,
      contextLabel: describeContext(context),
      version: manifest.version,
    })
  }

  private async handleList(url: URL, res: ServerResponse): Promise<void> {
    const cwd = this.requireCwd(url.searchParams.get('cwd'))
    const { context } = await this.authorize(cwd)
    const query = (url.searchParams.get('query') ?? '').slice(0, 200)
    const result = await this.options.coreVault.list(this.options.vaultPath, query || undefined)
    const entries: VaultEntrySummary[] = result.entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      username: entry.username,
      url: entry.url,
      updatedAt: entry.updatedAt,
    }))
    sendJson(res, 200, {
      ok: true,
      context,
      total: result.total,
      entries: entries.map((entry) => ({ ...entry, ref: formatVaultRef(entry.id) })),
    })
  }

  private async handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req)
    const cwd = this.requireCwd(body.cwd)
    const { context } = await this.authorize(cwd)
    const { rawEnv, entries: envEntries } = this.parseRunEnv(body.env)
    if (envEntries.length === 0) {
      throw new VaultAccessError('invalid', 'run requires at least one ndvault:// reference', 400)
    }
    const command = this.parseCommand(body.command)
    const timeoutMs = this.parseTimeout(body.timeoutSeconds)
    const purpose = optionalText(body.purpose, 300)
    const { entries, byRaw } = await this.resolveRefs(envEntries.map((entry) => entry.ref))
    const commandLine = displayCommand(command)
    const detail = this.approvalDetail(context, commandLine, entries, purpose)
    const controller = new AbortController()
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort()
    }
    res.on('close', onClose)
    const startedAt = Date.now()
    let authorized = false
    let auditCommand = commandLine
    try {
      if (this.running >= MAX_CONCURRENT_RUNS) {
        throw new VaultAccessError('busy', 'Too many vault commands are already running', 429)
      }
      await this.authorizeEntries(context, entries, detail, controller.signal)
      authorized = true
      if (controller.signal.aborted) throw cancelled()
      if (this.running >= MAX_CONCURRENT_RUNS) {
        throw new VaultAccessError('busy', 'Too many vault commands are already running', 429)
      }
      const values = await this.fetchValues(entries, (partial) => {
        auditCommand = redactCommand(command, [...partial.values()].flatMap((fields) => [...fields.values()]))
      })
      if (controller.signal.aborted) throw cancelled()
      auditCommand = redactCommand(command, [...values.values()].flatMap((fields) => [...fields.values()]))
      const childEnv = this.buildChildEnv(rawEnv, envEntries, values, byRaw)
      this.running += 1
      try {
        await this.streamCommand(res, command, cwd, childEnv, timeoutMs, controller.signal)
      } finally {
        this.running -= 1
      }
      await this.audit(context, 'secure-cli-run', 'allowed', `${auditCommand} · ${titles(entries)}`, 'ok', startedAt)
    } catch (error) {
      await this.audit(context, 'secure-cli-run', authorized ? 'allowed' : 'denied', `${auditCommand} · ${message(error)}`, 'failed', startedAt)
      throw error
    } finally {
      res.removeListener('close', onClose)
    }
  }

  private async handleInject(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req)
    const cwd = this.requireCwd(body.cwd)
    const { context } = await this.authorize(cwd)
    const template = requiredText(body.template, 'template', MAX_TEMPLATE_BYTES)
    const outPath = requiredText(body.outPath, 'outPath', 1_024)
    if (outPath === '-') {
      throw new VaultAccessError('invalid', 'inject never writes resolved secrets to stdout', 400)
    }
    const target = resolve(cwd, outPath)
    if (!sessionInWorkspace(cwd, target)) {
      throw new VaultAccessError('forbidden', 'The injected file must stay inside the command workspace', 403)
    }
    if (target === resolve(cwd)) {
      throw new VaultAccessError('invalid', 'outPath must name a file', 400)
    }
    // `sessionInWorkspace` is lexical; a symlinked/junctioned directory inside
    // the workspace must not redirect the write outside it.
    const [realRoot, realParent] = await Promise.all([
      fs.realpath(cwd).catch(() => undefined),
      fs.realpath(dirname(target)).catch(() => undefined),
    ])
    if (!realRoot || !realParent || !isWithinWorkspace(realRoot, realParent)) {
      throw new VaultAccessError('forbidden', 'The injected file must resolve inside the command workspace', 403)
    }
    if ((await fs.stat(target).catch(() => undefined))?.isDirectory()) {
      throw new VaultAccessError('invalid', 'outPath must name a file, not a directory', 400)
    }
    const refs = extractTemplateRefs(template)
    if (refs.length === 0) throw new VaultAccessError('invalid', 'The template has no ndvault:// references', 400)
    if (refs.length > MAX_ENV_ENTRIES) throw new VaultAccessError('invalid', 'Too many vault references', 400)
    const force = body.force === true
    if (!force && existsSync(target)) {
      throw new VaultAccessError('conflict', `${outPath} already exists; pass --force to replace it`, 409)
    }
    const purpose = optionalText(body.purpose, 300)
    const { entries, byRaw } = await this.resolveRefs(refs)
    const detail = this.approvalDetail(context, `write ${outPath}`, entries, purpose)
    const controller = new AbortController()
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort()
    }
    res.on('close', onClose)
    const startedAt = Date.now()
    let authorized = false
    try {
      await this.authorizeEntries(context, entries, detail, controller.signal)
      authorized = true
      if (controller.signal.aborted) throw cancelled()
      const values = await this.fetchValues(entries)
      if (controller.signal.aborted) throw cancelled()
      const replacements = new Map<string, string>()
      for (const ref of refs) {
        const entryId = byRaw.get(ref.raw)!
        const value = values.get(entryId)?.get(ref.field) ?? ''
        replacements.set(ref.raw, value)
      }
      const content = replaceTemplateRefs(template, replacements)
      await writeSecretFile(target, content)
      await this.audit(context, 'secure-cli-inject', 'allowed', `write ${outPath} · ${titles(entries)}`, 'ok', startedAt)
      sendJson(res, 200, { ok: true, path: target })
    } catch (error) {
      await this.audit(context, 'secure-cli-inject', authorized ? 'allowed' : 'denied', `write ${outPath} · ${message(error)}`, 'failed', startedAt)
      throw error
    } finally {
      res.removeListener('close', onClose)
    }
  }

  private async authorize(cwd: string): Promise<{
    context: NdContext
    manifest: NonNullable<Awaited<ReturnType<ExtensionPackageStore['activeManifest']>>>
  }> {
    const context = await this.contextForCwd(cwd)
    const manifest = await this.options.packages.activeManifest(PASSWORD_VAULT_EXTENSION_ID)
    if (!manifest) {
      throw new VaultAccessError(
        'not-enabled',
        'Password Vault is not installed. Install it in Settings → Extensions → Available.',
        409,
      )
    }
    if (!manifest.permissions.includes('vault.read')) {
      throw new VaultAccessError('not-enabled', 'Password Vault does not declare vault.read', 409)
    }
    const activation = await this.options.state.activation(PASSWORD_VAULT_EXTENSION_ID, context)
    if (!activation?.enabled) {
      throw new VaultAccessError(
        'not-activated',
        `Password Vault is not active for ${describeContext(context)}. Open Settings → Extensions, select that context, and activate Password Vault.`,
        409,
      )
    }
    const settings = await this.options.state.settingsFor(PASSWORD_VAULT_EXTENSION_ID, context)
    if (settings.agentCli === false) {
      throw new VaultAccessError('not-enabled', `Agent access to Password Vault is turned off for ${describeContext(context)}.`, 403)
    }
    if (context.kind !== 'personal' && this.options.organization.policy) {
      const effect = await this.options.organization.policy(context.companyId, 'vault.resolve').catch(() => 'ask' as const)
      if (effect === 'deny') {
        throw new VaultAccessError('forbidden', `Company policy does not allow Password Vault access in ${describeContext(context)}.`, 403)
      }
    }
    return { context, manifest }
  }

  private async contextForCwd(cwd: string): Promise<NdContext> {
    const organization = await this.options.organization.state()
    const projects = organization.projects.filter((project) => project.id !== PERSONAL_PROJECT_ID)
    const run = organization.runs
      .filter((candidate) => candidate.workspaceRoot && isWithinWorkspace(candidate.workspaceRoot, cwd))
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    if (run) {
      const project = projects.find((candidate) => candidate.id === run.projectId)
      if (project && project.companyId === run.companyId) {
        return { kind: 'project', companyId: project.companyId, projectId: project.id }
      }
      throw new VaultAccessError('forbidden', 'This ND task worktree no longer has a valid project context', 403)
    }
    const active = projects.find((project) => project.id === organization.activeProjectId)
    if (active?.workspacePath && isWithinWorkspace(active.workspacePath, cwd)) {
      return { kind: 'project', companyId: active.companyId, projectId: active.id }
    }
    const owner = projects.find((project) => project.workspacePath && isWithinWorkspace(project.workspacePath, cwd))
    if (owner) return { kind: 'project', companyId: owner.companyId, projectId: owner.id }
    if (!organization.activeProjectId || organization.activeProjectId === PERSONAL_PROJECT_ID) {
      return { kind: 'personal' }
    }
    if (isWithinWorkspace(this.options.workspace.state().root, cwd)) return { kind: 'personal' }
    throw new VaultAccessError('forbidden', 'This folder does not belong to an ND project or the active workspace', 403)
  }

  private requireCwd(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) {
      throw new VaultAccessError('invalid', 'cwd must be an absolute path', 400)
    }
    const cwd = resolve(value)
    if (!sessionInWorkspace(this.options.workspace.state().root, cwd) && !this.options.ownsWorktree(cwd)) {
      throw new VaultAccessError('forbidden', 'The vault CLI can only run inside the active ND workspace', 403)
    }
    return cwd
  }

  private async resolveRefs(refs: VaultRef[]): Promise<ResolvedRefs> {
    const unique = new Map<string, VaultRef>()
    for (const ref of refs) unique.set(ref.raw, ref)
    if (unique.size > MAX_ENV_ENTRIES) throw new VaultAccessError('invalid', 'Too many vault references', 400)
    const result = await this.options.coreVault.list(this.options.vaultPath)
    const summaries = result.entries
    const entries = new Map<string, ResolvedEntry>()
    const byRaw = new Map<string, string>()
    for (const ref of unique.values()) {
      const entry = summaries.find((candidate) => candidate.id === ref.target)
        ?? (() => {
          const matches = summaries.filter((candidate) => candidate.title.toLowerCase() === ref.target.toLowerCase())
          if (matches.length > 1) {
            throw new VaultAccessError(
              'invalid',
              `“${ref.target}” matches ${matches.length} vault entries. Use an entry id: ${matches.map((match) => match.id).join(', ')}`,
              400,
            )
          }
          return matches[0]
        })()
      if (!entry) {
        throw new VaultAccessError(
          'not-found',
          `No vault entry matches “${ref.target}”. Run nd-vault list to see entries.`,
          404,
        )
      }
      const resolved = entries.get(entry.id) ?? { id: entry.id, title: entry.title, fields: new Set<VaultRefField>() }
      resolved.fields.add(ref.field)
      entries.set(entry.id, resolved)
      byRaw.set(ref.raw, entry.id)
    }
    if (entries.size > MAX_ENTRIES_PER_COMMAND) {
      throw new VaultAccessError('invalid', `At most ${MAX_ENTRIES_PER_COMMAND} vault entries are allowed in one command`, 400)
    }
    return { entries: [...entries.values()], byRaw }
  }

  private async authorizeEntries(
    context: NdContext,
    entries: ResolvedEntry[],
    detail: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw cancelled()
    const missing: ResolvedEntry[] = []
    for (const entry of entries) {
      const grant = await this.options.state.findGrant(PASSWORD_VAULT_EXTENSION_ID, 'vault.resolve', context, entry.id)
      if (!grant) missing.push(entry)
    }
    if (missing.length > 0) {
      if (this.pending.size >= MAX_PENDING_APPROVALS) {
        throw new VaultAccessError('busy', 'Too many vault approvals are already waiting', 429)
      }
      const request = this.options.broker.requestAccess({
        extensionId: PASSWORD_VAULT_EXTENSION_ID,
        host: 'vault.resolve',
        context,
        title: missing.length === 1
          ? `Password Vault: use “${missing[0]!.title}”`
          : `Password Vault: use ${missing.length} entries`,
        detail,
        resources: missing.map((entry) => entry.id),
        timeoutMs: APPROVAL_TIMEOUT_MS,
      })
      if (request.approvalId) this.pending.add(request.approvalId)
      const onAbort = (): void => {
        void this.options.broker.cancelAccess(request.approvalId, 'request aborted')
      }
      if (signal.aborted) {
        onAbort()
        throw cancelled()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      let decision: { approved: boolean; remember: boolean }
      try {
        decision = await request.decision
      } finally {
        signal.removeEventListener('abort', onAbort)
        if (request.approvalId) this.pending.delete(request.approvalId)
      }
      if (signal.aborted) throw cancelled()
      if (!decision.approved) {
        throw new VaultAccessError('denied', 'Password Vault access was not approved by the user', 403)
      }
    }
    // Consume one-shot grants before reading a value: the user authorized one
    // use, and a replayed request must ask again.
    for (const entry of entries) {
      const grant = await this.options.state.findGrant(PASSWORD_VAULT_EXTENSION_ID, 'vault.resolve', context, entry.id)
      if (!grant) throw new VaultAccessError('failed', 'The vault approval did not create a grant', 500)
      if (grant.scope === 'once') await this.options.state.consumeGrant(grant.id)
    }
  }

  private async fetchValues(
    entries: ResolvedEntry[],
    onProgress?: (values: Map<string, Map<VaultRefField, string>>) => void,
  ): Promise<Map<string, Map<VaultRefField, string>>> {
    const values = new Map<string, Map<VaultRefField, string>>()
    for (const entry of entries) {
      const full = await this.options.coreVault.get(this.options.vaultPath, entry.id)
      const fields = new Map<VaultRefField, string>()
      for (const field of entry.fields) {
        const value = full[field]
        fields.set(field, typeof value === 'string' ? value : '')
      }
      values.set(entry.id, fields)
      onProgress?.(values)
    }
    return values
  }

  private parseRunEnv(value: unknown): { rawEnv: Record<string, string>; entries: VaultEnvEntry[] } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new VaultAccessError('invalid', 'env must be an object of environment variables', 400)
    }
    const rawEnv: Record<string, string> = {}
    const entries: VaultEnvEntry[] = []
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== 'string') {
        throw new VaultAccessError('invalid', `Environment variable ${key} must be a string`, 400)
      }
      if (item.includes('\0')) throw new VaultAccessError('invalid', 'Environment values must not contain NUL', 400)
      const ref = parseVaultRef(item)
      if (ref) {
        if (!ENV_KEY.test(key)) throw new VaultAccessError('invalid', `"${key}" is not a valid environment variable name`, 400)
        if (isReservedEnvKey(key)) {
          throw new VaultAccessError('invalid', `${key} is reserved by ND and cannot receive a vault value`, 400)
        }
        entries.push({ key, ref })
      } else {
        rawEnv[key] = item
      }
    }
    if (entries.length > MAX_ENV_ENTRIES) throw new VaultAccessError('invalid', 'Too many vault references', 400)
    return { rawEnv, entries }
  }

  private parseCommand(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMMAND_ARGS) {
      throw new VaultAccessError('invalid', `command must be an array of 1-${MAX_COMMAND_ARGS} arguments`, 400)
    }
    const command = value.map((item) => {
      if (typeof item !== 'string' || item.length > MAX_ARG_LENGTH || item.includes('\0')) {
        throw new VaultAccessError('invalid', 'command contains an invalid argument', 400)
      }
      return item
    })
    if (!command[0]!.trim()) throw new VaultAccessError('invalid', 'command must name an executable', 400)
    return command
  }

  private parseTimeout(value: unknown): number {
    if (value === undefined) return DEFAULT_RUN_TIMEOUT_MS
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new VaultAccessError('invalid', 'timeoutSeconds must be a positive number', 400)
    }
    return Math.min(Math.round(value * 1_000), MAX_RUN_TIMEOUT_MS)
  }

  private buildChildEnv(
    rawEnv: Record<string, string>,
    refs: VaultEnvEntry[],
    values: Map<string, Map<VaultRefField, string>>,
    byRaw: Map<string, string>,
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(rawEnv)) {
      if (isReservedEnvKey(key)) continue
      env[key] = value
    }
    for (const { key, ref } of refs) {
      if (isReservedEnvKey(key)) {
        throw new VaultAccessError('invalid', `${key} is reserved by ND and cannot receive a vault value`, 400)
      }
      const entryId = byRaw.get(ref.raw)
      if (!entryId) throw new VaultAccessError('failed', 'A vault reference was not resolved', 500)
      env[key] = values.get(entryId)?.get(ref.field) ?? ''
    }
    if (env.PATH === undefined && env.Path === undefined && process.env.PATH !== undefined) env.PATH = process.env.PATH
    return env
  }

  private approvalDetail(
    context: NdContext,
    action: string,
    entries: ResolvedEntry[],
    purpose: string | undefined,
  ): string {
    const titles = entries.map((entry) => entry.title).join(', ')
    return oneLine([
      describeContext(context),
      action,
      titles,
      purpose ? `reason: ${purpose}` : undefined,
    ].filter(Boolean).join(' · '), 400)
  }

  private async audit(
    context: NdContext,
    contributionId: string,
    decision: VaultAuditDecision,
    reason: string,
    outcome: 'ok' | 'failed',
    startedAt: number,
  ): Promise<void> {
    await this.options.state.recordAudit({
      extensionId: PASSWORD_VAULT_EXTENSION_ID,
      contributionId,
      host: 'vault.resolve',
      contextKey: contextKey(context),
      caller: 'agent',
      decision,
      reason: oneLine(reason, 300),
      outcome,
      durationMs: Date.now() - startedAt,
    }).catch(() => undefined)
  }

  private streamCommand(
    res: ServerResponse,
    command: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      let child: ChildProcess | undefined
      let outputBytes = 0
      let timer: NodeJS.Timeout | undefined
      const write = (event: Record<string, unknown>): void => {
        if (res.writableEnded || res.destroyed) return
        res.write(`${JSON.stringify(event)}\n`)
      }
      const finish = (event?: Record<string, unknown>): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        if (child) this.children.delete(child)
        if (event) write(event)
        if (!res.writableEnded && !res.destroyed) res.end()
        resolve()
      }
      const onAbort = (): void => {
        void killProcessTree(child)
        write({ type: 'error', message: 'The vault request was cancelled' })
        finish({ type: 'exit', code: 130, signal: null })
      }
      const onOutput = (kind: 'stdout' | 'stderr') => (chunk: Buffer): void => {
        if (settled) return
        outputBytes += chunk.length
        if (outputBytes > MAX_OUTPUT_BYTES) {
          write({ type: 'error', message: 'Command output exceeded the ND vault limit' })
          void killProcessTree(child)
          finish({ type: 'exit', code: 1, signal: null })
          return
        }
        write({ type: kind, data: chunk.toString('base64') })
      }
      if (signal.aborted || res.destroyed) {
        finish()
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      try {
        const spawnProcess = this.options.spawnProcess ?? spawn
        child = spawnProcess(command[0]!, command.slice(1), {
          cwd,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: this.platform !== 'win32',
        })
      } catch (error) {
        write({ type: 'error', message: `The command could not start: ${message(error)}` })
        finish({ type: 'exit', code: 127, signal: null })
        return
      }
      child.stdout?.on('data', onOutput('stdout'))
      child.stderr?.on('data', onOutput('stderr'))
      this.children.add(child)
      child.once('error', (error) => {
        write({ type: 'error', message: `The command could not start: ${message(error)}` })
        finish({ type: 'exit', code: 127, signal: null })
      })
      child.once('exit', (code, signalName) => {
        finish({ type: 'exit', code: code ?? 1, signal: signalName ?? null })
      })
      timer = setTimeout(() => {
        write({ type: 'error', message: `The command timed out after ${Math.round(timeoutMs / 1_000)}s` })
        void killProcessTree(child)
        finish({ type: 'exit', code: 124, signal: null })
      }, timeoutMs)
      res.once('close', () => {
        if (settled) return
        void killProcessTree(child)
        finish()
      })
    })
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) throw new VaultAccessError('invalid', 'The vault request body is too large', 413)
      chunks.push(buffer)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new VaultAccessError('invalid', 'The vault request body is not valid JSON', 400)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new VaultAccessError('invalid', 'The vault request body must be a JSON object', 400)
    }
    return parsed as Record<string, unknown>
  }

  private log(line: string): void {
    this.options.log?.(line)
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isReservedEnvKey(key: string): boolean {
  return CONTROL_ENV.test(key) || key.toUpperCase() === 'ELECTRON_RUN_AS_NODE'
}

function cancelled(): VaultAccessError {
  return new VaultAccessError('cancelled', 'The vault request was cancelled', 499)
}

function titles(entries: ResolvedEntry[]): string {
  return entries.map((entry) => entry.title).join(', ')
}

function oneLine(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = oneLine(value, max)
  return text || undefined
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new VaultAccessError('invalid', `${label} must be 1-${max} characters`, 400)
  }
  return value
}

function displayCommand(command: string[]): string {
  const rendered = command.map((part) => (/[\s"'&|<>^]/.test(part) ? JSON.stringify(part) : part)).join(' ')
  return oneLine(rendered, 220)
}

/**
 * Never let a value the agent embedded in its command reach the audit log.
 * Whole-argument matches cover short values without mangling common words;
 * longer values are also removed from composite arguments.
 */
function redactCommand(command: string[], values: string[]): string {
  const exact = new Set(values.filter((value) => value.length > 0))
  const parts = command.map((part) => (exact.has(part) ? '[redacted]' : part))
  let text = displayCommand(parts)
  for (const value of values.filter((candidate) => candidate.length >= 4).sort((left, right) => right.length - left.length)) {
    text = text.split(value).join('[redacted]')
  }
  return text
}

function escapePosix(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

async function writeIfChanged(path: string, content: string, mode?: number): Promise<void> {
  try {
    const current = await fs.readFile(path, 'utf8')
    if (current === content) {
      if (mode !== undefined) await fs.chmod(path, mode).catch(() => undefined)
      return
    }
  } catch {
    // Missing or unreadable: replace it below.
  }
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', ...(mode !== undefined ? { mode } : {}) })
    await fs.rename(temp, path)
    if (mode !== undefined) await fs.chmod(path, mode).catch(() => undefined)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function writeSecretFile(target: string, content: string): Promise<void> {
  await fs.mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temp, target)
    if (process.platform !== 'win32') await fs.chmod(target, 0o600).catch(() => undefined)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}
