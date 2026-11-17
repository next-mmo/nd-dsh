import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { SAFE_ID, SAFE_STORE_ID } from './security.js'
import { HttpError } from './types.js'
import type { HubConfig, ProjectConfig } from './types.js'

interface RawProject {
  id?: unknown
  name?: unknown
  path?: unknown
  store?: unknown
  watch?: unknown
}

export function loadConfig(configPath: string): HubConfig {
  const abs = path.resolve(configPath)
  if (!existsSync(abs)) {
    throw new Error(`config file not found: ${abs}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'))
  } catch (err) {
    throw new Error(`config file is not valid JSON: ${(err as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { projects?: unknown }).projects)) {
    throw new Error('config must be an object with a "projects" array')
  }
  const baseDir = path.dirname(abs)
  const seen = new Set<string>()
  const projects: ProjectConfig[] = []
  for (const entry of (raw as { projects: RawProject[] }).projects) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('each project entry must be an object')
    }
    const id = entry.id
    if (typeof id !== 'string' || !SAFE_ID.test(id)) {
      throw new Error(`project id must match ${SAFE_ID} (got ${JSON.stringify(id)})`)
    }
    if (seen.has(id)) throw new Error(`duplicate project id: ${id}`)
    seen.add(id)
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new Error(`project ${id}: "path" must be a non-empty string`)
    }
    const resolved = path.resolve(baseDir, entry.path)
    const canonical = existsSync(resolved) ? realpathSync(resolved) : resolved
    const project: ProjectConfig = {
      id,
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
      path: canonical,
    }
    if (entry.store !== undefined) {
      if (typeof entry.store !== 'string' || !SAFE_STORE_ID.test(entry.store)) {
        throw new Error(`project ${id}: "store" must match ${SAFE_STORE_ID}`)
      }
      project.store = entry.store
    }
    if (entry.watch !== undefined) {
      if (typeof entry.watch !== 'boolean') {
        throw new Error(`project ${id}: "watch" must be a boolean`)
      }
      project.watch = entry.watch
    }
    projects.push(project)
  }
  return { projects }
}

export function findProject(config: HubConfig, id: string): ProjectConfig {
  const project = config.projects.find((p) => p.id === id)
  if (!project) {
    throw new HttpError(404, 'unknown-project', 'project is not registered')
  }
  return project
}