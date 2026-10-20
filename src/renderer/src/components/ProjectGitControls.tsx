import { useEffect, useState } from 'react'
import type { GitStatusSnapshot, WorkspaceBinding } from '../../../shared/contracts'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

function sameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  return normalize(left) === normalize(right)
}

function BranchIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10c0 7-12 3-12 10"/></svg>
}

export function ProjectGitControls({ root, editable, workspaceBinding, onError }: { root: string; editable: boolean; workspaceBinding?: WorkspaceBinding | undefined; onError(message: string): void }) {
  const [state, setState] = useState<GitStatusSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [setup, setSetup] = useState(false)
  const [search, setSearch] = useState('')
  const [name, setName] = useState('origin')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const workspaceAvailable = workspaceBinding !== 'unlinked' && workspaceBinding !== 'missing'
  useEffect(() => {
    let active = true
    const update = (next: GitStatusSnapshot) => { if (active && next.root === root) setState(next) }
    const off = window.ndDsh.git.onState(update)
    void window.ndDsh.git.refresh().then(update).catch((error) => onError(String(error)))
    return () => { active = false; off() }
  }, [root, onError])
  useEffect(() => { if (!editable) setOpen(false) }, [editable])
  const exactRepo = state?.repoRoot !== null && state?.repoRoot !== undefined && sameWorkspacePath(state.repoRoot, root)
  const run = async (operation: () => Promise<GitStatusSnapshot>) => {
    if (!editable || !workspaceAvailable || busy) return
    setBusy(true)
    try { setState(await operation()); setOpen(false); setSetup(false); setSearch(''); setUrl('') }
    catch (error) { onError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const button = 'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-accent disabled:opacity-50'
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><button className={button} disabled={!state || busy || (workspaceAvailable && !editable)} title={!workspaceAvailable ? 'Link a workspace to use Git' : editable ? (exactRepo ? 'Project Git: remote and branch' : 'Connect Git for this project') : 'Start a new chat to change Git branches'} aria-label="Project Git: remote and branch"><BranchIcon/><span className="max-w-28 truncate">{exactRepo ? state?.remotes.join(', ') || 'Local Git' : 'Git optional'}</span><span className="max-w-36 truncate text-faint">{exactRepo ? state?.branch ?? '+ Git' : '+ Git'}</span></button></PopoverTrigger>
    <PopoverContent align="start" className="w-80 rounded-2xl p-2">
      {!workspaceAvailable ? <p className="p-3 text-xs text-faint">Link a workspace to this project before configuring Git.</p> : setup || !exactRepo ? <form className="grid gap-3 p-2" onSubmit={(event) => { event.preventDefault(); void run(() => window.ndDsh.git.configureRemote(root, name.trim(), url.trim())) }}>
        <strong className="text-sm">Connect Git remote</strong>
        <p className="text-xs text-faint">Git is optional. Nothing is pushed during setup.</p>
        {state?.repoRoot && !exactRepo ? <p className="text-xs text-faint">This project is inside another repository. Connecting will create a dedicated Git repository here; the parent repository will not be used.</p> : null}
        <input aria-label="Git remote name" placeholder="Remote name" value={name} onChange={(event) => setName(event.target.value)} className="rounded-md border bg-transparent p-2 text-sm" required />
        <input aria-label="Git remote URL" placeholder="https://github.com/owner/repo.git" value={url} onChange={(event) => setUrl(event.target.value)} className="rounded-md border bg-transparent p-2 text-sm" required />
        <button className={button} disabled={busy}>{busy ? 'Connecting…' : 'Connect remote'}</button>
        <button type="button" className={`${button} justify-center border`} disabled={busy || !url.trim()} onClick={() => void run(() => window.ndDsh.git.connectGitHub(root, name.trim(), url.trim()))}>{busy ? 'Waiting for GitHub…' : 'Connect with GitHub'}</button>
        <p className="text-[11px] text-faint">GitHub opens a browser to authorize Git Credential Manager. ND never receives your password or token.</p>
        <button type="button" className={button} onClick={() => { setSetup(false); setOpen(false) }}>Continue without changes</button>
      </form> : <>
        <input aria-label="Search branches" placeholder="Search branches" value={search} onChange={(event) => setSearch(event.target.value)} className="w-full rounded-lg bg-transparent p-3 text-sm outline-none" />
        <p className="px-3 py-2 text-xs text-faint">Branches · {state.remotes.join(', ') || 'Local Git'}</p>
        <div className="max-h-64 overflow-auto">{state.branches.filter((branch) => branch.name.toLowerCase().includes(search.toLowerCase())).map((branch) => <button key={branch.name} className={`${button} w-full py-2 text-left`} disabled={busy || branch.name === state.branch} onClick={() => void run(() => window.ndDsh.git.checkout(branch.name))}><BranchIcon/><span className="flex-1 truncate">{branch.name}</span>{branch.name === state.branch ? '✓' : null}</button>)}</div>
        <div className="mt-2 border-t pt-2">
          <button className={`${button} w-full`} disabled={busy || !search.trim()} onClick={() => void run(() => window.ndDsh.git.createBranch(search.trim()))}>+ {search.trim() ? `Create and checkout “${search.trim()}”` : 'Type a name to create a branch'}</button>
          <button className={`${button} w-full`} onClick={() => setSetup(true)}>+ {state.remotes.length ? 'Configure remote' : 'Connect Git remote'}</button>
        </div>
      </>}
    </PopoverContent>
  </Popover>
}
