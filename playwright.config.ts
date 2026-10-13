import { defineConfig } from "@playwright/test";

/**
 * Test browser dedicati agli stati del motore nella chat. Girano sul dev
 * server (solo web): il motore è simulato intercettando le chiamate a
 * `http://127.0.0.1:8765` con `page.route`, così gli scenari di caduta sono
 * riproducibili senza processi esterni. Non fanno parte di `npm run check`
 * (servono i browser Playwright): si avviano con `npm run test:browser`.
 */
export default defineConfig({
  testDir: "tests/browser",
  timeout: 30_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4183",
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:4183",
    reuseExistingServer: true,
    stdout: "ignore",
    stderr: "ignore",
  },
});
