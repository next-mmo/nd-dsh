import { useEffect, useState } from 'react'
import type { BrowserState } from '../../../shared/contracts'
import type { BrowserCompanionState } from '../../../shared/browser-companion'
import type { BrowserHistoryEntry, BrowserPlatformState, BrowserProfileSummary } from '../../../shared/browser-platform'
import { BridgePill } from './bridge-pill'
import { BrowserExtensionsManager } from './BrowserExtensionsManager'
import { BrowserProfileAvatar } from './BrowserProfileAvatar'
import { BrowserProfileDialog } from './BrowserProfileDialog'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import {
  SettingsButton,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  StatusChip,
  rowDesc,
  rowPathText,
  rowStack,
  rowTitle,
  rowValueText,
} from './settings-primitives'

interface BrowserSettingsProps {
  browser: BrowserState | null
  onError(message: string): void
  /** Switches to the built-in browser view, used where an action is only visible there. */
  onOpenBrowser(): void
}

/** General → Browser sub-tab: built-in browser control, profile data, and companion status. */
export function BrowserSettings({ browser, onError, onOpenBrowser }: BrowserSettingsProps) {
  const [browserCompanion, setBrowserCompanion] = useState<BrowserCompanionState | null>(null)
  const [browserPlatform, setBrowserPlatform] = useState<BrowserPlatformState | null>(null)
  const [browserHistory, setBrowserHistory] = useState<BrowserHistoryEntry[]>([])
  const [credentialOrigin, setCredentialOrigin] = useState('')
  const [credentialUsername, setCredentialUsername] = useState('')
  const [credentialPassword, setCredentialPassword] = useState('')
  const [permissionOrigin, setPermissionOrigin] = useState('')
  const [permissionName, setPermissionName] = useState('notifications')
  const [extensionsOpen, setExtensionsOpen] = useState(false)
  const [safeModeBusy, setSafeModeBusy] = useState(false)
  const [profileDialog, setProfileDialog] = useState<
    { mode: 'create' } | { mode: 'edit'; profile: BrowserProfileSummary } | null
  >(null)
  const [profileToDelete, setProfileToDelete] = useState<BrowserProfileSummary | null>(null)

  useEffect(() => {
    let mounted = true
    const refreshHistory = (): void => {
      void window.ndDsh.browserPlatform.history('builtin')
        .then((history) => { if (mounted) setBrowserHistory(history) })
        .catch(() => undefined)
    }
    void window.ndDsh.browserPlatform.state().then((state) => {
      if (mounted) setBrowserPlatform(state)
      refreshHistory()
    }).catch(() => undefined)
    const dispose = window.ndDsh.browserPlatform.onChanged((state) => {
      if (mounted) setBrowserPlatform(state)
      refreshHistory()
    })
    return () => {
      mounted = false
      dispose()
    }
  }, [])

  useEffect(() => {
    let mounted = true
    void window.ndDsh.browserCompanion.state().then((state) => { if (mounted) setBrowserCompanion(state) }).catch(() => undefined)
    const dispose = window.ndDsh.browserCompanion.onChanged((state) => { if (mounted) setBrowserCompanion(state) })
    return () => {
      mounted = false
      dispose()
    }
  }, [])

  const profiles = browserPlatform?.profiles ?? []
  const activeProfileId = profiles.find((profile) => profile.active)?.id
  const visibleDownloads = (browserPlatform?.downloads ?? [])
    .filter((download) => !download.profileId || !activeProfileId || download.profileId === activeProfileId)

  const runProfileAction = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
    } catch (cause) {
      onError(errorMessage(cause))
      throw cause
    }
  }

  const submitProfileDialog = async (input: { name: string; color: string }): Promise<void> => {
    if (profileDialog?.mode === 'edit') {
      await runProfileAction(() =>
        window.ndDsh.browserPlatform.updateProfile(profileDialog.profile.id, { name: input.name, color: input.color }))
      return
    }
    await runProfileAction(() => window.ndDsh.browserPlatform.createProfile(input.name, input.color))
  }

  const deleteProfile = async (profile: BrowserProfileSummary): Promise<void> => {
    try {
      await window.ndDsh.browserPlatform.deleteProfile(profile.id)
      setProfileToDelete(null)
    } catch (cause) {
      onError(errorMessage(cause))
    }
  }

  return (
    <>
      <SettingsSection title="Browser profiles" className="mt-3.5">
        <div className="space-y-1.5">
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Chrome-style profiles</strong>
              <span className={rowDesc}>Switch identities with separate cookies, site data, history, permissions and saved sign-ins. Tabs of other profiles stay open in the background.</span>
            </div>
            <SettingsButton onClick={() => setProfileDialog({ mode: 'create' })}>New profile</SettingsButton>
          </SettingsRow>
          {profiles.map((profile) => (
            <SettingsRow key={profile.id} label={`Browser profile ${profile.name}`}>
              <div className="flex min-w-0 items-center gap-2.5">
                <BrowserProfileAvatar name={profile.name} color={profile.color} size={26} />
                <div className={rowStack}>
                  <strong className={rowTitle}>
                    {profile.name}
                    {profile.isDefault ? <span className="ml-2 text-[9px] font-bold tracking-[0.08em] text-muted-foreground">DEFAULT</span> : null}
                    {profile.active ? <span className="ml-2 text-[9px] font-bold tracking-[0.08em] text-primary">ACTIVE</span> : null}
                  </strong>
                  <span className={rowDesc}>
                    {profile.tabCount} tab{profile.tabCount === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <SettingsButton
                  disabled={profile.active}
                  onClick={() => {
                    void window.ndDsh.browserPlatform.selectProfile(profile.id)
                      .catch((cause) => onError(errorMessage(cause)))
                  }}
                >
                  Switch
                </SettingsButton>
                {profile.isDefault ? null : (
                  <SettingsButton onClick={() => {
                    void window.ndDsh.browserPlatform.setDefaultProfile(profile.id)
                      .catch((cause) => onError(errorMessage(cause)))
                  }}>
                    Set default
                  </SettingsButton>
                )}
                <SettingsButton onClick={() => setProfileDialog({ mode: 'edit', profile })}>Edit</SettingsButton>
                {profile.isDefault || profile.id === 'default' ? null : (
                  <SettingsButton
                    className="hover:border-destructive/45 hover:text-destructive"
                    onClick={() => setProfileToDelete(profile)}
                  >
                    Delete
                  </SettingsButton>
                )}
              </div>
            </SettingsRow>
          ))}
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Global default</strong>
              <span className={rowDesc}>ND reopens the last active profile. The global default is the fallback on a fresh install or after deleting the active profile; the built-in Default profile keeps your existing cookies and sign-ins and cannot be deleted.</span>
            </div>
          </SettingsRow>
        </div>
      </SettingsSection>

      <SettingsSection title="Browser" className="mt-3.5">
        <div className="space-y-1.5">
          <SettingsRow>
            <div className={rowStack}>
              <span className="flex items-center gap-2">
                <strong className={rowTitle}>Safe Mode</strong>
                <StatusChip warn={browserPlatform?.safeModeEnabled === true} neutral>
                  {browserPlatform?.safeModeEnabled ? 'On' : 'Off'}
                </StatusChip>
                <StatusChip neutral>Experimental</StatusChip>
              </span>
              <span className={rowDesc}>
                Blocks third-party cookies and known trackers, strips cross-site referrers, sends GPC/DNT, adds stable
                per-profile canvas/WebGL/audio noise, hides common automation markers, and pauses ND agent control of the
                built-in browser. Open pages reload when this changes.
              </span>
            </div>
            <SettingsSwitch
              label="Browser Safe Mode"
              checked={browserPlatform?.safeModeEnabled ?? false}
              disabled={browserPlatform === null || safeModeBusy}
              onCheckedChange={(enabled) => {
                setSafeModeBusy(true)
                void window.ndDsh.browserPlatform.setSafeModeEnabled(enabled)
                  .then((next) => setBrowserPlatform(next))
                  .catch((cause) => onError(errorMessage(cause)))
                  .finally(() => setSafeModeBusy(false))
              }}
            />
          </SettingsRow>
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Agent browser control</strong>
              <span className={rowDesc}>Let the ND agent control the built-in Chromium browser. ND never launches Google Chrome for this; @Chrome companions and the browser pane keep working when off.</span>
            </div>
            <SettingsSwitch
              label="Built-in browser agent control"
              checked={browserPlatform?.browserUseEnabled ?? true}
              disabled={browserPlatform === null}
              onCheckedChange={(enabled) => {
                void window.ndDsh.browserPlatform.setBrowserUseEnabled(enabled)
                  .catch((cause) => onError(errorMessage(cause)))
              }}
            />
          </SettingsRow>
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Agent control</strong>
              <span className={rowDesc}>The agent controls the exact visible WebContentsView tab through the pinned browser bridge.</span>
            </div>
            <BridgePill state={browser?.agentBrowser ?? 'binding'}>
              {browser?.agentBrowser === 'ready' ? 'Linked' : browser?.agentBrowser === 'unavailable' ? 'Offline' : 'Linking'}
            </BridgePill>
          </SettingsRow>
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>CDP port</strong>
              <span className={rowDesc}>Loopback debugging endpoint</span>
            </div>
            <span className={rowValueText}>{browser?.cdpPort ?? '—'}</span>
          </SettingsRow>
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Current page</strong>
              <span className={rowPathText} title={browser?.url}>{browser?.url ?? 'No page'}</span>
            </div>
          </SettingsRow>
        </div>
      </SettingsSection>

      <SettingsSection title="Built-in browser profile" className="mt-3.5">
        <div className="space-y-1.5">
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Real tabs</strong>
              <span className={rowDesc}>Each tab is its own sandboxed WebContentsView in the active browser profile.</span>
            </div>
            <span className={rowValueText}>{browser?.tabs?.length ?? 0}</span>
          </SettingsRow>
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Extensions</strong>
              <span className={rowDesc}>Install, enable, and remove extensions for ND's built-in Chromium browser. ND's approved extensions load into every browser profile with isolated extension state. Nothing here launches or imports from external Google Chrome.</span>
            </div>
            <SettingsButton onClick={() => setExtensionsOpen((open) => !open)}>
              {extensionsOpen ? 'Close' : 'Manage'}
            </SettingsButton>
          </SettingsRow>
          {extensionsOpen ? (
            <BrowserExtensionsManager
              platform={browserPlatform}
              onError={onError}
              onOpenBrowser={onOpenBrowser}
            />
          ) : null}
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Downloads</strong>
              <span className={rowDesc}>Downloads started by the active browser profile are tracked explicitly and saved through its ND browser session.</span>
            </div>
            <span className={rowValueText}>{visibleDownloads.length}</span>
          </SettingsRow>
          {visibleDownloads.slice(0, 5).map((download) => (
            <SettingsRow key={download.id}>
              <div className={rowStack}>
                <strong className={rowTitle}>{download.filename}</strong>
                <span className={rowDesc}>{download.state} · {download.receivedBytes}/{download.totalBytes || '?'} bytes</span>
              </div>
              {download.state === 'starting' || download.state === 'progressing' ? (
                <SettingsButton onClick={() => {
                  void window.ndDsh.browserPlatform.cancelDownload(download.id)
                    .catch((cause) => onError(errorMessage(cause)))
                }}>Cancel</SettingsButton>
              ) : (
                <div className="flex shrink-0 items-center gap-1.5">
                  <StatusChip good={download.state === 'completed'}>{download.state}</StatusChip>
                  {download.state === 'completed' ? (
                    <>
                      <SettingsButton onClick={() => {
                        void window.ndDsh.browserPlatform.openDownload(download.id)
                          .catch((cause) => onError(errorMessage(cause)))
                      }}>Open</SettingsButton>
                      <SettingsButton onClick={() => {
                        void window.ndDsh.browserPlatform.revealDownload(download.id)
                          .catch((cause) => onError(errorMessage(cause)))
                      }}>Reveal</SettingsButton>
                    </>
                  ) : null}
                </div>
              )}
            </SettingsRow>
          ))}
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>History</strong>
              <span className={rowDesc}>Persistent navigation metadata for the active browser profile; page contents and credentials are not copied into history.</span>
            </div>
            <span className={rowValueText}>{browserHistory.length}</span>
          </SettingsRow>
          {browserHistory.slice(0, 8).map((entry) => (
            <SettingsRow key={entry.id}>
              <div className={rowStack}>
                <strong className={rowTitle}>{entry.title || entry.url}</strong>
                <span className={rowDesc}>{entry.url}</span>
              </div>
              <span className={rowValueText}>{new Date(entry.visitedAt).toLocaleString()}</span>
            </SettingsRow>
          ))}
          <SettingsRow>
            <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5">
              <input
                aria-label="Site permission origin"
                placeholder="https://example.com"
                value={permissionOrigin}
                onChange={(event) => setPermissionOrigin(event.target.value)}
                className="min-w-0 rounded-md border border-border bg-background px-2 py-1 text-[10px] outline-none"
              />
              <input
                aria-label="Browser permission name"
                placeholder="notifications"
                value={permissionName}
                onChange={(event) => setPermissionName(event.target.value)}
                className="min-w-0 rounded-md border border-border bg-background px-2 py-1 text-[10px] outline-none"
              />
            </div>
            <div className="flex shrink-0 gap-1.5">
              <SettingsButton onClick={() => {
                void window.ndDsh.browserPlatform.setSitePermission(permissionOrigin, permissionName, 'deny')
                  .catch((cause) => onError(errorMessage(cause)))
              }}>Deny</SettingsButton>
              <SettingsButton onClick={() => {
                void window.ndDsh.browserPlatform.setSitePermission(permissionOrigin, permissionName, 'allow')
                  .catch((cause) => onError(errorMessage(cause)))
              }}>Allow</SettingsButton>
            </div>
          </SettingsRow>
          {(browserPlatform?.sitePermissions ?? []).slice(0, 12).map((permission) => (
            <SettingsRow key={`${permission.origin}:${permission.permission}`}>
              <div className={rowStack}>
                <strong className={rowTitle}>{permission.permission}</strong>
                <span className={rowDesc}>{permission.origin}</span>
              </div>
              <StatusChip good={permission.effect === 'allow'}>{permission.effect}</StatusChip>
            </SettingsRow>
          ))}
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Browser data</strong>
              <span className={rowDesc}>Clear the active profile's cookies/site data, cache, and ND navigation history. Other browser profiles and Chrome Companion data are never cleared from here.</span>
            </div>
            <SettingsButton onClick={() => {
              void window.ndDsh.browserPlatform.clearBrowserData({ targetId: 'builtin', history: true })
                .catch((cause) => onError(errorMessage(cause)))
            }}>Clear ND browser data</SettingsButton>
          </SettingsRow>
        </div>
      </SettingsSection>

      <SettingsSection title="Saved browser credentials" className="mt-3.5">
        <div className="space-y-1.5">
          <SettingsRow>
            <div className="grid min-w-0 flex-1 grid-cols-3 gap-1.5">
              <input
                aria-label="Credential origin"
                placeholder="https://example.com"
                value={credentialOrigin}
                onChange={(event) => setCredentialOrigin(event.target.value)}
                className="min-w-0 rounded-md border border-border bg-background px-2 py-1 text-[10px] outline-none"
              />
              <input
                aria-label="Credential username"
                placeholder="Username"
                value={credentialUsername}
                onChange={(event) => setCredentialUsername(event.target.value)}
                className="min-w-0 rounded-md border border-border bg-background px-2 py-1 text-[10px] outline-none"
              />
              <input
                aria-label="Credential password"
                placeholder="Password"
                type="password"
                value={credentialPassword}
                onChange={(event) => setCredentialPassword(event.target.value)}
                className="min-w-0 rounded-md border border-border bg-background px-2 py-1 text-[10px] outline-none"
              />
            </div>
            <SettingsButton onClick={() => {
              void window.ndDsh.browserPlatform.saveCredential({
                origin: credentialOrigin,
                username: credentialUsername,
                password: credentialPassword,
              }).then(() => {
                setCredentialPassword('')
              }).catch((cause) => onError(errorMessage(cause)))
            }}>Save</SettingsButton>
          </SettingsRow>
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Secret boundary</strong>
              <span className={rowDesc}>Passwords are encrypted through the OS-backed Electron safeStorage primitive. The renderer and agent receive metadata only; autofill sends the decrypted secret directly from main to the intended built-in tab.</span>
            </div>
          </SettingsRow>
          {(browserPlatform?.credentials ?? []).map((credential) => (
            <SettingsRow key={credential.id}>
              <div className={rowStack}>
                <strong className={rowTitle}>{credential.username}</strong>
                <span className={rowDesc}>{credential.origin}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <SettingsButton onClick={() => {
                  void window.ndDsh.browserPlatform.autofillCredential(credential.id, 'builtin', browser?.activeTabId)
                    .catch((cause) => onError(errorMessage(cause)))
                }}>Fill active tab</SettingsButton>
                <SettingsButton onClick={() => {
                  void window.ndDsh.browserPlatform.removeCredential(credential.id)
                    .catch((cause) => onError(errorMessage(cause)))
                }}>Remove</SettingsButton>
              </div>
            </SettingsRow>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="Unified browser routing" className="mt-3.5">
        <div className="space-y-1.5">
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Targets</strong>
              <span className={rowDesc}>@Browser is the ND built-in profile; @Chrome entries are explicit existing-profile companions. Auto never silently crosses browser identity.</span>
            </div>
            <span className={rowValueText}>{browserPlatform?.targets.length ?? 0}</span>
          </SettingsRow>
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Trusted writable leases</strong>
              <span className={rowDesc}>Organization runs receive opaque session-bound access tokens. One execution lane owns one writable tab at a time.</span>
            </div>
            <span className={rowValueText}>{browserPlatform?.leases.length ?? 0}</span>
          </SettingsRow>
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Pending approvals</strong>
              <span className={rowDesc}>High-impact browser actions are normalized into the same ALLOW / ASK / DENY company policy boundary.</span>
            </div>
            <span className={rowValueText}>{browserPlatform?.approvals.length ?? 0}</span>
          </SettingsRow>
        </div>
      </SettingsSection>

      <SettingsSection title="Browser companions" className="mt-3.5">
        <div className="space-y-1.5">
          {browserCompanion?.connections.length ? browserCompanion.connections.map((connection) => (
            <SettingsRow key={connection.id}>
              <div className={rowStack}>
                <strong className={rowTitle}>{connection.profileLabel}</strong>
                <span className={rowDesc}>{connection.browser} · extension {connection.extensionVersion}</span>
              </div>
              <StatusChip good={connection.connected}>{connection.connected ? 'Connected' : 'Offline'}</StatusChip>
            </SettingsRow>
          )) : (
            <SettingsRow>
              <div className={rowStack}>
                <strong className={rowTitle}>Chrome / Chromium</strong>
                <span className={rowDesc}>Install the ND Browser Companion extension and native host to use an existing signed-in browser profile.</span>
              </div>
              <StatusChip>Not connected</StatusChip>
            </SettingsRow>
          )}
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Writable tab leases</strong>
              <span className={rowDesc}>One execution lane owns a writable tab at a time; disconnects revoke its leases.</span>
            </div>
            <span className={rowValueText}>{browserCompanion?.leases.length ?? 0}</span>
          </SettingsRow>
        </div>
      </SettingsSection>

      <BrowserProfileDialog
        open={profileDialog !== null}
        mode={profileDialog?.mode === 'edit' ? 'edit' : 'create'}
        initialName={profileDialog?.mode === 'edit' ? profileDialog.profile.name : undefined}
        initialColor={profileDialog?.mode === 'edit' ? profileDialog.profile.color : undefined}
        onSubmit={submitProfileDialog}
        onClose={() => setProfileDialog(null)}
      />

      <Dialog open={profileToDelete !== null} onOpenChange={(open) => { if (!open) setProfileToDelete(null) }}>
        <DialogContent className="sm:max-w-[470px]">
          <DialogHeader>
            <DialogTitle>Delete browser profile?</DialogTitle>
            <DialogDescription>
              {profileToDelete
                ? `“${profileToDelete.name}” will be removed together with its cookies, site data, history, permissions and saved sign-ins. Tabs open in it are closed.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <button
                type="button"
                className="shrink-0 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-[10px] text-soft transition-colors hover:bg-accent hover:text-foreground"
              >
                Cancel
              </button>
            </DialogClose>
            <button
              type="button"
              className="shrink-0 rounded-md border border-destructive/45 bg-secondary px-2.5 py-1.5 text-[10px] text-destructive transition-colors hover:bg-destructive/10"
              onClick={() => { if (profileToDelete) void deleteProfile(profileToDelete) }}
            >
              Delete profile
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
