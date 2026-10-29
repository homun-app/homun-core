# Immagine del box dei bot (fase 11b, punto 1) — NATIVA per l'host (nessun
# --platform: sul Mac arm64 la base è arm64, il box non gira emulato).
#
# - base Playwright ufficiale a versione FISSATA: Node, le dipendenze di
#   sistema di Chromium e il manifest arm64 verificato dal revisore;
# - il server Playwright MCP versione ESATTA 0.0.83 (dipende da playwright
#   1.64.0-alpha): è lui il browser del bot, via stdio;
# - il Chromium si installa A BUILD TIME con la CLI della playwright usata da
#   @playwright/mcp (installato GLOBALE: require.resolve NON cerca nei moduli
#   globali di npm, quindi la CLI si prende dal path di `npm root -g` — stessa
#   versione del driver, mai browser mancanti o sbagliati, MAI download a
#   runtime, niente npx …@latest);
# - `playwright-mcp --help` fa FALLIRE la build se qualcosa manca;
# - i browser restano di ROOT: leggibili ed eseguibili da tutti ma NON
#   scrivibili dal bot (uid 1000). Il chown -R duplicherebbe ~700 MB nel layer
#   e renderebbe i binari del browser modificabili dal bot.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

# fase 12 (0e): la configurazione del server MCP che spegne il traffico di
# fondo di Chromium (component update, sync, telemetry: connessioni non
# richieste verso googleapis.com viste dal proxy). File di root, leggibile da
# tutti; il contesto della build resta la sola cartella del Dockerfile, quindi
# niente COPY: il contenuto è la STESSA stringa di PLAYWRIGHT_MCP_CONFIG_JSON
# (src/main/sandbox/docker-argv.ts) e il test la confronta.
# Fase 15 (S9): l'ultimo arg è "--disable-blink-features=" con valore VUOTO —
# Playwright MCP 0.0.83 aggiunge da SÉ quel flag con valore "AutomationControlled"
# solo quando NON trova un arg che lo contiene: il flag vuoto lo accontenta SENZA
# nascondere l'automazione (navigator.webdriver resta true: il browser del bot
# si presenta come browser automatizzato, niente anti-rilevamento).
RUN mkdir -p /etc/sandbot \
 && printf '%s\n' \
      '{"browser":{"launchOptions":{"args":["--disable-background-networking","--disable-component-update","--disable-sync","--no-pings","--disable-domain-reliability","--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication","--disable-blink-features="]}}}' \
      > /etc/sandbot/playwright-mcp.json \
 && chmod 644 /etc/sandbot/playwright-mcp.json

RUN npm install -g @playwright/mcp@0.0.83 \
 && PWCLI="$(npm root -g)/@playwright/mcp/node_modules/playwright/cli.js" \
 && node "$PWCLI" install chromium \
 && playwright-mcp --help >/dev/null \
 && chmod -R a+rX,go-w "${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"

# fase 14 correzioni (P1): NESSUN useradd — l'immagine base Playwright porta
# GIÀ l'utente non-root pwuser (uid/gid 1001:1001, membro di 100/users) previsto
# apposta per far girare il browser: è lui l'utente del processo Playwright MCP
# e di TUTTO il suo stato (profilo, output, pid) nel volume /browser. La riga
# VERIFICA l'assunzione e fa FALLIRE la build in modo chiaro se l'immagine base
# cambia utente o uid: meglio una build rossa che un browser con uid inatteso.
RUN test "$(id -u pwuser)" = 1001 && test "$(id -g pwuser)" = 1001
