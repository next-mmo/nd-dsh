/**
 * Copy for runtime failure notices.
 *
 * The gateway relays agent failures verbatim (`errorChain` over the thrown
 * value), and providers like OpenRouter answer upstream outages with a bare
 * "Provider returned error" envelope that carries no further detail on the
 * wire. The notice therefore keeps the original message first and adds what ND
 * knows locally: which configured route failed and what is worth checking.
 */

import { isCodexChatGptModelMismatch, normalizeCodexFailure } from '../../../shared/codex-errors.js'
import { parsePromptShieldBlockedError } from '../../../shared/prompt-shield.js'

export interface AgentErrorRoute {
  provider: string
  model: string
}

const UPSTREAM_FAILURE = /provider.?returned.?error|overloaded|service.?unavailable|server.?error|internal.?error|\b50[0234]\b|\b524\b/i
const CREDENTIAL_FAILURE = /\b(?:api[- ]?key|credential)\b|\b401\b|\b403\b|unauthorized|forbidden|invalid api key/i
const QUOTA_FAILURE = /insufficient[_ ]?quota|quota exceeded|out of budget|billing|usage limit|credit/i
const CONTEXT_FAILURE = /context (?:window|length)|too large|too long|exceed/i
const NETWORK_FAILURE = /fetch failed|connection refused|ENOTFOUND|ETIMEDOUT|socket hang up|network/i

export function describeAgentError(message: string, route?: AgentErrorRoute | null): string {
  const base = normalizeCodexFailure(message.trim())
  const routeLine = route?.provider && route?.model
    ? `\n\nFailing route: ${route.provider} / ${route.model}.`
    : ''
  const hint = hintFor(base)
  return hint ? `${base}${routeLine}\n\n${hint}` : base
}

/**
 * Electron prefixes every rejected `ipcRenderer.invoke` with the channel and
 * error type. That wrapper names ND internals, not the failure, so user-facing
 * notifications strip it before showing the engine's own message.
 */
export function ipcFailureMessage(message: string): string {
  const unwrapped = message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '')
  const blocked = parsePromptShieldBlockedError(unwrapped)
  if (blocked) {
    const detail = blocked.findings.map((finding) => `${finding.label} ×${finding.count}`).join(', ')
    return `ND Prompt Shield blocked this message (${detail}). Nothing was sent. Change the category action in Settings → General → Privacy, or resend from the review dialog.`
  }
  return unwrapped
}

function hintFor(message: string): string | undefined {
  if (isCodexChatGptModelMismatch(message)) {
    return 'This is an account/model entitlement mismatch, not a sign-in failure: signing in again with the same ChatGPT account will repeat it. When the picker is on “Native model”, Codex inherits the model from ~/.codex/config.toml. The Codex desktop app can leave a model in that file which the subscription CLI route does not serve; picking a model in ND’s picker overrides it for this chat.'
  }
  if (UPSTREAM_FAILURE.test(message)) {
    return 'This came from the model provider’s servers after ND delivered the request — not from ND tools or your prompt. OpenRouter-style envelopes often carry no further detail. Retry, or switch routes in Model settings.'
  }
  if (CREDENTIAL_FAILURE.test(message)) {
    return 'The model provider rejected authentication. Check the stored credential in Model settings, then resend.'
  }
  if (QUOTA_FAILURE.test(message)) {
    return 'The account behind this route hit a quota or billing limit. Check the provider console, or switch routes in Model settings.'
  }
  if (CONTEXT_FAILURE.test(message)) {
    return 'The turn did not fit this model’s context window. Trim attached context or switch to a larger-context route.'
  }
  if (NETWORK_FAILURE.test(message)) {
    return 'ND could not reach the model server. Check network connectivity and the route’s Base URL, then retry.'
  }
  return undefined
}
