import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { LauncherHandoffTarget } from '../../shared/quick-launcher'
import type { ThemeState } from '../../shared/contracts'
import type { NdContext } from '../../shared/nd-context'
import type { NdCommandView } from '../../shared/nd-invocations'
import type { OrganizationSnapshot } from '../../shared/organization'
import { QuickLauncher } from './components/QuickLauncher'
import { Toaster } from './components/ui/sonner'
import {
  commandRunPlan,
  contextForOptionId,
  contextOptions,
  describeContextForUi,
} from './lib/nd-context-model'
import { buildLauncherMemoryMutation, buildLauncherTaskMutation } from './lib/quick-launcher-model'
import { errorMessage } from './lib/qa'

const DAILY_ESSENTIALS_ID = 'nd.daily-essentials'

/**
 * The launcher popup surface: a dedicated sandboxed renderer (frameless
 * window at #/launcher) that draws only the quick launcher card floating over
 * the user's current app. It deliberately never runs the full product shell,
 * so it only touches channels admitted for this surface — the organization
 * bridge, the theme read, launcher popup controls, and the extension commands
 * surface. Everything that needs chat state, the embedded browser, or capture
 * overlays hands off to the full window with the popup's explicit context, so
 * work started in Personal stays personal.
 */
export default function LauncherPopupApp(): React.ReactNode {
  const [orgState, setOrgState] = useState<OrganizationSnapshot | null>(null)
  const [theme, setTheme] = useState<ThemeState | null>(null)
  // The OS shortcut defaults to Personal on each opening; focusing the popup
  // resets the selector so a stale project context can never linger.
  const [launcherContextId, setLauncherContextId] = useState('personal')
  const [extensionCommands, setExtensionCommands] = useState<NdCommandView[]>([])

  useEffect(() => {
    let mounted = true
    void window.ndDshOrganization.state()
      .then((next) => { if (mounted) setOrgState(next) })
      .catch((cause) => toast(errorMessage(cause), { duration: 5000 }))
    const offOrganization = window.ndDshOrganization.onChanged((next) => {
      if (mounted) setOrgState(next)
    })
    void window.ndDsh.theme?.state()
      .then((next) => { if (mounted) setTheme(next) })
      .catch(() => undefined)
    const offTheme = window.ndDsh.theme?.onChanged(setTheme)
    const onFocus = (): void => setLauncherContextId('personal')
    window.addEventListener('focus', onFocus)
    return () => {
      mounted = false
      offOrganization()
      offTheme?.()
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    if (!theme) return
    document.documentElement.dataset.theme = theme.effective
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme.effective)
  }, [theme])

  // The themed body paints an opaque surface; the popup window must stay see-
  // through down to the OS, so drop the background on every root layer.
  useEffect(() => {
    const roots = [document.documentElement, document.body, document.getElementById('root')].filter(
      (element): element is HTMLElement => element !== null,
    )
    roots.forEach((element) => element.classList.add('launcher-popup-mode'))
    return () => roots.forEach((element) => element.classList.remove('launcher-popup-mode'))
  }, [])

  const contexts = useMemo(() => contextOptions(orgState), [orgState])
  const selectedContext: NdContext = contextForOptionId(contexts, launcherContextId) ?? { kind: 'personal' }

  useEffect(() => {
    let mounted = true
    void window.ndDsh.ndExtensions.commands(selectedContext)
      .then((next) => { if (mounted) setExtensionCommands(next) })
      .catch(() => { if (mounted) setExtensionCommands([]) })
    return () => { mounted = false }
  }, [launcherContextId, orgState])

  const notify = (message: string): void => {
    toast(message, { duration: 5000 })
  }

  const company = orgState?.companies.find((item) => item.id === orgState.activeCompanyId) ?? orgState?.companies[0] ?? null
  const companyProjects = orgState && company ? orgState.projects.filter((item) => item.companyId === company.id) : []
  const project = companyProjects.find((item) => item.id === orgState?.activeProjectId) ?? companyProjects[0] ?? null
  // Task/note writes follow the popup's explicitly selected context, never the
  // company/project that happens to be active in the main window.
  const contextCompany = selectedContext.kind === 'personal'
    ? null
    : orgState?.companies.find((item) => item.id === selectedContext.companyId) ?? null
  const contextProject = selectedContext.kind === 'project'
    ? orgState?.projects.find((item) => item.id === selectedContext.projectId) ?? null
    : null

  const hidePopup = (): void => {
    void window.ndDsh.window?.hideLauncherPopup?.().catch((cause) => notify(errorMessage(cause)))
  }
  const handoff = async (target: LauncherHandoffTarget, text?: string, context?: NdContext): Promise<void> => {
    await window.ndDsh.window?.handoffLauncherPopup?.(target, text, context)
      .catch((cause) => notify(errorMessage(cause)))
  }

  const invokeDaily = (contributionId: string, concept: 'command' | 'view', input: Record<string, unknown>) =>
    window.ndDsh.ndExtensions.invoke({
      extensionId: DAILY_ESSENTIALS_ID,
      contributionId,
      contributionKind: concept,
      context: selectedContext,
      caller: 'user',
      input,
    })

  const createTask = async (text: string): Promise<void> => {
    if (selectedContext.kind === 'personal') {
      notify('Tasks need a project context. Pick one in Context first.')
      return
    }
    if (!contextCompany || !contextProject) {
      notify('Pick a project context before creating a task.')
      return
    }
    try {
      await window.ndDshOrganization.mutate(buildLauncherTaskMutation(contextCompany.id, contextProject.id, text))
      hidePopup()
      toast('Task created from ND Quick Launcher.')
    } catch (cause) {
      notify(errorMessage(cause))
    }
  }

  const quickNote = async (text: string, tags: string[] = ['launcher', 'manual']): Promise<void> => {
    if (selectedContext.kind === 'personal') {
      try {
        const result = await invokeDaily('quick-note', 'command', { text, tags })
        if (!result.ok) {
          notify(result.error?.message ?? 'The note could not be saved.')
          return
        }
        hidePopup()
        toast('Note saved to Personal.')
      } catch (cause) {
        notify(errorMessage(cause))
      }
      return
    }
    if (!contextCompany) {
      notify('Choose a company context before saving a note.')
      return
    }
    try {
      await window.ndDshOrganization.mutate(buildLauncherMemoryMutation(contextCompany.id, contextProject?.id, text, tags))
      hidePopup()
      toast(contextProject ? `Note saved to ${contextProject.name}.` : `Note saved to ${contextCompany.name}.`)
    } catch (cause) {
      notify(errorMessage(cause))
    }
  }

  const captureClipboard = async (): Promise<void> => {
    if (selectedContext.kind === 'personal') {
      try {
        const result = await invokeDaily('capture-clipboard', 'command', {})
        if (!result.ok) {
          notify(result.error?.message ?? 'The clipboard could not be captured.')
          return
        }
        hidePopup()
        toast('Clipboard captured into Personal.')
      } catch (cause) {
        notify(errorMessage(cause))
      }
      return
    }
    try {
      const text = (await navigator.clipboard.readText()).trim()
      if (!text) {
        notify('Clipboard does not contain text to capture.')
        return
      }
      await quickNote(text, ['capture', 'clipboard'])
    } catch (cause) {
      notify(errorMessage(cause))
    }
  }

  const activateProject = async (projectId: string): Promise<void> => {
    const target = orgState?.projects.find((item) => item.id === projectId)
    if (!target) return
    try {
      if (target.companyId !== orgState?.activeCompanyId) {
        await window.ndDshOrganization.mutate({ type: 'company.activate', id: target.companyId })
      }
      await window.ndDshOrganization.mutate({ type: 'project.activate', id: projectId })
      hidePopup()
    } catch (cause) {
      notify(errorMessage(cause))
    }
  }

  const switchCompany = async (companyId: string): Promise<void> => {
    try {
      await window.ndDshOrganization.mutate({ type: 'company.activate', id: companyId })
      hidePopup()
    } catch (cause) {
      notify(errorMessage(cause))
    }
  }

  /**
   * Extension commands run through the broker with the popup's context. Local
   * results (notes, clipboard, capture) complete in place; anything that needs
   * the full app hands off with the same bound context.
   */
  const runCommand = async (command: NdCommandView, typed: string): Promise<void> => {
    const plan = commandRunPlan(command, typed)
    if (plan.missing) {
      notify(plan.missing)
      return
    }
    if (command.openViewId) {
      await handoff(
        'extension-view',
        `${command.extensionId}:${command.openViewId}`,
        selectedContext,
      )
      return
    }
    if (command.host === 'capture.area') {
      await handoff('capture-tools', undefined, selectedContext)
      return
    }
    if (command.host === 'chat.ask') {
      await handoff('agent', String(plan.input.text ?? ''), selectedContext)
      return
    }
    let hiddenForCapture = false
    const reportFailure = async (message: string): Promise<void> => {
      if (hiddenForCapture) {
        await window.ndDsh.window?.toggleLauncherPopup?.().catch(() => undefined)
        hiddenForCapture = false
      }
      notify(message)
    }
    try {
      if (command.host === 'capture.screen') {
        await window.ndDsh.window?.hideLauncherPopup?.()
        hiddenForCapture = true
      }
      const result = await window.ndDsh.ndExtensions.invoke({
        extensionId: command.extensionId,
        contributionId: command.contributionId,
        contributionKind: 'command',
        context: selectedContext,
        caller: 'user',
        input: plan.input,
      })
      if (!result.ok) {
        if (result.error?.code === 'approval-required') {
          await reportFailure('This needs your approval — check Settings → Extensions.')
          return
        }
        await reportFailure(result.error?.message ?? 'The action could not run.')
        return
      }
      const value = (result.value ?? {}) as Record<string, unknown>
      switch (command.host) {
        case 'browser.openUrl':
        case 'browser.search':
          await handoff('browser', typeof value.url === 'string' ? value.url : undefined, selectedContext)
          return
        case 'capture.screen':
          hidePopup()
          await handoff('home', undefined, selectedContext)
          return
        case 'note.create':
          hidePopup()
          toast(`Saved “${String(value.title ?? 'note')}”.`)
          return
        case 'note.search':
        case 'clipboard.read':
          hidePopup()
          toast('Captured into Personal.')
          return
        case 'os.openTarget':
          if (value.opened) toast(`Opened ${String(value.path)}`)
          hidePopup()
          return
        case 'os.wallpaper.chooseAndSet':
        case 'os.wallpaper.next':
        case 'os.wallpaper.previous':
        case 'os.wallpaper.random':
        case 'os.wallpaper.applySelected':
          hidePopup()
          if (value.changed) toast(typeof value.name === 'string' ? `Wallpaper changed to ${value.name}.` : 'Desktop wallpaper updated.')
          return
        case 'os.wallpaper.folders.add':
          hidePopup()
          if (value.changed) toast(typeof value.folder === 'string' ? `Wallpaper folder set to ${String(value.folder)}.` : 'Wallpaper folder updated.')
          return
        case 'browser.openExternal':
          hidePopup()
          toast('Opened in your system browser.')
          return
        default:
          hidePopup()
          return
      }
    } catch (cause) {
      await reportFailure(errorMessage(cause))
    }
  }

  return (
    <div className="launcher-popup-mode h-screen w-screen overflow-hidden bg-transparent p-2 font-sans">
      <QuickLauncher
        open
        closeBeforeRun={false}
        onOpenChange={hidePopup}
        organization={orgState}
        contexts={contexts}
        activeContextId={launcherContextId}
        contextLabel={describeContextForUi(selectedContext, orgState)}
        onSelectContext={setLauncherContextId}
        extensionCommands={extensionCommands}
        onRunExtensionCommand={runCommand}
        onOpenKanban={() => handoff('kanban', undefined, selectedContext)}
        onOpenAgent={() => handoff('agent', undefined, selectedContext)}
        onActivateProject={activateProject}
        onSwitchCompany={switchCompany}
        onCreateTask={createTask}
        onQuickNote={quickNote}
        onAskAgent={(text) => handoff('agent', text, selectedContext)}
        onCaptureScreen={() => {
          if (selectedContext.kind === 'personal') {
            return runCommand({
              extensionId: DAILY_ESSENTIALS_ID,
              contributionId: 'capture-screen',
              title: 'Capture screen',
              keywords: [],
              contexts: ['personal'],
              startsAgent: false,
              host: 'capture.screen',
              permission: 'capture.screen',
            }, '')
          }
          return handoff('capture-screen', undefined, selectedContext)
        }}
        onOpenCaptureTools={() => handoff('capture-tools', undefined, selectedContext)}
        onCaptureClipboard={captureClipboard}
        onCaptureUrl={(url) => quickNote(url, ['capture', 'url'])}
      />
      <Toaster position="bottom-right" duration={5000} />
    </div>
  )
}
