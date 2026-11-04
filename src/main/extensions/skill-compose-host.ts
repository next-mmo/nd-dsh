import type { NdSkillService } from '../skills/nd-skill-service.js'
import type { SkillComposeRequest } from '../../shared/skill-compose.js'
import type { NativeHostRegistry } from './native-host.js'

export type SkillCatalogPort = Pick<NdSkillService, 'catalog'>

/** Draft-only handoff: extensions cannot start a turn or run a patch here. */
export function registerSkillComposeHost(
  host: NativeHostRegistry,
  skills: SkillCatalogPort | undefined,
  compose: (request: SkillComposeRequest) => void,
): void {
  host.register('skill.compose', async (input, context) => {
    if (context.caller !== 'user') throw new Error('Preparing a skill request in chat is a user action')
    if (!skills) throw new Error('ND skills are unavailable in this runtime')
    const name = typeof input.skill === 'string' ? input.skill : ''
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(name)) throw new Error('Choose an available ND skill')
    if (typeof input.request !== 'string' || !input.request.trim() || input.request.length > 8_000) {
      throw new Error('Skill request must contain 1–8,000 characters')
    }
    const catalog = await skills.catalog(context.context.kind === 'project' ? context.context.projectId : null)
    if (!catalog.skills.some((skill) => skill.name === name)) throw new Error(`Skill /${name} is unavailable; open ND Skills to check this workspace`)
    const request = { skillName: name, text: `/${name} ${input.request.trim()}` }
    compose(request)
    return { composed: true, ...request }
  })
}
