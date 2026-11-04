/**
 * ND Emulator — pure logic module (no DOM, no bridge).
 *
 * Exported helpers are used by the web view and can be tested independently.
 */

/**
 * Parse the device list response into a normalized array.
 * @param {unknown} value — raw host method response
 * @returns {{ serial: string; type: string; model: string; product: string; transportId: string }[]}
 */
export function parseDeviceList(value) {
  if (!value || typeof value !== 'object') return []
  const valObj = /** @type {Record<string, unknown>} */ (value)
  const list = Array.isArray(valObj) ? valObj : Array.isArray(valObj.devices) ? valObj.devices : []
  return list.map((item) => {
    const obj = item && typeof item === 'object' ? item : {}
    return {
      serial: String(obj.serial ?? obj.id ?? ''),
      type: String(obj.type ?? obj.state ?? 'unknown'),
      model: String(obj.model ?? obj.name ?? ''),
      product: String(obj.product ?? ''),
      transportId: String(obj.transportId ?? ''),
    }
  }).filter((d) => d.serial.length > 0)
}

/**
 * Build a human-readable device info line.
 * @param {{ serial: string; type: string; model: string; product: string }} device
 * @returns {string}
 */
export function formatDeviceInfo(device) {
  const parts = []
  if (device.serial) parts.push(device.serial)
  if (device.product) parts.push(device.product)
  if (device.serial.includes(':')) parts.push('Wireless')
  else if (device.type === 'device') parts.push('USB')
  else if (device.type) parts.push(device.type)
  return parts.join(' · ')
}

/**
 * Format current time as HH:MM:SS for logs.
 * @returns {string}
 */
export function formatTimestamp() {
  const now = new Date()
  return now.toLocaleTimeString('en-US', { hour12: false })
}

/**
 * Catalog of popular Android emulators, providers, and essential tools.
 */
export const EMULATOR_PROVIDERS = [
  {
    id: 'ldplayer',
    name: 'LDPlayer',
    category: 'emulators',
    badge: 'Popular for Gaming & Apps',
    description: 'High-speed Android 9 & 12 emulator with low resource usage and high FPS. Optimized for mobile gaming, multi-instance, and bot automation.',
    defaultPort: 5555,
    hostAddress: '127.0.0.1:5555',
    downloadUrl: 'https://www.ldplayer.net/',
    setupGuide: 'Open LDPlayer Settings → Other Settings → Turn on ADB Debugging (Local Connection).',
    installCmd: null,
    icon: '⚡',
  },
  {
    id: 'bluestacks',
    name: 'BlueStacks',
    category: 'emulators',
    badge: 'Multi-Instance Leader',
    description: 'Leading Android gaming and app platform with Pie 64-bit and Android 11 support. Rich keymapping, sync instances, and performance tuning.',
    defaultPort: 5555,
    hostAddress: '127.0.0.1:5555',
    downloadUrl: 'https://www.bluestacks.com/',
    setupGuide: 'Settings → Advanced → Turn on Android Debug Bridge (ADB). Check displayed port if customized.',
    installCmd: null,
    icon: '🔷',
  },
  {
    id: 'mumu',
    name: 'MuMu Player (NetEase)',
    category: 'emulators',
    badge: 'Vulkan / Ultra Smooth',
    description: 'Next-gen Android 12 emulator powered by Vulkan. Low memory usage, fast load times, and top developer compatibility.',
    defaultPort: 16384,
    hostAddress: '127.0.0.1:16384',
    downloadUrl: 'https://www.mumuplayer.com/',
    setupGuide: 'Settings → General → Turn on ADB. MuMu 12 uses port 16384 (MuMu 6 uses 7555).',
    installCmd: null,
    icon: '🐮',
  },
  {
    id: 'nox',
    name: 'NoxPlayer',
    category: 'emulators',
    badge: 'Customizable & Root',
    description: 'Customizable Android emulator with root access toggle, virtual GPS, macro recorder, and multi-instance management.',
    defaultPort: 62001,
    hostAddress: '127.0.0.1:62001',
    downloadUrl: 'https://www.bignox.com/',
    setupGuide: 'Settings → General Settings → Turn on Root and enable ADB connection.',
    installCmd: null,
    icon: '🔮',
  },
  {
    id: 'android-studio',
    name: 'Google Android Studio (AVD)',
    category: 'developer',
    badge: 'Official Google SDK',
    description: 'Official Android Virtual Device with official Google Play images, stock Pixel system images, and all Android API versions.',
    defaultPort: 5554,
    hostAddress: 'emulator-5554',
    downloadUrl: 'https://developer.android.com/studio',
    setupGuide: 'Create a device in Android Studio Device Manager and start it. ADB detects it automatically.',
    installCmd: 'winget install Google.AndroidStudio',
    icon: '🤖',
  },
  {
    id: 'wsa',
    name: 'Windows Subsystem for Android (WSA)',
    category: 'emulators',
    badge: 'Windows 11 Native',
    description: 'Run Android apps directly on Windows 11 as native desktop windows without running a heavy standalone emulator.',
    defaultPort: 58526,
    hostAddress: '127.0.0.1:58526',
    downloadUrl: 'https://learn.microsoft.com/en-us/windows/android/wsa/',
    setupGuide: 'WSA Settings → Developer → Turn on Developer mode. Connect to the displayed IP:Port (usually 127.0.0.1:58526).',
    installCmd: null,
    icon: '🪟',
  },
  {
    id: 'scrcpy',
    name: 'scrcpy (Genymobile)',
    category: 'tools',
    badge: 'Ultra Low-Latency Mirroring',
    description: 'Display and control Android devices over USB or Wi-Fi. Sub-35ms latency, 30~120 FPS, clipboard sync, and physical keyboard/mouse input.',
    defaultPort: null,
    hostAddress: null,
    downloadUrl: 'https://github.com/Genymobile/scrcpy/releases',
    setupGuide: 'Extract to a folder on PATH or install with package managers like winget, brew, or choco.',
    installCmd: 'winget install Genymobile.scrcpy',
    icon: '🪞',
  },
  {
    id: 'platform-tools',
    name: 'Android SDK Platform-Tools (ADB)',
    category: 'tools',
    badge: 'Essential Debugging Engine',
    description: 'Official Google ADB (Android Debug Bridge) and Fastboot binaries. Required for device discovery, shell, and sideloading.',
    defaultPort: null,
    hostAddress: null,
    downloadUrl: 'https://developer.android.com/tools/releases/platform-tools',
    setupGuide: 'Extract platform-tools and add to system PATH, or set custom adbPath in ND Settings.',
    installCmd: 'winget install Google.PlatformTools',
    icon: '🛠️',
  },
]

/**
 * Filter emulator providers by category and search query.
 * @param {string} category - 'all' or category id
 * @param {string} query - text search query
 * @returns {typeof EMULATOR_PROVIDERS}
 */
export function filterProviders(category = 'all', query = '') {
  const q = query.trim().toLowerCase()
  return EMULATOR_PROVIDERS.filter((p) => {
    const matchesCategory = category === 'all' || p.category === category
    const matchesQuery = !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.badge.toLowerCase().includes(q)
    return matchesCategory && matchesQuery
  })
}

/**
 * Identify if a serial or address matches a known emulator provider.
 * @param {string} serialOrAddress
 * @returns {string | null}
 */
export function detectProvider(serialOrAddress) {
  if (!serialOrAddress) return null
  const s = serialOrAddress.toLowerCase()
  if (s.includes('58526')) return 'wsa'
  if (s.includes('16384') || s.includes('7555')) return 'mumu'
  if (s.includes('62001')) return 'nox'
  if (s.includes('emulator-') || s.includes('goldfish') || s.includes('ranchu')) return 'android-studio'
  if (s.includes('5555')) return 'ldplayer'
  return null
}
