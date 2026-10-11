import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeBrowserExtensionManifest } from '../src/main/browser/browser-extension-compatibility.js'

const PACKAGE_ROOT = resolve(process.cwd(), 'resources/browser-extensions/nd-ad-block')

interface Rule {
  id: number
  priority?: number
  action: { type: string }
  condition: { urlFilter?: string; resourceTypes?: string[] }
}

const readJson = (relativePath: string): unknown =>
  JSON.parse(readFileSync(join(PACKAGE_ROOT, relativePath), 'utf8'))

const manifest = readJson('manifest.json') as Record<string, unknown>
const ruleResources = ((manifest.declarative_net_request as { rule_resources?: Array<{ id: string; enabled: boolean; path: string }> })
  ?.rule_resources) ?? []

const rulesets = ruleResources.map((resource) => ({
  ...resource,
  rules: readJson(resource.path) as Rule[],
}))

const allRules = rulesets.flatMap((ruleset) => ruleset.rules)

describe('bundled ND Ad Block package', () => {
  it('is a manifest v3 extension ND reports as compatible', () => {
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.name).toBe('ND Ad Block')
    expect(typeof manifest.version).toBe('string')
    expect(analyzeBrowserExtensionManifest(manifest).status).toBe('compatible')
  })

  it('ships every file the manifest references', () => {
    expect(ruleResources.length).toBeGreaterThan(0)
    for (const resource of ruleResources) {
      expect(existsSync(join(PACKAGE_ROOT, resource.path)), resource.path).toBe(true)
    }
    const scripts = (manifest.content_scripts as Array<{ js?: string[]; css?: string[] }>).flatMap((entry) => [
      ...(entry.js ?? []),
      ...(entry.css ?? []),
    ])
    expect(scripts.length).toBeGreaterThan(0)
    for (const script of scripts) {
      expect(existsSync(join(PACKAGE_ROOT, script)), script).toBe(true)
    }
    const worker = (manifest.background as { service_worker?: string } | undefined)?.service_worker
    expect(worker).toBe('background.js')
    expect(existsSync(join(PACKAGE_ROOT, worker!))).toBe(true)
    const popup = (manifest.action as { default_popup?: string } | undefined)?.default_popup
    expect(existsSync(join(PACKAGE_ROOT, popup!))).toBe(true)
  })

  it('activates every rule set from the service worker', () => {
    // Electron loads the package but leaves manifest-declared rule sets
    // disabled, so the worker is the only thing that makes blocking work. If
    // this drifts, the shipped default silently stops blocking.
    const worker = readFileSync(join(PACKAGE_ROOT, 'background.js'), 'utf8')
    expect(worker).toContain('updateEnabledRulesets')
    for (const resource of ruleResources) {
      expect(worker).toContain(`'${resource.id}'`)
    }
  })

  it('keeps rule ids unique within each rule set and every rule a blocking rule', () => {
    const ids = allRules.map((rule) => rule.id)
    expect(ids.length).toBeGreaterThan(100)
    for (const ruleset of rulesets) {
      // Rule ids have to be unique per rule set, not across the whole package.
      const rulesetIds = ruleset.rules.map((rule) => rule.id)
      expect(new Set(rulesetIds).size, ruleset.id).toBe(rulesetIds.length)
      for (const rule of ruleset.rules) {
        expect(Number.isInteger(rule.id)).toBe(true)
        expect(rule.id).toBeGreaterThan(0)
        expect(rule.action.type).toBe('block')
        expect(typeof rule.condition.urlFilter).toBe('string')
        expect(rule.condition.urlFilter!.length).toBeGreaterThan(0)
      }
    }
  })

  it('does not repeat the same filter', () => {
    const filters = allRules.map((rule) => rule.condition.urlFilter)
    expect(new Set(filters).size).toBe(filters.length)
  })

  it('covers the ad hosts the runtime probe measures', () => {
    const filters = allRules.map((rule) => rule.condition.urlFilter!).join('\n')
    for (const host of ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com']) {
      expect(filters).toContain(`||${host}^`)
    }
  })

  it('blocks YouTube ad endpoints without touching the video CDN', () => {
    const filters = allRules.map((rule) => rule.condition.urlFilter!).join('\n')
    for (const path of ['pagead/', 'ptracking', 'api/stats/ads', 'get_midroll_info']) {
      expect(filters).toContain(`youtube.com/${path}`)
    }
    // googlevideo.com also serves the ad media itself, so blocking it stops
    // playback rather than ads.
    expect(filters).not.toContain('googlevideo.com')
  })

  it('removes YouTube ad placements in the page main world', () => {
    const source = readFileSync(join(PACKAGE_ROOT, 'content/youtube-ads.js'), 'utf8')
    // Main world is required: player data is read by the page, not by an
    // isolated content script.
    const mainWorld = (manifest.content_scripts as Array<{ world?: string; js?: string[]; run_at?: string }>)
      .find((entry) => (entry.js ?? []).includes('content/youtube-ads.js'))
    expect(mainWorld?.world).toBe('MAIN')
    expect(mainWorld?.run_at).toBe('document_start')
    expect(source).toContain('adPlacements')
    expect(source).toContain('playerAds')
    expect(source).toContain('ytInitialPlayerResponse')
  })

  it('prunes an XHR payload on read, not on a readyState event', () => {
    // Pages install xhr.onreadystatechange before calling send(), so pruning
    // keyed on a listener added inside send() hands the player the raw payload.
    const source = readFileSync(join(PACKAGE_ROOT, 'content/youtube-ads.js'), 'utf8')
    expect(source).not.toContain('__ndAdPruned')
    expect(source).toContain("wrap('responseText')")
  })

  it('reports ad breaks and stripped entries as separate counts', () => {
    // The popup must never present stripped placements as ads the user saw.
    const content = readFileSync(join(PACKAGE_ROOT, 'content/youtube-ads.js'), 'utf8')
    const report = readFileSync(join(PACKAGE_ROOT, 'content/youtube-ads-report.js'), 'utf8')
    const popup = readFileSync(join(PACKAGE_ROOT, 'popup.js'), 'utf8')
    const popupHtml = readFileSync(join(PACKAGE_ROOT, 'popup.html'), 'utf8')
    for (const source of [content, report, popup]) {
      expect(source).toContain('adBreaks')
      expect(source).toContain('pruned')
    }
    expect(content).toContain('adBreaks += 1')
    expect(popupHtml).toContain('Ad breaks ended')
    expect(popupHtml).not.toContain('Ads removed')
  })
})
