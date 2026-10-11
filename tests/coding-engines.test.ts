import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_ENGINE_ID,
  CHATGPT_WEB_ENGINE_ID,
  CLAUDE_CODE_CLI_ENGINE_ID,
  CODEX_CLI_ENGINE_ID,
  CODEX_ENGINE_ID,
  CURSOR_CLI_ENGINE_ID,
  ND_HARNESS_ENGINE_ID,
  ND_NATIVE_ENGINE_ID,
  PI_CODING_ENGINE_ID,
  ZCODE_CLI_ENGINE_ID,
  buildCodingEngineCatalog,
  chatGptWebEngineDescriptor,
  codingEngineInstallCommand,
  workerAssignableCodingEngines,
  type CodingEngineAvailability,
} from '../src/shared/coding-engines.js'

function availability(overrides: Partial<CodingEngineAvailability> = {}): CodingEngineAvailability {
  return {
    harnessReady: true,
    codexReady: true,
    codexCliReady: true,
    antigravityReady: true,
    zcodeCliReady: true,
    piCodingReady: true,
    cursorCliReady: true,
    claudeCodeCliReady: true,
    ...overrides,
  }
}

describe('coding engine catalog', () => {
  it('keeps model providers separate from the product-owned coding engine registry', () => {
    const engines = buildCodingEngineCatalog(availability())
    expect(engines.map((engine) => engine.id)).toEqual([
      ND_HARNESS_ENGINE_ID,
      ND_NATIVE_ENGINE_ID,
      CODEX_ENGINE_ID,
      CODEX_CLI_ENGINE_ID,
      ANTIGRAVITY_ENGINE_ID,
      ZCODE_CLI_ENGINE_ID,
      PI_CODING_ENGINE_ID,
      CURSOR_CLI_ENGINE_ID,
      CLAUDE_CODE_CLI_ENGINE_ID,
    ])
    expect(engines.find((engine) => engine.id === ND_HARNESS_ENGINE_ID)?.integration).toBe('primary')
    expect(engines.find((engine) => engine.id === CODEX_ENGINE_ID)?.integration).toBe('delegated')
    expect(engines.find((engine) => engine.id === CODEX_CLI_ENGINE_ID)?.integration).toBe('primary')
    expect(engines.find((engine) => engine.id === ANTIGRAVITY_ENGINE_ID)?.integration).toBe('primary')
    expect(engines.find((engine) => engine.id === ZCODE_CLI_ENGINE_ID)?.integration).toBe('primary')
    expect(engines.find((engine) => engine.id === PI_CODING_ENGINE_ID)?.integration).toBe('primary')
    expect(engines.find((engine) => engine.id === CURSOR_CLI_ENGINE_ID)?.integration).toBe('primary')
    expect(engines.find((engine) => engine.id === CLAUDE_CODE_CLI_ENGINE_ID)?.integration).toBe('primary')
  })

  it('keeps browser-only ChatGPT Web interactive instead of worker-assignable', () => {
    const chatGpt = chatGptWebEngineDescriptor()
    expect(chatGpt.id).toBe(CHATGPT_WEB_ENGINE_ID)
    expect(chatGpt.available).toBe(true)
    expect(chatGpt.capabilities.browser).toBe(true)
    expect(chatGpt.capabilities.workspace).toBe(false)

    const workers = workerAssignableCodingEngines([
      ...buildCodingEngineCatalog(availability()),
      chatGpt,
    ])
    expect(workers.map((engine) => engine.id)).not.toContain(CHATGPT_WEB_ENGINE_ID)
    expect(workers.map((engine) => engine.id)).toContain(ND_HARNESS_ENGINE_ID)
    expect(workers.map((engine) => engine.id)).toContain(ZCODE_CLI_ENGINE_ID)
    expect(workers.map((engine) => engine.id)).toContain(PI_CODING_ENGINE_ID)
    expect(workers.map((engine) => engine.id)).toContain(CURSOR_CLI_ENGINE_ID)
    expect(workers.map((engine) => engine.id)).toContain(CLAUDE_CODE_CLI_ENGINE_ID)
  })

  it('advertises only capabilities ND actually wires for the delegated Codex adapter', () => {
    const codex = buildCodingEngineCatalog(availability({ codexCliReady: false, antigravityReady: false })).find((engine) => engine.id === CODEX_ENGINE_ID)!
    expect(codex.available).toBe(true)
    expect(codex.name).toBe('Codex (delegated)')
    expect(codex.capabilities.workspace).toBe(true)
    expect(codex.capabilities.filesystem).toBe(true)
    expect(codex.capabilities.shell).toBe(true)
    expect(codex.capabilities.browser).toBe(false)
    expect(codex.capabilities.skills).toBe(false)
    expect(codex.capabilities.mcp).toBe(false)
    expect(codex.capabilities.humanApprovals).toBe(false)
    expect(codex.capabilities.persistentSessions).toBe(false)
  })

  it('advertises direct Codex CLI capabilities honestly', () => {
    const codexCli = buildCodingEngineCatalog(availability({ harnessReady: false, codexReady: false, antigravityReady: false })).find((engine) => engine.id === CODEX_CLI_ENGINE_ID)!
    expect(codexCli.available).toBe(true)
    expect(codexCli.capabilities.workspace).toBe(true)
    expect(codexCli.capabilities.filesystem).toBe(true)
    expect(codexCli.capabilities.shell).toBe(true)
    expect(codexCli.capabilities.humanApprovals).toBe(true)
    expect(codexCli.capabilities.streaming).toBe(true)
    // Not wired yet: no ND browser/skills/MCP compilation, and threads are not
    // restored across restarts.
    expect(codexCli.capabilities.browser).toBe(false)
    expect(codexCli.capabilities.skills).toBe(false)
    expect(codexCli.capabilities.mcp).toBe(false)
    expect(codexCli.capabilities.modelProviderRouting).toBe(false)
    expect(codexCli.capabilities.persistentSessions).toBe(false)
  })

  it('advertises Antigravity CLI capabilities honestly', () => {
    const antigravity = buildCodingEngineCatalog(availability({ harnessReady: false, codexReady: false, codexCliReady: false })).find((engine) => engine.id === ANTIGRAVITY_ENGINE_ID)!
    expect(antigravity.available).toBe(true)
    expect(antigravity.capabilities.workspace).toBe(true)
    expect(antigravity.capabilities.filesystem).toBe(true)
    expect(antigravity.capabilities.shell).toBe(true)
    expect(antigravity.capabilities.streaming).toBe(true)
    // Headless `agy` auto-denies ungranted tools instead of prompting, and
    // conversations are not restored across ND restarts.
    expect(antigravity.capabilities.humanApprovals).toBe(false)
    expect(antigravity.capabilities.persistentSessions).toBe(false)
    expect(antigravity.capabilities.browser).toBe(false)
    expect(antigravity.capabilities.skills).toBe(false)
    expect(antigravity.capabilities.mcp).toBe(false)
    expect(antigravity.capabilities.modelProviderRouting).toBe(false)
  })

  it('advertises ZCode CLI capabilities honestly', () => {
    const zcode = buildCodingEngineCatalog(availability({ harnessReady: false, codexReady: false, codexCliReady: false, antigravityReady: false, piCodingReady: false, cursorCliReady: false, claudeCodeCliReady: false })).find((engine) => engine.id === ZCODE_CLI_ENGINE_ID)!
    expect(zcode.available).toBe(true)
    expect(zcode.capabilities.workspace).toBe(true)
    expect(zcode.capabilities.filesystem).toBe(true)
    expect(zcode.capabilities.shell).toBe(true)
    expect(zcode.capabilities.streaming).toBe(true)
    // ZCode permission prompts flow through ND's approval gate; model config
    // stays native, and ND does not compile skills/MCP/browser into ZCode.
    expect(zcode.capabilities.humanApprovals).toBe(true)
    expect(zcode.capabilities.browser).toBe(false)
    expect(zcode.capabilities.skills).toBe(false)
    expect(zcode.capabilities.mcp).toBe(false)
    expect(zcode.capabilities.modelProviderRouting).toBe(false)
    expect(zcode.capabilities.persistentSessions).toBe(false)
  })

  it('advertises Pi, Cursor, and Claude Code CLI capabilities honestly', () => {
    const engines = buildCodingEngineCatalog(availability({ harnessReady: false, codexReady: false, codexCliReady: false, antigravityReady: false, zcodeCliReady: false }))
    const pi = engines.find((engine) => engine.id === PI_CODING_ENGINE_ID)!
    const cursor = engines.find((engine) => engine.id === CURSOR_CLI_ENGINE_ID)!
    const claude = engines.find((engine) => engine.id === CLAUDE_CODE_CLI_ENGINE_ID)!

    expect(pi.available).toBe(true)
    expect(pi.capabilities.workspace).toBe(true)
    expect(pi.capabilities.filesystem).toBe(true)
    expect(pi.capabilities.shell).toBe(true)
    expect(pi.capabilities.streaming).toBe(true)
    expect(pi.capabilities.browser).toBe(true)
    expect(pi.capabilities.skills).toBe(true)
    expect(pi.capabilities.modelProviderRouting).toBe(true)
    expect(pi.capabilities.humanApprovals).toBe(false)
    expect(pi.capabilities.persistentSessions).toBe(false)
    expect(pi.capabilities.mcp).toBe(false)

    for (const engine of [cursor, claude]) {
      expect(engine.available).toBe(true)
      expect(engine.capabilities.workspace).toBe(true)
      expect(engine.capabilities.filesystem).toBe(true)
      expect(engine.capabilities.shell).toBe(true)
      expect(engine.capabilities.streaming).toBe(true)
      // Headless CLIs without a programmatic approval surface; ND fail-closes
      // prompts, and conversations are not restored across ND restarts.
      expect(engine.capabilities.humanApprovals).toBe(false)
      expect(engine.capabilities.persistentSessions).toBe(false)
      expect(engine.capabilities.browser).toBe(false)
      expect(engine.capabilities.skills).toBe(false)
      expect(engine.capabilities.mcp).toBe(false)
      expect(engine.capabilities.modelProviderRouting).toBe(false)
    }
  })

  it('carries engine-owned worker instructions so workflow code never branches on engines', () => {
    const engines = buildCodingEngineCatalog(availability())
    for (const engine of engines) {
      expect(engine.workerInstructions).toMatch(/Execution engine:/)
    }
    expect(engines.find((engine) => engine.id === CODEX_ENGINE_ID)?.workerInstructions).toContain('subagent_codex')
    expect(engines.find((engine) => engine.id === ANTIGRAVITY_ENGINE_ID)?.workerInstructions).toContain('headless')
    expect(engines.find((engine) => engine.id === ZCODE_CLI_ENGINE_ID)?.workerInstructions).toContain('Permission prompts')
    expect(engines.find((engine) => engine.id === CURSOR_CLI_ENGINE_ID)?.workerInstructions).toContain('headless')
    expect(engines.find((engine) => engine.id === CLAUDE_CODE_CLI_ENGINE_ID)?.workerInstructions).toContain('allow-listed')
  })

  it('reports missing-runtime failures as a GUI remedy without pretending an engine is available', () => {
    const engines = buildCodingEngineCatalog(availability({
      harnessReady: false,
      codexReady: false,
      codexCliReady: false,
      antigravityReady: false,
      zcodeCliReady: false,
      piCodingReady: false,
      cursorCliReady: false,
      claudeCodeCliReady: false,
    }))
    expect(engines.every((engine) => !engine.available)).toBe(true)
    // The ND-owned runtime is fixed from Settings, so its reasons must route
    // there rather than to a developer bootstrap.
    expect(engines.find((engine) => engine.id === CODEX_ENGINE_ID)?.unavailableReason).toMatch(/Settings → Capabilities/i)
    expect(engines.find((engine) => engine.id === CODEX_CLI_ENGINE_ID)?.unavailableReason).toMatch(/Settings → Capabilities/i)
    expect(engines.find((engine) => engine.id === ANTIGRAVITY_ENGINE_ID)?.unavailableReason).toMatch(/agy/i)
    expect(engines.find((engine) => engine.id === ZCODE_CLI_ENGINE_ID)?.unavailableReason).toMatch(/ZCode CLI/i)
    expect(engines.find((engine) => engine.id === PI_CODING_ENGINE_ID)?.unavailableReason).toMatch(/ND_DSH_PI_BINARY/i)
    expect(engines.find((engine) => engine.id === CURSOR_CLI_ENGINE_ID)?.unavailableReason).toMatch(/ND_DSH_CURSOR_BINARY/i)
    expect(engines.find((engine) => engine.id === CLAUDE_CODE_CLI_ENGINE_ID)?.unavailableReason).toMatch(/ND_DSH_CLAUDE_BINARY/i)
    // ND's end users are not expected to run a terminal, so no engine reason may
    // hand them a shell command.
    for (const engine of engines) {
      expect(engine.unavailableReason ?? '').not.toMatch(/pnpm |npm install|product bootstrap|Run pnpm/i)
    }
  })

  it('offers end-user install guidance for the optional CLIs without putting commands in reasons', () => {
    const engines = buildCodingEngineCatalog(availability({
      harnessReady: false,
      codexReady: false,
      codexCliReady: false,
      antigravityReady: false,
      zcodeCliReady: false,
      piCodingReady: false,
      cursorCliReady: false,
      claudeCodeCliReady: false,
    }))
    const antigravity = engines.find((engine) => engine.id === ANTIGRAVITY_ENGINE_ID)!
    const zcode = engines.find((engine) => engine.id === ZCODE_CLI_ENGINE_ID)!
    const pi = engines.find((engine) => engine.id === PI_CODING_ENGINE_ID)!
    const cursor = engines.find((engine) => engine.id === CURSOR_CLI_ENGINE_ID)!
    const claude = engines.find((engine) => engine.id === CLAUDE_CODE_CLI_ENGINE_ID)!

    expect(antigravity.installHelp?.url).toBe('https://antigravity.google')
    expect(cursor.installHelp?.url).toBe('https://cursor.com/docs/cli/installation')
    expect(claude.installHelp?.url).toBe('https://claude.com/product/claude-code')
    expect(pi.installHelp?.command).toBe('npm install -g @mariozechner/pi-coding-agent')
    expect(claude.installHelp?.command).toBe('npm install -g @anthropic-ai/claude-code')
    // No official ZCode download source ships with ND, so its card offers Re-check only.
    expect(zcode.installHelp).toBeUndefined()
    // ND installs its own runtime from Settings, so the harness carries no third-party guidance.
    expect(engines.find((engine) => engine.id === ND_HARNESS_ENGINE_ID)?.installHelp).toBeUndefined()

    for (const engine of engines) {
      const url = engine.installHelp?.url
      if (url === undefined) continue
      expect(new URL(url).protocol).toBe('https:')
    }

    // The copyable command is the only place a shell command may appear.
    for (const engine of [pi, claude]) {
      const command = codingEngineInstallCommand(engine.installHelp, 'win32')!
      expect(command).toMatch(/^npm install -g /)
      expect(engine.unavailableReason ?? '').not.toContain(command)
    }
  })

  it('resolves the copyable install command per platform', () => {
    expect(codingEngineInstallCommand(undefined, 'win32')).toBeUndefined()
    expect(codingEngineInstallCommand({}, 'win32')).toBeUndefined()
    expect(codingEngineInstallCommand({ command: 'npm install -g anywhere' }, 'linux')).toBe('npm install -g anywhere')
    expect(codingEngineInstallCommand({ command: { win32: 'winget install X', darwin: 'brew install X' } }, 'darwin')).toBe('brew install X')
    expect(codingEngineInstallCommand({ command: { win32: 'winget install X' } }, 'linux')).toBeUndefined()
  })

  it('keeps the direct Codex CLI available independently from the ND runtime bootstrap', () => {
    const engines = buildCodingEngineCatalog(availability({ harnessReady: false, codexReady: false, antigravityReady: false }))
    expect(engines.find((engine) => engine.id === CODEX_CLI_ENGINE_ID)?.available).toBe(true)
    expect(engines.find((engine) => engine.id === ND_HARNESS_ENGINE_ID)?.available).toBe(false)
  })
})
