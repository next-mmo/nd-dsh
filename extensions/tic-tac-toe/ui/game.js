/**
 * ND 3D Tic-Tac-Toe — package-shipped web view UI.
 *
 * Runs inside ND's sandboxed iframe: opaque origin, no Node, no network, and
 * WebGL is the only privileged API it touches. Every durable effect goes
 * through the nd.webview/1 bridge (postMessage → parent → broker → host
 * methods), so this script holds no authority of its own. If WebGL is
 * unavailable the game still plays through keys and buttons; only visuals go.
 */
import * as THREE from './vendor/three.module.js'
import {
  EMPTY,
  applyMove,
  bestMove,
  easyMove,
  emptyBoard,
  opponentOf,
  outcomeOf,
} from './game-core.js'

const HUMAN = 'X'
const AI = 'O'
const CELL = 1.1

// --- nd.webview/1 bridge client ---------------------------------------------

function createBridge() {
  let hello = null
  const pending = new Map()
  const connectQueue = []

  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.kind === 'nd-webview:hello' && data.protocol === 'nd.webview/1') {
      hello = data
      while (connectQueue.length > 0) connectQueue.shift()()
      return
    }
    if (data.kind === 'nd-webview:result') {
      const settle = pending.get(data.requestId)
      if (settle) {
        pending.delete(data.requestId)
        settle(data)
      }
    }
  })

  // Announce readiness until the host answers: a fast burst first, then a
  // slow retry forever, so a host that mounts late still connects instead of
  // leaving the dialog stuck on its loading state.
  let attempts = 0
  let slow = false
  const announce = () => window.parent.postMessage({ kind: 'nd-webview:ready' }, '*')
  announce()
  const retry = setInterval(() => {
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

  return {
    get connected() {
      return Boolean(hello)
    },
    /** Run fn once the host handshake has landed (immediately if it has). */
    whenConnected(fn) {
      if (hello) fn()
      else connectQueue.push(fn)
    },
    /** input {action} routes through the parent to the view's declared host methods. */
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

// --- DOM ---------------------------------------------------------------------

const statusEl = document.getElementById('status')
const boardEl = document.getElementById('board')
const fallbackEl = document.getElementById('fallback')
const els = {
  wins: document.getElementById('score-wins'),
  losses: document.getElementById('score-losses'),
  draws: document.getElementById('score-draws'),
  streak: document.getElementById('score-streak'),
  modeAi: document.getElementById('mode-ai'),
  mode2p: document.getElementById('mode-2p'),
  diffHard: document.getElementById('diff-hard'),
  diffEasy: document.getElementById('diff-easy'),
  difficultyGroup: document.getElementById('difficulty-group'),
  newGame: document.getElementById('new-game'),
  resetScores: document.getElementById('reset-scores'),
}

const state = {
  board: emptyBoard(),
  turn: HUMAN,
  mode: 'ai', // 'ai' | '2p'
  difficulty: 'hard', // 'hard' | 'easy'
  finished: false,
  busy: false,
}

function refreshModeButtons() {
  els.modeAi.classList.toggle('on', state.mode === 'ai')
  els.mode2p.classList.toggle('on', state.mode === '2p')
  els.diffHard.classList.toggle('on', state.difficulty === 'hard')
  els.diffEasy.classList.toggle('on', state.difficulty === 'easy')
  els.difficultyGroup.style.visibility = state.mode === 'ai' ? 'visible' : 'hidden'
}

function setStatus(text) {
  statusEl.textContent = text
}

function humanTurn() {
  return !state.finished && !state.busy && (state.mode === '2p' || state.turn === HUMAN)
}

function turnLabel() {
  if (state.mode === '2p') return `${state.turn} to move`
  return state.turn === HUMAN ? 'Your turn — you are X' : 'AI is thinking…'
}

// --- three.js visuals (optional; the game plays fine without them) ------------

let addPiece = () => {}
let clearPieces = () => {}
let showWinLine = () => {}
let clearWinLine = () => {}

function createRenderer() {
  try {
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    return renderer.getContext() ? renderer : null
  } catch {
    return null
  }
}

const renderer = createRenderer()
if (renderer) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  boardEl.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x111318)

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
  const target = new THREE.Vector3(0, 0.2, 0)
  // The camera is fixed: a near top-down, axis-aligned view keeps all nine cells
  // equally readable and clickable, with rows and columns square to the screen.
  // There is no orbit, zoom, or preset switching, so a stray drag can never tip
  // the board into an unplayable angle mid-game.
  const VIEW = { theta: 0, phi: 0.32, radius: 8.2 }
  camera.position.set(
    VIEW.radius * Math.sin(VIEW.phi) * Math.sin(VIEW.theta),
    VIEW.radius * Math.cos(VIEW.phi),
    VIEW.radius * Math.sin(VIEW.phi) * Math.cos(VIEW.theta),
  )
  camera.lookAt(target)

  scene.add(new THREE.HemisphereLight(0xdfe7ff, 0x0b0d12, 1.0))
  const sun = new THREE.DirectionalLight(0xffffff, 1.6)
  sun.position.set(4, 7, 3)
  scene.add(sun)
  const fill = new THREE.PointLight(0xa78bfa, 12, 20)
  fill.position.set(-4, 3, -4)
  scene.add(fill)

  const base = new THREE.Mesh(
    new THREE.BoxGeometry(3.9, 0.36, 3.9),
    new THREE.MeshStandardMaterial({ color: 0x1d212b, roughness: 0.85, metalness: 0.1 }),
  )
  base.position.y = -0.18
  scene.add(base)

  const gridMaterial = new THREE.MeshStandardMaterial({ color: 0x2c3240, roughness: 0.6, metalness: 0.2 })
  for (const offset of [-0.55, 0.55]) {
    const alongX = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.1, 0.09), gridMaterial)
    alongX.position.set(0, 0.05, offset)
    scene.add(alongX)
    const alongZ = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 3.5), gridMaterial)
    alongZ.position.set(offset, 0.05, 0)
    scene.add(alongZ)
  }

  const hover = new THREE.Mesh(
    new THREE.PlaneGeometry(1.02, 1.02),
    new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.16, depthWrite: false }),
  )
  hover.rotation.x = -Math.PI / 2
  hover.visible = false
  scene.add(hover)

  const xMaterial = new THREE.MeshStandardMaterial({ color: 0xfbbf24, emissive: 0xfbbf24, emissiveIntensity: 0.25, roughness: 0.35, metalness: 0.3 })
  const oMaterial = new THREE.MeshStandardMaterial({ color: 0xa78bfa, emissive: 0xa78bfa, emissiveIntensity: 0.25, roughness: 0.35, metalness: 0.3 })

  function markMesh(player) {
    const group = new THREE.Group()
    if (player === HUMAN) {
      for (const angle of [Math.PI / 4, -Math.PI / 4]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.15, 0.15), xMaterial)
        bar.rotation.y = angle
        bar.position.y = 0.28
        group.add(bar)
      }
    } else {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.09, 16, 44), oMaterial)
      ring.rotation.x = -Math.PI / 2
      ring.position.y = 0.28
      group.add(ring)
    }
    return group
  }

  const pieces = new Map()
  const tweens = []

  function cellPosition(index) {
    const row = Math.floor(index / 3)
    const col = index % 3
    return new THREE.Vector3((col - 1) * CELL, 0, (row - 1) * CELL)
  }

  // Faint 1–9 sprites keep the keyboard mapping readable from any camera
  // angle; keys place marks in the same reading order.
  function digitSprite(value) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 96
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.font = '600 54px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#99a3b5'
      ctx.fillText(String(value), 48, 50)
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    }))
    sprite.scale.setScalar(0.34)
    return sprite
  }
  for (let index = 0; index < 9; index += 1) {
    const sprite = digitSprite(index + 1)
    const pos = cellPosition(index)
    sprite.position.set(pos.x - 0.4, 0.1, pos.z - 0.4)
    scene.add(sprite)
  }

  addPiece = (index, player) => {
    const mesh = markMesh(player)
    mesh.position.copy(cellPosition(index))
    mesh.position.y = 0.9
    mesh.scale.setScalar(0.01)
    scene.add(mesh)
    pieces.set(index, mesh)
    tweens.push({ mesh, start: performance.now(), duration: 340 })
  }

  clearPieces = () => {
    for (const mesh of pieces.values()) scene.remove(mesh)
    pieces.clear()
    tweens.length = 0
  }

  showWinLine = (line) => {
    const from = cellPosition(line[0]).setY(0.3)
    const to = cellPosition(line[2]).setY(0.3)
    const material = new THREE.MeshStandardMaterial({ color: 0x4ade80, emissive: 0x4ade80, emissiveIntensity: 0.9, roughness: 0.3 })
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, from.distanceTo(to) + 0.3, 12), material)
    beam.position.copy(from).add(to).multiplyScalar(0.5)
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize())
    scene.add(beam)
    tweens.winBeams ??= []
    tweens.winBeams.push(beam)
  }

  clearWinLine = () => {
    for (const beam of tweens.winBeams ?? []) scene.remove(beam)
    tweens.winBeams = []
  }

  // --- pointer interaction: hover + place (fixed camera, no orbit) --------------

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.11)
  const planeHit = new THREE.Vector3()

  // Picking intersects the board plane and reads the cell off x/z instead of
  // raycasting per-cell quads: flat pads become unhittable at grazing camera
  // angles, which reads as "the game won't take my move". The plane works from
  // any angle above the horizon, so a cell is always clickable.
  function cellUnderPointer(event) {
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    if (!raycaster.ray.intersectPlane(boardPlane, planeHit)) return -1
    const col = Math.round(planeHit.x / CELL) + 1
    const row = Math.round(planeHit.z / CELL) + 1
    if (col < 0 || col > 2 || row < 0 || row > 2) return -1
    return row * 3 + col
  }

  function showHover(index) {
    hover.visible = index >= 0 && state.board[index] === EMPTY && humanTurn()
    if (hover.visible) hover.position.copy(cellPosition(index)).setY(0.12)
  }

  renderer.domElement.addEventListener('pointermove', (event) => {
    showHover(cellUnderPointer(event))
  })

  renderer.domElement.addEventListener('pointerleave', () => {
    hover.visible = false
  })

  // Press previews the target cell (touch has no hover phase); release places
  // the mark. With the camera fixed there is no drag gesture to disambiguate, so
  // a plain click always lands on the cell under the pointer.
  renderer.domElement.addEventListener('pointerdown', (event) => {
    showHover(cellUnderPointer(event))
  })

  renderer.domElement.addEventListener('pointerup', (event) => {
    const index = cellUnderPointer(event)
    if (index >= 0) tryPlace(index)
  })

  // The camera is fixed, but a wheel over the board must not scroll the chrome.
  renderer.domElement.addEventListener('wheel', (event) => event.preventDefault(), { passive: false })

  function resize() {
    const { clientWidth, clientHeight } = boardEl
    if (clientWidth === 0 || clientHeight === 0) return
    renderer.setSize(clientWidth, clientHeight, false)
    camera.aspect = clientWidth / clientHeight
    camera.updateProjectionMatrix()
  }
  new ResizeObserver(resize).observe(boardEl)
  resize()

  renderer.setAnimationLoop(() => {
    const now = performance.now()
    for (let i = tweens.length - 1; i >= 0; i -= 1) {
      const tween = tweens[i]
      const t = Math.min(1, (now - tween.start) / tween.duration)
      const ease = 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2) // easeOutBack
      tween.mesh.scale.setScalar(0.01 + ease * 0.99)
      tween.mesh.position.y = 0.9 - ease * 0.62
      if (t >= 1) tweens.splice(i, 1)
    }
    const pulse = 0.75 + Math.sin(now * 0.005) * 0.25
    for (const beam of tweens.winBeams ?? []) beam.material.emissiveIntensity = pulse
    renderer.render(scene, camera)
  })
} else {
  fallbackEl.style.display = 'flex'
}

// --- game flow -----------------------------------------------------------------

const toastsEl = document.getElementById('toasts')

function toast(text, kind = 'info', ttl = 2200) {
  const node = document.createElement('div')
  node.className = kind === 'info' ? 'toast' : `toast ${kind}`
  node.textContent = text
  toastsEl.appendChild(node)
  while (toastsEl.children.length > 3) toastsEl.firstChild.remove()
  setTimeout(() => {
    node.classList.add('leaving')
    setTimeout(() => node.remove(), 260)
  }, ttl)
}

function newGameMessage() {
  return state.mode === '2p' ? 'New game — X to move' : 'New game — you are X'
}

function resetGame() {
  state.board = emptyBoard()
  state.turn = HUMAN
  state.finished = false
  state.busy = false
  clearPieces()
  clearWinLine()
  setStatus(turnLabel())
}

function place(index, player) {
  state.board = applyMove(state.board, index, player)
  addPiece(index, player)
}

function afterMove(player) {
  const outcome = outcomeOf(state.board)
  if (outcome.status !== 'playing') {
    state.finished = true
    state.busy = false
    if (outcome.status === 'won') {
      showWinLine(outcome.line)
      setStatus(state.mode === '2p' ? `${outcome.player} wins!` : outcome.player === HUMAN ? 'You win!' : 'AI wins — try again')
      if (state.mode === '2p') toast(`${outcome.player} wins!`, 'win', 3200)
      else if (outcome.player === HUMAN) toast('You win!', 'win', 3200)
      else toast('AI wins — try again', 'loss', 3200)
    } else {
      setStatus('Draw — the board is full')
      toast('Draw — the board is full', 'info', 3200)
    }
    // Scoreboard is X-perspective in both modes; see showScores().
    void recordOutcome(outcome.status === 'draw' ? 'draw' : outcome.player === HUMAN ? 'win' : 'loss')
    return
  }
  state.turn = opponentOf(player)
  setStatus(turnLabel())
  if (state.mode === 'ai' && state.turn === AI) {
    state.busy = true
    setTimeout(() => {
      const move = state.difficulty === 'hard' ? bestMove(state.board, AI) : easyMove(state.board, AI)
      state.busy = false
      if (move >= 0 && !state.finished) {
        place(move, AI)
        afterMove(AI)
      }
    }, 320)
  }
}

function tryPlace(index) {
  if (state.board[index] !== EMPTY || !humanTurn()) return
  place(index, state.turn)
  afterMove(state.turn)
}

// --- Scoreboard over the bridge ----------------------------------------------

function showScores(stats) {
  if (!stats || typeof stats !== 'object') {
    for (const el of [els.wins, els.losses, els.draws, els.streak]) el.textContent = '—'
    els.resetScores.disabled = true
    return
  }
  els.wins.textContent = String(stats.wins)
  els.losses.textContent = String(stats.losses)
  els.draws.textContent = String(stats.draws)
  els.streak.textContent = String(stats.streak)
  els.resetScores.disabled = false
}

async function loadScores() {
  const result = await bridge.invoke({ action: 'get' })
  showScores(result.ok ? result.value : null)
  if (!result.ok) toast("Scoreboard unavailable — scores won't persist", 'info', 3000)
}

async function recordOutcome(outcome) {
  const result = await bridge.invoke({ action: 'record', outcome })
  showScores(result.ok ? result.value : null)
}

// --- controls --------------------------------------------------------------------

els.newGame.addEventListener('click', () => {
  resetGame()
  toast(newGameMessage())
})
els.modeAi.addEventListener('click', () => {
  state.mode = 'ai'
  refreshModeButtons()
  resetGame()
  toast('VS AI mode')
})
els.mode2p.addEventListener('click', () => {
  state.mode = '2p'
  refreshModeButtons()
  resetGame()
  toast('Two-player mode')
})
els.diffHard.addEventListener('click', () => {
  state.difficulty = 'hard'
  refreshModeButtons()
  toast('AI difficulty: Hard')
})
els.diffEasy.addEventListener('click', () => {
  state.difficulty = 'easy'
  refreshModeButtons()
  toast('AI difficulty: Easy')
})
els.resetScores.addEventListener('click', async () => {
  els.resetScores.disabled = true
  const result = await bridge.invoke({ action: 'reset' })
  showScores(result.ok ? result.value : null)
  toast(result.ok ? 'Scoreboard cleared' : 'Scoreboard unavailable')
})

// Keys 1–9 place a mark in reading order, matching game-core's indexing.
window.addEventListener('keydown', (event) => {
  const index = Number(event.key) - 1
  if (Number.isInteger(index) && index >= 0 && index <= 8) tryPlace(index)
})

refreshModeButtons()
setStatus(turnLabel())
toast(newGameMessage())
// The handshake lands asynchronously; only fetch the scoreboard once the
// bridge is actually connected, or the first read would always miss.
bridge.whenConnected(() => {
  void loadScores()
})
