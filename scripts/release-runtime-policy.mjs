import { promises as fs } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** An advertised optional package must remain installable from shipped resources. */
export async function assertTranslateManifest(manifestPath) {
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  } catch (cause) {
    throw new Error(`ND Translate release manifest is missing or invalid: ${manifestPath}`, { cause })
  }
  const views = manifest?.contributions?.views
  const commands = manifest?.contributions?.commands
  const view = Array.isArray(views) ? views.find((item) => item?.id === 'translator') : undefined
  const command = Array.isArray(commands) ? commands.find((item) => item?.id === 'translate') : undefined
  if (manifest?.protocol !== 'nd.extension/1' || manifest.id !== 'nd.translate' || manifest.apiVersion !== 1
    || view?.host !== 'browser.translate' || command?.host !== 'browser.translate' || command?.openViewId !== 'translator') {
    throw new Error(`ND Translate release manifest has invalid identity or contributions: ${manifestPath}`)
  }
}

/** Exclude only native Office payloads, keeping upstream plugin metadata intact. */
export async function officeEngineDirectories(runtimeRoot) {
  const found = []
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(directory, entry.name)
      if (entry.name.startsWith('libreoffice-kit-') && directory.endsWith(join('node_modules', '@deepseek-ai'))) {
        found.push(path)
      } else {
        await walk(path)
      }
    }
  }
  await walk(resolve(runtimeRoot))
  return found
}

export async function removeOfficeEngines(runtimeRoot) {
  // macOS aliases /var to /private/var. Walk from the canonical staging root
  // so that alias does not look like a target escaping the deletion boundary.
  const root = await fs.realpath(resolve(runtimeRoot))
  const paths = await officeEngineDirectories(root)
  // Resolve every deletion target before the first mutation. Never follow an
  // unexpected staging junction into a source checkout or another directory.
  const realRoot = root
  for (const path of paths) {
    const inside = relative(realRoot, await fs.realpath(path))
    if (!inside || inside.startsWith('..') || resolve(realRoot, inside) !== resolve(path)) {
      throw new Error(`Office engine deletion is outside release staging: ${path}`)
    }
  }
  for (const path of paths) await fs.rm(path, { recursive: true, force: true })
  return paths.length
}

export async function assertNoOfficeEngines(runtimeRoot) {
  const paths = await officeEngineDirectories(runtimeRoot)
  if (paths.length) throw new Error(`Release must not bundle native Office engines: ${paths.join(', ')}`)
}
