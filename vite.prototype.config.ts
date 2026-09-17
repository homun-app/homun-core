import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Standalone UX preview: no TanStack server, authentication or external services.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./prototypes/reference/src", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 4182, strictPort: true },
  build: {
    outDir: "dist-prototype",
    rolldownOptions: { input: ["prototypes/first-work.html", "prototypes/conversations.html"] },
  },
});
