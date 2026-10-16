import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CodingEngineDescriptor } from '../../shared/contracts.js'
import { buildCodingEngineCatalog, chatGptWebEngineDescriptor, geminiWebEngineDescriptor, ND_HARNESS_ENGINE_ID } from '../../shared/coding-engines.js'
import { buildExtraCodingEngineCatalog } from '../../shared/extra-coding-engines.js'
import { antigravityBinPath, claudeBinPath, codexBinPath, cursorBinPath, dshPatchPath, harnessCliBinPath, harnessRoot, ndAgentBinPath, piBinPath, presetSourceDir, zcodeBinPath } from '../app-paths.js'
import type { CapabilityAssignmentStore } from '../capabilities/capability-assignment-store.js'
import { gooseBinPath, hermesBinPath, jcodeBinPath, minimaxBinPath, opencodeBinPath } from './agent-cli/extra-cli-paths.js'
import { nativePrivateSelectionEnabled } from './nd-native/native-selection-gate.js'

/**
 * ND control-plane registry for executable coding engines plus durable
 * per-employee routing. Organization workflow code consumes this abstraction,
 * never vendor package paths or product-specific protocol details.
 *
 * Assignments live in the shared capability store so engines, memory, and
 * context resolve through one mechanism; this class keeps the engine-shaped
 * surface the renderer and orchestrator already use.
 */
export class CodingEngineRegistry {
  constructor(private readonly assignmentsStore: CapabilityAssignmentStore) {}

  list(): CodingEngineDescriptor[] {
    const harnessReady = existsSync(harnessCliBinPath())
      && existsSync(dshPatchPath())
      && existsSync(presetSourceDir())
    const root = harnessRoot()
    const codexReady = harnessReady && [
      join(root, 'packages/subagent/subagent-codex/lib/index.js'),
      join(root, 'node_modules/@deepseek-ai/dsh-subagent-codex/lib/index.js'),
    ].some((entry) => existsSync(entry))
    // The direct engine needs only the pinned Codex CLI payload; it does not
    // depend on the ND runtime bootstrap.
    const codexCliReady = codexBinPath() !== undefined
    const antigravityReady = antigravityBinPath() !== undefined
    const zcodeCliReady = zcodeBinPath() !== undefined
    const piCodingReady = piBinPath() !== undefined
    const cursorCliReady = cursorBinPath() !== undefined
    const claudeCodeCliReady = claudeBinPath() !== undefined
    const nativeReady = nativePrivateSelectionEnabled() && existsSync(ndAgentBinPath())
    return [
      ...buildCodingEngineCatalog({
        harnessReady,
        // Private opt-in only. Public/package defaults stay fail-closed until
        // the milestone evidence is promoted into a release decision.
        nativeReady,
        codexReady,
        codexCliReady,
        antigravityReady,
        zcodeCliReady,
        piCodingReady,
        cursorCliReady,
        claudeCodeCliReady,
      }),
      ...buildExtraCodingEngineCatalog({
        opencodeCliReady: opencodeBinPath() !== undefined,
        gooseCliReady: gooseBinPath() !== undefined,
        jcodeCliReady: jcodeBinPath() !== undefined,
        hermesCliReady: hermesBinPath() !== undefined,
        minimaxCliReady: minimaxBinPath() !== undefined,
      }),
      chatGptWebEngineDescriptor(),
      geminiWebEngineDescriptor(),
    ]
  }

  /** Legacy view: agent id → engine id for agents explicitly off the default. */
  async assignments(): Promise<Record<string, string>> {
    const snapshot = await this.assignmentsStore.all()
    const agents: Record<string, string> = {}
    for (const [agentId, kinds] of Object.entries(snapshot.agents)) {
      if (kinds.engine) agents[agentId] = kinds.engine
    }
    return agents
  }

  async assignedEngine(agentId: string | undefined): Promise<string> {
    if (!agentId?.trim()) return ND_HARNESS_ENGINE_ID
    return this.assignmentsStore.resolve('engine', { type: 'agent', id: agentId })
  }

  async assign(agentId: string, engineId: string): Promise<Record<string, string>> {
    const descriptor = this.list().find((engine) => engine.id === engineId)
    if (!descriptor) throw new Error(`Unknown coding engine: ${engineId}`)
    this.assertWorkerEngine(descriptor)
    await this.assignmentsStore.assign('agent', agentId, 'engine', engineId)
    return this.assignments()
  }

  /** Organization workers require an engine with an actual ND workspace boundary. */
  assertAvailable(engineId: string): CodingEngineDescriptor {
    const descriptor = this.list().find((engine) => engine.id === engineId)
    if (!descriptor) throw new Error(`Unknown coding engine: ${engineId}`)
    this.assertWorkerEngine(descriptor)
    return descriptor
  }

  async resetToHarness(agentId: string): Promise<Record<string, string>> {
    await this.assignmentsStore.assign('agent', agentId, 'engine', ND_HARNESS_ENGINE_ID)
    return this.assignments()
  }

  private assertWorkerEngine(descriptor: CodingEngineDescriptor): void {
    if (!descriptor.available) throw new Error(descriptor.unavailableReason ?? `${descriptor.name} is unavailable`)
    if (!descriptor.capabilities.workspace) {
      throw new Error(`${descriptor.name} is an interactive chat engine and cannot be assigned to organization workers until it supports isolated ND workspaces.`)
    }
  }
}
