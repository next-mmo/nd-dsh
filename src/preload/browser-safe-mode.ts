import { contextBridge, ipcRenderer } from 'electron'

// Must equal BROWSER_SAFE_MODE_IPC.config. Importing the shared module would
// make the bundler emit a chunk, and sandboxed preloads cannot require it.
const CONFIG_CHANNEL = 'browser-safe-mode:config'

interface SafeModeConfig {
  enabled?: boolean
  seed?: number
  gpuVendor?: string
  gpuRenderer?: string
}

function readConfig(): SafeModeConfig {
  try {
    return ipcRenderer.sendSync(CONFIG_CHANNEL) as SafeModeConfig
  } catch {
    return { enabled: false }
  }
}

// This function is serialized into the page's main world. It must not close
// over anything from this preload module.
function installBrowserSafeMode(config: { seed: number; gpuVendor: string; gpuRenderer: string }): void {
  const marker = '__ndBrowserSafeModeV1'
  const scope = globalThis as any
  if (scope[marker]) return
  if (!['http:', 'https:'].includes(scope.location?.protocol ?? '')) return
  scope[marker] = true

  const seed = config.seed >>> 0
  const hash = (value: number): number => {
    let x = (value ^ Math.imul(value + 1, 2654435761)) >>> 0
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return x >>> 0
  }
  const signedNoise = (index: number): number => {
    const x = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453
    return (x - Math.floor(x)) * 2 - 1
  }
  // Detection scripts do not call `fn.toString()`; they call
  // `Function.prototype.toString.call(fn)`, which ignores any own property on
  // the function itself. Spoofing at the prototype is the only form that holds.
  const nativeNames = new WeakMap<object, string>()
  const originalFunctionToString = Function.prototype.toString
  const spoofedFunctionToString = function toString(this: unknown): string {
    try {
      const name = nativeNames.get(this as object)
      if (name) return `function ${name}() { [native code] }`
    } catch {
      // A revoked proxy can throw on property access; fall through.
    }
    return Reflect.apply(originalFunctionToString, this, [])
  }
  nativeNames.set(spoofedFunctionToString, 'toString')
  try {
    Object.defineProperty(Function.prototype, 'toString', {
      configurable: true,
      writable: true,
      value: spoofedFunctionToString,
    })
  } catch {
    // Frozen prototypes are rarer than they are annoying; leave them intact.
  }
  const asNative = (name: string, fn: unknown): void => {
    try {
      nativeNames.set(fn as object, name)
    } catch {
      // A frozen host object is better left working than fought over.
    }
  }

  try {
    Object.defineProperty(scope.Navigator.prototype, 'webdriver', {
      configurable: true,
      get: () => false,
    })
  } catch {
    // Older Chromium may expose webdriver as a data property.
  }
  for (const name of Object.getOwnPropertyNames(scope)) {
    if (/^(?:cdc_|__driver|__selenium|__webdriver|__fxdriver|_Selenium|_selenium|_phantom|callPhantom|__nightmare|domAutomation|_ATC_)/i.test(name)) {
      try {
        delete scope[name]
      } catch {
        // Some automation properties are non-configurable; leave them alone.
      }
    }
  }

  const noisyCanvas = (source: any): any => {
    const width = Number(source?.width) || 0
    const height = Number(source?.height) || 0
    if (!width || !height) return null
    const copy = scope.document.createElement('canvas')
    copy.width = width
    copy.height = height
    const context = copy.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(source, 0, 0)
    const pixels = context.getImageData(0, 0, width, height)
    const samples = Math.max(1, Math.min(64, Math.floor((width * height) / 4096)))
    for (let index = 0; index < samples; index += 1) {
      const offset = hash(seed + index * 977) % (width * height)
      const byte = offset * 4
      pixels.data[byte] = (pixels.data[byte] ?? 0) ^ (hash(seed + byte) & 1)
      pixels.data[byte + 1] = (pixels.data[byte + 1] ?? 0) ^ (hash(seed + byte + 1) & 1)
    }
    context.putImageData(pixels, 0, 0)
    return copy
  }

  const canvasProto = scope.HTMLCanvasElement?.prototype
  if (canvasProto) {
    const originalToDataURL = canvasProto.toDataURL
    const patchedToDataURL = function patchedCanvasToDataURL(this: any, ...args: any[]): string {
      try {
        const copy = noisyCanvas(this)
        if (copy) return Reflect.apply(originalToDataURL, copy, args)
      } catch {
        // A tainted canvas cannot be copied; returning the original readout is
        // safer than breaking the page's image workflow.
      }
      return Reflect.apply(originalToDataURL, this, args)
    }
    asNative('toDataURL', patchedToDataURL)
    Object.defineProperty(canvasProto, 'toDataURL', {
      configurable: true,
      writable: true,
      value: patchedToDataURL,
    })

    const originalToBlob = canvasProto.toBlob
    const patchedToBlob = function patchedCanvasToBlob(this: any, callback: any, type?: string, quality?: number): void {
      try {
        const copy = noisyCanvas(this)
        if (copy) {
          copy.toBlob(callback, type, quality)
          return
        }
      } catch {
        // Fall through to the native behavior.
      }
      originalToBlob.call(this, callback, type, quality)
    }
    asNative('toBlob', patchedToBlob)
    Object.defineProperty(canvasProto, 'toBlob', {
      configurable: true,
      writable: true,
      value: patchedToBlob,
    })
  }

  const patchWebGL = (proto: any): void => {
    if (!proto || typeof proto.getParameter !== 'function') return
    const original = proto.getParameter
    const patched = function patchedGetParameter(this: any, pname: number): unknown {
      if (pname === 37445) return config.gpuVendor
      if (pname === 37446) return config.gpuRenderer
      return original.call(this, pname)
    }
    asNative('getParameter', patched)
    Object.defineProperty(proto, 'getParameter', {
      configurable: true,
      writable: true,
      value: patched,
    })
  }
  patchWebGL(scope.WebGLRenderingContext?.prototype)
  patchWebGL(scope.WebGL2RenderingContext?.prototype)

  const audioProto = scope.AudioBuffer?.prototype
  if (audioProto && typeof audioProto.getChannelData === 'function') {
    const original = audioProto.getChannelData
    const touched = new WeakSet<object>()
    const patched = function patchedGetChannelData(this: any, channel: number): any {
      const data = original.call(this, channel)
      if (!(data instanceof scope.Float32Array) || data.length > 100_000 || touched.has(data)) return data
      touched.add(data)
      for (let index = 0; index < data.length; index += 1) {
        data[index] = (data[index] ?? 0) + signedNoise(index + channel * 104729) * 0.000001
      }
      return data
    }
    asNative('getChannelData', patched)
    Object.defineProperty(audioProto, 'getChannelData', {
      configurable: true,
      writable: true,
      value: patched,
    })
  }
}

const config = readConfig()
if (config.enabled && typeof config.seed === 'number') {
  contextBridge.executeInMainWorld({
    func: installBrowserSafeMode,
    args: [{
      seed: config.seed >>> 0,
      gpuVendor: config.gpuVendor || 'Google Inc. (Intel)',
      gpuRenderer: config.gpuRenderer || 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    }],
  })
}
