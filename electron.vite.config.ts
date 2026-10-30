import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// fase 17a (L1): le macro di Lingui (Trans, t, plural) si compilano con
// babel PRIMA che lingui() trasformi le importazioni del runtime; l'ordine
// è quello verificato in produzione. Main e preload non cambiano.
import babel from '@rolldown/plugin-babel'
import lingui from '@lingui/vite-plugin'

const here = import.meta.dirname

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // due entry: index = main Electron (solo UI), daemon = runtime Node
        // puro avviato con ELECTRON_RUN_AS_NODE (vedi src/daemon/index.ts)
        input: { index: resolve(here, 'src/main/index.ts'), daemon: resolve(here, 'src/daemon/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(here, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve(here, 'src/renderer'),
    plugins: [react(), babel({ plugins: ['@lingui/babel-plugin-lingui-macro'] }), lingui(), tailwindcss()],
    build: {
      rollupOptions: { input: { index: resolve(here, 'src/renderer/index.html') } }
    }
  }
})
