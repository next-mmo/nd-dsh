import type { DesktopApi } from '../../shared/contracts'
import type { DesignDesktopApi } from '../../shared/design'
import type { ExtensionsDesktopApi } from '../../shared/extensions'
import type { NdGatewayDesktopApi } from '../../shared/gateway'
import type { OrganizationControlDesktopApi } from '../../shared/organization-control'
import type { OrganizationDesktopApi } from '../../shared/organization'
import type { OrganizationStrategyDesktopApi } from '../../shared/organization-strategy'
import type { LocalRuntimeDesktopApi } from '../../shared/local-runtime'
import type { PromptShieldDesktopApi } from '../../shared/prompt-shield'
import type { RouterDesktopApi } from '../../shared/router'
import type { TerminalDesktopApi } from '../../shared/terminal'
import type { TokenSaverDesktopApi } from '../../shared/token-saver'
import type { ToolRoutingDesktopApi } from '../../shared/tool-routing'
import type { UsageDesktopApi } from '../../shared/usage'
import type { WorkflowPluginsDesktopApi } from '../../shared/workflow-plugins'

declare global {
  interface Window {
    ndDsh: DesktopApi
    ndDshExtensions: ExtensionsDesktopApi
    ndDshDesign: DesignDesktopApi
    ndDshOrganization: OrganizationDesktopApi
    ndDshControl: OrganizationControlDesktopApi
    ndDshStrategy: OrganizationStrategyDesktopApi
    ndDshLocalRuntime: LocalRuntimeDesktopApi
    ndDshTerminal: TerminalDesktopApi
    ndDshTokenSaver: TokenSaverDesktopApi
    ndDshPromptShield: PromptShieldDesktopApi
    ndDshRouter: RouterDesktopApi
    ndDshToolRouting: ToolRoutingDesktopApi
    ndDshGateway: NdGatewayDesktopApi
    ndDshWorkflowPlugins: WorkflowPluginsDesktopApi
    ndDshUsage: UsageDesktopApi
    ndDshRuntimeMode?: 'ui-preview'
  }
}

export {}