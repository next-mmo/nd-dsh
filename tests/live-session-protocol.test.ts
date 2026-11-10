import { describe, expect, it } from 'vitest'
import { isNdWebViewBridgeMessage } from '../src/shared/extension-webview.js'
import { downsampleFloat32, LIVE_MAX_LESSON_CONTEXT_CHARS, validateLiveOpenInput } from '../src/shared/live-session.js'
import { personalContext } from '../src/shared/nd-context.js'

describe('Live session protocol and validators', () => {
  it('validates live open input and rejects oversized or malformed fields', () => {
    const valid = validateLiveOpenInput({
      extensionId: 'nd.tutor',
      viewId: 'main',
      context: personalContext(),
      lessonContext: 'Day 1: Constraints',
      language: 'km',
      model: 'gemini-3.8-live',
      voice: 'Aoede',
      tools: [
        {
          name: 'show_hint',
          description: 'Show a hint',
          parameters: { type: 'object', properties: { level: { type: 'integer' } } },
        },
      ],
    })
    expect(valid.language).toBe('km')
    expect(valid.model).toBe('gemini-3.8-live')
    expect(valid.tools).toHaveLength(1)

    expect(() => validateLiveOpenInput({
      extensionId: '../evil',
      viewId: 'main',
      context: personalContext(),
      lessonContext: 'ok',
    })).toThrow(/extensionId/i)

    expect(() => validateLiveOpenInput({
      extensionId: 'nd.tutor',
      viewId: 'main',
      context: personalContext(),
      lessonContext: 'x'.repeat(LIVE_MAX_LESSON_CONTEXT_CHARS + 1),
    })).toThrow(/lessonContext/i)

    expect(() => validateLiveOpenInput({
      extensionId: 'nd.tutor',
      viewId: 'main',
      context: personalContext(),
      lessonContext: 'ok',
      model: 'gpt-4o-realtime',
    })).toThrow(/Unsupported live model/i)

    expect(() => validateLiveOpenInput({
      extensionId: 'nd.tutor',
      viewId: 'main',
      context: personalContext(),
      lessonContext: 'ok',
      tools: [{ name: 'BadName', description: 'bad' }],
    })).toThrow(/Invalid live tool name/i)

    expect(() => validateLiveOpenInput({
      extensionId: 'nd.tutor',
      viewId: 'main',
      context: personalContext(),
      lessonContext: 'ok',
      tools: Array.from({ length: 9 }, (_, i) => ({ name: `tool_${i}`, description: 'ok' })),
    })).toThrow(/At most 8/i)
  })

  it('validates nd.webview/1 live bridge messages and drops malformed payloads', () => {
    expect(isNdWebViewBridgeMessage({
      kind: 'nd-webview:live-start',
      lessonContext: 'Day 1',
      language: 'en',
      model: 'gemini-3.8-live',
    })).toBe(true)
    expect(isNdWebViewBridgeMessage({ kind: 'nd-webview:live-stop' })).toBe(true)
    expect(isNdWebViewBridgeMessage({ kind: 'nd-webview:live-send-text', text: 'SELECT 1;' })).toBe(true)
    expect(isNdWebViewBridgeMessage({ kind: 'nd-webview:live-mute', muted: true })).toBe(true)
    expect(isNdWebViewBridgeMessage({
      kind: 'nd-webview:live-tool-result',
      id: 'call-1',
      name: 'show_hint',
      response: { ok: true },
    })).toBe(true)
    expect(isNdWebViewBridgeMessage({ kind: 'nd-webview:live-state', status: 'live' })).toBe(true)
    expect(isNdWebViewBridgeMessage({ kind: 'nd-webview:live-transcript', role: 'teacher', text: 'Hello', final: false })).toBe(true)
    expect(isNdWebViewBridgeMessage({ kind: 'nd-webview:live-level', level: 0.42 })).toBe(true)
    expect(isNdWebViewBridgeMessage({ kind: 'nd-webview:live-tool-call', id: 'c1', name: 'show_hint', args: { level: 1 } })).toBe(true)

    expect(isNdWebViewBridgeMessage({ kind: 'nd-webview:live-send-text', text: '' })).toBe(false)
    expect(isNdWebViewBridgeMessage({ kind: 'nd-webview:live-level', level: 1.5 })).toBe(false)
    expect(isNdWebViewBridgeMessage({ kind: 'nd-webview:live-state', status: 'unknown' })).toBe(false)
    expect(isNdWebViewBridgeMessage({ kind: 'nd-webview:live-transcript', role: 'admin', text: 'x', final: true })).toBe(false)
  })

  it('downsamples PCM float32 audio cleanly from 48 kHz to 16 kHz', () => {
    const input = new Float32Array(480)
    for (let i = 0; i < input.length; i += 1) input[i] = Math.sin((i / 480) * Math.PI * 2)
    const out = downsampleFloat32(input, 48_000, 16_000)
    expect(out.length).toBe(160)
    expect(out[0]).toBeCloseTo(0, 5)
  })
})
