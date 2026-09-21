import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Render the actual TSX modules with the application's aliases, without a browser. */
export async function componentRenderer(path: string, name: string) {
  const cacheDir = await mkdtemp(join(tmpdir(), "homun-component-test-"));
  const server = await createServer({
    configFile: false,
    cacheDir,
    logLevel: "error",
    server: { middlewareMode: true, watch: null, ws: false },
    resolve: { alias: { "@": resolve("apps/web/src") } },
    optimizeDeps: { noDiscovery: true, include: [] },
    esbuild: { jsx: "automatic" },
  });
  try {
    const module = await server.ssrLoadModule(path);
    return {
      render: (props: Record<string, unknown>) => renderToStaticMarkup(createElement(module[name], props)),
      close: async () => {
        await server.close();
        await rm(cacheDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
    throw error;
  }
}
