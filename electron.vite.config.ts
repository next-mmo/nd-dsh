import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// electron-vite 5's preset forces `ssr.noExternal = true` on the main and
// preload builds. Under Vite 8 (Rolldown) that overrides the built-in
// `external: ['electron', ...]` list and inlines the `electron` package. The
// inlined copy resolves its binary relative to the bundle dir (`out/...`) and
// fails at runtime. Force Electron (and Node builtins) to stay externalized:
// an empty `noExternal` array tells Rolldown to bundle no node_modules, so
// `require('electron')` resolves to the real runtime module.
function preserveElectronExternal(): Plugin {
  return {
    name: 'preserve-electron-external',
    enforce: 'post',
    config(config) {
      config.ssr = {
        ...config.ssr,
        noExternal: [],
      }
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), preserveElectronExternal()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      sourcemap: true,
      rollupOptions: {
        input: resolve('src/main/index.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin(), preserveElectronExternal()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          'nd-pencil': resolve('src/preload/nd-pencil.ts'),
          'extension-runtime': resolve('src/preload/extension-runtime.ts'),
          'vault-prompt': resolve('src/preload/vault-prompt.ts'),
        },
        // The product renderer, the isolated ND Pencil host, and browser
        // extension contexts all run sandboxed, so their preload scripts must
        // remain CommonJS and must not share chunks.
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      sourcemap: true,
    },
  },
})
