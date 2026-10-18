import { exec } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execAsync = promisify(exec)
import { NdRestApiService } from '../src/main/rest-api/rest-api-service.js'
import type { EngineSessionRouter } from '../src/main/engines/engine-session-router.js'
import type { WorkspaceService } from '../src/main/workspace/workspace-service.js'

describe('NdRestApiService', () => {
  let tempDir: string
  let service: NdRestApiService
  let mockEngineRouter: Partial<EngineSessionRouter>
  let mockWorkspace: Partial<WorkspaceService>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'nd-rest-api-test-'))
    mockWorkspace = {
      state: () => ({ root: '/workspace/test', binding: 'attached' } as never),
    }

    mockEngineRouter = {
      sessions: vi.fn(() => [
        {
          sessionId: 'chatgpt-web-123',
          engineId: 'chatgpt-web',
          title: 'Test Session',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          running: false,
        },
      ]),
      run: vi.fn(async (_prompt: string, _opts: unknown) => {
        return { sessionId: 'chatgpt-web-123' }
      }),
      transcript: vi.fn(async (_sessionId: string) => {
        return {
          sessionId: 'chatgpt-web-123',
          engineId: 'chatgpt-web',
          events: [
            {
              type: 'assistant/message',
              seq: 1,
              time: Date.now(),
              data: {
                message: {
                  role: 'assistant',
                  content: [
                    {
                      type: 'text',
                      text: `1\n00:00:02,140 --> 00:00:18,170\n[SPEAKER_00] ឪពុក! ឪពុក! ភ្ញាក់ឡើងទៅ!\n\n2\n00:00:18,170 --> 00:00:19,980\n[SPEAKER_02] លោកគ្រូ`,
                    },
                  ],
                },
              },
            },
          ],
        }
      }),
    }

    service = new NdRestApiService({
      engineRouter: mockEngineRouter as EngineSessionRouter,
      workspace: mockWorkspace as WorkspaceService,
      userDataPath: tempDir,
      preferredPort: 3125, // test port
    })
  })

  afterEach(async () => {
    await service.stop()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('starts on loopback and writes discovery info file', async () => {
    const { port, endpoint } = await service.start()
    expect(port).toBeGreaterThan(1024)
    expect(endpoint).toBe(`http://127.0.0.1:${port}`)

    const infoPath = join(tempDir, 'nd-rest-api.json')
    const saved = JSON.parse(readFileSync(infoPath, 'utf-8'))
    expect(saved.port).toBe(port)
    expect(saved.endpoint).toBe(endpoint)
    expect(saved.pid).toBe(process.pid)
  })

  it('responds to GET /api/status and /api/health with status JSON', async () => {
    const { endpoint } = await service.start()
    const res = await fetch(`${endpoint}/api/status`)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({
      ok: true,
      status: 'ready',
      defaultEngine: 'chatgpt-web',
      workspace: '/workspace/test',
    })
  })

  it('responds to GET /api/sessions with session list', async () => {
    const { endpoint } = await service.start()
    const res = await fetch(`${endpoint}/api/sessions`)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.sessions).toHaveLength(1)
    expect(json.sessions[0].sessionId).toBe('chatgpt-web-123')
  })

  it('translates SRT via POST /gpt-web/translate-srt with JSON payload', async () => {
    const { endpoint } = await service.start()
    const rawSrt = `1
00:00:02,140 --> 00:00:18,170
[SPEAKER_00] 已经走了爹爹爹你醒醒爹你醒醒

2
00:00:18,170 --> 00:00:19,980
[SPEAKER_02] 大`

    const res = await fetch(`${endpoint}/gpt-web/translate-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        srt: rawSrt,
        targetLanguage: 'Khmer',
      }),
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.targetLanguage).toBe('Khmer')
    expect(json.totalBlocks).toBe(2)
    expect(json.batches).toBe(1)
    expect(json.engineId).toBe('chatgpt-web')
    expect(json.srt).toContain('[SPEAKER_00] ឪពុក! ឪពុក! ភ្ញាក់ឡើងទៅ!')
    expect(json.srt).toContain('[SPEAKER_02] លោកគ្រូ')
    expect(mockEngineRouter.run).toHaveBeenCalled()
  })

  it('translates SRT via raw text payload and returns plain text when requested', async () => {
    const { endpoint } = await service.start()
    const rawSrt = `1
00:00:02,140 --> 00:00:18,170
[SPEAKER_00] 已经走了爹爹爹你醒醒爹你醒醒

2
00:00:18,170 --> 00:00:19,980
[SPEAKER_02] 大`

    const res = await fetch(`${endpoint}/api/translate-srt?targetLanguage=Khmer`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: rawSrt,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    const text = await res.text()
    expect(text).toContain('[SPEAKER_00] ឪពុក! ឪពុក! ភ្ញាក់ឡើងទៅ!')
    expect(text).toContain('[SPEAKER_02] លោកគ្រូ')
  })

  it('translates SRT from filePath and writes to outputPath when specified', async () => {
    const { endpoint } = await service.start()
    const inputFilePath = join(tempDir, 'input.srt')
    const outputFilePath = join(tempDir, 'output.srt')
    const rawSrt = `1
00:00:02,140 --> 00:00:18,170
[SPEAKER_00] 已经走了

2
00:00:18,170 --> 00:00:19,980
[SPEAKER_02] 大`
    writeFileSync(inputFilePath, rawSrt, 'utf-8')

    const res = await fetch(`${endpoint}/gpt-web/translate-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath: inputFilePath,
        outputPath: outputFilePath,
        targetLanguage: 'Khmer',
      }),
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.outputPath).toBe(outputFilePath)

    const written = readFileSync(outputFilePath, 'utf-8')
    expect(written).toContain('[SPEAKER_00] ឪពុក! ឪពុក! ភ្ញាក់ឡើងទៅ!')
  })

  it('runs prompt via POST /gpt-web/run and returns assistant text', async () => {
    const { endpoint } = await service.start()
    const res = await fetch(`${endpoint}/gpt-web/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Hello world',
      }),
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.engineId).toBe('chatgpt-web')
    expect(json.sessionId).toBe('chatgpt-web-123')
    expect(json.response).toContain('ឪពុក!')
  })

  it('handles errors gracefully with appropriate status codes', async () => {
    const { endpoint } = await service.start()

    // 1. Invalid JSON
    const badJson = await fetch(`${endpoint}/gpt-web/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not a json',
    })
    expect(badJson.status).toBe(400)

    // 2. Missing prompt
    const emptyPrompt = await fetch(`${endpoint}/gpt-web/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    })
    expect(emptyPrompt.status).toBe(400)

    // 3. 404 for unknown route
    const notFound = await fetch(`${endpoint}/api/unknown-route`)
    expect(notFound.status).toBe(404)
  })

  it('handles live curl.exe execution against GET and POST endpoints', async () => {
    const { endpoint } = await service.start()

    // 1. Live curl GET /api/status
    const { stdout: statusOut } = await execAsync(`curl.exe -s "${endpoint}/api/status"`)
    const statusJson = JSON.parse(statusOut)
    expect(statusJson.ok).toBe(true)
    expect(statusJson.status).toBe('ready')

    // 2. Live curl POST /gpt-web/run
    const runPayload = JSON.stringify({ prompt: 'Hello via curl' })
    const runFilePath = join(tempDir, 'curl-run.json')
    writeFileSync(runFilePath, runPayload, 'utf-8')
    const { stdout: runOut } = await execAsync(
      `curl.exe -s -X POST "${endpoint}/gpt-web/run" -H "Content-Type: application/json" -d "@${runFilePath.replace(/\\/g, '/')}"`
    )
    const runJson = JSON.parse(runOut)
    expect(runJson.ok).toBe(true)
    expect(runJson.engineId).toBe('chatgpt-web')
    expect(runJson.response).toContain('ឪពុក!')

    // 3. Live curl POST /gpt-web/translate-srt with raw SRT file
    const srtFilePath = join(tempDir, 'curl-input.srt')
    writeFileSync(srtFilePath, '1\n00:00:01,000 --> 00:00:03,000\n[SPEAKER_00] Hi\n\n2\n00:00:04,000 --> 00:00:06,000\n[SPEAKER_01] Bye', 'utf-8')
    const { stdout: translateOut } = await execAsync(
      `curl.exe -s -X POST "${endpoint}/gpt-web/translate-srt?targetLanguage=Khmer" -H "Content-Type: text/plain" --data-binary "@${srtFilePath.replace(/\\/g, '/')}"`
    )
    expect(translateOut).toContain('[SPEAKER_00] ឪពុក! ឪពុក! ភ្ញាក់ឡើងទៅ!')
    expect(translateOut).toContain('[SPEAKER_01] លោកគ្រូ')
  })
})

