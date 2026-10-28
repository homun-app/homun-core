# Immagine del box dei bot (fase 11b, punto 1) — NATIVA per l'host (nessun
# --platform: sul Mac arm64 la base è arm64, il box non gira emulato).
#
# - base Playwright ufficiale a versione FISSATA: Node, le dipendenze di
#   sistema di Chromium e il manifest arm64 verificato dal revisore;
# - il server Playwright MCP versione ESATTA 0.0.83 (dipende da playwright
#   1.64.0-alpha): è lui il browser del bot, via stdio;
# - il Chromium si installa A BUILD TIME con la CLI della playwright usata da
#   @playwright/mcp (risolta dal SUO albero di dipendenze, annidato o hoisted):
#   stessa versione del driver, mai browser mancanti o sbagliati, MAI download
#   a runtime (niente npx …@latest);
# - `playwright-mcp --help` fa FALLIRE la build se qualcosa manca;
# - i browser restano leggibili dall'utente 1000:1000 con cui gira il box.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

RUN npm install -g @playwright/mcp@0.0.83 \
 && PWCLI="$(node -p "require.resolve('playwright/cli.js', { paths: [require('path').dirname(require.resolve('@playwright/mcp/package.json'))] })")" \
 && node "$PWCLI" install chromium \
 && playwright-mcp --help >/dev/null \
 && chown -R 1000:1000 "${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
