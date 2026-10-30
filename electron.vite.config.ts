import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// fase 17a (L1): le macro di Lingui (Trans, t, plural) si compilano con
// babel PRIMA che lingui() trasformi le importazioni del runtime; l'ordine
// è quello verificato in produzione. Main e preload non cambiano.
// fase 17c (C1): la macro msg (src/shared/ui-messages.ts) gira anche nel
// main e nel daemon — stesso plugin babel del renderer; il renderer la
// incontra tramite src/shared (cron-human), quindi l'include copre anche
// quella cartella.
import babel from '@rolldown/plugin-babel'
import lingui from '@lingui/vite-plugin'

const here = import.meta.dirname

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      babel({ plugins: ['@lingui/babel-plugin-lingui-macro'], include: ['src/shared/**/*.ts', 'src/main/**/*.ts', 'src/daemon/**/*.ts'] })
    ],
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
    plugins: [
      react(),
      babel({ plugins: ['@lingui/babel-plugin-lingui-macro'], include: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx', 'src/shared/**/*.ts'] }),
      lingui(),
      tailwindcss()
    ],
    build: {
      rollupOptions: { input: { index: resolve(here, 'src/renderer/index.html') } }
    }
  }
})
