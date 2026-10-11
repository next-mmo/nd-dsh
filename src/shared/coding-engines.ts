import type { CodingEngineDescriptor, CodingEngineInstallHelp } from './contracts.js'

export const ND_HARNESS_ENGINE_ID = 'nd-harness'
export const ND_NATIVE_ENGINE_ID = 'nd-native'
export const CHATGPT_WEB_ENGINE_ID = 'chatgpt-web'
export const CODEX_ENGINE_ID = 'codex'
export const CODEX_CLI_ENGINE_ID = 'codex-cli'
export const ANTIGRAVITY_ENGINE_ID = 'antigravity'
export const ZCODE_CLI_ENGINE_ID = 'zcode-cli'
export const PI_CODING_ENGINE_ID = 'pi-coding'
export const CURSOR_CLI_ENGINE_ID = 'cursor-cli'
export const CLAUDE_CODE_CLI_ENGINE_ID = 'claude-code-cli'

export interface CodingEngineAvailability {
  harnessReady: boolean
  nativeReady?: boolean
  codexReady: boolean
  codexCliReady: boolean
  antigravityReady: boolean
  zcodeCliReady: boolean
  piCodingReady: boolean
  cursorCliReady: boolean
  claudeCodeCliReady: boolean
}

export function chatGptWebEngineDescriptor(): CodingEngineDescriptor {
  return {
    id: CHATGPT_WEB_ENGINE_ID,
    name: 'ChatGPT Web',
    integration: 'primary',
    available: true,
    description: 'Chat through the signed-in ChatGPT website in ND\'s visible browser. Conversation state stays on ChatGPT; code synchronizes through a safe per-chat Git branch on the project remote.',
    capabilities: {
      workspace: false,
      filesystem: false,
      shell: false,
      browser: true,
      skills: false,
      mcp: false,
      modelProviderRouting: false,
      humanApprovals: false,
      streaming: false,
      persistentSessions: true,
    },
    workerInstructions: '\nExecution engine: ChatGPT Web with Git sync. Conversation transport is the signed-in ChatGPT website in ND\'s visible browser; local code transport is the session-owned Git branch. Do not assume direct ND filesystem or shell tools exist inside ChatGPT. Require actual remote commits before claiming code synchronized. Never push directly to main or master.\n',
  }
}

/** Organization workers need a real ND workspace boundary; browser-only chat adapters stay interactive. */
export function workerAssignableCodingEngines(engines: readonly CodingEngineDescriptor[]): CodingEngineDescriptor[] {
  return engines.filter((engine) => engine.capabilities.workspace)
}

/** The install command matching the current platform, when the engine publishes one. */
export function codingEngineInstallCommand(help: CodingEngineInstallHelp | undefined, platform: string): string | undefined {
  const command = help?.command
  if (command === undefined) return undefined
  if (typeof command === 'string') return command
  return command[platform as keyof typeof command]
}

/**
 * Product-owned engine catalog. Runtime probes decide availability; the
 * descriptors themselves stay independent from Electron and vendor packages.
 *
 * `workerInstructions` carries engine-specific execution guidance for
 * organization workers so workflow code never branches on engine ids.
 */
export function buildCodingEngineCatalog(availability: CodingEngineAvailability): CodingEngineDescriptor[] {
  const harnessReason = availability.harnessReady
    ? undefined
    : 'The ND runtime is not set up on this install. Set it up in Settings → Capabilities, or reinstall ND.'
  const codexReason = availability.harnessReady
    ? availability.codexReady
      ? undefined
      : 'The bundled Codex adapter is missing from this install. Set the runtime up in Settings → Capabilities, or reinstall ND.'
    : 'Codex delegation needs the ND runtime, which is not set up on this install. Set it up in Settings → Capabilities, or reinstall ND.'
  const codexCliReason = availability.codexCliReady
    ? undefined
    : 'The bundled Codex CLI payload is missing from this install. Set the runtime up in Settings → Capabilities, or reinstall ND.'
  const antigravityReason = availability.antigravityReady
    ? undefined
    : 'The Antigravity CLI (agy) is not installed. Install it from the official Antigravity page. (Developers can override the path with ND_DSH_ANTIGRAVITY_BINARY.)'
  const zcodeCliReason = availability.zcodeCliReady
    ? undefined
    : 'The ZCode CLI is not installed. Install the ZCode desktop app. (Developers can override the path with ND_DSH_ZCODE_BINARY.)'
  const piReason = availability.piCodingReady
    ? undefined
    : 'The Pi coding agent CLI (pi) is not installed. Install the @mariozechner/pi-coding-agent package. (Developers can override the path with ND_DSH_PI_BINARY.)'
  const cursorReason = availability.cursorCliReady
    ? undefined
    : 'The Cursor CLI (cursor-agent) is not installed. Follow the official Cursor CLI installation guide. (Developers can override the path with ND_DSH_CURSOR_BINARY.)'
  const claudeReason = availability.claudeCodeCliReady
    ? undefined
    : 'The Claude Code CLI is not installed. Install it from the official Claude Code page. (Developers can override the path with ND_DSH_CLAUDE_BINARY.)'

  return [
    {
      id: ND_HARNESS_ENGINE_ID,
      name: 'ND Harness',
      integration: 'primary',
      available: availability.harnessReady,
      description: 'Primary ND coding runtime with durable sessions, workspace tools, browser control, skills, MCP, approvals, and provider-neutral model routing.',
      ...(harnessReason ? { unavailableReason: harnessReason } : {}),
      capabilities: {
        workspace: true,
        filesystem: true,
        shell: true,
        browser: true,
        skills: true,
        mcp: true,
        modelProviderRouting: true,
        humanApprovals: true,
        streaming: true,
        persistentSessions: true,
      },
      workerInstructions: '\nExecution engine: ND Harness. Work directly in the project workspace using the available ND tools.\n',
    },
    {
      id: ND_NATIVE_ENGINE_ID,
      name: 'ND Agent (Rust)',
      integration: 'primary',
      available: availability.nativeReady === true,
      description: 'ND-owned Rust agent runtime using ND model routes, workspace tools, browser and extension brokerage, approvals, and durable sessions.',
        ...(availability.nativeReady ? {} : { unavailableReason: 'ND Agent is in private workflow verification.' }),
      capabilities: {
          workspace: true, filesystem: true, shell: false, browser: true, skills: true,
          mcp: false, modelProviderRouting: true, humanApprovals: true,
        streaming: true, persistentSessions: true,
      },
      workerInstructions: '\nExecution engine: ND Agent. Use ND workspace tools and the visible ND browser.\n',
    },
    {
      id: CODEX_ENGINE_ID,
      name: 'Codex (delegated)',
      integration: 'delegated',
      available: availability.codexReady,
      description: 'Official Codex app-server exposed as a one-shot coding engine through the pinned ND Harness adapter. Authentication and model configuration remain native to Codex.',
      ...(codexReason ? { unavailableReason: codexReason } : {}),
      capabilities: {
        workspace: true,
        filesystem: true,
        shell: true,
        browser: false,
        skills: false,
        mcp: false,
        modelProviderRouting: false,
        humanApprovals: false,
        streaming: false,
        persistentSessions: false,
      },
      workerInstructions: '\nExecution engine: Codex CLI (delegated through the ND runtime).\nYou MUST delegate the implementation to the subagent_codex tool as one self-contained task that includes the project objective, task description, acceptance criteria, and relevant review feedback. Do not implement the requested code changes yourself before that delegation. After Codex returns, inspect the actual workspace, run appropriate validation with your ND tools, and report an evidence-based result. If Codex authentication, project trust, sandbox policy, or execution fails, report the blocker clearly and do not invent completion.\n',
    },
    {
      id: CODEX_CLI_ENGINE_ID,
      name: 'Codex CLI',
      integration: 'primary',
      available: availability.codexCliReady,
      description: 'Official Codex app-server managed directly by ND: streamed chat threads, approval prompts, and workspace-scoped unattended runs. Authentication and model configuration remain native to Codex.',
      ...(codexCliReason ? { unavailableReason: codexCliReason } : {}),
      capabilities: {
        workspace: true,
        filesystem: true,
        shell: true,
        browser: false,
        skills: false,
        mcp: false,
        modelProviderRouting: false,
        humanApprovals: true,
        streaming: true,
        persistentSessions: false,
      },
      workerInstructions: '\nExecution engine: Codex CLI (direct, managed by ND).\nImplement the requested changes yourself with your native Codex tools inside the provided project workspace. Inspect before editing, stay inside the workspace sandbox, and run meaningful validation before declaring the task complete. If authentication, project trust, sandbox policy, or execution fails, report the blocker clearly and do not invent completion.\n',
    },
    {
      id: ANTIGRAVITY_ENGINE_ID,
      name: 'Antigravity CLI',
      integration: 'primary',
      available: availability.antigravityReady,
      description: 'Google Antigravity CLI (agy) managed directly by ND: streamed multi-turn conversations over the stream-json wires with native Google-account authentication. Model configuration and headless permission policy remain native to Antigravity.',
      ...(antigravityReason ? { unavailableReason: antigravityReason } : {}),
      installHelp: { url: 'https://antigravity.google' },
      capabilities: {
        workspace: true,
        filesystem: true,
        shell: true,
        browser: false,
        skills: false,
        mcp: false,
        modelProviderRouting: false,
        humanApprovals: false,
        streaming: true,
        persistentSessions: false,
      },
      workerInstructions: '\nExecution engine: Antigravity CLI (direct, managed by ND).\nImplement the requested changes yourself with your native Antigravity tools inside the provided project workspace. The session is headless: tools the user has not allow-listed in the Antigravity CLI settings are auto-denied, so report permission denials clearly instead of retrying or inventing completion. Do not use Antigravity browser tools; ND owns browser control. If authentication or execution fails, report the blocker clearly and do not invent completion.\n',
    },
    {
      id: ZCODE_CLI_ENGINE_ID,
      name: 'ZCode CLI',
      integration: 'primary',
      available: availability.zcodeCliReady,
      description: 'ZCode CLI app-server managed directly by ND: streamed multi-turn chats, approval prompts routed through ND, and workspace-scoped turns. Authentication, model, and permission-mode configuration remain native to ZCode.',
      ...(zcodeCliReason ? { unavailableReason: zcodeCliReason } : {}),
      capabilities: {
        workspace: true,
        filesystem: true,
        shell: true,
        browser: false,
        skills: false,
        mcp: false,
        modelProviderRouting: false,
        humanApprovals: true,
        streaming: true,
        persistentSessions: false,
      },
      workerInstructions: '\nExecution engine: ZCode CLI (direct, managed by ND).\nImplement the requested changes yourself with your native ZCode tools inside the provided project workspace. Inspect before editing, stay inside the workspace, and run meaningful validation before declaring the task complete. Permission prompts are surfaced through ND; unattended runs deny them, so allow-list risky tools in ZCode settings instead of retrying. Do not use ZCode browser tools; ND owns browser control. If authentication, model configuration, or execution fails, report the blocker clearly and do not invent completion.\n',
    },
    {
      id: PI_CODING_ENGINE_ID,
      name: 'Pi CLI',
      integration: 'primary',
      available: availability.piCodingReady,
      description: 'Pi coding agent (pi --mode rpc) managed directly by ND: streamed multi-turn conversations over JSONL RPC with ND provider routing, embedded browser sharing, and workspace skills.',
      ...(piReason ? { unavailableReason: piReason } : {}),
      installHelp: { command: 'npm install -g @mariozechner/pi-coding-agent' },
      capabilities: {
        workspace: true,
        filesystem: true,
        shell: true,
        browser: true,
        skills: true,
        mcp: false,
        modelProviderRouting: true,
        humanApprovals: false,
        streaming: true,
        persistentSessions: false,
      },
      workerInstructions: '\nExecution engine: Pi CLI (direct, managed by ND).\nImplement the requested changes yourself with your native Pi tools inside the provided project workspace. Inspect before editing, stay inside the workspace, and run meaningful validation before declaring the task complete. Pi has no permission gate: follow the task instructions strictly and do not touch anything outside the workspace. If authentication or execution fails, report the blocker clearly and do not invent completion.\n',
    },
    {
      id: CURSOR_CLI_ENGINE_ID,
      name: 'Cursor CLI',
      integration: 'primary',
      available: availability.cursorCliReady,
      description: 'Cursor CLI (cursor-agent -p) managed directly by ND: streamed headless turns over the stream-json wires with native Cursor authentication and models. Runs with --force because headless Cursor otherwise only proposes diffs instead of applying them.',
      ...(cursorReason ? { unavailableReason: cursorReason } : {}),
      installHelp: { url: 'https://cursor.com/docs/cli/installation' },
      capabilities: {
        workspace: true,
        filesystem: true,
        shell: true,
        browser: false,
        skills: false,
        mcp: false,
        modelProviderRouting: false,
        humanApprovals: false,
        streaming: true,
        persistentSessions: false,
      },
      workerInstructions: '\nExecution engine: Cursor CLI (direct, managed by ND).\nImplement the requested changes yourself with your native Cursor tools inside the provided project workspace. Inspect before editing, stay inside the workspace, and run meaningful validation before declaring the task complete. The session is headless with changes applied directly, so scope every edit to the task at hand. Do not use Cursor browser tools; ND owns browser control. If authentication or execution fails, report the blocker clearly and do not invent completion.\n',
    },
    {
      id: CLAUDE_CODE_CLI_ENGINE_ID,
      name: 'Claude Code CLI',
      integration: 'primary',
      available: availability.claudeCodeCliReady,
      description: 'Claude Code CLI (claude -p) managed directly by ND: streamed multi-turn conversations over the headless stream-json wires with native Claude authentication and settings. File edits run under acceptEdits; headless permission prompts stay denied by the CLI itself.',
      ...(claudeReason ? { unavailableReason: claudeReason } : {}),
      installHelp: {
        url: 'https://claude.com/product/claude-code',
        command: 'npm install -g @anthropic-ai/claude-code',
      },
      capabilities: {
        workspace: true,
        filesystem: true,
        shell: true,
        browser: false,
        skills: false,
        mcp: false,
        modelProviderRouting: false,
        humanApprovals: false,
        streaming: true,
        persistentSessions: false,
      },
      workerInstructions: '\nExecution engine: Claude Code CLI (direct, managed by ND).\nImplement the requested changes yourself with your native Claude Code tools inside the provided project workspace. Inspect before editing, stay inside the workspace, and run meaningful validation before declaring the task complete. The session is headless: tools the user has not allow-listed in Claude Code settings are denied, so report permission denials clearly instead of retrying or inventing completion. Do not use Claude browser tools; ND owns browser control. If authentication or execution fails, report the blocker clearly and do not invent completion.\n',
    },
  ]
}
