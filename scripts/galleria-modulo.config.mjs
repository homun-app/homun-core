// F2: il config del SOLO modulo della pagina dei componenti. L'app di
// produzione NON lo bundla (il marcatore non entra in out/): la galleria lo
// compila a parte (lib, React incluso, niente externals) in galleria/.modulo/
// e lo copia in out/renderer/ prima di avviare l'app — il renderer lo carica
// con un import() dinamico dietro SANDBOT_TEST_GALLERIA=1 (App.tsx).
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import lingui from '@lingui/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

const here = import.meta.dirname

export default defineConfig({
  root: resolve(here, '..', 'src/renderer'),
  // il bundle gira nel RENDERER (browser): il top-level di react/dom chiede
  // NODE_ENV risolto — senza define l'import lancia «process is not defined»
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [
    react(),
    babel({ plugins: ['@lingui/babel-plugin-lingui-macro'], include: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx', 'src/shared/**/*.ts'] }),
    lingui(),
    tailwindcss()
  ],
  build: {
    outDir: resolve(here, '..', 'galleria', '.modulo'),
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: resolve(here, '..', 'src/renderer/src/galleria/componenti.tsx'),
      formats: ['es'],
      fileName: () => 'galleria-componenti.js'
    },
    rollupOptions: {
      // UN file unico: i chunk separati (mermaid, vega…) non verrebbero copiati
      // in out/ e l'import a runtime fallirebbe
      output: { entryFileNames: 'galleria-componenti.js', inlineDynamicImports: true }
    }
  }
})
