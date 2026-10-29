#!/usr/bin/env node
import { existsSync, promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []

for (const path of [
  'src/shared/nd-design/model.ts',
  'src/shared/nd-design/validate.ts',
  'src/shared/nd-design/commands.ts',
  'src/shared/nd-design/history.ts',
  'src/shared/nd-design/legacy.ts',
  'src/shared/nd-design/svg.ts',
  'src/shared/nd-design/spec.ts',
  'src/shared/nd-design/agent-context.ts',
  'src/main/design/design-session-service.ts',
  'src/main/design/design-store.ts',
  'src/main/design/design-agent-tool.ts',
  'src/main/design/design-agent-bridge.ts',
  'src/main/design/design-build.ts',
  'src/main/design/ipc.ts',
  'src/renderer/src/design/DesignWorkspace.tsx',
  'src/renderer/src/design/CanvasStage.tsx',
  'scripts/nd-design-mcp.mjs',
  'docs/nd-pencil.md',
]) {
  if (!existsSync(join(root, path))) errors.push(`missing in-repo ND Pencil file: ${path}`)
}

for (const retired of ['vendor/openpencil', 'resources/nd-pencil']) {
  if (existsSync(join(root, retired))) errors.push(`retired ND Pencil runtime path must be removed: ${retired}`)
}

const model = await read('src/shared/nd-design/model.ts')
for (const needle of ["ND_DESIGN_FORMAT = 'nd-pencil'", 'ND_DESIGN_VERSION = 2', "ND_DESIGN_EXTENSION = '.op'", 'maxNodes', 'maxDocumentBytes']) {
  if (!model.includes(needle)) errors.push(`ND Pencil v2 schema is missing ${needle}`)
}

const commands = await read('src/shared/nd-design/commands.ts')
for (const needle of ["op: 'insert'", "op: 'update'", "op: 'delete'", "op: 'reorder'", "op: 'group'", "op: 'ungroup'", 'applyDesignCommands', 'applyDesignHistoryCommands']) {
  if (!commands.includes(needle)) errors.push(`ND Pencil command reducer is missing ${needle}`)
}

const legacy = await read('src/shared/nd-design/legacy.ts')
for (const needle of ['openpencil-0.8.4', 'backup', 'legacyFill']) {
  if (!legacy.includes(needle)) errors.push(`legacy .op importer is missing ${needle}`)
}

const session = await read('src/main/design/design-session-service.ts')
for (const needle of ['class DesignSessionService', 'scheduleAutosave', 'performSave', 'agentApply', 'agentState', 'sourceHash', 'buildDesignPrompt']) {
  if (!session.includes(needle)) errors.push(`ND Pencil session service is missing ${needle}`)
}

const tool = await read('src/main/design/design-agent-tool.ts')
for (const needle of ["case 'state'", "case 'apply'", 'active project root', 'commands']) {
  if (!tool.includes(needle)) errors.push(`ND Pencil agent tool is missing ${needle}`)
}

const bridge = await read('src/main/design/design-agent-bridge.ts')
for (const needle of ['timingSafeEqual', "'127.0.0.1'", '/nd-design', 'ND_DSH_DESIGN_MCP_TOKEN', 'ND_DSH_DESIGN_MCP_ENTRY']) {
  if (!bridge.includes(needle)) errors.push(`ND Pencil design bridge is missing ${needle}`)
}

const broker = await read('src/main/engines/nd-native/nd-native-tool-broker.ts')
for (const needle of ["case 'nd_design'", "endsWith('.op')", 'nd_design']) {
  if (!broker.includes(needle)) errors.push(`ND Agent design routing is missing ${needle}`)
}

const mcp = await read('scripts/nd-design-mcp.mjs')
for (const needle of ["name: 'nd_design'", 'ND_DSH_DESIGN_MCP_TOKEN', '/nd-design', 'tools/call']) {
  if (!mcp.includes(needle)) errors.push(`ND Pencil MCP server is missing ${needle}`)
}

const patch = await read('configs/dsh/nd-dsh.patch.yml')
for (const needle of ['nd-design-mcp', 'ND_DSH_DESIGN_MCP_ENTRY', 'ND_DSH_DESIGN_MCP_TOKEN']) {
  if (!patch.includes(needle)) errors.push(`Harness patch is missing the ND Pencil design bridge: ${needle}`)
}

const builder = await read('electron-builder.yml')
if (!builder.includes('nd-design-mcp.mjs')) errors.push('electron-builder.yml must ship the ND Pencil MCP server')
if (builder.includes('resources/nd-pencil')) errors.push('electron-builder.yml must not ship the retired ND Pencil runtime')

const packageJson = JSON.parse(await read('package.json'))
if (!String(packageJson.scripts?.verify ?? '').includes('verify-design.mjs')) errors.push('pnpm verify must run verify-design.mjs')
if (packageJson.scripts?.['nd-pencil:build']) errors.push('package.json must not expose the retired nd-pencil:build script')

const gitmodules = await read('.gitmodules')
if (gitmodules.includes('vendor/openpencil')) errors.push('.gitmodules must not retain the OpenPencil submodule')

const agents = await read('AGENTS.md')
if (agents.includes('vendor/openpencil')) errors.push('AGENTS.md must describe the in-repo ND Pencil, not the retired vendor')
if (!/in-repo/i.test(agents)) errors.push('AGENTS.md must state that ND Pencil is in-repo')

const renderer = await read('src/renderer/src/design/DesignWorkspace.tsx') + await read('src/renderer/src/design/CanvasStage.tsx')
for (const needle of ['ND Pencil canvas', 'DesignAgentPromptBar', 'buildDesignAgentContext']) {
  if (!renderer.includes(needle)) errors.push(`ND Pencil renderer is missing ${needle}`)
}

const sourceText = await readSourceTree(join(root, 'src'))
for (const forbidden of ['vendor/openpencil', 'resources/nd-pencil', 'nd-pencil-controller', 'nd-pencil-host', 'ND_PENCIL_BINARY', 'op-host-web-server', 'op_host_web_bg.wasm']) {
  if (sourceText.includes(forbidden)) errors.push(`retired ND Pencil runtime reference remains in src: ${forbidden}`)
}
if (/OpenPencil/.test(sourceText)) errors.push('OpenPencil branding must not remain in product source')

if (errors.length > 0) {
  console.error('ND Pencil verification failed:')
  for (const error of errors) console.error(` - ${error}`)
  process.exit(1)
}
console.log('ND Pencil in-repo editor, schema, agent bridge, MCP and release gates verified.')

async function read(path) {
  try {
    return await fs.readFile(join(root, path), 'utf8')
  } catch {
    errors.push(`could not read ${path}`)
    return ''
  }
}

async function readSourceTree(directory) {
  let text = ''
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) text += await readSourceTree(path)
    else if (/\.(?:ts|tsx)$/.test(entry.name)) text += await fs.readFile(path, 'utf8')
  }
  return text
}
