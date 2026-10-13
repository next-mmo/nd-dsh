/** Reproducible warmed registry benchmark; no renderer/OS measurements are implied. */
import { build } from 'vite'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = await mkdtemp(join(tmpdir(), 'nd-extension-scale-'))
try {
  const source = [
    `export { ExtensionPackageStore } from ${JSON.stringify(join(repo, 'src/main/extensions/package-store.ts'))}`,
    `export { InvocationStateStore } from ${JSON.stringify(join(repo, 'src/main/extensions/invocation-state.ts'))}`,
    `export { InvocationBroker } from ${JSON.stringify(join(repo, 'src/main/extensions/invocation-broker.ts'))}`,
    `export { NativeHostRegistry } from ${JSON.stringify(join(repo, 'src/main/extensions/native-host.ts'))}`,
    `export { validateNdExtensionManifest } from ${JSON.stringify(join(repo, 'src/shared/extension-package.ts'))}`,
  ].join('\n')
  await writeFile(join(root, 'entry.mjs'), source)
  await build({ configFile: false, logLevel: 'error', build: { ssr: true, outDir: join(root, 'bundle'), rollupOptions: { input: join(root, 'entry.mjs'), output: { entryFileNames: 'entry.mjs' } } } })
  const { ExtensionPackageStore, InvocationStateStore, InvocationBroker, NativeHostRegistry, validateNdExtensionManifest } = await import(pathToFileURL(join(root, 'bundle/entry.mjs')).href)
  const base = { protocol: 'nd.extension/1', id: 'nd.audit', name: 'Audit', description: 'Fixture', version: '1.0.0', apiVersion: 1,
    contexts: ['personal'], permissions: ['notes.write'], settings: [], contributions: { commands: [{ id: 'note', title: 'Note', host: 'note.create', contexts: ['personal'] }] } }
  const results = []
  for (const count of [10, 100, 1_000, 5_000]) {
    const dir = join(root, String(count)); await mkdir(dir)
    const records = Array.from({ length: count }, (_, index) => ({ manifest: validateNdExtensionManifest({ ...base, id: `nd.audit-${index}` }).manifest,
      source: { kind: 'local', location: '/audit' }, installedAt: 1, updatedAt: 1, versions: ['1.0.0'] }))
    await writeFile(join(dir, 'nd-extensions.json'), JSON.stringify({ version: 1, packages: records }))
    await writeFile(join(dir, 'nd-invocation-state.json'), JSON.stringify({ version: 1, activations: records.map(({ manifest }) => ({ extensionId: manifest.id, contextKey: 'personal', context: { kind: 'personal' }, enabled: true, settings: {}, updatedAt: 1 })), grants: [], audit: [] }))
    const packages = new ExtensionPackageStore(dir), state = new InvocationStateStore(dir)
    const deps = { packages, state, host: new NativeHostRegistry(), organization: { state: async () => ({ companies: [], projects: [] }), policy: async () => 'allow' } }
    const broker = new InvocationBroker(deps)
    await broker.commands({ kind: 'personal' })
    const measure = async (operation) => {
      const times = []
      for (let i = 0; i < 7; i++) {
        const start = performance.now(); const result = await operation()
        if (result.length !== count) throw new Error('Incomplete benchmark output')
        times.push(performance.now() - start)
      }
      times.sort((a, b) => a - b)
      return +times[3].toFixed(2)
    }
    results.push({ installedExtensions: count,
      uncachedMedianMs: await measure(() => new InvocationBroker(deps).commands({ kind: 'personal' })),
      cachedMedianMs: await measure(() => broker.commands({ kind: 'personal' })) })
  }
  const result = { scope: 'Local synthetic registry, one activated command per extension; seven warmed samples', results }
  console.log(JSON.stringify(result, null, 2))
  if (process.argv[2]) await writeFile(resolve(process.argv[2]), JSON.stringify(result, null, 2) + '\n')
} finally { await rm(root, { recursive: true, force: true }) }
