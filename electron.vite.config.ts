import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const here = import.meta.dirname

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(here, 'src/main/index.ts') } }
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
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { input: { index: resolve(here, 'src/renderer/index.html') } }
    }
  }
})
