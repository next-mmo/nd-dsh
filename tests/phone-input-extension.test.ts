import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { NativeHostRegistry } from '../src/main/extensions/native-host.js'
import { InvocationBroker, type NdOrganizationPort } from '../src/main/extensions/invocation-broker.js'
import {
  manifestPermissionIssues,
  ndHostMethod,
  validateNdExtensionManifest,
  type NdExtensionManifest,
} from '../src/shared/extension-package.js'
import { personalContext } from '../src/shared/nd-context.js'
import { PHONE_INPUT_EXTENSION_ID, isPhoneInputKey } from '../src/shared/phone-input.js'
import {
  describeSessionState,
  formatInjectionSummary,
  formatTransportKind,
  summarizeUserAgent,
} from '../extensions/nd-phone-input/ui/phone-input-core.js'

const packagePath = fileURLToPath(new URL('../extensions/nd-phone-input/', import.meta.url))
const manifestPath = new URL('../extensions/nd-phone-input/nd-extension.json', import.meta.url)

const organization: NdOrganizationPort = {
  state: async () => ({
    companies: [{ id: 'c1' } as never],
    projects: [{ id: 'p1', companyId: 'c1' } as never],
    memory: [],
  }),
}

async function loadManifest(): Promise<NdExtensionManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

describe('ND Phone Keyboard extension package', () => {
  it('validates manifest, permissions, and explicit Personal context scoping', async () => {
    const manifest = await loadManifest()
    expect(manifest.id).toBe(PHONE_INPUT_EXTENSION_ID)
    expect(manifest.name).toBe('Phone Keyboard')
    expect(manifest.contexts).toEqual(['personal'])
    expect(manifest.permissions).toEqual(['phoneinput.read', 'phoneinput.write', 'clipboard.write'])
    expect(manifestPermissionIssues(manifest)).toEqual([])

    const [view] = manifest.contributions.views
    expect(view?.kind).toBe('web')
    expect(view?.entry).toBe('ui/index.html')
    expect(view?.actions.map((action) => [action.id, action.host])).toEqual([
      ['status', 'phoneinput.status.get'],
      ['start', 'phoneinput.session.start'],
      ['stop', 'phoneinput.session.stop'],
      ['disconnect', 'phoneinput.client.disconnect'],
      ['rotate-token', 'phoneinput.token.rotate'],
      ['set-options', 'phoneinput.options.set'],
      ['copy-url', 'clipboard.write'],
    ])

    for (const c of [...manifest.contributions.commands, ...manifest.contributions.views]) {
      expect(c.contexts).toEqual(['personal'])
    }
    expect(ndHostMethod('phoneinput.session.start')?.sensitive).toBe(true)
    expect(ndHostMethod('phoneinput.status.get')?.sensitive).toBe(false)
  })

  it('installs, activates, enforces broker permissions/approvals, and uninstalls cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-phone-input-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const installed = await packages.installFromDirectory(packagePath, { expectId: PHONE_INPUT_EXTENSION_ID })
      for (const asset of ['ui/index.html', 'ui/bridge.js', 'ui/phone-input-core.js', 'ui/app.js']) {
        expect(await packages.snapshotFileFor(PHONE_INPUT_EXTENSION_ID, installed.version, asset)).not.toBeNull()
      }

      const state = new InvocationStateStore(root)
      const host = new NativeHostRegistry()
      let running = false
      host.register('phoneinput.status.get', async () => ({ sessionState: running ? 'waiting' : 'stopped' }))
      host.register('phoneinput.session.start', async () => {
        running = true
        return { sessionState: 'waiting' }
      })
      host.register('phoneinput.session.stop', async () => {
        running = false
        return { sessionState: 'stopped' }
      })

      const broker = new InvocationBroker({ packages, state, host, organization })
      await state.setActivation(PHONE_INPUT_EXTENSION_ID, personalContext(), true)

      const view = await broker.loadView(PHONE_INPUT_EXTENSION_ID, 'main', personalContext())
      expect(view.kind).toBe('web')
      expect(view.webView?.entry).toBe('ui/index.html')

      const userStart = await broker.invoke({
        extensionId: PHONE_INPUT_EXTENSION_ID,
        contributionId: 'main',
        contributionKind: 'view',
        context: personalContext(),
        caller: 'user',
        input: { action: 'start' },
      })
      expect(userStart.ok).toBe(true)
      expect(running).toBe(true)

      const wrongContext = await broker.invoke({
        extensionId: PHONE_INPUT_EXTENSION_ID,
        contributionId: 'main',
        contributionKind: 'view',
        context: { kind: 'company', companyId: 'c1' },
        caller: 'user',
        input: { action: 'status' },
      })
      expect(wrongContext.ok).toBe(false)
      expect(wrongContext.error?.code).toBe('denied')

      const agentStart = await broker.invoke({
        extensionId: PHONE_INPUT_EXTENSION_ID,
        contributionId: 'main',
        contributionKind: 'view',
        context: personalContext(),
        caller: 'agent',
        input: { action: 'start' },
      })
      expect(agentStart.ok).toBe(false)
      expect(agentStart.error?.code).toBe('approval-required')
      const approvalId = (agentStart.value as { approvalId: string }).approvalId
      await broker.approve(approvalId, true)
      const grantedStart = await broker.invoke({
        extensionId: PHONE_INPUT_EXTENSION_ID,
        contributionId: 'main',
        contributionKind: 'view',
        context: personalContext(),
        caller: 'agent',
        input: { action: 'start' },
      })
      expect(grantedStart.ok).toBe(true)

      await packages.uninstall(PHONE_INPUT_EXTENSION_ID)
      expect(await packages.activeManifest(PHONE_INPUT_EXTENSION_ID)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('formats UI helpers and validates the key allowlist', () => {
    expect(describeSessionState('waiting')).toEqual({ label: 'Waiting for phone', tone: 'accent' })
    expect(describeSessionState('connected')).toEqual({ label: 'Connected', tone: 'ok' })
    expect(describeSessionState('nonsense')).toEqual({ label: 'Stopped', tone: 'idle' })
    expect(formatTransportKind('usb')).toBe('USB Tethering')
    expect(formatInjectionSummary({ injectedChars: 12, injectedKeys: 3 })).toBe('12 chars · 3 keys sent')
    expect(summarizeUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0.0.0 Mobile')).toBe('Android 14 · Chrome 130')
    expect(summarizeUserAgent('')).toBe('Phone browser')

    expect(isPhoneInputKey('enter')).toBe(true)
    expect(isPhoneInputKey('backspace')).toBe(true)
    expect(isPhoneInputKey('ctrl+c')).toBe(false)
    expect(isPhoneInputKey('')).toBe(false)
    expect(isPhoneInputKey(42)).toBe(false)
  })
})