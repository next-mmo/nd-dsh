import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitExecRunner } from '../src/main/git/git-cli.js'
import { OrganizationStore } from '../src/main/organization/store.js'
import { WorkflowPluginStore } from '../src/main/workflows/workflow-plugin-store.js'
import { WorkflowService } from '../src/main/workflows/workflow-service.js'
import type { WorkflowPluginManifest } from '../src/shared/workflow-plugins.js'
import { parseWorkflowPluginManifest } from '../src/shared/workflow-plugins.js'

const tempDirs: string[] = []

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `${prefix}-`)))
  tempDirs.push(dir)
  return dir
}

const STUB_SCRIPT = [
  "import { existsSync } from 'node:fs'",
  "import { join } from 'node:path'",
  'const argv = process.argv.slice(2)',
  'const rootIndex = argv.indexOf("--root")',
  'const root = rootIndex >= 0 ? argv[rootIndex + 1] : process.cwd()',
  'const method = argv[0] === "nd" ? argv[1] : argv[0]',
  'const envelope = (extra) => JSON.stringify({ protocol: "nd.workflow/1", plugin: { id: "agent-workflow-scrum", version: "0.1.0" }, root, diagnostics: [], ...extra })',
  'const supported = existsSync(join(root, ".agents", "config.json"))',
  'if (method === "detect") {',
  '  process.stdout.write(envelope({ supported, config: supported ? { schemaVersion: 1, mode: "standard", packageManager: "npm" } : undefined }) + "\\n")',
  '  process.exit(0)',
  '}',
  'if (method === "snapshot") {',
  '  if (!supported) { console.error("workflow not initialized"); process.exit(1) }',
  '  const tasks = [',
  '    { key: "1", sourcePath: "todo-0001-0001-bootstrap.md", contentHash: "h1", title: "Bootstrap", lifecycle: "todo", displayStatus: "ready", archived: false, legacyArchive: false, prdRefs: [], scope: [], criteria: [], diagnostics: [] },',
  '    { key: "2", sourcePath: "wip-0002-0002-dark-mode.md", contentHash: "h2", title: "Dark Mode", lifecycle: "wip", displayStatus: "in_progress", archived: false, legacyArchive: false, prdRefs: ["0002"], scope: [], criteria: [{ text: "toggle works", checked: true }], evidence: "browser pass", diagnostics: [{ severity: "warning", code: "prd_status_draft", message: "PRD 0002 is draft", sourcePath: ".agents/docs/prd/0002-dark-mode.md" }] },',
  '    { key: "3", sourcePath: "done/done-0003-0003-express.md", contentHash: "h3", title: "Express Todo", lifecycle: "done", displayStatus: "completed", archived: true, legacyArchive: false, prdRefs: [], scope: [], criteria: [{ text: "server saves", checked: true }], evidence: "integration test", humanAcceptance: "accepted by ND", diagnostics: [] },',
  '  ]',
  '  process.stdout.write(envelope({ snapshot: { version: 1, scannedAt: new Date().toISOString(), git: { available: false, dirty: false }, tasks, prds: [], diagnostics: [] } }) + "\\n")',
  '  process.exit(0)',
  '}',
  'console.error("unknown method"); process.exit(1)',
].join('\n')

interface Fixture {
  baseDir: string
  companyA: string
  companyB: string
  projectA: string
  projectB: string
  workspaceA: string
  workspaceB: string
  service: WorkflowService
  org: OrganizationStore
}

/** Company A project A has a linked, initialized workflow workspace; B is a bare second company. */
async function fixture(): Promise<Fixture> {
  const baseDir = await tempDir('nd-workflow-svc')
  const orgDir = join(baseDir, 'org')
  await mkdir(orgDir, { recursive: true })
  const org = new OrganizationStore(join(orgDir, 'organization.json'))
  await org.mutate({ type: 'company.create', name: 'Company A', mission: 'build' })
  await org.mutate({ type: 'company.create', name: 'Company B', mission: 'other' })
  const state = await org.state()
  const companyA = state.companies[0]!.id
  const companyB = state.companies[1]!.id

  const workspaceA = await stubWorkflowProject(join(baseDir, 'workspace-a'))
  const workspaceB = await stubWorkflowProject(join(baseDir, 'workspace-b'))
  await org.mutate({ type: 'project.create', companyId: companyA, name: 'A', objective: 'o', workspacePath: workspaceA })
  await org.mutate({ type: 'project.create', companyId: companyB, name: 'B', objective: 'o', workspacePath: workspaceB })
  const nextState = await org.state()
  const projectA = nextState.projects.find((item) => item.companyId === companyA)!.id
  const projectB = nextState.projects.find((item) => item.companyId === companyB)!.id

  const pluginStore = new WorkflowPluginStore(join(orgDir, 'workflow-plugins.json'))
  const service = new WorkflowService({ store: pluginStore, organization: org, pluginCacheDir: join(baseDir, 'plugin-cache') })
  return { baseDir, companyA, companyB, projectA, projectB, workspaceA, workspaceB, service, org }
}

/** Project with its own node_modules stub CLI and an initialized .agents/config.json. */
async function stubWorkflowProject(root: string): Promise<string> {
  const pkgDir = join(root, 'node_modules', '@next-mmo', 'agent-workflow-scrum')
  await mkdir(join(pkgDir, 'bin'), { recursive: true })
  await mkdir(join(root, '.agents'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'workflow-project', private: true }), 'utf8')
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({
    name: '@next-mmo/agent-workflow-scrum',
    version: '0.1.0',
    bin: { 'agent-workflow': './bin/agent-workflow.mjs' },
  }), 'utf8')
  await writeFile(join(pkgDir, 'bin', 'agent-workflow.mjs'), STUB_SCRIPT, 'utf8')
  await writeFile(join(root, '.agents', 'config.json'), JSON.stringify({ schemaVersion: 1, mode: 'standard', packageManager: 'npm' }), 'utf8')
  return root
}

const BUNDLE_MANIFEST: WorkflowPluginManifest = parseWorkflowPluginManifest({
  protocol: 'nd.workflow/1',
  id: 'agent-workflow-scrum',
  version: '0.1.0',
  surface: 'plugin',
  ndApiVersion: '1',
  description: 'pilot',
  contributions: [{ kind: 'workflow', id: 'scrum', protocolVersion: 1, methods: ['detect', 'readSnapshot', 'buildContext'] }],
  requestedPermissions: ['project.workflow.read', 'board.project', 'context.contribute'],
  transport: {
    kind: 'cli',
    invocation: 'nd <method>',
    requirements: { shell: false, fixedArgv: true, timeoutMs: 10_000, maxOutputBytes: 1_048_576, noInstall: true },
    methods: { detect: 'detect', readSnapshot: 'snapshot', buildContext: 'context' },
  },
  upstream: { package: '@next-mmo/agent-workflow-scrum', supportedConfigSchemas: [1], supportedModes: ['standard'], taskPrefixes: ['todo-'] },
})

async function writePluginBundle(baseDir: string): Promise<string> {
  const bundle = join(baseDir, 'plugin-bundle', 'nd')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'nd-plugin.json'), JSON.stringify(BUNDLE_MANIFEST, null, 2), 'utf8')
  return join(baseDir, 'plugin-bundle')
}

describe('WorkflowService', () => {
  it('installs on demand, detects, enables mirror, and refreshes an atomic snapshot', async () => {
    const fx = await fixture()
    const bundle = await writePluginBundle(fx.baseDir)
    const state = await fx.service.install({ kind: 'local', path: bundle })
    expect(state.plugins).toHaveLength(1)
    expect(state.plugins[0]?.source).toMatchObject({ kind: 'local' })

    const previews = await fx.service.detect(fx.companyA, fx.projectA)
    expect(previews).toHaveLength(1)
    expect(previews[0]).toMatchObject({ pluginId: 'agent-workflow-scrum', supported: true, config: { schemaVersion: 1 } })

    await fx.service.enable(fx.companyA, fx.projectA, 'agent-workflow-scrum')
    const view = await fx.service.projectView(fx.companyA, fx.projectA)
    expect(view.binding).toMatchObject({ mode: 'mirror', pluginId: 'agent-workflow-scrum', root: fx.workspaceA })
    expect(view.binding?.validatedAt).toBeDefined()

    await fx.service.refresh(fx.companyA, fx.projectA)
    const refreshed = await fx.service.projectView(fx.companyA, fx.projectA)
    expect(refreshed.snapshot?.stale).toBe(false)
    expect(refreshed.snapshot?.tasks.map((task) => task.title)).toEqual(['Bootstrap', 'Dark Mode', 'Express Todo'])
    expect(refreshed.snapshot?.tasks[2]?.humanAcceptance).toBe('accepted by ND')
  })

  it('routes plugin provenance and clone commands through the injected ND Core git runner', async () => {
    const fx = await fixture()
    const cacheDir = join(fx.baseDir, 'runner-cache')
    const calls: Array<{ cwd: string; args: string[] }> = []
    const runner: GitExecRunner = async (cwd, args) => {
      calls.push({ cwd, args })
      if (args[0] === 'clone') {
        const dest = args[2]!
        await mkdir(join(dest, 'nd'), { recursive: true })
        await writeFile(join(dest, 'nd', 'nd-plugin.json'), JSON.stringify(BUNDLE_MANIFEST), 'utf8')
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (args[1] === '--is-inside-work-tree') return { exitCode: 0, stdout: 'true\n', stderr: '' }
      if (args[1] === 'HEAD') return { exitCode: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }
      if (args[1] === '--abbrev-ref') return { exitCode: 0, stdout: 'main\n', stderr: '' }
      if (args[1] === '--porcelain') return { exitCode: 0, stdout: '', stderr: '' }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    }
    const pluginStore = new WorkflowPluginStore(join(fx.baseDir, 'runner-plugins.json'))
    const service = new WorkflowService({ store: pluginStore, organization: fx.org, pluginCacheDir: cacheDir, git: runner })

    const bundle = await writePluginBundle(fx.baseDir)
    await service.install({ kind: 'local', path: bundle })
    expect(calls[0]).toEqual({ cwd: bundle, args: ['rev-parse', '--is-inside-work-tree'] })

    calls.length = 0
    const url = 'https://example.invalid/plugin.git'
    const state = await service.install({ kind: 'git', url })
    expect(state.plugins[0]?.source).toMatchObject({ kind: 'git', url, resolvedSha: 'a'.repeat(40) })
    expect(calls[0]?.cwd).toBe(cacheDir)
    expect(calls[0]?.args.slice(0, 2)).toEqual(['clone', url])
    expect(calls.some((call) => call.args[1] === '--is-inside-work-tree' && call.cwd.startsWith(cacheDir))).toBe(true)
  })

  it('fails enablement without a linked workspace and before detection passes', async () => {
    const fx = await fixture()
    const bundle = await writePluginBundle(fx.baseDir)
    await fx.service.install({ kind: 'local', path: bundle })
    await expect(fx.service.enable(fx.companyA, fx.projectA, 'missing-plugin')).rejects.toThrow(/not installed/)

    const bare = await tempDir('nd-workflow-bare')
    await writeFile(join(bare, 'package.json'), '{}', 'utf8')
    await fx.org.mutate({ type: 'project.create', companyId: fx.companyA, name: 'Bare', objective: 'o', workspacePath: bare })
    const projects = (await fx.org.state()).projects.filter((item) => item.companyId === fx.companyA)
    const bareProject = projects.find((item) => item.name === 'Bare')!.id
    await expect(fx.service.enable(fx.companyA, bareProject, 'agent-workflow-scrum')).rejects.toThrow(/did not detect a compatible workflow/)
  })

  it('keeps the last good snapshot stale when the workspace is rebound, and recovers after re-enable', async () => {
    const fx = await fixture()
    const bundle = await writePluginBundle(fx.baseDir)
    await fx.service.install({ kind: 'local', path: bundle })
    await fx.service.enable(fx.companyA, fx.projectA, 'agent-workflow-scrum')
    await fx.service.refresh(fx.companyA, fx.projectA)

    await fx.org.mutate({ type: 'project.update', id: fx.projectA, patch: { workspacePath: fx.workspaceB } })
    await fx.service.refresh(fx.companyA, fx.projectA)
    const rebound = await fx.service.projectView(fx.companyA, fx.projectA)
    expect(rebound.snapshot?.stale).toBe(true)
    expect(rebound.snapshot?.lastError).toMatch(/re-validate|moved/i)
    expect(rebound.snapshot?.tasks).toHaveLength(3)

    await fx.service.enable(fx.companyA, fx.projectA, 'agent-workflow-scrum')
    await fx.service.refresh(fx.companyA, fx.projectA)
    const recovered = await fx.service.projectView(fx.companyA, fx.projectA)
    expect(recovered.snapshot?.stale).toBe(false)
    expect(recovered.binding?.root).toBe(fx.workspaceB)
  })

  it('marks snapshots stale when the workflow disappears from the project', async () => {
    const fx = await fixture()
    const bundle = await writePluginBundle(fx.baseDir)
    await fx.service.install({ kind: 'local', path: bundle })
    await fx.service.enable(fx.companyA, fx.projectA, 'agent-workflow-scrum')
    await fx.service.refresh(fx.companyA, fx.projectA)

    await rm(join(fx.workspaceA, '.agents'), { recursive: true, force: true })
    await fx.service.refresh(fx.companyA, fx.projectA)
    const stale = await fx.service.projectView(fx.companyA, fx.projectA)
    expect(stale.snapshot?.stale).toBe(true)
    expect(stale.snapshot?.lastError).toMatch(/non-zero-exit|workflow/)
  })

  it('disabling revokes the binding immediately and the snapshot shows as disconnected history', async () => {
    const fx = await fixture()
    const bundle = await writePluginBundle(fx.baseDir)
    await fx.service.install({ kind: 'local', path: bundle })
    await fx.service.enable(fx.companyA, fx.projectA, 'agent-workflow-scrum')
    await fx.service.refresh(fx.companyA, fx.projectA)

    await fx.service.disable(fx.companyA, fx.projectA, 'agent-workflow-scrum')
    const disabled = await fx.service.projectView(fx.companyA, fx.projectA)
    expect(disabled.binding).toBeUndefined()
    expect(disabled.snapshot?.tasks).toHaveLength(3)
    expect(disabled.disconnected).toBe(true)

    // Refresh without a binding fails closed; nothing new is mirrored.
    await expect(fx.service.refresh(fx.companyA, fx.projectA)).rejects.toThrow(/no enabled workflow/)
  })

  it('uninstalling a plugin cascades bindings and snapshots for every company', async () => {
    const fx = await fixture()
    const bundle = await writePluginBundle(fx.baseDir)
    await fx.service.install({ kind: 'local', path: bundle })
    await fx.service.enable(fx.companyA, fx.projectA, 'agent-workflow-scrum')
    await fx.service.enable(fx.companyB, fx.projectB, 'agent-workflow-scrum')

    const afterRemove = await fx.service.remove('agent-workflow-scrum')
    expect(afterRemove.plugins).toHaveLength(0)
    expect(afterRemove.bindings).toHaveLength(0)
    expect(afterRemove.snapshots).toHaveLength(0)
  })

  it('isolates bindings between companies sharing one plugin', async () => {
    const fx = await fixture()
    const bundle = await writePluginBundle(fx.baseDir)
    await fx.service.install({ kind: 'local', path: bundle })
    await fx.service.enable(fx.companyA, fx.projectA, 'agent-workflow-scrum')
    await fx.service.refresh(fx.companyA, fx.projectA)

    const viewB = await fx.service.projectView(fx.companyB, fx.projectB)
    expect(viewB.binding).toBeUndefined()
    expect(viewB.snapshot).toBeUndefined()
    await expect(fx.service.projectView(fx.companyB, fx.projectA)).rejects.toThrow(/Project not found/)
    await expect(fx.service.refresh(fx.companyB, fx.projectB)).rejects.toThrow(/no enabled workflow/)
  })

  it('refuses to enable with an incompatible or missing plugin and reports detection errors', async () => {
    const fx = await fixture()
    const previews = await fx.service.detect(fx.companyA, fx.projectA)
    expect(previews).toHaveLength(0)
    await expect(fx.service.detect(fx.companyA, fx.projectA, 'agent-workflow-scrum')).rejects.toThrow(/not installed/)
  })
})
