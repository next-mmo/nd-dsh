/**
 * ND Video Gen — package-shipped 9:16 3D vertical video studio.
 *
 * Runs inside ND's sandboxed iframe: opaque/token origin, no Node, no network,
 * no external fonts or assets. Renders a Three.js kinetic orb scene into an
 * offscreen 720x1280 WebGL canvas, composites WebGL + burned-in Hook/CTA
 * typography onto a single 720x1280 2D canvas, and records that composite
 * canvas via captureStream(30) + MediaRecorder for local Blob download.
 */
import * as THREE from './vendor/three.module.js'
import { connectStudio } from './bridge.js'
import {
  DEFAULT_CTA_TEXT,
  DEFAULT_DURATION_SECONDS,
  DEFAULT_HOOK_TEXT,
  EXPORT_BITRATE,
  EXPORT_FPS,
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  MAX_CTA_CHARS,
  MAX_HOOK_CHARS,
  buildExportFilename,
  clampDurationSeconds,
  computeChoreography,
  normalizeOverlayText,
  pickSupportedVideoMimeType,
  wrapCanvasLines,
} from './studio-core.js'

const PALETTES = {
  neon: ['#22d3ee', '#a855f7', '#fb923c'],
  sunset: ['#ffc45b', '#fb7185', '#f472b6'],
  aurora: ['#5eead4', '#60a5fa', '#c4b5fd'],
}

// --- DOM refs ----------------------------------------------------------------

const compositeCanvas = document.getElementById('composite-canvas')
const compositeCtx = compositeCanvas.getContext('2d', { alpha: false })
const fallbackEl = document.getElementById('webgl-fallback')
const modelSelect = document.getElementById('model-select')
const paletteSelect = document.getElementById('palette-select')
const refreshModelsBtn = document.getElementById('refresh-models')
const briefInput = document.getElementById('brief-input')
const generateBtn = document.getElementById('generate-scene')
const generationStatus = document.getElementById('generation-status')
const hookInput = document.getElementById('hook-input')
const ctaInput = document.getElementById('cta-input')
const hookCount = document.getElementById('hook-count')
const ctaCount = document.getElementById('cta-count')
const codecLabel = document.getElementById('codec-label')
const durationBtns = Array.from(document.querySelectorAll('.duration-btn'))
const playPauseBtn = document.getElementById('play-pause')
const replayBtn = document.getElementById('replay')
const timecodeEl = document.getElementById('timecode')
const previewBarEl = document.getElementById('preview-bar')
const renderBtn = document.getElementById('render-btn')
const cancelBtn = document.getElementById('cancel-btn')
const saveBtn = document.getElementById('save-btn')
const renderPctEl = document.getElementById('render-pct')
const renderBarEl = document.getElementById('render-bar')
const statusEl = document.getElementById('status')

// --- Studio state ------------------------------------------------------------

const state = {
  hook: DEFAULT_HOOK_TEXT,
  cta: DEFAULT_CTA_TEXT,
  palette: 'neon',
  durationSeconds: DEFAULT_DURATION_SECONDS,
  playing: true,
  elapsedSeconds: 0,
  rendering: false,
  contextLost: false,
  exportBlobUrl: null,
  exportFilename: buildExportFilename(DEFAULT_HOOK_TEXT),
  exportBytes: 0,
  exportMime: '',
  exportStale: false,
}

let previewRaf = 0
let lastTickMs = 0
let activeExport = null
let modelOptions = new Map()
let loadingModels = false
let generating = false
let bridgeReady = false

function setStatus(message, tone = 'muted') {
  statusEl.textContent = message
  statusEl.className = tone === 'ok' ? 'status ok' : tone === 'error' ? 'status error' : 'status'
}

function revokeExportUrl() {
  if (state.exportBlobUrl) {
    URL.revokeObjectURL(state.exportBlobUrl)
    state.exportBlobUrl = null
  }
  state.exportBytes = 0
  state.exportMime = ''
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function probeEncoderSupport() {
  if (typeof MediaRecorder === 'undefined') {
    return { supported: false, mimeType: null, reason: 'MediaRecorder is unavailable in this runtime.' }
  }
  if (typeof compositeCanvas.captureStream !== 'function') {
    return { supported: false, mimeType: null, reason: 'Canvas captureStream() is unavailable in this runtime.' }
  }
  const mimeType = pickSupportedVideoMimeType((type) => MediaRecorder.isTypeSupported(type))
  if (!mimeType) {
    return { supported: false, mimeType: null, reason: 'No supported WebM video codec (VP9/VP8) found.' }
  }
  return { supported: true, mimeType, reason: '' }
}

const encoderProbe = probeEncoderSupport()
codecLabel.textContent = encoderProbe.mimeType?.includes('vp9')
  ? 'WebM · VP9'
  : encoderProbe.mimeType?.includes('vp8')
    ? 'WebM · VP8'
    : encoderProbe.supported
      ? 'WebM'
      : 'Unavailable'

// --- Three.js offscreen 720x1280 WebGL studio --------------------------------

const glCanvas = document.createElement('canvas')
glCanvas.width = EXPORT_WIDTH
glCanvas.height = EXPORT_HEIGHT

function createStudioRenderer() {
  try {
    const renderer = new THREE.WebGLRenderer({
      canvas: glCanvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    })
    if (!renderer.getContext()) {
      renderer.dispose()
      return null
    }
    renderer.setPixelRatio(1)
    renderer.setSize(EXPORT_WIDTH, EXPORT_HEIGHT, false)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.18
    renderer.outputColorSpace = THREE.SRGBColorSpace
    return renderer
  } catch {
    return null
  }
}

const renderer = createStudioRenderer()
let studioScene = null

function createParticleTexture() {
  const texCanvas = document.createElement('canvas')
  texCanvas.width = 64
  texCanvas.height = 64
  const c = texCanvas.getContext('2d')
  const grad = c.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)')
  grad.addColorStop(0.35, 'rgba(186, 230, 253, 0.8)')
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
  c.fillStyle = grad
  c.fillRect(0, 0, 64, 64)
  const texture = new THREE.CanvasTexture(texCanvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function buildStudioScene() {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x07090f)
  scene.fog = new THREE.FogExp2(0x07090f, 0.068)

  const camera = new THREE.PerspectiveCamera(42, EXPORT_WIDTH / EXPORT_HEIGHT, 0.1, 60)
  const target = new THREE.Vector3(0, 0.06, 0)

  const hemi = new THREE.HemisphereLight(0xdbeafe, 0x090b12, 0.85)
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.2)
  keyLight.position.set(3.8, 5.5, 4.2)

  const cyanLight = new THREE.PointLight(0x22d3ee, 24, 18, 1.5)
  cyanLight.position.set(-3.4, 2.0, 2.8)

  const violetLight = new THREE.PointLight(0xa855f7, 26, 18, 1.5)
  violetLight.position.set(3.2, -1.8, -2.5)

  const coralLight = new THREE.PointLight(0xf97316, 14, 14, 1.6)
  coralLight.position.set(0.2, 3.6, -3.6)

  scene.add(hemi, keyLight, cyanLight, violetLight, coralLight)

  // Hero Kinetic Orb Assembly
  const heroGroup = new THREE.Group()
  heroGroup.position.set(0, 0.08, 0)
  scene.add(heroGroup)

  const coreGeo = new THREE.IcosahedronGeometry(0.92, 2)
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0x161b2e,
    roughness: 0.18,
    metalness: 0.88,
    emissive: 0x0e7490,
    emissiveIntensity: 0.35,
    flatShading: true,
  })
  const coreMesh = new THREE.Mesh(coreGeo, coreMat)
  heroGroup.add(coreMesh)

  const innerGeo = new THREE.SphereGeometry(0.62, 32, 32)
  const innerMat = new THREE.MeshStandardMaterial({
    color: 0x22d3ee,
    emissive: 0x38bdf8,
    emissiveIntensity: 0.9,
    roughness: 0.25,
    metalness: 0.2,
  })
  const innerMesh = new THREE.Mesh(innerGeo, innerMat)
  heroGroup.add(innerMesh)

  const cageGeo = new THREE.IcosahedronGeometry(1.18, 1)
  const cageMat = new THREE.MeshStandardMaterial({
    color: 0xc084fc,
    emissive: 0x9333ea,
    emissiveIntensity: 0.55,
    wireframe: true,
    transparent: true,
    opacity: 0.48,
  })
  const cageMesh = new THREE.Mesh(cageGeo, cageMat)
  heroGroup.add(cageMesh)

  // Orbital anodized rings
  const ring1Geo = new THREE.TorusGeometry(1.52, 0.032, 20, 120)
  const ring1Mat = new THREE.MeshStandardMaterial({
    color: 0x22d3ee,
    emissive: 0x06b6d4,
    emissiveIntensity: 0.95,
    roughness: 0.22,
    metalness: 0.8,
  })
  const ring1 = new THREE.Mesh(ring1Geo, ring1Mat)
  ring1.rotation.set(Math.PI * 0.36, 0.24, 0)
  heroGroup.add(ring1)

  const ring2Geo = new THREE.TorusGeometry(1.86, 0.022, 16, 120)
  const ring2Mat = new THREE.MeshStandardMaterial({
    color: 0xfb923c,
    emissive: 0xf97316,
    emissiveIntensity: 0.75,
    roughness: 0.28,
    metalness: 0.75,
  })
  const ring2 = new THREE.Mesh(ring2Geo, ring2Mat)
  ring2.rotation.set(-Math.PI * 0.28, -0.42, 0.3)
  heroGroup.add(ring2)

  // Orbiting geometric prism satellites
  const shardGeo = new THREE.OctahedronGeometry(0.11, 0)
  const shardMat = new THREE.MeshStandardMaterial({
    color: 0xf8fafc,
    emissive: 0x38bdf8,
    emissiveIntensity: 0.7,
    roughness: 0.15,
    metalness: 0.9,
  })
  const shards = []
  const shardCount = 6
  for (let i = 0; i < shardCount; i += 1) {
    const mesh = new THREE.Mesh(shardGeo, shardMat)
    heroGroup.add(mesh)
    shards.push({
      mesh,
      phase: (i / shardCount) * Math.PI * 2,
      radius: 2.05 + (i % 2) * 0.24,
      yAmp: 0.55 + (i % 3) * 0.18,
    })
  }

  // Subtle architectural studio pedestal disc below the orb
  const stageGeo = new THREE.RingGeometry(1.25, 2.55, 64)
  const stageMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.5,
    metalness: 0.65,
    transparent: true,
    opacity: 0.28,
    side: THREE.DoubleSide,
  })
  const stageRing = new THREE.Mesh(stageGeo, stageMat)
  stageRing.rotation.x = -Math.PI / 2
  stageRing.position.y = -1.78
  scene.add(stageRing)

  // Procedural star/studio dust field (deterministic LCG so frames stay crisp)
  const particleCount = 140
  const positions = new Float32Array(particleCount * 3)
  let seed = 42197
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  for (let i = 0; i < particleCount; i += 1) {
    const angle = rand() * Math.PI * 2
    const radius = 2.6 + rand() * 5.2
    positions[i * 3] = Math.cos(angle) * radius
    positions[i * 3 + 1] = (rand() - 0.5) * 7.5
    positions[i * 3 + 2] = Math.sin(angle) * radius - 1.2
  }
  const particleGeo = new THREE.BufferGeometry()
  particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const particleTex = createParticleTexture()
  const particleMat = new THREE.PointsMaterial({
    color: 0x93c5fd,
    map: particleTex,
    size: 0.11,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const particles = new THREE.Points(particleGeo, particleMat)
  scene.add(particles)

  const geometries = [coreGeo, innerGeo, cageGeo, ring1Geo, ring2Geo, shardGeo, stageGeo, particleGeo]
  const materials = [coreMat, innerMat, cageMat, ring1Mat, ring2Mat, shardMat, stageMat, particleMat]
  const textures = [particleTex]

  return {
    scene,
    camera,
    target,
    heroGroup,
    coreMesh,
    coreMat,
    innerMesh,
    cageMesh,
    ring1,
    ring2,
    shards,
    particles,
    cyanLight,
    violetLight,
    applyPalette([primary, secondary, accent]) {
      cyanLight.color.set(primary)
      violetLight.color.set(secondary)
      coralLight.color.set(accent)
      coreMat.emissive.set(primary)
      innerMat.color.set(primary)
      innerMat.emissive.set(primary)
      cageMat.color.set(secondary)
      cageMat.emissive.set(secondary)
      ring1Mat.color.set(primary)
      ring1Mat.emissive.set(primary)
      ring2Mat.color.set(accent)
      ring2Mat.emissive.set(accent)
      shardMat.emissive.set(primary)
      particleMat.color.set(secondary)
    },
    dispose() {
      for (const geo of geometries) geo.dispose()
      for (const mat of materials) mat.dispose()
      for (const tex of textures) tex.dispose()
    },
  }
}

if (renderer) {
  studioScene = buildStudioScene()
}

// --- 2D Composite Burn-in Renderer ------------------------------------------

function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

function drawEditorialOverlay(choreo) {
  const [primary, secondary, accent] = PALETTES[state.palette]
  const ctx = compositeCtx
  const W = EXPORT_WIDTH
  const H = EXPORT_HEIGHT

  // Top and bottom editorial scrims for guaranteed legibility over glowing 3D accents
  const topScrim = ctx.createLinearGradient(0, 0, 0, 440)
  topScrim.addColorStop(0, 'rgba(6, 8, 14, 0.84)')
  topScrim.addColorStop(0.55, 'rgba(6, 8, 14, 0.36)')
  topScrim.addColorStop(1, 'rgba(6, 8, 14, 0)')
  ctx.fillStyle = topScrim
  ctx.fillRect(0, 0, W, 440)

  const bottomScrim = ctx.createLinearGradient(0, H - 360, 0, H)
  bottomScrim.addColorStop(0, 'rgba(6, 8, 14, 0)')
  bottomScrim.addColorStop(0.45, 'rgba(6, 8, 14, 0.44)')
  bottomScrim.addColorStop(1, 'rgba(6, 8, 14, 0.88)')
  ctx.fillStyle = bottomScrim
  ctx.fillRect(0, H - 360, W, 360)

  // Subtle corner viewfinder ticks
  ctx.save()
  ctx.strokeStyle = 'rgba(226, 232, 240, 0.22)'
  ctx.lineWidth = 2
  const pad = 28
  const tick = 18
  const corners = [
    [pad, pad, 1, 1],
    [W - pad, pad, -1, 1],
    [pad, H - pad, 1, -1],
    [W - pad, H - pad, -1, -1],
  ]
  for (const [cx, cy, sx, sy] of corners) {
    ctx.beginPath()
    ctx.moveTo(cx + sx * tick, cy)
    ctx.lineTo(cx, cy)
    ctx.lineTo(cx, cy + sy * tick)
    ctx.stroke()
  }
  ctx.restore()

  // Top eyebrow studio tag
  ctx.save()
  ctx.globalAlpha = 0.9 * choreo.hookOpacity
  drawRoundedRect(ctx, 52, 64, 188, 34, 17)
  ctx.fillStyle = 'rgba(15, 23, 42, 0.72)'
  ctx.fill()
  ctx.strokeStyle = primary + '73'
  ctx.lineWidth = 1.5
  ctx.stroke()

  ctx.fillStyle = primary
  ctx.beginPath()
  ctx.arc(72, 81, 4.5, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#e2e8f0'
  ctx.font = '700 13px system-ui, -apple-system, "Segoe UI", sans-serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText('ND STUDIO · 01', 86, 82)
  ctx.restore()

  // Burned-in Hook Headline (upper third)
  const hookText = state.hook.trim()
  if (hookText) {
    ctx.save()
    ctx.globalAlpha = choreo.hookOpacity
    ctx.translate(0, choreo.hookOffsetY)
    ctx.font = '800 50px system-ui, -apple-system, "Segoe UI", sans-serif'
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    const lines = wrapCanvasLines(ctx, hookText, W - 104, 3)
    const lineHeight = 60
    const startY = 122

    ctx.shadowColor = 'rgba(0, 0, 0, 0.65)'
    ctx.shadowBlur = 18
    ctx.shadowOffsetY = 4
    ctx.fillStyle = '#f8fafc'

    for (let i = 0; i < lines.length; i += 1) {
      ctx.fillText(lines[i], 52, startY + i * lineHeight)
    }

    // Vivid animated accent rule beneath the hook
    const ruleY = startY + lines.length * lineHeight + 16
    const ruleWidth = Math.max(48, 176 * choreo.accentSweep)
    const ruleGrad = ctx.createLinearGradient(52, ruleY, 52 + ruleWidth, ruleY)
    ruleGrad.addColorStop(0, primary)
    ruleGrad.addColorStop(0.55, secondary)
    ruleGrad.addColorStop(1, accent)
    ctx.shadowBlur = 0
    ctx.fillStyle = ruleGrad
    drawRoundedRect(ctx, 52, ruleY, ruleWidth, 5, 2.5)
    ctx.fill()
    ctx.restore()
  }

  // Burned-in Call-To-Action Capsule (lower third)
  const ctaText = state.cta.trim()
  if (ctaText) {
    ctx.save()
    ctx.globalAlpha = choreo.ctaOpacity
    ctx.translate(0, choreo.ctaOffsetY)
    ctx.font = '700 26px system-ui, -apple-system, "Segoe UI", sans-serif'
    const lines = wrapCanvasLines(ctx, ctaText, W - 168, 1)
    const label = lines[0] || ''
    const textWidth = ctx.measureText(label).width
    const pillWidth = Math.min(W - 96, Math.max(220, textWidth + 92))
    const pillHeight = 66
    const pillX = (W - pillWidth) / 2
    const pillY = H - 178

    // Soft glow behind capsule
    ctx.shadowColor = primary + '57'
    ctx.shadowBlur = 24
    ctx.shadowOffsetY = 6
    drawRoundedRect(ctx, pillX, pillY, pillWidth, pillHeight, 33)
    ctx.fillStyle = 'rgba(13, 18, 30, 0.88)'
    ctx.fill()

    // Gradient stroke border
    ctx.shadowBlur = 0
    const borderGrad = ctx.createLinearGradient(pillX, pillY, pillX + pillWidth, pillY + pillHeight)
    borderGrad.addColorStop(0, primary)
    borderGrad.addColorStop(0.5, secondary)
    borderGrad.addColorStop(1, accent)
    ctx.strokeStyle = borderGrad
    ctx.lineWidth = 2.5
    ctx.stroke()

    ctx.fillStyle = '#f8fafc'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.fillText(label, W / 2, pillY + pillHeight / 2 + 1)
    ctx.restore()
  }

  // Editorial timeline hairline along bottom edge
  ctx.save()
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)'
  ctx.fillRect(52, H - 56, W - 104, 4)
  const progGrad = ctx.createLinearGradient(52, 0, W - 52, 0)
  progGrad.addColorStop(0, primary)
  progGrad.addColorStop(1, secondary)
  ctx.fillStyle = progGrad
  ctx.fillRect(52, H - 56, (W - 104) * choreo.t, 4)
  ctx.restore()
}

function renderCompositeFrame(elapsedSeconds) {
  if (!renderer || !studioScene || state.contextLost) return
  const progress = state.durationSeconds > 0 ? elapsedSeconds / state.durationSeconds : 0
  const choreo = computeChoreography(progress)

  const {
    scene,
    camera,
    target,
    heroGroup,
    coreMesh,
    coreMat,
    innerMesh,
    cageMesh,
    ring1,
    ring2,
    shards,
    particles,
    cyanLight,
    violetLight,
  } = studioScene

  camera.position.set(
    Math.sin(choreo.orbitAngle) * choreo.cameraRadius,
    choreo.cameraY,
    Math.cos(choreo.orbitAngle) * choreo.cameraRadius,
  )
  camera.lookAt(target)

  heroGroup.scale.setScalar(choreo.orbScale)
  coreMesh.rotation.set(choreo.orbSpinX, choreo.orbSpinY, choreo.orbSpinX * 0.5)
  coreMat.emissiveIntensity = 0.28 + choreo.pulse * 0.35
  innerMesh.scale.setScalar(0.94 + choreo.pulse * 0.14)
  cageMesh.rotation.set(-choreo.orbSpinX * 1.2, -choreo.orbSpinY * 0.65, 0.2)

  ring1.rotation.z = choreo.t * Math.PI * 2
  ring1.rotation.y = 0.24 + Math.sin(choreo.t * Math.PI * 2) * 0.35
  ring2.rotation.z = -choreo.t * Math.PI * 1.5
  ring2.rotation.x = -Math.PI * 0.28 + Math.cos(choreo.t * Math.PI * 2) * 0.25

  for (const shard of shards) {
    const a = shard.phase + choreo.t * Math.PI * 2
    shard.mesh.position.set(
      Math.cos(a) * shard.radius,
      Math.sin(a * 2) * shard.yAmp,
      Math.sin(a) * shard.radius,
    )
    shard.mesh.rotation.set(a, a * 1.5, 0)
  }

  particles.rotation.y = choreo.t * 0.45
  cyanLight.intensity = 20 + choreo.pulse * 12
  violetLight.intensity = 22 + (1 - choreo.pulse) * 12

  renderer.render(scene, camera)

  // Draw the WebGL frame + burned-in text overlays onto the single 720x1280 composite canvas
  compositeCtx.drawImage(glCanvas, 0, 0, EXPORT_WIDTH, EXPORT_HEIGHT)
  drawEditorialOverlay(choreo)
}

function updatePlaybackReadout() {
  const dur = state.durationSeconds
  const t = Math.max(0, Math.min(dur, state.elapsedSeconds))
  timecodeEl.textContent = `${t.toFixed(1)}s / ${dur.toFixed(1)}s`
  const pct = dur > 0 ? (t / dur) * 100 : 0
  previewBarEl.style.width = `${pct.toFixed(1)}%`
}

function syncUiControls() {
  const usable = Boolean(renderer && studioScene) && !state.contextLost
  const locked = state.rendering || !usable
  const editingLocked = locked || generating
  modelSelect.disabled = !bridgeReady || generating || loadingModels || state.rendering || !modelOptions.size
  refreshModelsBtn.disabled = !bridgeReady || generating || loadingModels || state.rendering
  briefInput.disabled = generating || state.rendering
  generateBtn.disabled = editingLocked || loadingModels || !modelOptions.has(modelSelect.value) || !briefInput.value.trim()
  paletteSelect.disabled = editingLocked

  hookInput.disabled = editingLocked
  ctaInput.disabled = editingLocked
  for (const btn of durationBtns) {
    const dur = Number(btn.dataset.duration)
    btn.disabled = locked
    btn.classList.toggle('on', dur === state.durationSeconds)
  }

  playPauseBtn.disabled = locked
  playPauseBtn.textContent = state.playing ? 'Pause' : 'Play'
  playPauseBtn.classList.toggle('on', state.playing)
  replayBtn.disabled = locked

  renderBtn.disabled = editingLocked || !encoderProbe.supported
  cancelBtn.hidden = !state.rendering
  cancelBtn.disabled = !state.rendering
  const canSave = Boolean(!state.rendering && state.exportBlobUrl && !state.exportStale)
  saveBtn.disabled = !canSave
  saveBtn.classList.toggle('save-ready', canSave)

  hookCount.textContent = `${state.hook.length}/${MAX_HOOK_CHARS}`
  ctaCount.textContent = `${state.cta.length}/${MAX_CTA_CHARS}`
}

// --- Preview Animation Loop (bounded: stops when paused/hidden/zero-sized) --

function stopPreviewLoop() {
  if (previewRaf) {
    cancelAnimationFrame(previewRaf)
    previewRaf = 0
  }
  lastTickMs = 0
}

function renderStaticFrame() {
  renderCompositeFrame(state.elapsedSeconds)
  updatePlaybackReadout()
}

function shouldRunPreviewLoop() {
  return Boolean(
    renderer
    && studioScene
    && !state.contextLost
    && state.playing
    && !state.rendering
    && !document.hidden
    && compositeCanvas.clientWidth > 0
    && compositeCanvas.clientHeight > 0,
  )
}

function schedulePreviewLoop() {
  if (previewRaf || !shouldRunPreviewLoop()) return
  lastTickMs = performance.now()
  previewRaf = requestAnimationFrame(previewTick)
}

function previewTick(now) {
  previewRaf = 0
  if (!shouldRunPreviewLoop()) {
    lastTickMs = 0
    return
  }
  const dt = Math.min(0.1, Math.max(0, (now - lastTickMs) / 1000))
  lastTickMs = now
  state.elapsedSeconds = (state.elapsedSeconds + dt) % state.durationSeconds
  renderCompositeFrame(state.elapsedSeconds)
  updatePlaybackReadout()
  schedulePreviewLoop()
}

// --- Export (single composite canvas -> captureStream(30) -> MediaRecorder) ---

function cleanupActiveExport(discard = false) {
  if (!activeExport) return
  const job = activeExport
  activeExport = null
  job.cancelled = discard
  if (job.rafId) cancelAnimationFrame(job.rafId)
  if (job.finishTimer) clearTimeout(job.finishTimer)
  if (job.recorder && job.recorder.state !== 'inactive') {
    try { job.recorder.stop() } catch { /* ignore */ }
  }
  if (job.stream) {
    for (const track of job.stream.getTracks()) {
      try { track.stop() } catch { /* ignore */ }
    }
  }
}

function finishExportUi(statusText, tone = 'muted') {
  state.rendering = false
  renderPctEl.textContent = tone === 'ok' ? 'Complete' : 'Idle'
  if (tone !== 'ok') renderBarEl.style.width = '0%'
  setStatus(statusText, tone)
  syncUiControls()
  if (state.playing) schedulePreviewLoop()
  else renderStaticFrame()
}

function startVideoRender() {
  if (state.rendering || !renderer || !studioScene || state.contextLost) return
  if (!encoderProbe.supported || !encoderProbe.mimeType) {
    setStatus(encoderProbe.reason || 'Video export is unavailable on this device.', 'error')
    return
  }

  stopPreviewLoop()
  revokeExportUrl()
  state.exportStale = false
  state.rendering = true
  state.elapsedSeconds = 0
  renderBarEl.style.width = '0%'
  renderPctEl.textContent = '0%'
  setStatus(`Rendering ${state.durationSeconds}s 720×1280 WebM at ${EXPORT_FPS} FPS…`)
  syncUiControls()

  // Draw deterministic frame 0 before captureStream starts
  renderCompositeFrame(0)
  updatePlaybackReadout()

  let stream = null
  let recorder = null
  try {
    stream = compositeCanvas.captureStream(EXPORT_FPS)
    recorder = new MediaRecorder(stream, {
      mimeType: encoderProbe.mimeType,
      videoBitsPerSecond: EXPORT_BITRATE,
    })
  } catch (cause) {
    if (stream) for (const track of stream.getTracks()) track.stop()
    const message = cause instanceof Error ? cause.message : String(cause)
    finishExportUi(`Could not start video recorder: ${message}`, 'error')
    return
  }

  const chunks = []
  const job = {
    stream,
    recorder,
    rafId: 0,
    finishTimer: 0,
    cancelled: false,
    startedMs: performance.now(),
  }
  activeExport = job

  recorder.ondataavailable = (event) => {
    if (!job.cancelled && event.data && event.data.size > 0) {
      chunks.push(event.data)
    }
  }

  recorder.onerror = () => {
    if (job.cancelled) return
    cleanupActiveExport(true)
    finishExportUi('Video encoder failed during export.', 'error')
  }

  recorder.onstop = () => {
    for (const track of stream.getTracks()) {
      try { track.stop() } catch { /* ignore */ }
    }
    if (job.cancelled) return
    activeExport = null
    if (chunks.length === 0) {
      finishExportUi('Export produced no video frames. Try again with the window visible.', 'error')
      return
    }
    const mime = recorder.mimeType || encoderProbe.mimeType || 'video/webm'
    const blob = new Blob(chunks, { type: mime })
    if (blob.size === 0) {
      finishExportUi('Export produced an empty video file.', 'error')
      return
    }
    revokeExportUrl()
    state.exportBlobUrl = URL.createObjectURL(blob)
    state.exportFilename = buildExportFilename(state.hook)
    state.exportBytes = blob.size
    state.exportMime = mime
    state.exportStale = false
    renderBarEl.style.width = '100%'
    finishExportUi(`Ready to save: ${state.exportFilename} (${formatBytes(blob.size)})`, 'ok')
  }

  try {
    recorder.start(250)
  } catch (cause) {
    cleanupActiveExport(true)
    const message = cause instanceof Error ? cause.message : String(cause)
    finishExportUi(`Could not start MediaRecorder: ${message}`, 'error')
    return
  }

  const durationMs = state.durationSeconds * 1000
  const step = (now) => {
    if (job.cancelled || activeExport !== job) return
    const elapsedMs = Math.max(0, now - job.startedMs)
    const clampedSeconds = Math.min(state.durationSeconds, elapsedMs / 1000)
    state.elapsedSeconds = clampedSeconds
    renderCompositeFrame(clampedSeconds)
    updatePlaybackReadout()

    const pct = Math.min(99, Math.floor((elapsedMs / durationMs) * 100))
    renderBarEl.style.width = `${pct}%`
    renderPctEl.textContent = `${pct}%`

    if (elapsedMs < durationMs) {
      job.rafId = requestAnimationFrame(step)
      return
    }

    // Hold final frame briefly so captureStream flushes it before recorder.stop()
    renderCompositeFrame(state.durationSeconds)
    renderBarEl.style.width = '100%'
    renderPctEl.textContent = 'Finalizing…'
    job.finishTimer = setTimeout(() => {
      if (job.cancelled || activeExport !== job) return
      if (recorder.state !== 'inactive') {
        try { recorder.stop() } catch { /* ignore */ }
      }
    }, 80)
  }

  job.rafId = requestAnimationFrame(step)
}

function cancelVideoRender() {
  if (!state.rendering) return
  cleanupActiveExport(true)
  finishExportUi('Render cancelled.', 'muted')
}

function saveRenderedVideo() {
  if (state.rendering || !state.exportBlobUrl || state.exportStale) return
  const link = document.createElement('a')
  link.href = state.exportBlobUrl
  link.download = state.exportFilename
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setStatus(`Download started: ${state.exportFilename} (${formatBytes(state.exportBytes)})`, 'ok')
}

// --- Event Listeners & Lifecycle ---------------------------------------------

function markEdited() {
  if (state.exportBlobUrl) {
    state.exportStale = true
    renderPctEl.textContent = 'Stale'
    renderBarEl.style.width = '0%'
    setStatus('Scene settings changed. Render again to include your edits.')
  }
  syncUiControls()
  if (!state.playing && !state.rendering) renderStaticFrame()
}

function setPalette(palette) {
  state.palette = palette
  paletteSelect.value = palette
  studioScene?.applyPalette(PALETTES[palette])
}

function setGenerationStatus(message, failed = false) {
  generationStatus.textContent = message
  generationStatus.classList.toggle('error', failed)
}

async function loadModels() {
  loadingModels = true
  syncUiControls()
  setGenerationStatus('Loading text models…')
  try {
    const entries = await invoke('models')
    const chosen = modelSelect.value
    modelOptions = new Map(entries.map((entry) => [JSON.stringify([entry.providerId, entry.model]), entry]))
    modelSelect.replaceChildren(new Option('Choose a model', ''))
    for (const [key, entry] of modelOptions) {
      modelSelect.add(new Option(`${entry.providerName} / ${entry.model}`, key))
    }
    modelSelect.value = modelOptions.has(chosen) ? chosen : ''
    setGenerationStatus(modelOptions.size
      ? 'Generate sends your brief to the selected model.'
      : 'Add a text API model in ND Router, then refresh.')
  } catch (error) {
    modelOptions.clear()
    modelSelect.replaceChildren(new Option('Choose a model', ''))
    setGenerationStatus(error.message, true)
  } finally {
    loadingModels = false
    syncUiControls()
  }
}

async function generateScene() {
  const brief = briefInput.value.trim()
  const selected = modelOptions.get(modelSelect.value)
  if (!brief || !selected || generateBtn.disabled) return
  generating = true
  syncUiControls()
  setGenerationStatus(`Generating with ${selected.providerName} / ${selected.model}…`)
  try {
    const { providerId, model } = selected
    const scene = await invoke('generate', { brief, providerId, model }, 70_000)
    if (scene.hook !== state.hook || scene.cta !== state.cta || scene.palette !== state.palette) {
      state.hook = scene.hook
      state.cta = scene.cta
      hookInput.value = state.hook
      ctaInput.value = state.cta
      setPalette(scene.palette)
      markEdited()
    }
    setGenerationStatus(`Scene settings generated with ${selected.providerName} / ${selected.model}.`)
  } catch (error) {
    setGenerationStatus(error.message, true)
  } finally {
    generating = false
    syncUiControls()
  }
}

hookInput.value = state.hook
ctaInput.value = state.cta
modelSelect.addEventListener('change', syncUiControls)
briefInput.addEventListener('input', syncUiControls)
refreshModelsBtn.addEventListener('click', loadModels)
generateBtn.addEventListener('click', generateScene)
paletteSelect.addEventListener('change', () => {
  if (paletteSelect.value === state.palette) return
  setPalette(paletteSelect.value)
  markEdited()
})

hookInput.addEventListener('input', () => {
  const nextHook = normalizeOverlayText(hookInput.value, '', MAX_HOOK_CHARS)
  if (hookInput.value !== nextHook) hookInput.value = nextHook
  if (nextHook === state.hook) return
  state.hook = nextHook
  markEdited()
})

ctaInput.addEventListener('input', () => {
  const nextCta = normalizeOverlayText(ctaInput.value, '', MAX_CTA_CHARS)
  if (ctaInput.value !== nextCta) ctaInput.value = nextCta
  if (nextCta === state.cta) return
  state.cta = nextCta
  markEdited()
})

for (const btn of durationBtns) {
  btn.addEventListener('click', () => {
    if (state.rendering) return
    const nextDuration = clampDurationSeconds(btn.dataset.duration)
    if (nextDuration === state.durationSeconds) return
    state.durationSeconds = nextDuration
    state.elapsedSeconds = 0
    updatePlaybackReadout()
    markEdited()
  })
}

playPauseBtn.addEventListener('click', () => {
  if (state.rendering || !renderer || state.contextLost) return
  state.playing = !state.playing
  syncUiControls()
  if (state.playing) schedulePreviewLoop()
  else stopPreviewLoop()
})

replayBtn.addEventListener('click', () => {
  if (state.rendering || !renderer || state.contextLost) return
  state.elapsedSeconds = 0
  state.playing = true
  renderStaticFrame()
  syncUiControls()
  schedulePreviewLoop()
})

renderBtn.addEventListener('click', () => startVideoRender())
cancelBtn.addEventListener('click', () => cancelVideoRender())
saveBtn.addEventListener('click', () => saveRenderedVideo())

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPreviewLoop()
  } else if (state.playing && !state.rendering) {
    schedulePreviewLoop()
  }
})

const resizeObserver = typeof ResizeObserver !== 'undefined'
  ? new ResizeObserver(() => {
    if (compositeCanvas.clientWidth > 0 && compositeCanvas.clientHeight > 0) {
      if (state.playing && !state.rendering) schedulePreviewLoop()
      else renderStaticFrame()
    } else {
      stopPreviewLoop()
    }
  })
  : null
resizeObserver?.observe(compositeCanvas)

glCanvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault()
  state.contextLost = true
  stopPreviewLoop()
  if (state.rendering) cleanupActiveExport(true)
  state.rendering = false
  fallbackEl.textContent = 'WebGL context was lost. Reopen the studio or wait for GPU recovery.'
  fallbackEl.style.display = 'flex'
  setStatus('WebGL context lost — rendering paused.', 'error')
  syncUiControls()
})

glCanvas.addEventListener('webglcontextrestored', () => {
  state.contextLost = false
  fallbackEl.style.display = 'none'
  setStatus('WebGL context restored.', 'ok')
  syncUiControls()
  renderStaticFrame()
  if (state.playing) schedulePreviewLoop()
})

function disposeAllResources() {
  stopPreviewLoop()
  cleanupActiveExport(true)
  revokeExportUrl()
  resizeObserver?.disconnect()
  studioScene?.dispose()
  renderer?.dispose()
}

window.addEventListener('pagehide', disposeAllResources)
window.addEventListener('beforeunload', disposeAllResources)

// --- Initialize & announce readiness only after controls are bound -----------

if (!renderer || !studioScene) {
  fallbackEl.textContent = 'WebGL is unavailable in this environment, so 3D video rendering cannot start.'
  fallbackEl.style.display = 'flex'
  state.playing = false
  setStatus('WebGL context could not be created.', 'error')
  syncUiControls()
} else if (!encoderProbe.supported) {
  renderStaticFrame()
  syncUiControls()
  setStatus(encoderProbe.reason, 'error')
  if (state.playing) schedulePreviewLoop()
} else {
  renderStaticFrame()
  syncUiControls()
  setStatus('Ready — edit hook or CTA, preview live, then Render video.')
  if (state.playing) schedulePreviewLoop()
}

const invoke = connectStudio(() => {
  bridgeReady = true
  void loadModels()
})
