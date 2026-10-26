import type { PromptShieldService } from './prompt-shield-service.js'

let runtime: PromptShieldService | undefined

export function setPromptShieldRuntime(service: PromptShieldService | undefined): void {
  runtime = service
}

/** The active shield, if the desktop IPC bridge has been composed. */
export function promptShieldRuntime(): PromptShieldService | undefined {
  return runtime
}
