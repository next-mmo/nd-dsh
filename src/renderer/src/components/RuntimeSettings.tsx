import type { HarnessStatus } from '../../../shared/contracts'
import {
  SettingsRow,
  SettingsSection,
  StatusChip,
  rowDesc,
  rowPathText,
  rowStack,
  rowTitle,
  rowValueText,
} from './settings-primitives'
import { cn } from '../lib/utils'

interface RuntimeSettingsProps {
  harness: HarnessStatus | null
}

/** General → Runtime: ND Harness status and product architecture notes. */
export function RuntimeSettings({ harness }: RuntimeSettingsProps) {
  const dotClass = harness?.state === 'ready'
    ? 'bg-primary'
    : harness?.state === 'running' || harness?.state === 'starting'
      ? 'animate-pulse-dot bg-info'
      : harness?.state === 'error'
        ? 'bg-destructive'
        : 'bg-faint'

  return (
    <>
      <SettingsSection title="ND runtime" className="mt-3.5">
        <div className="space-y-1.5">
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Primary adapter</strong>
              <span className={rowDesc}>ND Harness currently owns durable sessions, tools, approvals, and organization run events. Additional coding engines are registered separately.</span>
            </div>
            <span className={cn('inline-block size-1.5 shrink-0 rounded-full', dotClass)} />
          </SettingsRow>
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Model route</strong>
              <span className={rowDesc}>{harness?.model ?? 'Not connected'}</span>
            </div>
            <span className={rowValueText}>{harness?.provider ?? '—'}</span>
          </SettingsRow>
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Provider credential</strong>
              <span className={rowDesc}>{harness?.apiKeyPresent ? 'Provider credentials configured' : harness?.apiKeyRequired ? 'Credential required for the active route' : 'No credential required for the active local route'}</span>
            </div>
            <StatusChip good={harness?.apiKeyPresent || !harness?.apiKeyRequired} warn={!harness?.apiKeyPresent && harness?.apiKeyRequired}>
              {harness?.apiKeyPresent ? 'Ready' : harness?.apiKeyRequired ? 'Check route' : 'No key needed'}
            </StatusChip>
          </SettingsRow>
          {harness?.sessionId ? (
            <SettingsRow>
              <div className={rowStack}>
                <strong className={rowTitle}>Active session</strong>
                <span className={rowPathText} title={harness.sessionId}>{harness.sessionId}</span>
              </div>
            </SettingsRow>
          ) : null}
          {harness?.error ? (
            <SettingsRow>
              <div className={rowStack}>
                <strong className={rowTitle}>Runtime error</strong>
                <span className={rowDesc}>{harness.error}</span>
              </div>
              <StatusChip warn>Attention</StatusChip>
            </SettingsRow>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection title="Product architecture">
        <div className="space-y-1.5">
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Control plane</strong>
              <span className={rowDesc}>ND-DSH owns companies, projects, roles, agents, tasks, skills, memory, policies, provider routes, and engine registration.</span>
            </div>
            <StatusChip good>ND-DSH</StatusChip>
          </SettingsRow>
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Execution boundary</strong>
              <span className={rowDesc}>Coding engines are replaceable adapters. Vendor runtime interfaces are infrastructure, not product identity.</span>
            </div>
          </SettingsRow>
        </div>
      </SettingsSection>
    </>
  )
}
