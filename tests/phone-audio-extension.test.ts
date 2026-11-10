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
import { PHONE_AUDIO_EXTENSION_ID, preferLowLatencyOpusSdp } from '../src/shared/phone-audio.js'
import {
  describeStreamState,
  detectOutputDiagnostics,
  formatLatencySummary,
  formatTransportKind,
  summarizeUserAgent,
} from '../extensions/nd-phone-audio/ui/phone-audio-core.js'

const packagePath = fileURLToPath(new URL('../extensions/nd-phone-audio/', import.meta.url))
const manifestPath = new URL('../extensions/nd-phone-audio/nd-extension.json', import.meta.url)

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

describe('ND Phone Audio extension package', () => {
  it('validates manifest, permissions, and explicit Personal context scoping', async () => {
    const manifest = await loadManifest()
    expect(manifest.id).toBe(PHONE_AUDIO_EXTENSION_ID)
    expect(manifest.name).toBe('Phone Audio')
    expect(manifest.contexts).toEqual(['personal'])
    expect(manifest.permissions).toEqual(['phoneaudio.read', 'phoneaudio.write', 'clipboard.write'])
    expect(manifestPermissionIssues(manifest)).toEqual([])

    const [view] = manifest.contributions.views
    expect(view?.kind).toBe('web')
    expect(view?.entry).toBe('ui/index.html')
    expect(view?.actions.map((action) => [action.id, action.host])).toEqual([
      ['status', 'phoneaudio.status.get'],
      ['start', 'phoneaudio.session.start'],
      ['stop', 'phoneaudio.session.stop'],
      ['disconnect', 'phoneaudio.client.disconnect'],
      ['rotate-token', 'phoneaudio.token.rotate'],
      ['set-options', 'phoneaudio.options.set'],
      ['copy-url', 'clipboard.write'],
    ])

    for (const c of [...manifest.contributions.commands, ...manifest.contributions.views]) {
      expect(c.contexts).toEqual(['personal'])
    }
    expect(ndHostMethod('phoneaudio.session.start')?.sensitive).toBe(true)
    expect(ndHostMethod('phoneaudio.status.get')?.sensitive).toBe(false)
  })

  it('installs, activates, enforces broker permissions/approvals, and uninstalls cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-phone-audio-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const installed = await packages.installFromDirectory(packagePath, { expectId: PHONE_AUDIO_EXTENSION_ID })
      for (const asset of ['ui/index.html', 'ui/bridge.js', 'ui/phone-audio-core.js', 'ui/app.js']) {
        expect(await packages.snapshotFileFor(PHONE_AUDIO_EXTENSION_ID, installed.version, asset)).not.toBeNull()
      }

      const state = new InvocationStateStore(root)
      const host = new NativeHostRegistry()
      let running = false
      host.register('phoneaudio.status.get', async () => ({ streamState: running ? 'waiting' : 'stopped' }))
      host.register('phoneaudio.session.start', async () => {
        running = true
        return { streamState: 'waiting' }
      })
      host.register('phoneaudio.session.stop', async () => {
        running = false
        return { streamState: 'stopped' }
      })

      const broker = new InvocationBroker({ packages, state, host, organization })
      await state.setActivation(PHONE_AUDIO_EXTENSION_ID, personalContext(), true)

      const view = await broker.loadView(PHONE_AUDIO_EXTENSION_ID, 'main', personalContext())
      expect(view.kind).toBe('web')
      expect(view.webView?.entry).toBe('ui/index.html')

      const userStart = await broker.invoke({
        extensionId: PHONE_AUDIO_EXTENSION_ID,
        contributionId: 'main',
        contributionKind: 'view',
        context: personalContext(),
        caller: 'user',
        input: { action: 'start' },
      })
      expect(userStart.ok).toBe(true)
      expect(running).toBe(true)

      const wrongContext = await broker.invoke({
        extensionId: PHONE_AUDIO_EXTENSION_ID,
        contributionId: 'main',
        contributionKind: 'view',
        context: { kind: 'company', companyId: 'c1' },
        caller: 'user',
        input: { action: 'status' },
      })
      expect(wrongContext.ok).toBe(false)
      expect(wrongContext.error?.code).toBe('denied')

      const agentStart = await broker.invoke({
        extensionId: PHONE_AUDIO_EXTENSION_ID,
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
        extensionId: PHONE_AUDIO_EXTENSION_ID,
        contributionId: 'main',
        contributionKind: 'view',
        context: personalContext(),
        caller: 'agent',
        input: { action: 'start' },
      })
      expect(grantedStart.ok).toBe(true)

      await packages.uninstall(PHONE_AUDIO_EXTENSION_ID)
      expect(await packages.activeManifest(PHONE_AUDIO_EXTENSION_ID)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('formats UI diagnostics and tunes Opus SDP cleanly', () => {
    expect(describeStreamState('waiting')).toEqual({ label: 'Waiting for Android', tone: 'accent' })
    expect(describeStreamState('connected')).toEqual({ label: 'Connected', tone: 'ok' })
    expect(formatTransportKind('usb')).toBe('USB Tethering')
    expect(formatLatencySummary({ rttMs: 14, jitterMs: 1.8 }, null)).toBe('14 ms RTT · 1.8 ms jitter')
    expect(summarizeUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0.0.0 Mobile')).toBe('Android 14 · Chrome 130')
    expect(detectOutputDiagnostics({ outputDevices: [], systemVolume: { available: false } }).ok).toBe(false)
    expect(detectOutputDiagnostics({ outputDevices: [{ label: 'Speakers' }], systemVolume: { available: true, muted: true } }).warning).toContain('muted')

    const sampleSdp = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10;useinbandfec=1',
    ].join('\r\n')
    const tuned = preferLowLatencyOpusSdp(sampleSdp)
    expect(tuned).toContain('stereo=1')
    expect(tuned).toContain('sprop-stereo=1')
    expect(tuned).toContain('ptime=10')
    expect(tuned).toContain('maxaveragebitrate=128000')
  })
})
