import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowCliClient } from '../src/main/workflows/workflow-cli-client.js'
import { parseWorkflowPluginManifest, type WorkflowPluginManifest } from '../src/shared/workflow-plugins.js'

const tempDirs: string[] = []

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))

afterEach(async () => {
  delete process.env.STUB_MODE
  // Killed CLI children can hold the script open briefly on Windows; retry
  // instead of failing the test on an EBUSY teardown race.
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })))
})

/** A project whose own dependency tree contains a stub `@next-mmo/agent-workflow-scrum` CLI. */
async function stubProject(scriptBody: string, env: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nd-workflow-cli-'))
  tempDirs.push(root)
  const pkgDir = join(root, 'node_modules', '@next-mmo', 'agent-workflow-scrum')
  await mkdir(join(pkgDir, 'bin'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture-project', private: true }), 'utf8')
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({
    name: '@next-mmo/agent-workflow-scrum',
    version: '0.1.0',
    bin: { 'agent-workflow': './bin/agent-workflow.mjs' },
  }), 'utf8')
  await writeFile(join(pkgDir, 'bin', 'agent-workflow.mjs'), [
    "import { existsSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const argv = process.argv.slice(2)',
    'const rootIndex = argv.indexOf("--root")',
    'const root = rootIndex >= 0 ? argv[rootIndex + 1] : process.cwd()',
    'const method = argv[0] === "nd" ? argv[1] : argv[0]',
    'const envelope = (extra) => JSON.stringify({ protocol: "nd.workflow/1", plugin: { id: "agent-workflow-scrum", version: "0.1.0" }, root, diagnostics: [], ...extra })',
    scriptBody,
  ].join('\n'), 'utf8')
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  return root
}

function manifest(overrides: Partial<{ timeoutMs: number; maxOutputBytes: number }> = {}): WorkflowPluginManifest {
  return parseWorkflowPluginManifest({
    protocol: 'nd.workflow/1',
    id: 'agent-workflow-scrum',
    version: '0.1.0',
    surface: 'plugin',
    ndApiVersion: '1',
    description: 'stub fixture plugin',
    contributions: [{ kind: 'workflow', id: 'scrum', protocolVersion: 1, methods: ['detect', 'readSnapshot', 'buildContext'] }],
    requestedPermissions: ['project.workflow.read'],
    transport: {
      kind: 'cli',
      invocation: 'nd <method>',
      requirements: { shell: false, fixedArgv: true, timeoutMs: overrides.timeoutMs ?? 10_000, maxOutputBytes: overrides.maxOutputBytes ?? 1_048_576, noInstall: true },
      methods: { detect: 'detect', readSnapshot: 'snapshot', buildContext: 'context' },
    },
    upstream: { package: '@next-mmo/agent-workflow-scrum', supportedConfigSchemas: [1], supportedModes: ['standard'], taskPrefixes: ['todo-'] },
  })
}

const HANDLER = `
const supported = existsSync(join(root, ".agents", "config.json"))
if (process.env.STUB_MODE === "fail") { console.error("workflow not initialized"); process.exit(1) }
if (process.env.STUB_MODE === "garbage") { process.stdout.write("definitely not json"); process.exit(0) }
if (process.env.STUB_MODE === "foreign") {
  process.stdout.write(JSON.stringify({ protocol: "nd.workflow/1", plugin: { id: "other-plugin", version: "9.9.9" }, root, diagnostics: [] }) + "\\n")
  process.exit(0)
}
if (process.env.STUB_MODE === "big") { process.stdout.write("x".repeat(2_000_000)); process.exit(0) }
if (process.env.STUB_MODE === "slow") {
  setTimeout(() => { process.stdout.write(envelope({ supported: true }) + "\\n") }, 30_000)
} else if (method === "detect") {
  process.stdout.write(envelope({ supported, config: supported ? { schemaVersion: 1, mode: "standard", packageManager: "npm" } : undefined }) + "\\n")
  process.exit(0)
} else if (method === "snapshot") {
  if (!supported) { console.error("workflow not initialized"); process.exit(1) }
  const task = (key, lifecycle, displayStatus, extra = {}) => ({ key, sourcePath: lifecycle + "-" + key + "-x.md", contentHash: "h" + key, title: "Task " + key, lifecycle, archived: lifecycle === "done", legacyArchive: false, prdRefs: [], scope: [], criteria: [], diagnostics: [], ...extra, ...(displayStatus ? { displayStatus } : {}) })
  process.stdout.write(envelope({
    snapshot: {
      version: 1,
      scannedAt: new Date().toISOString(),
      git: { available: true, branch: "main", head: "a".repeat(40), dirty: false },
      tasks: [
        task("1", "todo", "ready"),
        task("2", "wip", "in_progress", { criteria: [{ text: "c", checked: true }], evidence: "pass" }),
        task("3", "done", "completed", { humanAcceptance: "accepted by ND" }),
      ],
      prds: [],
      diagnostics: [{ severity: "warning", code: "prd_missing_from_index", message: "PRD 0002 missing from index" }],
    },
  }) + "\\n")
  process.exit(0)
} else {
  console.error("unknown method " + String(method))
  process.exit(1)
}
`

describe('WorkflowCliClient', () => {
  it('runs detect through the project-local package bin with fixed argv', async () => {
    const root = await stubProject(HANDLER)
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(join(root, '.agents', 'config.json'), JSON.stringify({ schemaVersion: 1, mode: 'standard', packageManager: 'npm' }), 'utf8')
    const response = await new WorkflowCliClient().run(root, 'detect', manifest())
    expect(response.envelope.plugin.id).toBe('agent-workflow-scrum')
    expect(response.envelope.root).toBe(root)
    expect(response.detection).toMatchObject({ supported: true, config: { schemaVersion: 1, mode: 'standard', packageManager: 'npm' } })
  })

  it('reads a snapshot and validates every record', async () => {
    const root = await stubProject(HANDLER)
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(join(root, '.agents', 'config.json'), '{}', 'utf8')
    const response = await new WorkflowCliClient().run(root, 'readSnapshot', manifest())
    expect(response.snapshot?.tasks).toHaveLength(3)
    expect(response.snapshot?.tasks.map((task) => task.displayStatus)).toEqual(['ready', 'in_progress', 'completed'])
    expect(response.snapshot?.tasks[1]?.criteria.filter((item) => item.checked)).toHaveLength(1)
    expect(response.snapshot?.diagnostics[0]?.code).toBe('prd_missing_from_index')
  })

  it('reports detection failure without treating it as a runtime error', async () => {
    const root = await stubProject(HANDLER)
    const response = await new WorkflowCliClient().run(root, 'detect', manifest())
    expect(response.detection).toEqual({ supported: false })
  })

  it('fails closed when the project has not installed the workflow package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-workflow-cli-'))
    tempDirs.push(root)
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'bare', private: true }), 'utf8')
    await expect(new WorkflowCliClient().run(root, 'detect', manifest())).rejects.toMatchObject({ code: 'package-missing' })
  })

  it('rejects the buildContext method until context injection ships', async () => {
    const root = await stubProject(HANDLER)
    await expect(new WorkflowCliClient().run(root, 'buildContext', manifest())).rejects.toMatchObject({ code: 'transport-unsupported' })
  })

  it('enforces the deadline', async () => {
    const root = await stubProject(HANDLER, { STUB_MODE: 'slow' })
    await expect(new WorkflowCliClient().run(root, 'detect', manifest({ timeoutMs: 2_000 }))).rejects.toMatchObject({ code: 'timeout' })
  }, 15_000)

  it('enforces the output cap', async () => {
    const root = await stubProject(HANDLER, { STUB_MODE: 'big' })
    await expect(new WorkflowCliClient().run(root, 'detect', manifest({ maxOutputBytes: 4_096 }))).rejects.toMatchObject({ code: 'output-cap' })
  })

  it('surfaces non-zero exits and invalid JSON as typed errors', async () => {
    const failed = await stubProject(HANDLER, { STUB_MODE: 'fail' })
    await mkdir(join(failed, '.agents'), { recursive: true })
    await writeFile(join(failed, '.agents', 'config.json'), '{}', 'utf8')
    await expect(new WorkflowCliClient().run(failed, 'readSnapshot', manifest())).rejects.toMatchObject({ code: 'non-zero-exit' })

    const garbage = await stubProject(HANDLER, { STUB_MODE: 'garbage' })
    await expect(new WorkflowCliClient().run(garbage, 'detect', manifest())).rejects.toMatchObject({ code: 'invalid-json' })
  })

  it('rejects results from a foreign plugin identity', async () => {
    const root = await stubProject(HANDLER, { STUB_MODE: 'foreign' })
    await expect(new WorkflowCliClient().run(root, 'detect', manifest())).rejects.toMatchObject({ code: 'envelope-invalid' })
  })
})
