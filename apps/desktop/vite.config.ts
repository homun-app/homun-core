import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  clearScreen: false,
  build: {
    // Desktop ships some intentionally isolated data/vendor chunks (font manifest,
    // Mermaid diagram engines). Keep the warning budget aligned with that shape so
    // real regressions remain visible instead of repeating the same known warning.
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // The generated font manifest is ~1.8MB of base64 woff2 payload — a
          // data blob, not code, and by far the largest single module in the
          // build. In its own chunk it no longer dominates the entry: the
          // browser parses it off the entry's critical path and the desktop
          // auto-updater stops re-downloading it every time app code changes.
          // (It is still a *static* dependency of presentationsShared.ts, so
          // it is fetched at boot; making it a dynamic import belongs to that
          // module, not to the bundler config.)
          if (id.includes("/src/components/fontsManifest")) {
            return "fonts-manifest";
          }
          if (!id.includes("node_modules")) return undefined;
          if (
            id.includes("react-markdown") ||
            id.includes("remark-") ||
            id.includes("rehype-") ||
            id.includes("unified") ||
            id.includes("mdast") ||
            id.includes("hast") ||
            id.includes("micromark")
          ) {
            return "vendor-markdown";
          }
          if (id.includes("katex")) {
            return "vendor-katex";
          }
          // Syntax highlighting ships every registered language grammar; it is
          // only needed once a code block actually renders, never at boot.
          if (id.includes("lowlight") || id.includes("highlight.js")) {
            return "vendor-highlight";
          }
          // The force-directed graph pulls in three.js — hundreds of KB that
          // only the project-graph panel ever touches.
          if (id.includes("react-force-graph") || id.includes("three")) {
            return "vendor-graph";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      // Packaging stages thousands of generated resources under the app root.
      // They are never renderer source and must not trigger HMR/full reloads.
      ignored: ["**/.package/**"],
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 1421,
    strictPort: true,
  },
});
