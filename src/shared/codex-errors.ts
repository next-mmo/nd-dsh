/**
 * Codex app-server relays upstream HTTP failures as a JSON body inside its
 * JSON-RPC error message. ND keeps the useful meaning but turns the
 * account/model entitlement failure into a direct, actionable sentence so the
 * raw envelope never reaches a chat notice or the IPC error surface.
 */

const CHATGPT_MODEL_MISMATCH = /['"`]([^'"`]+)['"`]\s+model is not supported when using Codex with a ChatGPT account/i

export interface CodexChatGptModelMismatch {
  model?: string
}

/** Match Codex's "model not supported with a ChatGPT account" failure. */
export function codexChatGptModelMismatch(message: string): CodexChatGptModelMismatch | undefined {
  const match = CHATGPT_MODEL_MISMATCH.exec(message)
  if (!match) return undefined
  return match[1] ? { model: match[1] } : {}
}

/** Raw upstream wording or ND's normalized wording for the same failure. */
export function isCodexChatGptModelMismatch(message: string): boolean {
  return CHATGPT_MODEL_MISMATCH.test(message) || /not available with a ChatGPT account/i.test(message)
}

/**
 * Normalize only known Codex entitlement failures; every other message stays
 * byte-for-byte identical so diagnostics keep their original detail.
 */
export function normalizeCodexFailure(message: string): string {
  const mismatch = codexChatGptModelMismatch(message)
  if (!mismatch) return message
  return mismatch.model
    ? `Codex model “${mismatch.model}” is not available with a ChatGPT account. Choose a supported Codex model, or use API-key authentication.`
    : 'The selected Codex model is not available with a ChatGPT account. Choose a supported Codex model, or use API-key authentication.'
}
