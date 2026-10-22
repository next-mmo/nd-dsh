import type { HarnessUpstreamStatus } from '../../shared/contracts.js'

const LATEST_DSH_URL = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest'
const CHECK_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 10 * 60_000
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

type LatestVersionFetcher = () => Promise<string>

export class HarnessUpstreamChecker {
  private cached?: { latestVersion: string; checkedAt: number }
  private inFlight: Promise<string> | undefined

  constructor(private readonly fetchLatestVersion: LatestVersionFetcher = fetchLatestPublishedVersion) {}

  async check(currentVersion: string | undefined): Promise<HarnessUpstreamStatus> {
    if (!currentVersion) return { updateAvailable: false }
    const latestVersion = await this.latestVersion()
    return {
      currentVersion,
      latestVersion,
      updateAvailable: compareHarnessVersions(latestVersion, currentVersion) > 0,
    }
  }

  private latestVersion(): Promise<string> {
    if (this.cached && Date.now() - this.cached.checkedAt < CACHE_TTL_MS) {
      return Promise.resolve(this.cached.latestVersion)
    }
    if (!this.inFlight) {
      this.inFlight = this.fetchLatestVersion()
        .then((version) => {
          this.cached = { latestVersion: version, checkedAt: Date.now() }
          return version
        })
        .finally(() => {
          this.inFlight = undefined
        })
    }
    return this.inFlight
  }
}

let sharedChecker: HarnessUpstreamChecker | undefined

export function checkHarnessUpstream(currentVersion: string | undefined): Promise<HarnessUpstreamStatus> {
  sharedChecker ??= new HarnessUpstreamChecker()
  return sharedChecker.check(currentVersion)
}

async function fetchLatestPublishedVersion(): Promise<string> {
  const response = await fetch(LATEST_DSH_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`)
  const payload = await response.json() as { version?: unknown }
  if (typeof payload.version !== 'string' || !VERSION_PATTERN.test(payload.version)) {
    throw new Error('npm registry returned invalid DeepSeek Harness version metadata')
  }
  return payload.version
}

export function compareHarnessVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left)
  const rightVersion = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const diff = (leftVersion.core[index] ?? 0) - (rightVersion.core[index] ?? 0)
    if (diff !== 0) return diff
  }
  if (!leftVersion.prerelease && !rightVersion.prerelease) return 0
  if (!leftVersion.prerelease) return 1
  if (!rightVersion.prerelease) return -1
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index]
    const rightPart = rightVersion.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) {
      const diff = Number(leftPart) - Number(rightPart)
      if (diff !== 0) return diff
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1
    } else if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1
    }
  }
  return 0
}

function parseVersion(value: string): { core: number[]; prerelease: string[] | undefined } {
  const withoutBuild = value.split('+', 1)[0] ?? value
  const dash = withoutBuild.indexOf('-')
  return {
    core: (dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)).split('.').map((part) => Number.parseInt(part, 10)),
    prerelease: dash === -1 ? undefined : withoutBuild.slice(dash + 1).split('.'),
  }
}
