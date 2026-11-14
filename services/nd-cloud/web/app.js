'use strict'

// Memory-only credentials. This pilot does not use localStorage, sessionStorage,
// cookies, URL tokens, untrusted scripts, browser extensions, or remote origins.
const state = { token: '', me: null, projects: [], project: '', board: null, cases: [], cards: [], sources: [], panel: 'overview' }
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
  state.sources = []
  $('token').value = ''
  $('auth-view').hidden = false
  $('workspace').hidden = true
  $('signout').hidden = true
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
  state.sources = []
  if (!state.project) { renderBoard(); renderCases(); renderCards(); renderSources(); return }
  const base = '/v1/projects/' + encodeURIComponent(state.project)
  const [board, cases, cards, sources] = await Promise.all([
    fetchOptional(base + '/board'),
    request('GET', base + '/support/cases'),
    request('GET', base + '/knowledge/cards'),
    ['owner','reviewer'].includes(state.me?.role) ? request('GET', base + '/sources') : Promise.resolve({sources: []}),
  ])
  state.board = board
  state.cases = cases.cases || []
  state.cards = cards.cards || []
  state.sources = sources.sources || []
  renderBoard(); renderCases(); renderCards(); renderSources()
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
    if (c.proposed_nd_task) item.append(line('ND task proposal: ' + c.proposed_nd_task))
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

async function action(task) {
  try { clearNotice(); await task() }
  catch (e) { say(e.message, true) }
}
function switchPanel(panel) {
  state.panel = panel
  const headings = {overview:'Overview',board:'Kanban',sources:'Source snapshots',knowledge:'Knowledge',assist:'ND Assist',support:'ND Support'}
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
  $('project-picker').addEventListener('change', (e) => action(async () => {state.project=e.target.value;renderProjects();await loadProjectData()}))
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
    say('ZIP manifest imported. Raw archive discarded; no Wiki auto-publication or execution.')
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
  $('assist-form').addEventListener('submit', e => action(async () => {
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
