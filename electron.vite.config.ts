import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
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

// fase rilascio (A2): id di build iniettato a OGNI build (dev compreso:
// electron-vite valuta la config una volta per sessione). La UI lo confronta
// con quello che il daemon scrive in daemon.json: dopo un aggiornamento il
// daemon vecchio esce bene e si rilancia. In vitest il define non c'è e il
// valore di ripiego è 'test' (src/main/build-id.ts).
const BUILD_ID = randomUUID()

export default defineConfig({
  main: {
    // fase rilascio (A1): il bundle del main contiene ANCHE il runtime del
    // daemon (importato da src/main/index.ts in modalità --homun-daemon).
    // L'entry daemon.js resta per i probe storici in ELECTRON_RUN_AS_NODE.
    define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
    plugins: [
      externalizeDepsPlugin(),
      babel({ plugins: ['@lingui/babel-plugin-lingui-macro'], include: ['src/shared/**/*.ts', 'src/main/**/*.ts', 'src/daemon/**/*.ts'] })
    ],
    build: {
      rollupOptions: {
        // due entry: index = main Electron (UI + modalità daemon), daemon =
        // runtime Node puro d'epoca (probe e sviluppo legacy)
        input: { index: resolve(here, 'src/main/index.ts'), daemon: resolve(here, 'src/daemon/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
    build: {
      // fase rilascio (A5): il preload esce COME COMMONJS (.cjs) — con
      // "type": "module" il default sarebbe .mjs (ESM), che obbliga a
      // sandbox:false sulla finestra. Il preload resta solo contextBridge +
      // ipcRenderer e la finestra torna sandbox:true.
      rollupOptions: {
        input: { index: resolve(here, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: '[name].cjs' }
      }
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
