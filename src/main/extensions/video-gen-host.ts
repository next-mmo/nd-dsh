import { randomUUID } from 'node:crypto'
import { providerCategory, type RouterPlaygroundInput, type RouterState } from '../../shared/router.js'
import type { RouterService } from '../router/router-service.js'
import type { NativeHostRegistry, NdHostCallContext } from './native-host.js'

type VideoGenRouter = Pick<RouterService, 'state' | 'playgroundStart' | 'playgroundStop'>

const SCENE_PROMPT = `Create on-screen copy and a color palette for a vertical video of a glowing geometric orb. Match the language of the brief. The hook is up to 72 characters and the call to action is up to 36 characters. Pick one palette: neon (cyan/violet/orange), sunset (amber/coral/pink), or aurora (mint/blue/lavender). Reply with a JSON object containing only the string fields hook, cta, and palette.`

function requireStudio(context: NdHostCallContext): void {
  if (context.extensionId !== 'nd.video-gen' || context.context.kind !== 'personal' || context.caller !== 'user') {
    throw new Error('This action is only available in the Personal ND Video Gen studio.')
  }
}

function models(state: RouterState) {
  return state.providers.flatMap((provider) => {
    if (!provider.isActive || providerCategory(provider.kind) !== 'api') return []
    return [...new Set(provider.models)].map((model) => ({ providerId: provider.id, providerName: provider.name, model }))
  })
}

function sceneSettings(text: string) {
  const error = new Error('The model did not return usable scene settings. Try again or choose another model.')
  if (text.length > 4_096) throw error
  let value: Record<string, unknown> | null
  try {
    value = JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'))
  } catch {
    throw error
  }
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 ||
      !['hook', 'cta', 'palette'].every((key) => Object.hasOwn(value, key))) throw error
  const { hook, cta, palette } = value
  if (palette !== 'neon' && palette !== 'sunset' && palette !== 'aurora') throw error
  return { hook: overlayText(hook, 72), cta: overlayText(cta, 36), palette }
}

function overlayText(value: unknown, maxLength: number): string {
  const result = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (!result || result.length > maxLength) throw new Error('The model returned missing or overly long video text. Try again.')
  return result
}

export function registerVideoGenHosts(host: NativeHostRegistry, router: VideoGenRouter | undefined): () => void {
  let current: AbortController | undefined

  host.register('video-gen.models', async (_input, context) => {
    requireStudio(context)
    if (!router) throw new Error('ND Router is unavailable.')
    return models(await router.state())
  })

  host.register('video-gen.generate', async (input, context) => {
    requireStudio(context)
    if (!router) throw new Error('ND Router is unavailable.')
    if (current) throw new Error('A scene is already being generated.')
    const brief = typeof input.brief === 'string' ? input.brief.trim() : ''
    if (!brief || brief.length > 500) throw new Error('Enter a video brief of up to 500 characters.')

    const controller = new AbortController()
    current = controller
    const timeout = setTimeout(() => controller.abort(), 60_000)
    try {
      const route = models(await router.state()).find((item) => item.providerId === input.providerId && item.model === input.model)
      if (!route) throw new Error('Choose an available ND Router text API model.')
      if (controller.signal.aborted) throw new Error('The scene request timed out.')
      const requestId = randomUUID()
      const request: RouterPlaygroundInput = {
        requestId,
        route: { kind: 'model', providerId: route.providerId, model: route.model },
        messages: [{ role: 'system', content: SCENE_PROMPT }, { role: 'user', content: brief }],
        stream: false,
      }
      const text = await new Promise<string>((resolve, reject) => {
        const cancel = () => {
          router.playgroundStop(requestId)
          reject(new Error('The scene request timed out or was closed.'))
        }
        controller.signal.addEventListener('abort', cancel, { once: true })
        router.playgroundStart(request, (event) => {
          if (event.requestId !== requestId || (event.type !== 'done' && event.type !== 'error')) return
          controller.signal.removeEventListener('abort', cancel)
          if (event.type === 'done') resolve(event.text ?? '')
          else reject(new Error('The selected model could not generate a scene. Check your connection in ND Router and try again.'))
        }, { requireApiModel: true })
      })
      return sceneSettings(text)
    } finally {
      clearTimeout(timeout)
      current = undefined
    }
  })

  return () => current?.abort()
}
