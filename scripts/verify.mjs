#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pin = JSON.parse(await fs.readFile(join(root, 'vendor', 'deepseek-harness.json'), 'utf8'))
// Harness tracks upstream latest during beta; metadata records provenance only.
const harnessBranch = typeof pin.branch === 'string' ? pin.branch.trim() : ''
const harnessRepository = typeof pin.repository === 'string' ? pin.repository : ''
const errors = []
const notes = []

const required = [
  '.gitmodules',
  '.env.example',
  'configs/dsh/nd-dsh.patch.yml',
  'configs/dsh/agent-presets/nd-dsh/preset.yml',
  'configs/dsh/agent-presets/nd-dsh/agent.cordis.yml',
  'configs/dsh/agent-presets/nd-dsh/coordination-policy.md',
  'configs/dsh/agent-presets/nd-dsh/skills/live-browser/SKILL.md',
  '.dsh/skills/live-browser/SKILL.md',
  'docs/architecture.md',
  'docs/coding-engine-architecture.md',
  'docs/roadmap.md',
  'src/main/index.ts',
  'src/main/browser/browser-controller.ts',
  'src/main/dsh/gateway-client.ts',
  'src/main/dsh/dsh-surface.ts',
  'src/main/engines/coding-engine-registry.ts',
  'src/main/harness/harness-service.ts',
  'src/preload/index.ts',
  'src/renderer/index.html',
  'src/renderer/src/App.tsx',
  'src/shared/coding-engines.ts',
  'src/shared/contracts.ts',
  'vendor/deepseek-harness.json',
]
for (const path of required) {
  if (!existsSync(join(root, path))) errors.push(`missing required file: ${path}`)
}
for (const stale of [
  'configs/dsh/cordis.yml',
  'docs/ARCHITECTURE.md',
  'docs/ROADMAP.md',
  'tsconfig.node.tsbuildinfo',
  'tsconfig.web.tsbuildinfo',
  'src/renderer/src/components/MockWebPage.tsx',
  'src/renderer/src/components/DshPane.tsx',
  'src/renderer/src/lib/web-bridge.ts',
  'src/renderer/src/lib/web-chat.ts',
  'src/renderer/src/lib/web-mock.ts',
  'src/renderer/src/lib/web-organization-mock.ts',
  'src/renderer/src/lib/web-sidecar.ts',
  'src/shared/web-sidecar.ts',
  'scripts/web-sidecar.mjs',
]) {
  // Compare against real directory entries: existsSync is case-insensitive on
  // Windows, so the legacy uppercase prototypes would always look present.
  if (await caseSensitiveExists(join(root, stale))) {
    errors.push(`stale generated/prototype file must be removed: ${stale}`)
  }
}

if (!harnessBranch) errors.push('Harness metadata must name the tracked upstream branch')
if (harnessRepository !== 'https://github.com/deepseek-ai/deepseek-harness.git') {
  errors.push('Harness repository must be the official deepseek-ai/deepseek-harness repository')
}

const packageJson = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'))
const expectedPins = {
  'agent-browser': '0.34.0',
  electron: '43.4.0',
  'electron-vite': '5.0.0',
  typescript: '7.0.2',
  vite: '8.2.1',
}
for (const [name, version] of Object.entries(expectedPins)) {
  if (packageJson.devDependencies?.[name] !== version) errors.push(`${name} must remain pinned to ${version}`)
}
if (packageJson.dependencies?.react !== '19.2.8' || packageJson.dependencies?.['react-dom'] !== '19.2.8') {
  errors.push('React and react-dom must remain aligned at 19.2.8')
}
if (!String(packageJson.engines?.node ?? '').includes('24')) errors.push('package.json must require Node 24+')
if (!String(packageJson.packageManager ?? '').startsWith('pnpm@11.')) errors.push('packageManager must pin pnpm 11')
if (Object.keys(packageJson.scripts ?? {}).some((name) => name.includes('mock') || name.includes('sidecar'))) {
  errors.push('package.json must not expose the retired mock/web-sidecar prototype as a product script')
}

// The Harness submodule tracks upstream latest; the ND Pencil submodule stays commit-pinned.
function gitmodulesSection(content, submodulePath) {
  const escaped = submodulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\[submodule "${escaped}"\\]([^\\[]*)`).exec(content)?.[1] ?? ''
}
const gitmodules = await fs.readFile(join(root, '.gitmodules'), 'utf8')
const harnessSection = gitmodulesSection(gitmodules, 'vendor/deepseek-harness')
if (!harnessSection.includes(harnessRepository)) errors.push('DeepSeek Harness submodule URL is missing or differs from pin metadata')
if (harnessBranch && !new RegExp(`^\\s*branch\\s*=\\s*${harnessBranch}\\s*$`, 'm').test(harnessSection)) {
  errors.push(`DeepSeek Harness submodule must track the upstream ${harnessBranch} branch`)
}
if (/^\s*branch\s*=/m.test(gitmodulesSection(gitmodules, 'vendor/openpencil'))) {
  errors.push('Pinned ND Pencil upstream submodule must not track a moving branch')
}

const vendorReadme = await fs.readFile(join(root, 'vendor/README.md'), 'utf8')
const projectReadme = await fs.readFile(join(root, 'README.md'), 'utf8')
for (const [name, content] of [['vendor/README.md', vendorReadme], ['README.md', projectReadme]]) {
  if (!content.includes('upstream latest')) errors.push(`${name} must document that the Harness runtime tracks upstream latest`)
}
if (!projectReadme.includes('corepack pnpm dsh:update')) {
  errors.push('README must document Harness runtime syncs through dsh:update')
}

const patch = await fs.readFile(join(root, 'configs/dsh/nd-dsh.patch.yml'), 'utf8')
for (const needle of [
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-subagent-codex',
  'providerName: codex',
  'ND_DSH_CODEX_PERMISSION_MODE',
  'ND_BROWSER_COMPANION_RUNTIME',
  'failOnStartupError: true',
  'DSH_PERMISSION_MODE',
  'DSH_CWD',
  'dshHomePath',
  'default: nd-dsh',
]) {
  if (!patch.includes(needle)) errors.push(`configs/dsh/nd-dsh.patch.yml is missing ${needle}`)
}
if (patch.includes('policy: never')) {
  errors.push('configs/dsh/nd-dsh.patch.yml must not pin the Harness approval policy to never (the engine default ask backs the approval UI)')
}

const preset = await fs.readFile(join(root, 'configs/dsh/agent-presets/nd-dsh/agent.cordis.yml'), 'utf8')
for (const needle of [
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill',
  "new URL('skills/', baseUrl)",
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-compaction-basic',
  'provider: codex',
  'toolName: subagent_codex',
]) {
  if (!preset.includes(needle)) errors.push(`configs/dsh/agent-presets/nd-dsh/agent.cordis.yml is missing ${needle}`)
}
const codexToolBlock = /- id: tool-subagent-codex\b([\s\S]*?)(?=\n\s*- id:|$)/.exec(preset)?.[1] ?? ''
if (!codexToolBlock || /disabled:\s*true/.test(codexToolBlock)) {
  errors.push('ND-DSH Codex coding-engine tool must be enabled in the standard agent preset')
}
const personaBlock = /- id: persona\b([\s\S]*?)(?=\n\s*- id:|$)/.exec(preset)?.[1] ?? ''
if (!personaBlock.includes('prefix:')) {
  errors.push('configs/dsh/agent-presets/nd-dsh/agent.cordis.yml persona row must configure prefix')
}
const presetMeta = await fs.readFile(join(root, 'configs/dsh/agent-presets/nd-dsh/preset.yml'), 'utf8')
if (!presetMeta.includes('name: ND-DSH')) errors.push('configs/dsh/agent-presets/nd-dsh/preset.yml must name the ND-DSH preset')

const mainProcess = await fs.readFile(join(root, 'src/main/index.ts'), 'utf8')
if (!mainProcess.includes("app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')")) {
  errors.push('src/main/index.ts must bind Electron CDP to 127.0.0.1 only')
}
if (!mainProcess.includes("app.commandLine.appendSwitch('remote-debugging-port'")) {
  errors.push('src/main/index.ts must keep the explicit Electron CDP port switch')
}

const harnessService = await fs.readFile(join(root, 'src/main/harness/harness-service.ts'), 'utf8')
for (const needle of ["'--profile', 'web'", "'--patch'", "'--no-open'", "'--port'", '127.0.0.1']) {
  if (!harnessService.includes(needle)) errors.push(`src/main/harness/harness-service.ts must launch the web profile with ${needle}`)
}
if (harnessService.includes("'--host'")) {
  errors.push('src/main/harness/harness-service.ts must not pass --host; the gateway binds loopback only')
}

const dshSurface = await fs.readFile(join(root, 'src/main/dsh/dsh-surface.ts'), 'utf8')
for (const needle of ['sandbox: true', 'contextIsolation: true', 'nodeIntegration: false', 'webSecurity: true']) {
  if (!dshSurface.includes(needle)) errors.push(`src/main/dsh/dsh-surface.ts must keep the DSH UI view hardened (${needle})`)
}

const gatewayClient = await fs.readFile(join(root, 'src/main/dsh/gateway-client.ts'), 'utf8')
for (const needle of ['/api/respond', '/api/events.mux', '/api/events.host', "type: 'client-request'"]) {
  if (!gatewayClient.includes(needle)) errors.push(`src/main/dsh/gateway-client.ts must speak the upstream gateway protocol (${needle})`)
}

const rendererHtml = await fs.readFile(join(root, 'src/renderer/index.html'), 'utf8')
for (const directive of ["default-src 'self'", "script-src 'self'", "connect-src 'self'"]) {
  if (!rendererHtml.includes(directive)) errors.push(`renderer CSP is missing ${directive}`)
}
const rendererMain = await fs.readFile(join(root, 'src/renderer/src/main.tsx'), 'utf8')
if (!rendererMain.includes('ND runtime unavailable') || rendererMain.includes('installWebBridge') || !rendererMain.includes('import.meta.env.DEV')) {
  errors.push('renderer must fail closed in production; any UI-only browser preview must be explicitly development-gated')
}
const browserUrl = await fs.readFile(join(root, 'src/main/browser/browser-url.ts'), 'utf8')
if (!browserUrl.includes("DEFAULT_BROWSER_URL = 'about:blank'")) {
  errors.push('product browser must default to about:blank instead of a development server')
}

const sourceFiles = await walk(join(root, 'src'))
const testFiles = await walk(join(root, 'tests'))
const scriptFiles = await walk(join(root, 'scripts'))
const typescriptFiles = [...sourceFiles, ...testFiles].filter((path) => ['.ts', '.tsx'].includes(extname(path)))
const staleTerms = [
  'agent-browser-bridge',
  'AgentBrowserBridge',
  'HarnessRuntime',
  'MockOrganizationService',
  'MockSessionRuntime',
  'MockWorkspaceService',
]
const thisVerifier = fileURLToPath(import.meta.url)
for (const file of typescriptFiles) {
  if (file === thisVerifier) continue
  const content = await fs.readFile(file, 'utf8')
  for (const term of staleTerms) {
    if (content.includes(term)) errors.push(`${relative(root, file)} still references discarded prototype ${term}`)
  }
  if (content.includes('DeepSeek ↗')) errors.push(`${relative(root, file)} exposes a vendor-specific DeepSeek product shortcut`)
}

for (const file of typescriptFiles) {
  const content = await fs.readFile(file, 'utf8')
  for (const specifier of relativeImports(content)) {
    if (!resolveLocalImport(file, specifier)) errors.push(`${relative(root, file)} has unresolved import ${specifier}`)
  }
  if (file.includes(`${join('src', 'renderer', 'src')}`) && /(?:from\s+|import\s*\()(['"])(?:electron|node:)/.test(content)) {
    errors.push(`${relative(root, file)} imports a privileged Electron/Node module into the renderer`)
  }
}

for (const file of scriptFiles.filter((path) => extname(path) === '.mjs')) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    errors.push(`${relative(root, file)} failed Node syntax check: ${commandError(error)}`)
  }
}

const ts = loadTypeScript()
if (ts && typeof ts.transpileModule === 'function') {
  const transpileFiles = typescriptFiles.filter((file) => !file.endsWith('.d.ts'))
  for (const file of transpileFiles) {
    const content = await fs.readFile(file, 'utf8')
    try {
      const output = ts.transpileModule(content, {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
          isolatedModules: true,
        },
      })
      for (const diagnostic of output.diagnostics ?? []) {
        if (diagnostic.category !== ts.DiagnosticCategory.Error) continue
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
        errors.push(`${relative(root, file)}:${diagnostic.start ?? 0} TypeScript syntax error TS${diagnostic.code}: ${message}`)
      }
    } catch (error) {
      errors.push(`${relative(root, file)} could not be transpile-checked with TypeScript ${ts.version}: ${commandError(error)}`)
    }
  }
  notes.push(`TypeScript ${ts.version} transpile syntax check passed for ${transpileFiles.length} files.`)
} else if (ts) {
  notes.push(`TypeScript ${ts.version} does not expose the legacy transpile API; syntax is covered by \`pnpm typecheck\`.`)
} else {
  notes.push('TypeScript package unavailable; skipped transpile syntax checks (relative imports and Node scripts were still checked).')
}

for (const cssFile of sourceFiles.filter((path) => extname(path) === '.css')) {
  const content = await fs.readFile(cssFile, 'utf8')
  const balance = braceBalance(content)
  if (balance !== 0) errors.push(`${relative(root, cssFile)} has unbalanced CSS braces (${balance})`)
}

const harnessRoot = join(root, 'vendor', 'deepseek-harness')
if (existsSync(join(harnessRoot, 'package.json'))) {
  try {
    const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: harnessRoot, encoding: 'utf8' }).trim().toLowerCase()
    notes.push(`Harness submodule checked out at ${actual.slice(0, 12)} (tracks upstream ${harnessBranch || 'master'} latest).`)
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: harnessRoot, encoding: 'utf8' }).trim()
    if (dirty) errors.push('populated Harness submodule has local changes')
  } catch (error) {
    errors.push(`could not verify populated Harness submodule: ${commandError(error)}`)
  }
} else {
  notes.push('Harness submodule is not populated in this archive; bootstrap will initialize and sync it to upstream latest.')
}

if (existsSync(join(root, '.git'))) {
  try {
    const stage = execFileSync('git', ['ls-files', '--stage', '--', 'vendor/deepseek-harness'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    if (!stage) {
      errors.push('repository is initialized but the Harness submodule gitlink is missing')
    } else if (!stage.startsWith('160000 ')) {
      errors.push(`repository Harness gitlink is malformed: ${stage}`)
    }
  } catch (error) {
    errors.push(`could not verify repository gitlink: ${commandError(error)}`)
  }
}

if (errors.length) {
  console.error('ND-DSH verification failed:\n')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`ND-DSH static verification passed (${sourceFiles.length} source files, ${testFiles.length} test files).`)
for (const note of notes) console.log(note)

async function walk(directory) {
  const result = []
  if (!existsSync(directory)) return result
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await walk(path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}

function relativeImports(content) {
  const imports = []
  const pattern = /(?:from\s+|import\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g
  for (const match of content.matchAll(pattern)) imports.push(match[2])
  const sideEffect = /import\s+(['"])(\.{1,2}\/[^'"]+)\1/g
  for (const match of content.matchAll(sideEffect)) imports.push(match[2])
  return [...new Set(imports)]
}

function resolveLocalImport(importer, specifier) {
  // Vite import queries (`?raw`, `?url`, `?inline`) are bundler directives, not
  // part of the path; the file behind them still has to exist on disk.
  const [pathPart] = specifier.split('?')
  const base = resolve(dirname(importer), pathPart)
  const candidates = [base]
  if (base.endsWith('.js')) candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx')
  if (!extname(base)) {
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.css`, join(base, 'index.ts'), join(base, 'index.tsx'))
  }
  return candidates.find((candidate) => existsSync(candidate))
}

async function caseSensitiveExists(path) {
  try {
    const entries = await fs.readdir(dirname(path))
    return entries.includes(basename(path))
  } catch {
    return false
  }
}

function loadTypeScript() {
  const require = createRequire(import.meta.url)
  const candidates = [
    'typescript',
    join(resolve(dirname(process.execPath), '..'), 'lib', 'node_modules', 'typescript', 'lib', 'typescript.js'),
  ]
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {
      // Try the next local/global installation.
    }
  }
  return undefined
}

function braceBalance(content) {
  let balance = 0
  let quote = ''
  let inComment = false
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    const next = content[index + 1]
    if (inComment) {
      if (char === '*' && next === '/') {
        inComment = false
        index += 1
      }
      continue
    }
    if (!quote && char === '/' && next === '*') {
      inComment = true
      index += 1
      continue
    }
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '{') balance += 1
    if (char === '}') balance -= 1
    if (balance < 0) return balance
  }
  return balance
}

function commandError(error) {
  if (error && typeof error === 'object') {
    const stderr = error.stderr
    if (Buffer.isBuffer(stderr)) return stderr.toString('utf8').trim()
    if (typeof stderr === 'string') return stderr.trim()
  }
  return error instanceof Error ? error.message : String(error)
}
