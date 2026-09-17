import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  publicDir: fileURLToPath(new URL("../../public", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { alias: {
    "@homun/ui": fileURLToPath(new URL("../../packages/ui/src", import.meta.url)),
    "@": fileURLToPath(new URL("./src", import.meta.url)),
  } },
  server: { host: "127.0.0.1", port: 4183, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
