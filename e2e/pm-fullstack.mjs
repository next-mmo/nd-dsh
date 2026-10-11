/**
 * PM full-stack delivery journey — one AI PM delivers a complete project.
 *
 * Proves the audit's core customer claim end-to-end on the frozen candidate:
 * a lead creates one company and one project with a bounded full-stack
 * objective (dependency-free Node HTTP backend + static frontend + tests),
 * the AI PM plans the full task graph, autopilot (autonomy 4) executes it
 * through workers with required checks and independent review, and the
 * integrated workspace holds the working deliverable. No hidden test-driver
 * nudges after the plan: approvals are auto-allowed, everything else is the
 * product.
 *
 * Usage: node e2e/pm-fullstack.mjs   (requires .env.e2e with E2E_MODEL_*)
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { config as loadDotenv } from 'dotenv'
import { _electron as electron } from '@playwright/test'
import { electronLaunchOptions } from '../scripts/e2e-electron-target.mjs'
import { processDescendants, readProcessRows } from '../scripts/e2e-process-tree.mjs'
import { translateAutopilotScenario } from './lib/nd-translate-autopilot-scenario.mjs'

loadDotenv({ path: '.env.e2e', quiet: true })
loadDotenv({ quiet: true })

const REPO = resolve(import.meta.dirname, '..')
const PROVIDER_ID = 'e2e-openai-compatible'
const PROVIDER_NAME = 'E2E OpenAI Compatible'
const BASE_URL = process.env.E2E_MODEL_BASE_URL?.trim() ?? ''
const API_KEY = process.env.E2E_MODEL_API_KEY?.trim() ?? ''
const MODELS = [1, 2, 3].map((n) => process.env[`E2E_MODEL_${n}`]?.trim() ?? '')
if (!BASE_URL || !API_KEY || MODELS.some((m) => !m)) {
  console.error('pm-fullstack: set E2E_MODEL_BASE_URL, E2E_MODEL_API_KEY, E2E_MODEL_1/2/3 in .env.e2e')
  process.exit(2)
}
const M1 = MODELS[0]
const translateScenario = process.env.ND_PM_SCENARIO === 'nd-translate' ? translateAutopilotScenario : null

const T = { plan: 12 * 60_000, delivery: 45 * 60_000, stall: 10 * 60_000, ui: 30_000 }

const startedAt = new Date()
const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)
const evidenceDir = join(REPO, 'e2e-results', `pm-fullstack-${stamp}`)
mkdirSync(evidenceDir, { recursive: true })
const driverLog = join(evidenceDir, 'driver.log')

function log(line) {
  const text = `[${new Date().toISOString().slice(11, 19)}] ${line}`
  console.log(text)
  writeFileSync(driverLog, `${text}\n`, { flag: 'a' })
}

function writeJson(name, value) {
  writeFileSync(join(evidenceDir, name), JSON.stringify(value, null, 2))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(label, probe, options = {}) {
  const { timeoutMs = 120_000, stallMs = 0, pollMs = 2_000 } = options
  const started = Date.now()
  let lastSig
  let lastChangeAt = started
  let lastDetail = '(no probe output yet)'
  for (;;) {
    let out
    try {
      out = await probe()
    } catch (error) {
      if (error instanceof FatalWaitError) throw error
      out = { done: false, detail: `probe error: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (out.done) return out.value
    lastDetail = out.detail ?? lastDetail
    const sig = out.sig ?? lastDetail
    const now = Date.now()
    if (sig !== lastSig) { lastSig = sig; lastChangeAt = now }
    if (now - started > timeoutMs) {
      throw new Error(`Timed out waiting for: ${label}. Last observed: ${lastDetail}`)
    }
    if (stallMs && now - lastChangeAt > stallMs) {
      throw new Error(`Stalled waiting for: ${label} (no state change for ${Math.round((now - lastChangeAt) / 60_000)} min). Last observed: ${lastDetail}`)
    }
    await sleep(pollMs)
  }
}

class FatalWaitError extends Error {}

// ── Workspace + provider seeding ────────────────────────────────────────────
function seedWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'pm-fullstack-'))
  const git = (args) => {
    const result = spawnSync('git', ['-c', 'user.name=ND-DSH E2E', '-c', 'user.email=e2e@nd-dsh.invalid', '-c', 'commit.gpgsign=false', ...args],
      { cwd: dir, encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr?.trim()}`)
  }
  git(['init', '--initial-branch=main'])
  writeFileSync(join(dir, 'README.md'), '# Autopilot delivery workspace\n\nSeeded by e2e/pm-fullstack.mjs\n')
  if (translateScenario) writeFileSync(join(dir, 'host-contract.md'), translateScenario.reference)
  git(['add', '.'])
  git(['commit', '-m', 'chore: seed the full-stack delivery workspace'])
  return dir
}

function seedProviders(dir) {
  const providers = [{
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    enabled: true,
    baseUrl: BASE_URL,
    apiFormat: 'OpenAI compatible (/v1/chat/completions)',
    apiKey: API_KEY,
    models: MODELS.map((id) => ({ id, context: process.env.E2E_MODEL_CONTEXT?.trim() || '256000' })),
  }]
  writeFileSync(join(dir, 'providers.json'), JSON.stringify(providers, null, 2))
}

// ── App lifecycle ───────────────────────────────────────────────────────────
let currentPage = null
let currentApp = null
let rendererErrors = []
let approvalLoopToken = 0

function installPageHandlers(page) {
  page.on('pageerror', (error) => { rendererErrors.push(`pageerror: ${error.message}`) })
  page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(`console: ${message.text().slice(0, 300)}`)
  })
}

function startApprovalLoop() {
  const token = ++approvalLoopToken
  const tick = async () => {
    if (token !== approvalLoopToken || !currentPage) return
    try {
      const card = currentPage.locator('aside[aria-label="Runtime requests"]')
      if (await card.count() > 0) {
        const allow = card.getByRole('button', { name: 'Allow once' })
        const count = await allow.count()
        for (let i = 0; i < count; i += 1) {
          log(`[approval] allowing once (${i + 1}/${count})`)
          await allow.nth(i).click({ timeout: 2_500 }).catch(() => undefined)
        }
        const submit = card.getByRole('button', { name: 'Submit answer' })
        if (await submit.count() > 0) {
          const sections = card.locator('section')
          for (let i = 0; i < await sections.count(); i += 1) {
            await sections.nth(i).getByRole('button').first().click({ timeout: 2_000 }).catch(() => undefined)
          }
          await submit.first().click({ timeout: 2_000 }).catch(() => undefined)
        }
      }
      const toasts = await currentPage.locator('[data-sonner-toast]').allTextContents()
      for (const text of toasts) {
        const cleaned = text.trim()
        if (cleaned) log(`[toast] ${cleaned.slice(0, 300)}`)
      }
    } catch { /* next tick retries */ }
    setTimeout(() => void tick(), 700)
  }
  void tick()
}

async function launchApp() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'pm-fullstack-profile-'))
  seedProviders(userDataDir)
  const app = await electron.launch(electronLaunchOptions(userDataDir, REPO))
  const stdoutLog = join(evidenceDir, 'main-stdout.log')
  const stderrLog = join(evidenceDir, 'main-stderr.log')
  try {
    app.process().stdout?.on('data', (chunk) => writeFileSync(stdoutLog, String(chunk), { flag: 'a' }))
    app.process().stderr?.on('data', (chunk) => writeFileSync(stderrLog, String(chunk), { flag: 'a' }))
  } catch { /* diagnostics only */ }
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.setDefaultTimeout(45_000)
  installPageHandlers(page)
  currentApp = app
  currentPage = page
  return { app, page, userDataDir }
}

async function closeApp() {
  if (!currentApp) return
  approvalLoopToken += 1
  const app = currentApp
  const child = app.process()
  try {
    await Promise.race([
      app.evaluate(({ app: electronApp }) => { setImmediate(() => electronApp.quit()) }).catch(() => undefined),
      sleep(2_000),
    ])
  } catch { /* bounded exit wait below */ }
  let exited = await waitProcessExit(child, 8_000)
  if (!exited && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    exited = await waitProcessExit(child, 5_000)
  }
  await Promise.race([app.close().catch(() => undefined), sleep(60_000)])
  currentApp = null
  currentPage = null
  log(`[close] exited=${exited}`)
}

function waitProcessExit(child, timeoutMs) {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolveExit(true); return }
    const timer = setTimeout(() => { clearTimeout(timer); resolveExit(false) }, timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolveExit(true) })
  })
}

// ── Organization API wrappers ───────────────────────────────────────────────
async function state() {
  return currentPage.evaluate(() => window.ndDshOrganization.state())
}

async function mutate(mutation) {
  log(`[mutate] ${mutation.type}`)
  return currentPage.evaluate((input) => window.ndDshOrganization.mutate(input), mutation)
}

async function runtimeQuiescent(label) {
  let streak = 0
  await waitUntil(`runtime quiescent after ${label}`, async () => {
    const status = await currentPage.evaluate(() => window.ndDsh.harness.status()).catch(() => null)
    const s = status?.state ?? 'unknown'
    const quiet = s === 'ready' || s === 'stopped'
    streak = quiet ? streak + 1 : 0
    return { done: streak >= 3, sig: `${s}|${streak}`, detail: `harness=${s}` }
  }, { timeoutMs: 90_000, pollMs: 600 })
  log(`[pace] runtime quiescent after ${label}`)
}

async function navTo(title) {
  await currentPage.getByRole('navigation', { name: 'ND-DSH navigation' }).getByTitle(title).click()
}

async function clickAiPmPlan() {
  await navTo('Company')
  const button = currentPage.getByRole('button', { name: 'AI PM plan' })
  await waitUntil('AI PM plan button enabled', async () => ({
    done: await button.isEnabled().catch(() => false),
    detail: 'AI PM plan button not enabled',
  }), { timeoutMs: 30_000 })
  await button.click()
  log('[action] clicked AI PM plan')
}

async function createCompanyViaUi(name, mission) {
  await navTo('Company')
  const newButton = currentPage.getByRole('button', { name: '+ New', exact: true }).first()
  if (await newButton.isVisible().catch(() => false)) await newButton.click()
  const dialog = currentPage.getByRole('dialog')
  const scope = await dialog.count() > 0 ? dialog : currentPage
  await scope.getByPlaceholder('Company name').fill(name)
  await scope.getByPlaceholder('Company mission').fill(mission)
  await scope.getByRole('button', { name: 'Create AI company' }).click()
  await waitUntil(`company "${name}" appears in state`, async () => {
    const snap = await state()
    return { done: snap.companies.some((item) => item.name === name), detail: `companies=${snap.companies.map((item) => item.name).join(', ') || '(none)'}` }
  }, { timeoutMs: T.ui })
  await runtimeQuiescent(`company.create (${name})`)
}

async function createProjectViaUi(name, objective, workspace) {
  await navTo('Company')
  const form = currentPage.locator('form').filter({ has: currentPage.getByPlaceholder('New project') })
  await waitUntil('project form visible', async () => ({
    done: await form.isVisible().catch(() => false),
    detail: 'project creation form not visible',
  }), { timeoutMs: T.ui })
  await form.getByPlaceholder('New project').fill(name)
  await form.getByPlaceholder('Objective').fill(objective)
  // Stub the native folder picker so Browse resolves to the throwaway repo.
  await currentApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, workspace)
  const browse = form.getByRole('button', { name: 'Browse for workspace folder' })
  await browse.click()
  await waitUntil('workspace folder shown', async () => {
    const text = (await browse.textContent().catch(() => ''))?.trim() ?? ''
    return { done: resolve(text) === resolve(workspace), detail: `browse shows "${text}"` }
  }, { timeoutMs: 15_000 })
  await form.getByRole('button', { name: 'Add project' }).click()
  await waitUntil(`project "${name}" appears in state`, async () => {
    const snap = await state()
    return { done: snap.projects.some((item) => item.name === name), detail: `projects=${snap.projects.map((item) => item.name).join(', ')}` }
  }, { timeoutMs: T.ui })
  await runtimeQuiescent(`project.create (${name})`)
}

async function setAutonomy(level) {
  await navTo('Company')
  const scope = currentPage.locator('label[title="Autonomy level"]')
  await scope.getByRole('combobox').or(scope.locator('button')).first().click()
  if (level !== 4) throw new Error('This journey enables Autopilot level 4 only')
  const option = currentPage.getByRole('option', { name: `${level} Autopilot`, exact: true })
  await option.waitFor({ state: 'visible', timeout: T.ui })
  await currentPage.keyboard.press('End')
  await waitUntil('Autopilot option has keyboard focus', async () => ({
    done: await option.evaluate(element => element === document.activeElement).catch(() => false),
  }), { timeoutMs: T.ui, pollMs: 50 })
  await currentPage.keyboard.press('Enter')
  await waitUntil(`autonomy level = ${level}`, async () => {
    const snap = await state()
    const company = snap.companies.find((item) => item.id === snap.activeCompanyId)
    return { done: company?.autonomyLevel === level, detail: `level=${company?.autonomyLevel}` }
  }, { timeoutMs: 30_000 })
  log(`[action] autonomy set to ${level} (Autopilot)`)
}

async function selectAllWork(projectId) {
  await navTo('Company')
  await currentPage.getByRole('button', { name: 'Company Workspace', exact: true }).click()
  await currentPage.getByRole('button', { name: 'Work', exact: true }).click()
  const selector = currentPage.getByRole('combobox', { name: 'Delivery milestone', exact: true })
  await selector.click()
  const option = currentPage.getByRole('option', { name: 'All work', exact: true })
  await option.waitFor({ state: 'visible', timeout: T.ui })
  // All work is the first entry. Use the ordinary keyboard path so streamed
  // layout updates cannot invalidate pointer actionability during the menu animation.
  await currentPage.keyboard.press('Home')
  await waitUntil('All work option has keyboard focus', async () => ({
    done: await option.evaluate(element => element === document.activeElement).catch(() => false),
  }), { timeoutMs: T.ui, pollMs: 50 })
  await currentPage.keyboard.press('Enter')
  await waitUntil('visible delivery scope is All work', async () => {
    const project = (await state()).projects.find((item) => item.id === projectId)
    return { done: Boolean(project) && !project.deliveryMilestoneId, detail: `deliveryMilestoneId=${project?.deliveryMilestoneId ?? '(all)'}` }
  }, { timeoutMs: T.ui })
  log('[setup] selected Deliver now → All work before enabling Autopilot')
}

// ── Delivery wait ───────────────────────────────────────────────────────────
const DELIVERABLE_FILES = translateScenario?.files ?? ['server.js', 'public/index.html', 'public/app.js', 'server.test.js', 'README.md']

function projectTasks(snap, projectId) {
  return snap.tasks.filter((task) => task.projectId === projectId)
}

function projectRuns(snap, projectId) {
  return snap.runs.filter((run) => run.projectId === projectId)
}

function taskDeliveryReceipts(tasks, runs, evidence) {
  return tasks.map((task) => {
    const execution = runs.find((run) => run.taskId === task.id && run.kind === 'task-execution' && run.sessionId === task.executionSessionId)
    const review = runs.find((run) => run.taskId === task.id && run.kind === 'task-review' && run.sessionId === task.reviewSessionId)
    const verified = evidence.find((item) => item.taskId === task.id && item.status === 'verified' && item.exact === true && item.gitHead === review?.checkpointCommit && item.reviewerRunId === review?.id)
    return {
      taskId: task.id,
      completed: task.status === 'completed' && execution?.status === 'completed',
      integrated: task.integrationState === 'integrated' && typeof task.integratedHead === 'string' && Boolean(task.integratedHead.trim()),
      reviewed: review?.status === 'completed' && execution?.status === 'completed'
        && Number.isFinite(review.completedAt) && Number.isFinite(execution.completedAt)
        && review.startedAt >= execution.completedAt
        && Boolean(execution.checkpointCommit) && review.checkpointCommit === execution.checkpointCommit
        && Boolean(verified),
      executionRunId: execution?.id,
      reviewRunId: review?.id,
      checkpointCommit: review?.checkpointCommit,
      evidenceId: verified?.id,
      integratedHead: task.integratedHead,
    }
  })
}

function independentExecutionOverlap(tasks, runs) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const dependsOn = (taskId, ancestorId, seen = new Set()) => {
    if (seen.has(taskId)) return false
    seen.add(taskId)
    return (byId.get(taskId)?.dependsOn ?? []).some((id) => id === ancestorId || dependsOn(id, ancestorId, seen))
  }
  const executions = runs.filter((run) => run.kind === 'task-execution' && run.status === 'completed'
    && Number.isFinite(run.startedAt) && Number.isFinite(run.completedAt) && run.startedAt < run.completedAt)
  for (const [index, first] of executions.entries()) {
    const second = executions.slice(index + 1).find((other) => first.taskId !== other.taskId
      && byId.has(first.taskId) && byId.has(other.taskId)
      && !dependsOn(first.taskId, other.taskId) && !dependsOn(other.taskId, first.taskId)
      && first.workspaceKind === 'git-worktree' && other.workspaceKind === 'git-worktree'
      && first.workspaceRoot && other.workspaceRoot && first.workspaceRoot !== other.workspaceRoot
      && Math.max(first.startedAt, other.startedAt) < Math.min(first.completedAt, other.completedAt))
    if (second) return { runIds: [first.id, second.id], taskIds: [first.taskId, second.taskId], overlapMs: Math.min(first.completedAt, second.completedAt) - Math.max(first.startedAt, second.startedAt) }
  }
  return null
}

async function waitForDelivery(projectId, workspace) {
  let integratedAt = null
  const result = await waitUntil('PM-driven full-stack delivery completes', async () => {
    const snap = await state()
    const tasks = projectTasks(snap, projectId)
    const runs = projectRuns(snap, projectId)
    const byStatus = {}
    for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1
    const open = tasks.filter((task) => ['backlog', 'ready', 'in_progress', 'review', 'blocked'].includes(task.status))
    const live = runs.filter((run) => run.status === 'running')
    const integrated = tasks.filter((task) => task.integrationState === 'integrated')
    const failed = runs.filter((run) => run.status === 'failed')
    if (integrated.length > 0 && !integratedAt) {
      integratedAt = Date.now()
      log(`[delivery] first integrated run receipt (${integrated.length})`)
    }
    const filesOk = DELIVERABLE_FILES.every((name) => existsSync(join(workspace, name)))
    const done = tasks.length > 0 && tasks.every((task) => task.status === 'completed') && open.length === 0 && live.length === 0 && filesOk
    return {
      done,
      sig: JSON.stringify([byStatus, live.length, integrated.length]),
      detail: `tasks=${JSON.stringify(byStatus)} liveRuns=${live.length} integrated=${integrated.length} failedRuns=${failed.length} filesOk=${filesOk}`,
    }
  }, { timeoutMs: T.delivery, stallMs: T.stall, pollMs: 3_000 })
  return result
}

async function runIntegratedTests(workspace) {
  const probe = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 180_000 })
  const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`
  writeFileSync(join(evidenceDir, 'integrated-tests.txt'), output.slice(-8_000))
  const passCount = Number(/^# pass (\d+)\s*$/m.exec(output)?.[1] ?? 0)
  const failCount = Number(/^# fail (\d+)\s*$/m.exec(output)?.[1] ?? NaN)
  return { exitCode: probe.status, passCount, failCount, passed: passCount > 0 && failCount === 0 }
}

// ── Journey ─────────────────────────────────────────────────────────────────
async function main() {
  log(`pm-fullstack evidence directory: ${evidenceDir}`)
  log(`models: [${MODELS.join(', ')}] provider=${PROVIDER_ID} (key present: true)`)
  const workspace = seedWorkspace()
  log(`workspace seeded: ${workspace}`)
  const { app } = await launchApp()
  log('app launched with fresh profile')

  const runtimeInterruptionProbe = process.env.ND_PM_STABILITY_FAULT === 'runtime-exit'
  const summary = { kind: runtimeInterruptionProbe ? 'pm-runtime-interruption' : 'pm-delivery', terminal: 'pending', gates: [], durationMinutes: 0 }
  const gate = (id, title, pass, evidence) => {
    summary.gates.push({ id, title, status: pass ? 'pass' : 'fail', evidence })
    log(`gate ${pass ? 'PASS' : 'FAIL'}  ${title}`)
  }

  try {
    const companyName = translateScenario?.company ?? 'FullStack Labs'
    const projectName = translateScenario?.project ?? 'Notes Web'
    await createCompanyViaUi(companyName, translateScenario?.mission ?? 'Deliver a complete dependency-free notes web app under one PM.')
    const objective = 'Build a dependency-free notes web app in this workspace: (1) server.js — a Node http server exposing GET /api/notes and POST /api/notes over JSON with in-memory storage; (2) public/index.html plus public/app.js — a minimal frontend that lists existing notes and adds a note through the API; (3) server.test.js — node:test + assert/strict coverage for both API endpoints (start the server on an ephemeral port inside the test); (4) update README.md documenting `node server.js` and `node --test`. All tests must pass with `node --test`. No npm dependencies and no other files.'
    await createProjectViaUi(projectName, translateScenario?.objective ?? objective, workspace)
    const snap = await state()
    const company = snap.companies.find((item) => item.name === companyName)
    const project = snap.projects.find((item) => item.name === projectName)
    if (!company || !project) throw new Error('company/project missing after create')
    if (translateScenario) {
      await mutate({ type: 'project.update', id: project.id, patch: { testCommand: 'node --test' } })
      const builder = snap.agents.find((agent) => agent.companyId === company.id && snap.roles.some((role) => role.id === agent.roleId && role.name === 'Software Engineer'))
      if (!builder) throw new Error('Default Software Engineer is missing')
      await mutate({ type: 'agent.create', companyId: company.id, name: 'Parallel Builder', roleId: builder.roleId, ...(builder.teamId ? { teamId: builder.teamId } : {}) })
      // Explicit local test policy, recorded in the disposable company. No
      // background approval loop grants external actions or edits task state.
      for (const action of ['source.write', 'shell.execute', 'git.commit']) {
        await mutate({ type: 'policy.set', companyId: company.id, action, effect: 'allow', description: 'Authorized local ND Translate stability scenario in a disposable workspace.' })
      }
    }
    const wsState = await currentPage.evaluate(() => window.ndDsh.workspace.state())
    gate('bind', 'Workspace bound to the seeded project repo', resolve(wsState.root ?? '') === resolve(workspace), wsState.root)

    await clickAiPmPlan()
    if (runtimeInterruptionProbe) {
      // Separate fault qualification: never substitute these gates for delivery.
      const run = await waitUntil('PM admitted before runtime fault', async () => {
        const active = projectRuns(await state(), project.id).find(item => item.kind === 'pm-plan' && item.status === 'running')
        return { done: Boolean(active), value: active }
      }, { timeoutMs: T.ui })
      // Organization receipts are created before launch-policy refresh. Do not
      // terminate a runtime already being replaced before prompt admission.
      await waitUntil('PM prompt accepted by the stable harness', async () => {
        const observation = await currentPage.evaluate(async sessionId => ({
          status: await window.ndDsh.harness.status(),
          sessions: await window.ndDsh.dsh.rpc('session.list'),
          history: await window.ndDsh.dsh.rpc('session.history', { sessionId }),
        }), run.sessionId)
        const row = observation.sessions.value?.items?.find(item => item.sessionId === run.sessionId)
        const started = observation.history.value?.events?.some(entry => (entry.event ?? entry).type === 'turn/start')
        return { done: observation.status.state === 'running' && row?.running === true && started, detail: `harness=${observation.status.state} running=${row?.running} turnStarted=${Boolean(started)}` }
      }, { timeoutMs: 90_000, pollMs: 1_000 })
      const mainPid = await app.evaluate(() => process.pid)
      const runtimePid = await waitUntil('owned harness child is identifiable', async () => {
        const output = readFileSync(join(evidenceDir, 'main-stdout.log'), 'utf8')
        const match = [...output.matchAll(/ND-DSH runtime spawning: .*?pid=(\d+) file=/g)].at(-1)
        const pid = match ? Number(match[1]) : undefined
        const row = processDescendants(mainPid, readProcessRows()).find(item => item.pid === pid)
        const identityMatches = process.platform === 'win32'
          ? Boolean(row && /^node\.exe \(started /i.test(row.command) && row.startedAt >= startedAt.getTime() - 1_000)
          : Boolean(row && /deepseek-harness/i.test(row.command) && /--profile"?\s+"?web/.test(row.command))
        return { done: identityMatches, value: pid }
      }, { timeoutMs: T.ui })
      log(`[fault] terminating owned harness child pid=${runtimePid}`)
      const faultAt = Date.now()
      process.kill(runtimePid, 'SIGTERM')
      const failed = await waitUntil('interrupted PM released without a stale active run', async () => {
        const snap = await state()
        const interrupted = snap.runs.find(item => item.id === run.id)
        return { done: interrupted?.status === 'failed' && !projectRuns(snap, project.id).some(item => item.status === 'running'), value: interrupted, detail: `PM status=${interrupted?.status}` }
      }, { timeoutMs: 20_000, pollMs: 250 })
      writeJson('runtime-interruption.json', { mainPid, runtimePid, faultAt, observedAt: Date.now(), run: failed })
      gate('runtime-exit', 'Unexpected harness exit promptly fails and releases the PM run', failed?.status === 'failed' && /interrupted/i.test(failed.error ?? ''), 'runtime-interruption.json')
      const recovery = await currentPage.evaluate(async sessionId => ({
        sessions: await window.ndDsh.dsh.rpc('session.list'),
        status: await window.ndDsh.harness.status(),
        sessionId,
      }), run.sessionId)
      writeJson('runtime-recovery.json', recovery)
      gate('runtime-recovery', 'Recovered runtime lists the interrupted session as stopped', recovery.sessions.ok && recovery.status.state === 'ready'
        && recovery.sessions.value?.items?.some(item => item.sessionId === recovery.sessionId && item.running === false), 'runtime-recovery.json')
      await navTo('Company')
      await currentPage.getByRole('button', { name: 'Company Workspace', exact: true }).click()
      await currentPage.screenshot({ path: join(evidenceDir, 'runtime-recovery-ui.png') })
      writeJson('runtime-recovery-ui.json', { url: currentPage.url(), text: await currentPage.locator('body').innerText() })
      gate('retry-ready', 'PM plan can be requested again after runtime recovery', await currentPage.getByRole('button', { name: 'AI PM plan', exact: true }).isEnabled({ timeout: T.ui }), 'visible enabled PM button')
      summary.terminal = summary.gates.every(item => item.status === 'pass') ? 'pass' : 'fail'
      process.exitCode = summary.terminal === 'pass' ? 0 : 1
      log(`[fault] runtime interruption qualification ${summary.terminal.toUpperCase()}; this is not a delivery result`)
      return
    }
    await waitUntil('AI PM plan produces the full task graph', async () => {
      const s = await state()
      const runs = projectRuns(s, project.id)
      const planRun = runs.filter((run) => run.kind === 'pm-plan').at(-1)
      if (planRun?.status === 'failed') throw new FatalWaitError(`AI PM plan failed: ${planRun.error}`)
      const tasks = projectTasks(s, project.id)
      if (planRun?.status === 'completed' && tasks.length < 2) throw new FatalWaitError(`AI PM completed an unusable multi-task plan: only ${tasks.length} task(s) were materialized`)
      return { done: tasks.length >= 2 && planRun?.status === 'completed', detail: `tasks=${tasks.length} planRun=${planRun?.status ?? 'none'}` }
    }, { timeoutMs: T.plan })
    const planned = await state()
    const tasks = projectTasks(planned, project.id)
    gate('plan', `AI PM planned a multi-task graph (${tasks.length} tasks)`, tasks.length >= 2, tasks.map((task) => task.title))

    await selectAllWork(project.id)
    const deliveryScope = (await state()).projects.find((item) => item.id === project.id)
    gate('scope', 'All planned work selected visibly before Autopilot', Boolean(deliveryScope) && !deliveryScope.deliveryMilestoneId, 'Deliver now → All work')
    await setAutonomy(4)
    const deliveryStarted = Date.now()
    await waitForDelivery(project.id, workspace)
    const deliveryMinutes = (Date.now() - deliveryStarted) / 60_000
    log(`[delivery] completed in ${deliveryMinutes.toFixed(1)} min`)

    const final = await state()
    const control = await currentPage.evaluate(() => window.ndDshControl.state())
    const finalTasks = projectTasks(final, project.id)
    const finalRuns = projectRuns(final, project.id)
    const receipts = taskDeliveryReceipts(finalTasks, finalRuns, control.evidence.filter((item) => item.projectId === project.id))
    writeJson('delivery-receipts.json', receipts)
    writeJson('final-state.json', {
      company, project,
      tasks: projectTasks(final, project.id),
      runs: finalRuns.map(({ id, sessionId, kind, status, taskId, workspaceKind, workspaceRoot, workspaceBranch, baselineCommit, checkpointCommit, startedAt, completedAt }) => ({ id, sessionId, kind, status, taskId, workspaceKind, workspaceRoot, workspaceBranch, baselineCommit, checkpointCommit, startedAt, completedAt })),
      receipts,
      rendererErrors,
    })
    gate('deliver', 'All planned tasks completed by successful workers', receipts.length > 0 && receipts.every((item) => item.completed),
      `statuses=${JSON.stringify(finalTasks.map((task) => task.status))}, deliveryMinutes=${deliveryMinutes.toFixed(1)}`)
    const integratedTasks = finalTasks.filter((task) => task.integrationState === 'integrated')
    gate('integrate', 'Every planned task integrated into the base checkout', receipts.length > 0 && receipts.every((item) => item.integrated),
      `taskIntegrationStates=${JSON.stringify(finalTasks.map((task) => task.integrationState))}, heads=${JSON.stringify(integratedTasks.map((task) => task.integratedHead))}`)
    gate('review', 'Every planned task has completed independent review of its exact checkpoint', receipts.length > 0 && receipts.every((item) => item.reviewed), 'delivery-receipts.json')
    gate('files', 'All declared full-stack artifacts exist in the integrated workspace', DELIVERABLE_FILES.every((name) => existsSync(join(workspace, name))), DELIVERABLE_FILES.join(', '))

    const tests = await runIntegratedTests(workspace)
    gate('tests', 'node --test runs passing tests in the integrated workspace', tests.exitCode === 0 && tests.passed, `exitCode=${tests.exitCode} passed=${tests.passCount} failed=${tests.failCount}`)
    if (translateScenario) {
      await currentPage.screenshot({ path: join(evidenceDir, 'task-groups.png') })
      const sessions = await currentPage.evaluate(async () => {
        const response = await window.ndDsh.dsh.rpc('session.list')
        return response.ok ? response.value : null
      })
      writeJson('session-lineage.json', sessions)
      const sessionRows = Array.isArray(sessions) ? sessions : sessions?.items ?? []
      const workerSessions = new Set(finalRuns.filter((run) => run.kind === 'task-execution' && run.status === 'completed').map((run) => run.sessionId))
      gate('subagent', 'A real completed child session belongs to a project worker', sessionRows.some((row) => row.origin === 'subagent' && row.blank === false && !row.running && workerSessions.has(row.parentSessionId)), 'session-lineage.json')
      const overlap = independentExecutionOverlap(finalTasks, finalRuns)
      writeJson('parallel-overlap.json', overlap)
      gate('parallel', 'Successful independent tasks overlap in isolated worktrees', Boolean(overlap), 'parallel-overlap.json')
      const install = await currentPage.evaluate(async (path) => {
        await window.ndDsh.ndExtensions.installFromPath(path)
        await window.ndDsh.ndExtensions.setActivation('nd.translate', { kind: 'personal' }, true)
        return window.ndDsh.ndExtensions.loadView('nd.translate', 'translator', { kind: 'personal' })
      }, workspace)
      gate('install', 'Generated package installs and loads the ND Translate view', install.viewId === 'translator', install.title)
      const translation = await currentPage.evaluate(() => window.ndDsh.ndExtensions.invoke({
        extensionId: 'nd.translate', contributionId: 'translator', contributionKind: 'view', caller: 'user',
        context: { kind: 'personal' }, input: { text: 'Hello world', sourceLanguage: 'en', targetLanguage: 'es', provider: 'google' },
      }))
      writeJson('translation-result.json', translation)
      gate('translation', 'Generated extension returns a real Google translation', translation.ok && translation.value?.status === 'translated' && /hola/i.test(translation.value?.translatedText ?? ''), 'translation-result.json')
    }
    gate('clean', 'No renderer/page errors during the whole journey', rendererErrors.length === 0, JSON.stringify(rendererErrors.slice(0, 4)))

    summary.terminal = summary.gates.every((item) => item.status === 'pass') ? 'pass' : 'fail'
  } catch (error) {
    summary.terminal = 'fail'
    summary.failure = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    log(`FAILURE: ${summary.failure.split('\n')[0]}`)
  } finally {
    if (summary.terminal === 'fail' && currentPage) {
      await currentPage.screenshot({ path: join(evidenceDir, 'failure-ui.png') }).catch(() => undefined)
      await currentPage.locator('body').innerText().then(text => writeJson('failure-ui.json', { url: currentPage.url(), text: text.slice(-12_000) })).catch(() => undefined)
    }
    try {
      const failedState = await state()
      writeJson('last-state.json', failedState)
    } catch { /* the app may have exited; preserve existing evidence */ }
    summary.durationMinutes = (Date.now() - startedAt.getTime()) / 60_000
    summary.evidenceDir = evidenceDir
    writeJson('summary.json', summary)
    await closeApp()
  }

  log(`══ pm-fullstack ${summary.terminal.toUpperCase()} in ${summary.durationMinutes.toFixed(1)} min — evidence: ${evidenceDir}`)
  for (const item of summary.gates) log(`  ${item.status.toUpperCase().padEnd(5)} ${item.title}`)
  process.exitCode = summary.terminal === 'pass' ? 0 : 1
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 1
})
