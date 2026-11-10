/**
 * ND Tutor UI Renderer & Bridge Client
 *
 * Implements the nd.webview/1 protocol with full theme synchronization,
 * offline sandboxing, and interactive curriculum state management.
 */

import {
  COURSES,
  SPRINGBOOT_COURSE_ID,
  SANDBOX_COMPOSE_YAML,
  SANDBOX_SEED_SQL,
  QUICK_REFERENCE_SECTIONS,
  LIVE_TEACHER_TOOLS,
  buildLiveLessonContext,
  getCourse,
  getLesson,
  calculateStats,
  getDueReviews,
  getNextDay,
} from './tutor-core.js'

// --- nd.webview/1 Bridge Client ---------------------------------------------

function createBridge() {
  let hello = null
  const pending = new Map()
  const connectQueue = []
  const eventListeners = new Set()

  const applyTheme = (theme) => {
    const effective = theme === 'light' ? 'light' : 'dark'
    document.documentElement.dataset.theme = effective
    const meta = document.querySelector('meta[name="color-scheme"]')
    if (meta) meta.setAttribute('content', effective)
  }

  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.kind === 'nd-webview:hello' && data.protocol === 'nd.webview/1') {
      if (data.theme) applyTheme(data.theme)
      hello = data
      while (connectQueue.length > 0) {
        const fn = connectQueue.shift()
        if (fn) fn()
      }
      return
    }
    if (data.kind === 'nd-webview:theme' && data.protocol === 'nd.webview/1') {
      if (data.theme) applyTheme(data.theme)
      return
    }
    if (data.kind === 'nd-webview:result') {
      const settle = pending.get(data.requestId)
      if (settle) {
        pending.delete(data.requestId)
        settle(data)
      }
      return
    }
    if (typeof data.kind === 'string' && data.kind.startsWith('nd-webview:live-')) {
      for (const listener of eventListeners) {
        listener(data)
      }
    }
  })

  let attempts = 0
  let slow = false
  let retry = null
  const announce = () => window.parent.postMessage({ kind: 'nd-webview:ready' }, '*')
  const start = () => {
    if (retry) return
    announce()
    retry = setInterval(() => {
      if (hello) {
        clearInterval(retry)
        return
      }
      attempts += 1
      if (!slow && attempts > 40) {
        slow = true
        clearInterval(retry)
        setInterval(function slower() {
          if (!hello) announce()
          else clearInterval(slower)
        }, 2_000)
        return
      }
      announce()
    }, 250)
  }

  return {
    start,
    get connected() {
      return Boolean(hello)
    },
    whenConnected(fn) {
      if (hello) fn()
      else connectQueue.push(fn)
    },
    onEvent(fn) {
      eventListeners.add(fn)
      return () => eventListeners.delete(fn)
    },
    send(payload) {
      if (!hello) return false
      window.parent.postMessage(payload, '*')
      return true
    },
    invoke(input) {
      if (!hello) {
        return Promise.resolve({ ok: false, error: { code: 'unavailable', message: 'Not connected to ND' } })
      }
      const requestId = crypto.randomUUID()
      return new Promise((resolve) => {
        pending.set(requestId, resolve)
        window.parent.postMessage({ kind: 'nd-webview:invoke', requestId, input }, '*')
        setTimeout(() => {
          if (pending.has(requestId)) {
            pending.delete(requestId)
            resolve({ ok: false, error: { code: 'timeout', message: 'ND did not answer in time' } })
          }
        }, 10_000)
      })
    },
  }
}

const bridge = createBridge()

// --- UI State ---------------------------------------------------------------

const appState = {
  courseId: SPRINGBOOT_COURSE_ID,
  currentDay: 1,
  filter: 'all', // 'all' | 'in_progress' | 'completed'
  lang: 'en', // 'en' | 'km'
  progress: {
    days: {},
    reviews: [],
    journal: [],
  },
  scratchpadTimer: null,
  hintsRevealed: new Set(),
  live: {
    dockOpen: false,
    status: 'idle', // 'idle' | 'connecting' | 'live' | 'muted' | 'ended' | 'error'
    muted: false,
    model: 'gemini-3.8-live',
    startedAt: 0,
    startedDay: 1,
    activeBubble: { user: null, teacher: null },
  },
}

// --- DOM Elements -----------------------------------------------------------

const els = {
  courseSelect: document.getElementById('course-select'),
  statCompleted: document.getElementById('stat-completed'),
  statProgressFill: document.getElementById('stat-progress-fill'),
  statAvgScore: document.getElementById('stat-avg-score'),
  statDueCount: document.getElementById('stat-due-count'),
  btnReviews: document.getElementById('btn-reviews'),
  btnLangToggle: document.getElementById('btn-lang-toggle'),
  langLabel: document.getElementById('lang-label'),
  btnSandbox: document.getElementById('btn-sandbox'),
  btnQuickRef: document.getElementById('btn-quick-ref'),
  btnJournal: document.getElementById('btn-journal'),
  curriculumList: document.getElementById('curriculum-list'),
  filterBtns: document.querySelectorAll('.filter-btn'),
  bannerDayTag: document.getElementById('banner-day-tag'),
  bannerTitle: document.getElementById('banner-title'),
  btnAskCoach: document.getElementById('btn-ask-coach'),
  btnCopyPrompt: document.getElementById('btn-copy-prompt'),
  btnLiveToggle: document.getElementById('btn-live-toggle'),
  liveDock: document.getElementById('live-dock'),
  liveDot: document.getElementById('live-dot'),
  liveModelLabel: document.getElementById('live-model-label'),
  liveStatusPill: document.getElementById('live-status-pill'),
  btnLiveClose: document.getElementById('btn-live-close'),
  btnLiveCall: document.getElementById('btn-live-call'),
  btnLiveMute: document.getElementById('btn-live-mute'),
  liveModelSelect: document.getElementById('live-model-select'),
  liveMeterFill: document.getElementById('live-meter-fill'),
  liveErrorBox: document.getElementById('live-error-box'),
  liveTranscript: document.getElementById('live-transcript'),
  btnLiveShareAnswer: document.getElementById('btn-live-share-answer'),
  liveTextInput: document.getElementById('live-text-input'),
  btnLiveSend: document.getElementById('btn-live-send'),
  objectiveBox: document.getElementById('objective-box'),
  diagnosticText: document.getElementById('diagnostic-text'),
  exerciseText: document.getElementById('exercise-text'),
  lessonPrereq: document.getElementById('lesson-prereq'),
  trapText: document.getElementById('trap-text'),
  scratchpad: document.getElementById('scratchpad'),
  scratchpadStatus: document.getElementById('scratchpad-status'),
  scoreInput: document.getElementById('score-input'),
  statusSelect: document.getElementById('status-select'),
  btnSaveProgress: document.getElementById('btn-save-progress'),
  hint1Content: document.getElementById('hint-1-content'),
  hint2Content: document.getElementById('hint-2-content'),
  hint3Content: document.getElementById('hint-3-content'),
  solutionContent: document.getElementById('solution-content'),
  solutionCode: document.getElementById('solution-code'),
  retrievalContainer: document.getElementById('retrieval-container'),
  // Modals
  modalSandbox: document.getElementById('modal-sandbox'),
  modalQuickRef: document.getElementById('modal-quick-ref'),
  modalReviews: document.getElementById('modal-reviews'),
  modalJournal: document.getElementById('modal-journal'),
  sandboxComposeCode: document.getElementById('sandbox-compose-code'),
  sandboxSeedCode: document.getElementById('sandbox-seed-code'),
  btnCopyCompose: document.getElementById('btn-copy-compose'),
  btnCopySeed: document.getElementById('btn-copy-seed'),
  quickRefBody: document.getElementById('quick-ref-body'),
  reviewsListContainer: document.getElementById('reviews-list-container'),
  manualJournalInput: document.getElementById('manual-journal-input'),
  btnAddJournal: document.getElementById('btn-add-journal'),
  journalListContainer: document.getElementById('journal-list-container'),
}

// --- Render Functions -------------------------------------------------------

function renderStats() {
  const stats = calculateStats(appState.courseId, appState.progress)
  if (els.statCompleted) els.statCompleted.textContent = `${stats.completedDays} / ${stats.totalDays}`
  if (els.statProgressFill) els.statProgressFill.style.width = `${stats.percent}%`
  if (els.statAvgScore) els.statAvgScore.textContent = stats.avgScore > 0 ? `${stats.avgScore}%` : '—'

  const due = getDueReviews(appState.progress.reviews)
  if (els.statDueCount) els.statDueCount.textContent = String(due.length)
}

function renderSidebar() {
  const course = getCourse(appState.courseId)
  if (!course || !els.curriculumList) return

  els.curriculumList.innerHTML = ''

  for (const week of course.weeks) {
    const weekEl = document.createElement('div')
    weekEl.className = 'week-group'

    const labelEl = document.createElement('div')
    labelEl.className = 'week-label'
    labelEl.innerHTML = `<span>Week ${week.week}</span><span style="font-size:10px; opacity:0.7;">${week.title}</span>`
    weekEl.appendChild(labelEl)

    for (const dayNum of week.days) {
      const lesson = getLesson(appState.courseId, dayNum)
      if (!lesson) continue

      const dayProgress = appState.progress.days[String(dayNum)]
      const status = dayProgress?.status || 'pending'

      if (appState.filter === 'completed' && status !== 'completed') continue
      if (appState.filter === 'in_progress' && status === 'completed') continue

      const itemEl = document.createElement('div')
      itemEl.className = `lesson-item ${dayNum === appState.currentDay ? 'active' : ''}`
      itemEl.dataset.day = String(dayNum)

      itemEl.innerHTML = `
        <span class="lesson-badge">${dayNum}</span>
        <div class="lesson-info">
          <div class="lesson-name">${lesson.topic}</div>
        </div>
        <span class="lesson-status-dot status-${status}"></span>
      `

      itemEl.addEventListener('click', () => {
        selectDay(dayNum)
      })

      weekEl.appendChild(itemEl)
    }

    els.curriculumList.appendChild(weekEl)
  }
}

function renderLesson(dayNum) {
  const lesson = getLesson(appState.courseId, dayNum)
  if (!lesson) return

  const isKm = appState.lang === 'km'
  const dayKey = String(dayNum)
  const dayProgress = appState.progress.days[dayKey] || {}

  if (els.bannerDayTag) els.bannerDayTag.textContent = `Day ${dayNum} / 28`
  if (els.bannerTitle) els.bannerTitle.textContent = lesson.topic

  // Objective
  if (els.objectiveBox) {
    const text = isKm && lesson.khmerObjective ? lesson.khmerObjective : lesson.objective
    els.objectiveBox.innerHTML = `<strong>Objective:</strong> ${text}`
  }

  // Diagnostic
  if (els.diagnosticText) {
    const text = isKm && lesson.khmerDiagnostic ? lesson.khmerDiagnostic : lesson.diagnostic
    els.diagnosticText.textContent = text
  }

  // Hands-on Exercise
  if (els.exerciseText) {
    els.exerciseText.textContent = lesson.exercise
  }
  if (els.lessonPrereq) {
    els.lessonPrereq.textContent = `Prerequisites: ${lesson.prerequisites}`
  }

  // Production failure trap
  if (els.trapText) {
    els.trapText.textContent = lesson.failureCase
  }

  // Scratchpad & Status
  if (els.scratchpad) {
    els.scratchpad.value = dayProgress.answer || ''
  }
  if (els.scoreInput) {
    els.scoreInput.value = dayProgress.score !== undefined ? String(dayProgress.score) : ''
  }
  if (els.statusSelect) {
    els.statusSelect.value = dayProgress.status || 'in_progress'
  }
  if (els.scratchpadStatus) {
    els.scratchpadStatus.textContent = dayProgress.answer ? 'Saved' : 'Ready'
  }

  // Escalating hints
  if (els.hint1Content) {
    els.hint1Content.textContent = lesson.hints[0] || 'Think about the constraints.'
    els.hint1Content.classList.remove('open')
  }
  if (els.hint2Content) {
    els.hint2Content.textContent = lesson.hints[1] || 'Review the table columns and data types.'
    els.hint2Content.classList.remove('open')
  }
  if (els.hint3Content) {
    els.hint3Content.textContent = lesson.hints[2] || 'Look at the syntax example in the quick reference.'
    els.hint3Content.classList.remove('open')
  }
  if (els.solutionCode) {
    els.solutionCode.textContent = lesson.solution
  }
  if (els.solutionContent) {
    els.solutionContent.classList.remove('open')
  }

  // Retrieval questions
  if (els.retrievalContainer) {
    els.retrievalContainer.innerHTML = ''
    if (lesson.retrievalQuestions && lesson.retrievalQuestions.length > 0) {
      const ul = document.createElement('ul')
      ul.style.paddingLeft = '18px'
      for (const q of lesson.retrievalQuestions) {
        const li = document.createElement('li')
        li.textContent = q
        li.style.marginBottom = '4px'
        ul.appendChild(li)
      }
      els.retrievalContainer.appendChild(ul)
    } else {
      els.retrievalContainer.textContent = 'None'
    }
  }
}

function selectDay(dayNum) {
  appState.currentDay = dayNum
  appState.hintsRevealed = new Set()
  renderSidebar()
  renderLesson(dayNum)
  if (appState.live.status === 'live' || appState.live.status === 'muted') {
    const lesson = getLesson(appState.courseId, dayNum)
    if (lesson) {
      bridge.send({
        kind: 'nd-webview:live-send-text',
        text: `[Context update: Learner switched to Day ${dayNum} — ${lesson.topic}. Objective: ${lesson.objective}]`,
      })
    }
  }
}

// --- Scratchpad Auto-save ----------------------------------------------------

function setupScratchpadAutoSave() {
  if (!els.scratchpad) return
  els.scratchpad.addEventListener('input', () => {
    if (els.scratchpadStatus) els.scratchpadStatus.textContent = 'Unsaved...'
    if (appState.scratchpadTimer) clearTimeout(appState.scratchpadTimer)
    appState.scratchpadTimer = setTimeout(() => {
      saveProgressOnly()
    }, 1000)
  })
}

async function saveProgressOnly() {
  const dayKey = String(appState.currentDay)
  const answer = els.scratchpad ? els.scratchpad.value : ''
  const lesson = getLesson(appState.courseId, appState.currentDay)

  const currentScoreVal = els.scoreInput ? parseInt(els.scoreInput.value, 10) : NaN
  const score = Number.isFinite(currentScoreVal) ? currentScoreVal : undefined
  const status = els.statusSelect ? els.statusSelect.value : 'in_progress'

  const res = await bridge.invoke({
    action: 'save-progress',
    courseId: appState.courseId,
    day: appState.currentDay,
    status,
    score,
    answer,
    topic: lesson?.topic,
  })

  if (res.ok && res.value && res.value.courseProgress) {
    appState.progress = res.value.courseProgress
    if (els.scratchpadStatus) els.scratchpadStatus.textContent = 'Saved'
    renderStats()
    renderSidebar()
  }
}

async function handleSaveProgressBtn() {
  const lesson = getLesson(appState.courseId, appState.currentDay)
  const day = appState.currentDay
  const answer = els.scratchpad ? els.scratchpad.value : ''
  const rawScore = els.scoreInput ? parseInt(els.scoreInput.value, 10) : NaN
  const score = Number.isFinite(rawScore) ? rawScore : undefined
  const status = els.statusSelect ? els.statusSelect.value : 'completed'

  const journalMessage = status === 'completed'
    ? `Completed Day ${day} (${lesson?.topic}) with score ${score ?? 'mastery'}.`
    : `Studied Day ${day} (${lesson?.topic}).`

  const res = await bridge.invoke({
    action: 'save-progress',
    courseId: appState.courseId,
    day,
    status,
    score,
    answer,
    topic: lesson?.topic,
    journalMessage,
  })

  if (res.ok && res.value && res.value.courseProgress) {
    appState.progress = res.value.courseProgress
    renderStats()
    renderSidebar()
    if (els.scratchpadStatus) els.scratchpadStatus.textContent = 'Saved & Recorded'
  }
}

// --- Action Handlers --------------------------------------------------------

async function copyText(text) {
  try {
    const res = await bridge.invoke({ action: 'copy', text })
    if (!res.ok) {
      await navigator.clipboard.writeText(text)
    }
  } catch {
    await navigator.clipboard.writeText(text)
  }
}

async function askCoachInChat() {
  const lesson = getLesson(appState.courseId, appState.currentDay)
  if (!lesson) return

  const promptText = `Use springboot-db-tutor. Start Day ${appState.currentDay} of my 30-minute PostgreSQL Todo lesson: "${lesson.topic}".
Objective: ${lesson.objective}
Ask me to write the SQL or reasoning first. Do not give away the solution upfront. Provide hints only if I get stuck.`

  await bridge.invoke({
    action: 'ask-coach',
    skill: 'tutor-coach',
    request: promptText,
  })
}

function copyPrompt() {
  const lesson = getLesson(appState.courseId, appState.currentDay)
  if (!lesson) return

  const prompt = `Use springboot-db-tutor. Day ${appState.currentDay} — ${lesson.topic}.
Diagnostic: ${lesson.diagnostic}
Exercise: ${lesson.exercise}`
  void copyText(prompt)
}

// --- Modal Controls ---------------------------------------------------------

function openModal(modalEl) {
  if (modalEl) modalEl.classList.add('open')
}

function closeModal(modalEl) {
  if (modalEl) modalEl.classList.remove('open')
}

function renderQuickRefModal() {
  if (!els.quickRefBody) return
  els.quickRefBody.innerHTML = ''
  for (const sec of QUICK_REFERENCE_SECTIONS) {
    const secEl = document.createElement('div')
    secEl.style.marginBottom = '12px'
    secEl.innerHTML = `
      <h3 style="font-size: 13px; font-weight: 600; color: var(--accent); margin-bottom: 6px;">${sec.title}</h3>
      <ul style="padding-left: 18px; font-size: 12px; color: var(--text);">
        ${sec.items.map((i) => `<li style="margin-bottom: 4px;">${i}</li>`).join('')}
      </ul>
    `
    els.quickRefBody.appendChild(secEl)
  }
}

function renderReviewsModal() {
  if (!els.reviewsListContainer) return
  els.reviewsListContainer.innerHTML = ''
  const reviews = getDueReviews(appState.progress.reviews)

  if (reviews.length === 0) {
    els.reviewsListContainer.innerHTML = '<p style="color:var(--text-muted); font-size:12px;">🎉 No reviews due today! Keep up the daily practice.</p>'
    return
  }

  for (const r of reviews) {
    const itemEl = document.createElement('div')
    itemEl.className = 'review-item'
    itemEl.innerHTML = `
      <div class="review-top">
        <strong>Day ${r.day} — ${r.topic}</strong>
        <span class="review-due">Due: ${r.due} (+${r.intervalDays}d)</span>
      </div>
      <div style="font-size: 11.5px; color: var(--text-muted);">
        Can you explain the key invariants and constraints learned in this lesson from memory?
      </div>
      <div class="review-actions">
        <button class="btn btn-sm btn-primary" data-review="${r.id}" data-result="passed">✅ Pass</button>
        <button class="btn btn-sm btn-danger" data-review="${r.id}" data-result="failed">❌ Retry</button>
      </div>
    `
    els.reviewsListContainer.appendChild(itemEl)
  }

  // Hook review buttons
  els.reviewsListContainer.querySelectorAll('[data-review]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      const target = ev.currentTarget
      const reviewId = target.dataset.review
      const result = target.dataset.result

      const res = await bridge.invoke({
        action: 'save-progress',
        courseId: appState.courseId,
        reviewId,
        result,
      })
      if (res.ok && res.value?.courseProgress) {
        appState.progress = res.value.courseProgress
        renderStats()
        renderReviewsModal()
      }
    })
  })
}

function renderJournalModal() {
  if (!els.journalListContainer) return
  els.journalListContainer.innerHTML = ''
  const journal = appState.progress.journal || []

  if (journal.length === 0) {
    els.journalListContainer.innerHTML = '<p style="color:var(--text-muted); font-size:12px;">No journal entries yet. Complete lessons to log reflections.</p>'
    return
  }

  for (const j of journal) {
    const itemEl = document.createElement('div')
    itemEl.className = 'journal-item'
    const dateStr = new Date(j.timestamp).toLocaleString()
    itemEl.innerHTML = `
      <div class="journal-meta">${dateStr} ${j.day ? `• [Day ${j.day}]` : ''}</div>
      <div>${j.message}</div>
    `
    els.journalListContainer.appendChild(itemEl)
  }
}

// --- Setup Event Listeners --------------------------------------------------

function setupEvents() {
  // Filter buttons
  els.filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      els.filterBtns.forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      appState.filter = btn.dataset.filter || 'all'
      renderSidebar()
    })
  })

  // Language toggle
  if (els.btnLangToggle) {
    els.btnLangToggle.addEventListener('click', () => {
      appState.lang = appState.lang === 'en' ? 'km' : 'en'
      if (els.langLabel) els.langLabel.textContent = appState.lang === 'en' ? 'ខ្មែរ (KM)' : 'English (EN)'
      renderLesson(appState.currentDay)
    })
  }

  // Ask Coach button
  if (els.btnAskCoach) {
    els.btnAskCoach.addEventListener('click', askCoachInChat)
  }

  // Live Teacher controls
  setupLiveTeacher()

  // Copy prompt button
  if (els.btnCopyPrompt) {
    els.btnCopyPrompt.addEventListener('click', copyPrompt)
  }

  // Save Progress button
  if (els.btnSaveProgress) {
    els.btnSaveProgress.addEventListener('click', handleSaveProgressBtn)
  }

  // Hints toggles
  document.querySelectorAll('.hint-header').forEach((h) => {
    h.addEventListener('click', () => {
      const step = h.parentElement
      const content = step?.querySelector('.hint-content')
      if (content) {
        content.classList.toggle('open')
        const hintAttr = h.getAttribute('data-hint')
        const hintNum = hintAttr ? Number.parseInt(hintAttr, 10) : NaN
        if (Number.isInteger(hintNum) && content.classList.contains('open')) {
          appState.hintsRevealed.add(hintNum)
        }
      }
    })
  })

  // Modal open buttons
  if (els.btnSandbox) {
    els.btnSandbox.addEventListener('click', () => {
      if (els.sandboxComposeCode) els.sandboxComposeCode.textContent = SANDBOX_COMPOSE_YAML
      if (els.sandboxSeedCode) els.sandboxSeedCode.textContent = SANDBOX_SEED_SQL
      openModal(els.modalSandbox)
    })
  }

  if (els.btnCopyCompose) {
    els.btnCopyCompose.addEventListener('click', () => void copyText(SANDBOX_COMPOSE_YAML))
  }
  if (els.btnCopySeed) {
    els.btnCopySeed.addEventListener('click', () => void copyText(SANDBOX_SEED_SQL))
  }

  if (els.btnQuickRef) {
    els.btnQuickRef.addEventListener('click', () => {
      renderQuickRefModal()
      openModal(els.modalQuickRef)
    })
  }

  if (els.btnReviews) {
    els.btnReviews.addEventListener('click', () => {
      renderReviewsModal()
      openModal(els.modalReviews)
    })
  }

  if (els.btnJournal) {
    els.btnJournal.addEventListener('click', () => {
      renderJournalModal()
      openModal(els.modalJournal)
    })
  }

  // Manual journal addition
  if (els.btnAddJournal && els.manualJournalInput) {
    els.btnAddJournal.addEventListener('click', async () => {
      const text = els.manualJournalInput.value.trim()
      if (!text) return
      const res = await bridge.invoke({
        action: 'save-progress',
        courseId: appState.courseId,
        day: appState.currentDay,
        status: els.statusSelect ? els.statusSelect.value : 'in_progress',
        journalMessage: text,
      })
      if (res.ok && res.value?.courseProgress) {
        appState.progress = res.value.courseProgress
        els.manualJournalInput.value = ''
        renderJournalModal()
      }
    })
  }

  // Close modals
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-close')
      if (modalId) {
        const modal = document.getElementById(modalId)
        if (modal) closeModal(modal)
      }
    })
  })

  // Modal backdrop click
  document.querySelectorAll('.modal-overlay').forEach((modal) => {
    modal.addEventListener('click', (ev) => {
      if (ev.target === modal) closeModal(modal)
    })
  })

  // Course select change (for future courses)
  if (els.courseSelect) {
    els.courseSelect.addEventListener('change', () => {
      appState.courseId = els.courseSelect.value
      appState.currentDay = 1
      loadInitialState()
    })
  }

  setupScratchpadAutoSave()
}

// --- Live Teacher Controller ------------------------------------------------

function setLiveDockOpen(open) {
  appState.live.dockOpen = open
  if (els.liveDock) els.liveDock.classList.toggle('open', open)
}

function formatLiveErrorGuidance(raw) {
  const text = String(raw || '').trim()
  if (!text) return 'Live session failed.'
  if (/Google AI Studio/i.test(text) || /API key/i.test(text)) {
    return `${text} Open Settings → ND Router → Providers → Add Google AI Studio to enable Live Teacher.`
  }
  if (/Safe Mode/i.test(text)) {
    return 'ND Router Safe Mode is currently on. Disable Safe Mode in Settings → ND Router to start a live voice call.'
  }
  if (/Microphone/i.test(text) || /Permission/i.test(text) || /NotAllowedError/i.test(text)) {
    return `Microphone access was denied or unavailable (${text}). Allow microphone access for ND and try again.`
  }
  return text
}

function updateLiveUi() {
  const st = appState.live.status
  const active = st === 'live' || st === 'muted'
  const busy = st === 'connecting'

  if (els.liveDot) {
    els.liveDot.className = `live-dot ${st}`
  }
  if (els.liveStatusPill) {
    const label = st === 'idle' ? 'Ready'
      : st === 'connecting' ? 'Connecting…'
        : st === 'live' ? 'Live'
          : st === 'muted' ? 'Muted'
            : st === 'error' ? 'Error'
              : 'Ended'
    els.liveStatusPill.textContent = label
    els.liveStatusPill.className = `live-status-pill ${st}`
  }
  if (els.liveModelLabel) {
    els.liveModelLabel.textContent = appState.live.model
  }
  if (els.btnLiveCall) {
    if (active || busy) {
      els.btnLiveCall.textContent = '⏹ End Call'
      els.btnLiveCall.classList.remove('btn-primary')
      els.btnLiveCall.classList.add('btn-danger')
    } else {
      els.btnLiveCall.textContent = '🎙 Start Live Call'
      els.btnLiveCall.classList.add('btn-primary')
      els.btnLiveCall.classList.remove('btn-danger')
    }
  }
  if (els.btnLiveToggle) {
    els.btnLiveToggle.textContent = active ? '🔴 Live Teacher' : busy ? '⏳ Connecting…' : '🎙 Live Teacher'
  }
  if (els.btnLiveMute) {
    els.btnLiveMute.disabled = !active
    els.btnLiveMute.textContent = appState.live.muted ? '🎙 Unmute' : '🔇 Mute'
  }
  if (els.liveModelSelect) {
    els.liveModelSelect.disabled = active || busy
  }
  if (els.btnLiveShareAnswer) {
    els.btnLiveShareAnswer.disabled = !active
  }
  if (els.liveTextInput) {
    els.liveTextInput.disabled = !active
  }
  if (els.btnLiveSend) {
    els.btnLiveSend.disabled = !active
  }
  if (!active && els.liveMeterFill) {
    els.liveMeterFill.style.width = '0%'
  }
}

function showLiveError(message) {
  if (!els.liveErrorBox) return
  if (!message) {
    els.liveErrorBox.hidden = true
    els.liveErrorBox.textContent = ''
    return
  }
  els.liveErrorBox.hidden = false
  els.liveErrorBox.textContent = formatLiveErrorGuidance(message)
}

function clearLiveEmptyState() {
  if (!els.liveTranscript) return
  const empty = els.liveTranscript.querySelector('.live-empty')
  if (empty) empty.remove()
}

function appendLiveToolChip(text) {
  if (!els.liveTranscript) return
  clearLiveEmptyState()
  const chip = document.createElement('div')
  chip.className = 'live-tool-chip'
  chip.textContent = text
  els.liveTranscript.appendChild(chip)
  els.liveTranscript.scrollTop = els.liveTranscript.scrollHeight
}

function appendLiveTranscript(role, text, isFinal) {
  if (!els.liveTranscript) return
  const key = role === 'user' ? 'user' : 'teacher'
  const current = appState.live.activeBubble[key]

  if (!text && isFinal) {
    appState.live.activeBubble[key] = null
    return
  }

  clearLiveEmptyState()
  let bubble = current
  if (!bubble) {
    bubble = document.createElement('div')
    bubble.className = `live-bubble ${key}`
    const roleEl = document.createElement('div')
    roleEl.className = 'live-bubble-role'
    roleEl.textContent = key === 'user' ? 'You' : 'Live Teacher'
    const bodyEl = document.createElement('div')
    bodyEl.className = 'live-bubble-body'
    bubble.appendChild(roleEl)
    bubble.appendChild(bodyEl)
    els.liveTranscript.appendChild(bubble)
    appState.live.activeBubble[key] = bubble
  }

  const bodyEl = bubble.querySelector('.live-bubble-body')
  if (bodyEl && text) {
    bodyEl.textContent = `${bodyEl.textContent || ''}${text}`
  }

  if (isFinal) {
    appState.live.activeBubble[key] = null
  }
  els.liveTranscript.scrollTop = els.liveTranscript.scrollHeight
}

function handleLiveToolCall(call) {
  const { id, name, args } = call
  let response = { ok: false, error: 'Unsupported teacher tool' }

  if (name === 'show_hint') {
    const rawLevel = Number(args?.level)
    const level = Number.isInteger(rawLevel) ? Math.max(1, Math.min(3, rawLevel)) : 1
    const el = level === 1 ? els.hint1Content : level === 2 ? els.hint2Content : els.hint3Content
    if (el) {
      el.classList.add('open')
      appState.hintsRevealed.add(level)
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      appendLiveToolChip(`💡 Live Teacher revealed Hint ${level}`)
      response = { ok: true, level, text: el.textContent || '' }
    } else {
      response = { ok: false, error: 'Hint panel unavailable' }
    }
  } else if (name === 'reveal_solution') {
    if (!appState.hintsRevealed.has(3) && appState.hintsRevealed.size < 3) {
      response = {
        ok: false,
        error: 'Reveal Hint 1, Hint 2, and Hint 3 first before showing the worked solution.',
      }
    } else if (els.solutionContent) {
      els.solutionContent.classList.add('open')
      els.solutionContent.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      appendLiveToolChip('📘 Live Teacher opened the worked reference solution')
      response = { ok: true }
    }
  } else if (name === 'record_score') {
    const rawScore = Number(args?.score)
    if (!Number.isFinite(rawScore)) {
      response = { ok: false, error: 'score must be a number between 0 and 100' }
    } else {
      const score = Math.max(0, Math.min(100, Math.round(rawScore)))
      const note = typeof args?.note === 'string' ? args.note.trim().slice(0, 240) : ''
      if (els.scoreInput) els.scoreInput.value = String(score)
      if (els.statusSelect) {
        els.statusSelect.value = score >= 70 ? 'completed' : 'needs_retry'
      }
      appendLiveToolChip(`📊 Suggested score: ${score}/100${note ? ` — ${note}` : ''} (press Save to record)`)
      response = { ok: true, score, note, savedByLearner: false }
    }
  }

  bridge.send({
    kind: 'nd-webview:live-tool-result',
    id,
    name,
    response,
  })
}

function recordLiveSessionJournalIfNeeded() {
  if (!appState.live.startedAt) return
  const elapsedSec = Math.max(1, Math.round((Date.now() - appState.live.startedAt) / 1000))
  const day = appState.live.startedDay
  appState.live.startedAt = 0
  if (elapsedSec < 3) return
  const mins = Math.floor(elapsedSec / 60)
  const secs = elapsedSec % 60
  const durationLabel = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
  const lesson = getLesson(appState.courseId, day)
  const status = els.statusSelect ? els.statusSelect.value : 'in_progress'
  void bridge.invoke({
    action: 'save-progress',
    courseId: appState.courseId,
    day,
    status,
    topic: lesson?.topic,
    journalMessage: `Live session · ${durationLabel} · Day ${day}${lesson ? ` (${lesson.topic})` : ''}`,
  }).then((res) => {
    if (res.ok && res.value?.courseProgress) {
      appState.progress = res.value.courseProgress
      renderStats()
      renderSidebar()
    }
  })
}

function startLiveCall() {
  showLiveError('')
  setLiveDockOpen(true)
  appState.live.muted = false
  appState.live.activeBubble = { user: null, teacher: null }

  const dueCount = getDueReviews(appState.progress.reviews).length
  const lessonContext = buildLiveLessonContext({
    courseId: appState.courseId,
    day: appState.currentDay,
    lang: appState.lang,
    scratchpad: els.scratchpad ? els.scratchpad.value : '',
    dueReviewsCount: dueCount,
  })

  const selectedModel = els.liveModelSelect ? els.liveModelSelect.value : ''
  appState.live.model = selectedModel || 'gemini-3.8-live'
  appState.live.status = 'connecting'
  updateLiveUi()

  bridge.send({
    kind: 'nd-webview:live-start',
    lessonContext,
    language: appState.lang,
    ...(selectedModel ? { model: selectedModel } : {}),
    tools: LIVE_TEACHER_TOOLS,
  })
}

function stopLiveCall() {
  bridge.send({ kind: 'nd-webview:live-stop' })
}

function sendLiveText(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return false
  if (appState.live.status !== 'live' && appState.live.status !== 'muted') return false
  appendLiveTranscript('user', trimmed, true)
  bridge.send({ kind: 'nd-webview:live-send-text', text: trimmed })
  return true
}

function setupLiveTeacher() {
  updateLiveUi()

  bridge.onEvent((data) => {
    if (data.kind === 'nd-webview:live-state') {
      const next = data.status || 'ended'
      appState.live.status = next
      if (data.model) appState.live.model = data.model
      if (next === 'live' && !appState.live.startedAt) {
        appState.live.startedAt = Date.now()
        appState.live.startedDay = appState.currentDay
      }
      if (next === 'muted') appState.live.muted = true
      if (next === 'live') appState.live.muted = false
      if (next === 'error') {
        showLiveError(data.reason || 'Live Teacher connection failed.')
        recordLiveSessionJournalIfNeeded()
      } else if (next === 'ended') {
        appState.live.activeBubble = { user: null, teacher: null }
        recordLiveSessionJournalIfNeeded()
      }
      updateLiveUi()
      return
    }
    if (data.kind === 'nd-webview:live-transcript') {
      appendLiveTranscript(data.role, data.text || '', Boolean(data.final))
      return
    }
    if (data.kind === 'nd-webview:live-level') {
      if (els.liveMeterFill) {
        const pct = Math.max(0, Math.min(100, Math.round((Number(data.level) || 0) * 100)))
        els.liveMeterFill.style.width = `${pct}%`
      }
      return
    }
    if (data.kind === 'nd-webview:live-tool-call') {
      handleLiveToolCall(data)
    }
  })

  if (els.btnLiveToggle) {
    els.btnLiveToggle.addEventListener('click', () => {
      setLiveDockOpen(!appState.live.dockOpen)
    })
  }
  if (els.btnLiveClose) {
    els.btnLiveClose.addEventListener('click', () => {
      setLiveDockOpen(false)
    })
  }
  if (els.btnLiveCall) {
    els.btnLiveCall.addEventListener('click', () => {
      const st = appState.live.status
      if (st === 'live' || st === 'muted' || st === 'connecting') {
        stopLiveCall()
      } else {
        startLiveCall()
      }
    })
  }
  if (els.btnLiveMute) {
    els.btnLiveMute.addEventListener('click', () => {
      const nextMuted = !appState.live.muted
      appState.live.muted = nextMuted
      bridge.send({ kind: 'nd-webview:live-mute', muted: nextMuted })
      updateLiveUi()
    })
  }
  if (els.btnLiveShareAnswer) {
    els.btnLiveShareAnswer.addEventListener('click', () => {
      const draft = els.scratchpad ? els.scratchpad.value.trim() : ''
      if (!draft) {
        appendLiveToolChip('Write an answer in your SQL scratchpad first, then share it.')
        return
      }
      sendLiveText(`Here is my current scratchpad answer for Day ${appState.currentDay}:\n\`\`\`sql\n${draft}\n\`\`\`\nPlease evaluate it and ask follow-up questions before revealing the solution.`)
    })
  }
  if (els.btnLiveSend && els.liveTextInput) {
    const submit = () => {
      if (sendLiveText(els.liveTextInput.value)) {
        els.liveTextInput.value = ''
      }
    }
    els.btnLiveSend.addEventListener('click', submit)
    els.liveTextInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        submit()
      }
    })
  }
}

// --- Initialization ---------------------------------------------------------

async function loadInitialState() {
  const res = await bridge.invoke({
    action: 'get-progress',
    courseId: appState.courseId,
  })

  if (res.ok && res.value) {
    appState.progress = res.value.courseProgress || { days: {}, reviews: [], journal: [] }
    const nextDay = getNextDay(appState.courseId, appState.progress)
    appState.currentDay = nextDay || 1
  }

  renderStats()
  renderSidebar()
  renderLesson(appState.currentDay)
}

function main() {
  setupEvents()
  bridge.start()
  bridge.whenConnected(() => {
    void loadInitialState()
  })
}

// Start once DOM is loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main)
} else {
  main()
}
