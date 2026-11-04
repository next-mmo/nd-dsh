/** A request staged in the composer. Sending is always a separate user action. */
export interface SkillComposeRequest {
  skillName: string
  text: string
}

export function prependSkillDraft(current: string, request: string): string {
  return current.trim() ? `${request}\n\n${current}` : request
}
