'use strict'

// Memory-only credentials. This pilot does not use localStorage, sessionStorage,
// cookies, URL tokens, untrusted scripts, browser extensions, or remote origins.
const state = { token: '', me: null, projects: [], project: '', board: null, cases: [], cards: [], sources: [], wiki: [], specs: [], specEdit: null, proposals: [], events: [], sync: null, router: null, ledger: null, panel: 'overview' }
const $ = (id) => document.getElementById(id)
const say = (message, error = false) => {
  const n = $('notice')
  n.hidden = false
  n.classList.toggle('error', error)
  n.textContent = message
}
const clearNotice = () => { $('notice').hidden = true }

function node(tag, content = '', className = '') {
  const el = document.createElement(tag)
  if (className) el.className = className
  el.textContent = content
  return el
}
function clear(el) { el.replaceChildren() }
function line(content, className = '') { return node('p', content, className) }
function shortID(value) { return String(value || '').slice(0, 16) }

async function request(method, path, data) {
  if (!state.token) throw new Error('Connect with a pilot token first.')
  if (!path.startsWith('/v1/')) throw new Error('Invalid API path')
  const headers = { Authorization: 'Bearer ' + state.token }
  if (data !== undefined) headers['Content-Type'] = 'application/json'
  let response
  try {
    response = await fetch(path, {
      method, headers, cache: 'no-store', credentials: 'omit', redirect: 'error',
      body: data === undefined ? undefined : JSON.stringify(data),
    })
  } catch (_) { throw new Error('Local ND Cloud service is unreachable.') }
  let payload
  try { payload = await response.json() } catch (_) { throw new Error('Invalid API response') }
  if (!response.ok) throw new Error(payload.error || 'Request failed (' + response.status + ')')
  return payload
}

function disconnect() {
  state.token = ''
  state.me = null
  state.projects = []
  state.project = ''
  state.board = null
  state.cases = []
  state.cards = []
  state.sources = []; state.wiki = []; state.specs = []; state.specEdit = null; state.proposals = []; state.events = []; state.sync = null; state.router = null; state.ledger = null
  $('token').value = ''
  $('auth-view').hidden = false
  $('workspace').hidden = true
  $('signout').hidden = true
  resetSpecEditor()
  say('Disconnected. Your in-memory token has been cleared.')
}

async function connect(event) {
  event.preventDefault()
  const candidate = $('token').value.trim()
  if (!candidate.startsWith('ndp_')) { say('Enter a valid ND Cloud pilot credential.', true); return }
  state.token = candidate
  try {
    state.me = await request('GET', '/v1/me')
    $('token').value = ''
    $('auth-view').hidden = true
    $('workspace').hidden = false
    $('signout').hidden = false
    $('identity').textContent = state.me.subject
    $('role').textContent = state.me.tenant_id + ' · ' + state.me.role
    await loadProjects()
    say('Authenticated for tenant ' + state.me.tenant_id + '. No cloud sync or remote execution is enabled.')
  } catch (e) {
    state.token = ''
    say(e.message, true)
  }
}

async function loadProjects() {
  const value = await request('GET', '/v1/tenants/' + encodeURIComponent(state.me.tenant_id) + '/projects')
  state.projects = value.projects || []
  if (!state.projects.some(p => p.id === state.project)) state.project = state.projects[0]?.id || ''
  const select = $('project-picker')
  clear(select)
  if (state.projects.length === 0) {
    const empty = node('option', 'No accessible projects')
    empty.value = ''
    select.append(empty)
  }
  for (const project of state.projects) {
    const option = node('option', project.name)
    option.value = project.id
    select.append(option)
  }
  select.value = state.project
  $('metric-projects').textContent = String(state.projects.length)
  renderProjects()
  await loadProjectData()
}

async function fetchOptional(path) {
  try { return await request('GET', path) }
  catch (e) {
    if (e.message.includes('not synchronized')) return null
    throw e
  }
}

async function loadProjectData() {
  state.board = null
  state.cases = []
  state.cards = []
  state.sources = []; state.wiki = []; state.specs = []; state.specEdit = null; state.proposals = []; state.events = []; state.sync = null; state.router = null; state.ledger = null
  if (!state.project) { renderBoard(); renderCases(); renderCards(); renderSources(); renderWiki(); renderSpecs(); renderProposals(); renderSync(); renderRouter(); return }
  const base = '/v1/projects/' + encodeURIComponent(state.project)
  const [board, cases, cards, sources, wiki, specs, proposals, sync, events, router, ledger] = await Promise.all([
    fetchOptional(base + '/board'),
    request('GET', base + '/support/cases'),
    request('GET', base + '/knowledge/cards'),
    ['owner','reviewer'].includes(state.me?.role) ? request('GET', base + '/sources') : Promise.resolve({sources: []}),
    request('GET', base + '/wiki/pages'),
    request('GET', base + '/specs'),
    ['owner','reviewer'].includes(state.me?.role) ? request('GET', base + '/task-proposals') : Promise.resolve({proposals: []}),
    request('GET', base + '/sync/status'),
    loadInitialEvents(base),
    request('GET', base + '/router/status'),
    state.me?.role === 'owner' ? request('GET', base + '/ledger') : Promise.resolve(null),
  ])
  state.board = board
  state.cases = cases.cases || []
  state.cards = cards.cards || []
  state.sources = sources.sources || []
  state.wiki = wiki.pages || []; state.specs = specs.specs || []; state.proposals = proposals.proposals || []
  state.sync = sync; state.events = events.events || []; state.eventsGap = Boolean(events.gap); state.router = router; state.ledger = ledger
  renderBoard(); renderCases(); renderCards(); renderSources(); renderWiki(); renderSpecs(); renderProposals(); renderSync(); renderRouter()
}

function renderProjects() {
  const list = $('projects-list')
  clear(list)
  for (const p of state.projects) {
    const item = node('div', '', 'item')
    const head = node('div', '', 'item-head')
    head.append(node('h3', p.name), node('span', p.id === state.project ? 'Selected' : 'Available', 'pill'))
    item.append(head, node('small', p.id))
    list.append(item)
  }
  if (!state.projects.length) list.append(line('No projects assigned. A tenant owner can create one.'))
}

function renderBoard() {
  const target = $('board-list')
  clear(target)
  const tasks = state.board?.tasks || []
  $('metric-tasks').textContent = state.board ? String(tasks.length) : '—'
  $('board-version').textContent = state.board ? 'Revision ' + state.board.revision : 'Not yet synchronized'
  const groups = [
    { label:'To do', statuses:['backlog','ready'] },
    { label:'In progress', statuses:['in_progress','review','blocked'] },
    { label:'Completed', statuses:['completed'] },
  ]
  for (const group of groups) {
    const col = node('div', '', 'column')
    const selected = tasks.filter(t => group.statuses.includes(t.status))
    const h = node('h3', group.label)
    h.append(node('span', String(selected.length)))
    col.append(h)
    for (const task of selected) {
      const el = node('div', '', 'task')
      el.append(node('strong', task.title), node('small', task.status + ' · ' + task.priority), node('small', shortID(task.id)))
      col.append(el)
    }
    if (!selected.length) col.append(line('No tasks', 'subtle'))
    target.append(col)
  }
}

function renderCases() {
  const list = $('cases-list'); clear(list)
  $('metric-cases').textContent = String(state.cases.length)
  for (const c of state.cases) {
    const item = node('div', '', 'item')
    const head = node('div', '', 'item-head')
    head.append(node('h3', c.subject), node('span', c.status, 'pill'))
    item.append(head, line(c.description), node('small', c.id + ' · revision ' + c.revision))
    if (c.proposed_nd_task) item.append(line('Legacy proposal note: ' + c.proposed_nd_task))
    if (state.me.role === 'owner' || state.me.role === 'reviewer') {
      const entry = node('textarea')
      entry.rows = 2
      entry.placeholder = 'Write an ND-DSH task proposal (does not create a task)'
      entry.setAttribute('aria-label', 'Task proposal for ' + c.subject)
      const button = node('button', 'Save task proposal', 'quiet')
      button.type = 'button'
      button.addEventListener('click', () => action(async () => {
        if (!entry.value.trim()) throw new Error('A task proposal is required.')
        await request('POST', '/v1/projects/' + encodeURIComponent(state.project) + '/support/cases/' + encodeURIComponent(c.id) + '/propose-task', { expected_revision:c.revision, proposal:entry.value })
        await loadProjectData()
        say('Task proposal recorded, without ND-DSH execution.')
      }))
      item.append(entry, button)
      const requestButton = node('button', 'Create governed task proposal', 'quiet')
      requestButton.type = 'button'
      requestButton.addEventListener('click', () => action(async () => {
        if (!entry.value.trim()) throw new Error('A proposal is required.')
        await request('POST', '/v1/projects/' + encodeURIComponent(state.project) + '/support/cases/' + encodeURIComponent(c.id) + '/task-proposals', {
          expected_case_revision: c.revision, idempotency_key: crypto.randomUUID(), text: entry.value,
        })
        await loadProjectData()
        say('Proposal awaiting independent owner approval; ND-DSH has not created a task.')
      }))
      item.append(requestButton)
    }
    list.append(item)
  }
  if (!state.cases.length) list.append(line('No visible cases for this project.'))
}

function renderCards() {
  const list = $('knowledge-list'); clear(list)
  for (const c of state.cards) {
    const item = node('div', '', 'item')
    const head = node('div', '', 'item-head')
    head.append(node('h3', c.question), node('span', c.status, 'pill'))
    item.append(head, line(c.answer), node('small', c.app_release + ' · ' + c.author + (c.reviewer ? ' → ' + c.reviewer : '')))
    for (const citation of c.citations || []) {
      const link = node('a', citation.label + ' · ' + citation.revision)
      link.href = citation.url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      item.append(link)
    }
    if (c.status === 'draft' && (state.me.role === 'owner' || state.me.role === 'reviewer')) {
      const button = node('button', 'Publish with independent review', 'quiet')
      button.type = 'button'
      button.addEventListener('click', () => action(async () => {
        await request('POST', '/v1/projects/' + encodeURIComponent(state.project) + '/knowledge/cards/' + encodeURIComponent(c.id) + '/publish', {expected_revision:c.revision})
        await loadProjectData()
        say('Knowledge Card published. No automatic UI demo was authorized.')
      }))
      item.append(button)
    }
    list.append(item)
  }
  if (!state.cards.length) list.append(line('No visible Knowledge Cards for this project.'))
}

function renderSources() {
  const list = $('sources-list'); clear(list)
  if (!state.project) { list.append(line('Choose a project first.')); return }
  if (!['owner','reviewer'].includes(state.me?.role)) {
    list.append(line('Source manifests are restricted to project owners and reviewers.')); return
  }
  for (const snapshot of state.sources) {
    const item = node('div', '', 'item')
    const head = node('div', '', 'item-head')
    head.append(node('h3', snapshot.filename), node('span', snapshot.status, 'pill'))
    item.append(head, node('small', 'SHA-256: ' + snapshot.artifact_sha256))
    for (const f of snapshot.files || []) {
      item.append(node('small', f.path + ' · ' + f.kind + ' · ' + f.bytes + ' bytes · ' + f.sha256.slice(0, 14)))
    }
    list.append(item)
  }
  if (!state.sources.length) list.append(line('No source snapshots imported. No source content has been stored.'))
}

async function importArchive(file) {
  if (!state.token || !state.project) throw new Error('Connect and choose a project first.')
  if (state.me?.role !== 'owner') throw new Error('Only the owner may import source archives.')
  if (!file || !file.name.toLowerCase().endsWith('.zip') || file.size > 8 * 1024 * 1024 || file.size === 0) {
    throw new Error('Choose a ZIP file smaller than 8 MiB.')
  }
  let response
  try {
    response = await fetch('/v1/projects/' + encodeURIComponent(state.project) + '/sources/zip', {
      method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error',
      headers: { Authorization: 'Bearer ' + state.token,
        'Content-Type': 'application/zip', 'X-ND-Source-Filename': file.name },
      body: file,
    })
  } catch (_) { throw new Error('Local ND Cloud service is unreachable.') }
  const result = await response.json().catch(() => ({error: 'Invalid server response'}))
  if (!response.ok) throw new Error(result.error || 'ZIP import rejected')
  return result
}


function renderWiki() {
  const target = $('wiki-list'); clear(target)
  for (const page of state.wiki) {
    const box = node('div', '', 'item')
    const head = node('div', '', 'item-head')
    head.append(node('h3', page.title), node('span', page.status, 'pill'))
    box.append(head, node('small', page.id + ' · ' + page.source_snapshot_id))
    box.append(line(page.generated ? 'Source inventory: paths and hashes only.' : page.body))
    box.append(node('small', page.source_path || 'Whole ZIP provenance'))
    if (page.status === 'draft' && ['owner','reviewer'].includes(state.me?.role) && page.author !== state.me.subject) {
      const btn = node('button', 'Publish after independent review', 'quiet')
      btn.addEventListener('click', () => action(async () => {
        await request('POST', '/v1/projects/' + encodeURIComponent(state.project) + '/wiki/pages/' + encodeURIComponent(page.id) + '/publish', { expected_revision: page.revision })
        await loadProjectData(); say('Wiki published; source changes will mark it stale.')
      }))
      box.append(btn)
    }
    target.append(box)
  }
  if (!state.wiki.length) target.append(line('Import a ZIP or create a source-linked Wiki draft.'))
}
function renderSpecs() {
  const target = $('spec-list'); clear(target)
  const editorAllowed = ['owner','reviewer'].includes(state.me?.role)
  $('spec-form').hidden = !editorAllowed
  for (const spec of state.specs) {
    const box = node('div', '', 'item')
    const head = node('div', '', 'item-head')
    head.append(node('h3', spec.title), node('span', spec.status, 'pill'))
    box.append(head, node('small', spec.id + ' · revision ' + spec.revision + ' · ' + spec.source_path))
    box.append(line(spec.body))
    box.append(node('small', 'Pinned SHA-256: ' + spec.source_sha256.slice(0,16) + ' · Author ' + spec.author + (spec.reviewer ? ' · Reviewed by ' + spec.reviewer : '')))
    if (spec.status === 'conflict') box.append(line('Source changed: revise to the latest snapshot and request independent re-review.'))
    if (editorAllowed) {
      const edit = node('button', 'Revise / rebase', 'quiet')
      edit.addEventListener('click', () => {
        state.specEdit = {id: spec.id, revision: spec.revision}
        $('spec-source').value = spec.source_snapshot_id
        $('spec-path').value = spec.source_path
        $('spec-title').value = spec.title
        $('spec-body').value = spec.body
        $('spec-edit-caption').textContent = 'Editing ' + spec.id + ' · expected revision ' + spec.revision
        $('spec-submit').textContent = 'Submit spec revision'
        $('spec-cancel').hidden = false
        $('spec-form').scrollIntoView({behavior:'smooth',block:'start'})
      })
      box.append(edit)
    }
    if (spec.status === 'draft' && editorAllowed && spec.author !== state.me.subject) {
      const approve = node('button', 'Approve exact spec revision', 'quiet')
      approve.addEventListener('click', () => action(async () => {
        await request('POST','/v1/projects/'+encodeURIComponent(state.project)+'/specs/'+encodeURIComponent(spec.id)+'/approve',{expected_revision: spec.revision})
        await loadProjectData();say('Spec revision approved. Source hash drift will revoke approval.')
      }))
      box.append(approve)
    }
    target.append(box)
  }
  if (!state.specs.length) target.append(line('No human specifications for this project.'))
}
function resetSpecEditor() {
  state.specEdit = null
  $('spec-form').reset()
  $('spec-edit-caption').textContent = 'New specification'
  $('spec-submit').textContent = 'Create spec draft'
  $('spec-cancel').hidden = true
}

function renderProposals() {
  const target = $('proposals-list'); clear(target)
  for (const p of state.proposals) {
    const box = node('div', '', 'item')
    const head = node('div', '', 'item-head')
    head.append(node('h3', p.text), node('span', p.status, 'pill'))
    box.append(head, node('small', p.id + ' · case: ' + p.case_id + ' · version ' + p.revision))
    if (p.nd_task_id) box.append(line('Host-reported ND task ID: ' + p.nd_task_id))
    if (p.status === 'pending' && state.me.role === 'owner' && state.me.subject !== p.author) {
      const btn = node('button', 'Approve for ND host review', 'quiet')
      btn.addEventListener('click', () => action(async () => {
        await request('POST', '/v1/projects/' + encodeURIComponent(state.project) + '/task-proposals/' + encodeURIComponent(p.id) + '/approve', {expected_revision:p.revision})
        await loadProjectData();say('Approved for host review. No task execution authorized.')
      }))
      box.append(btn)
    }
    target.append(box)
  }
  if (!state.proposals.length) target.append(line('No governed task proposals.'))
}
async function loadInitialEvents(base) {
  try { return await request('GET', base + '/events?limit=50') }
  catch (e) {
    if (e.message.includes('snapshot resync')) return {events:[],gap:true}
    throw e
  }
}
function renderSync() {
  $('sync-status').textContent = state.eventsGap ? 'Cursor expired — request a fresh board snapshot before replay.' :
    (state.sync ? 'Projection: ' + state.sync.state + ' · Host connectivity NOT confirmed' : 'No projection')
  const target = $('events-list');clear(target)
  for (const event of state.events) {
    const box = node('div', '', 'item')
    box.append(node('strong', event.kind), node('small', 'Seq ' + event.sequence + ' · ' + event.entity_id + ' · ' + event.created_at))
    target.append(box)
  }
  if (!state.events.length) target.append(line('No events yet.'))
}
function renderRouter() {
  $('router-status').textContent = !state.router?.enabled ?
    'Disabled. Restart the Go service with -router-lab to enable a controlled test.' :
    (state.router?.configured ? 'Temporary BYOK configured for this project, model ' + state.router.model : 'Enabled — owner must configure a temporary key')
  const b = state.ledger?.balances
  $('router-balance').textContent = b ?
    'Nonmonetary test units — available: ' + b.available + ', reserved: ' + b.reserved + ', spent: ' + b.spent :
    'Only the owner can view the demo ledger. No real funds or payments.'
}

async function routerStream(prompt) {
  if (!state.router?.enabled || !state.router.configured) throw new Error('Router Lab is disabled or no temporary key is configured.')
  const result = $('router-result');result.textContent = ''
  const body = {request_id:crypto.randomUUID(),messages:[{role:'user',content:prompt}],max_output_tokens:128}
  const response = await fetch('/v1/projects/' + encodeURIComponent(state.project) + '/router/chat/stream', {
    method:'POST',headers:{Authorization:'Bearer '+state.token,'Content-Type':'application/json'},body:JSON.stringify(body),
    cache:'no-store',credentials:'omit',redirect:'error',
  })
  if (!response.ok) {
    const p = await response.json().catch(() => ({})); throw new Error(p.error || 'Stream failed')
  }
  if (!response.body) throw new Error('Streaming not supported by this browser')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let pending = '', done = false
  while (!done) {
    const part = await reader.read();done = part.done
    pending += decoder.decode(part.value || new Uint8Array(), {stream:!done})
    let eol
    while ((eol = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0,eol).trim();pending = pending.slice(eol+1)
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
      try { const chunk = JSON.parse(line.slice(6));result.textContent += chunk?.choices?.[0]?.delta?.content || '' } catch (_) { /* provider event */ }
    }
  }
}

async function action(task) {
  try { clearNotice(); await task() }
  catch (e) { say(e.message, true) }
}
function switchPanel(panel) {
  state.panel = panel
  const headings = {overview:'Overview',board:'Kanban',sources:'Source snapshots',wiki:'Source Wiki',knowledge:'Knowledge',assist:'ND Assist',support:'ND Support',sync:'Sync Events',router:'Router Lab'}
  $('page-title').textContent = headings[panel]
  for (const name of Object.keys(headings)) $('panel-' + name).hidden = name !== panel
  for (const button of document.querySelectorAll('[data-panel]')) {
    const active = button.dataset.panel === panel
    button.classList.toggle('selected', active)
    button.setAttribute('aria-current', active ? 'page' : 'false')
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('login-form').addEventListener('submit', connect)
  $('signout').addEventListener('click', disconnect)
  $('refresh').addEventListener('click', () => action(async () => { await loadProjects(); say('Project data refreshed.') }))
  $('project-picker').addEventListener('change', (e) => action(async () => {resetSpecEditor();state.project=e.target.value;renderProjects();await loadProjectData()}))
  for (const button of document.querySelectorAll('[data-panel]')) button.addEventListener('click', () => switchPanel(button.dataset.panel))
  $('project-form').addEventListener('submit', e => action(async () => {
    e.preventDefault()
    await request('POST','/v1/tenants/'+encodeURIComponent(state.me.tenant_id)+'/projects',{name:$('project-name').value})
    $('project-name').value=''
    await loadProjects();say('Project created.')
  }))
  $('source-form').addEventListener('submit', e => action(async () => {
    e.preventDefault()
    await importArchive($('source-file').files[0])
    $('source-file').value = ''
    await loadProjectData()
    say('ZIP manifest imported; draft Wiki inventory created for review. No code executed or Wiki auto-published.')
  }))
  $('case-form').addEventListener('submit', e => action(async () => {
    e.preventDefault();if(!state.project)throw new Error('Choose a project first.')
    await request('POST','/v1/projects/'+encodeURIComponent(state.project)+'/support/cases',{subject:$('case-subject').value,description:$('case-desc').value})
    $('case-subject').value='';$('case-desc').value=''
    await loadProjectData();say('Support case created.')
  }))
  $('knowledge-form').addEventListener('submit', e => action(async () => {
    e.preventDefault();if(!state.project)throw new Error('Choose a project first.')
    await request('POST','/v1/projects/'+encodeURIComponent(state.project)+'/knowledge/cards',{
      app_release:$('knowledge-release').value,question:$('knowledge-question').value,answer:$('knowledge-answer').value,
      citations:[{url:$('knowledge-url').value,revision:$('knowledge-revision').value,label:$('knowledge-label').value}],
    })
    $('knowledge-question').value='';$('knowledge-answer').value=''
    await loadProjectData();say('Knowledge draft created. Another authorized human must review it.')
  }))
  $('wiki-form').addEventListener('submit', e => action(async () => {
    e.preventDefault()
    await request('POST', '/v1/projects/' + encodeURIComponent(state.project) + '/wiki/pages', {
      source_snapshot_id: $('wiki-source').value, source_path: $('wiki-path').value,
      title: $('wiki-title').value, body: $('wiki-body').value,
    })
    $('wiki-body').value = '';$('wiki-title').value = ''
    await loadProjectData();say('Wiki draft created; a separate reviewer must publish it.')
  }))
  $('spec-cancel').addEventListener('click', resetSpecEditor)
  $('spec-form').addEventListener('submit', e => action(async () => {
    e.preventDefault()
    if(!state.project) throw new Error('Choose a project first.')
    const payload = {source_snapshot_id:$('spec-source').value,source_path:$('spec-path').value,title:$('spec-title').value,body:$('spec-body').value}
    const edit = state.specEdit
    const base = '/v1/projects/' + encodeURIComponent(state.project) + '/specs'
    if (edit) await request('POST',base+'/'+encodeURIComponent(edit.id)+'/revise',{...payload,expected_revision:edit.revision})
    else await request('POST',base,payload)
    resetSpecEditor()
    await loadProjectData();say('Spec saved as private draft; a different reviewer must approve it.')
  }))
  $('router-key-form').addEventListener('submit', e => action(async () => {
    e.preventDefault()
    await request('POST', '/v1/projects/' + encodeURIComponent(state.project) + '/router/credentials', {
      model: $('router-model').value, api_key: $('router-key').value,
    })
    $('router-key').value = ''
    await loadProjectData();say('Temporary BYOK configured in Go process memory only.')
  }))
  $('router-quota-form').addEventListener('submit', e => action(async () => {
    e.preventDefault()
    await request('POST', '/v1/projects/' + encodeURIComponent(state.project) + '/ledger/demo-grant', {
      idempotency_key: crypto.randomUUID(), units: Number($('router-quota').value),
    })
    await loadProjectData();say('Nonmonetary demo quota granted.')
  }))
  $('router-chat-form').addEventListener('submit', e => action(async () => {
    e.preventDefault()
    await routerStream($('router-prompt').value)
    await loadProjectData();say('Streaming attempt completed; inspect metering under local API.')
  }))
  $('assist-form').addEventListener('submit' , e => action(async () => {
    e.preventDefault();if(!state.project)throw new Error('Choose a project first.')
    const value=await request('POST','/v1/projects/'+encodeURIComponent(state.project)+'/assist/lookup',{
      app_release:$('assist-release').value,question:$('assist-question').value,
    })
    const result=$('assist-result');clear(result)
    const box=node('div','', 'item')
    box.append(node('strong',value.status==='unknown'?'Unknown — no supported answer':'Human-reviewed note (not independently verified)'))
    box.append(line(value.answer||'No matching published knowledge for this project, release and question.'))
    for(const citation of value.citations||[]){
      const link=node('a',citation.label+' · '+citation.revision);link.href=citation.url;link.target='_blank';link.rel='noopener noreferrer';box.append(link)
    }
    result.append(box)
  }))
})
