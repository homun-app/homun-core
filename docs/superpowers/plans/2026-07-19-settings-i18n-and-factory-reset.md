# Settings: lingue es/fr/de + factory reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere i cataloghi di traduzione Spagnolo/Francese/Tedesco (il gateway li supporta già, mancano solo i JSON UI) e implementare un vero factory reset totale al posto del bottone "Delete local data" oggi disabilitato.

**Architecture:** Task A = solo UI React/i18next (9 nuovi JSON + registrazione + test di parità chiavi). Task B = Electron main orchestra il reset (kill gateway → `rm -rf ~/.homun` → clear localStorage → relaunch), esposto via IPC + coreBridge, con conferma in `SettingsView`.

**Tech Stack:** React 19 + i18next, Electron (main.cjs/preload.cjs), Node test runner.

## Global Constraints

- Branch **`settings-i18n-factory-reset`**. **NIENTE `Co-Authored-By`**, **NIENTE push**. Commenti in inglese sul *perché*. ⚠️ Verifica `git rev-parse --abbrev-ref HEAD` PRIMA di ogni commit.
- **Lingue = bundled, offline.** Struttura chiavi di ogni catalogo es/fr/de **identica** a `en.json`; solo i valori tradotti. `fallbackLng:"en"` copre i buchi. Proper noun invariati (Homun, nomi brand/provider, "PPTX"/"DOCX"), e i placeholder di interpolazione `{{...}}` **invariati**.
- **Factory reset = TOTALE**: cancella tutto `~/.homun` (chat, memoria, vault+chiavi API, brand kit, sessioni canali, config provider) + localStorage UI → l'app riparte da onboarding. Dietro **conferma esplicita**. Fail-open per passo (ogni step try/catch loggato; il `rm ~/.homun` è il passo critico).
- Gate: `cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron`; `pre_release_gate.py`. (Nessun file Rust toccato.)

---

### Task A1: Scaffolding i18n es/fr/de + registrazione + test di parità chiavi

**Files:**
- Create: `apps/desktop/src/i18n/locales/{es,fr,de}.json`, `apps/desktop/src/plugins/presentations/locales/{es,fr,de}.json`, `apps/desktop/src/plugins/proattivita/locales/{es,fr,de}.json` (9 file, inizialmente **copia esatta** del rispettivo `en.json` — valori inglesi placeholder, chiavi complete)
- Modify: `apps/desktop/src/i18n/index.ts`, `apps/desktop/src/plugins/presentations/index.tsx`, `apps/desktop/src/plugins/proattivita/index.tsx`
- Create: `apps/desktop/tests/i18n-parity.test.mjs`

**Interfaces:** nessuna esportata; produce i 9 file + le registrazioni che A2/A3/A4 poi traducono.

- [ ] **Step 1: Crea i 9 file come copia di en.** Per ciascuno dei 3 cataloghi, copia `en.json` in `es.json`, `fr.json`, `de.json` (stessa struttura/chiavi, valori inglesi per ora):

```bash
cd /Users/fabio/Projects/Homun/app/apps/desktop
for base in src/i18n/locales src/plugins/presentations/locales src/plugins/proattivita/locales; do
  for lng in es fr de; do cp "$base/en.json" "$base/$lng.json"; done
done
```

- [ ] **Step 2: Registra le lingue in `i18n/index.ts`.** Aggiungi gli import e le voci `resources`:

```ts
import en from "./locales/en.json";
import it from "./locales/it.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import de from "./locales/de.json";
// ...
  resources: {
    en: { translation: en },
    it: { translation: it },
    es: { translation: es },
    fr: { translation: fr },
    de: { translation: de },
  },
```

- [ ] **Step 3: Registra i bundle plugin.** In `apps/desktop/src/plugins/presentations/index.tsx` (grep `addResourceBundle`), accanto a en/it aggiungi:

```tsx
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import de from "./locales/de.json";
// ... dove ci sono i due addResourceBundle esistenti:
    i18n.addResourceBundle("es", "presentations", es);
    i18n.addResourceBundle("fr", "presentations", fr);
    i18n.addResourceBundle("de", "presentations", de);
```

Fai lo stesso in `apps/desktop/src/plugins/proattivita/index.tsx` (namespace `"proattivita"` — usa il namespace reale già presente nel file).

- [ ] **Step 4: Test di parità chiavi (anti-drift).** Crea `apps/desktop/tests/i18n-parity.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const CATALOGS = [
  "i18n/locales",
  "plugins/presentations/locales",
  "plugins/proattivita/locales",
];
// en is the reference; enforce parity for the NEW bundled catalogs we control.
// (it.json is the pre-existing shipped catalog and may have historical drift — not
// gated here to avoid failing this task on unrelated drift; a separate cleanup can
// add it later.)
const LANGS = ["es", "fr", "de"];

function keyPaths(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...keyPaths(v, p));
    else out.push(p);
  }
  return out.sort();
}
const load = (rel) => JSON.parse(readFileSync(path.join(dir, rel), "utf8"));

// Every non-English catalog must have EXACTLY the same key set as en.json — a
// missing key silently falls back to English, an extra key is dead weight. This
// pins full coverage so es/fr/de can't drift as en.json grows.
for (const cat of CATALOGS) {
  const enKeys = keyPaths(load(`${cat}/en.json`));
  for (const lng of LANGS) {
    test(`${cat}/${lng}.json has the same keys as en`, () => {
      const got = keyPaths(load(`${cat}/${lng}.json`));
      assert.deepEqual(got, enKeys, `${cat}/${lng}.json key set differs from en`);
    });
  }
}
```

- [ ] **Step 5: Gate.**

Run: `cd apps/desktop && npm run build && npm run test:electron`
Expected: build verde (i JSON importati tipano), `i18n-parity` verde (le copie hanno le stesse chiavi di en).

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/i18n apps/desktop/src/plugins/presentations/locales apps/desktop/src/plugins/proattivita/locales apps/desktop/src/i18n/index.ts apps/desktop/src/plugins/presentations/index.tsx apps/desktop/src/plugins/proattivita/index.tsx apps/desktop/tests/i18n-parity.test.mjs
git commit -m "feat(i18n): scaffold + register es/fr/de catalogs (en-copy) + key-parity test"
```

---

### Task A2: Traduzione SPAGNOLO (es)

**Files:** Modify `apps/desktop/src/i18n/locales/es.json`, `apps/desktop/src/plugins/presentations/locales/es.json`, `apps/desktop/src/plugins/proattivita/locales/es.json`

- [ ] **Step 1: Traduci ogni valore da inglese a spagnolo.** In ciascuno dei 3 file `es.json`, sostituisci OGNI valore-foglia (stringa) con la sua traduzione **spagnola** professionale. **NON toccare le chiavi.** Mantieni invariati: proper noun (Homun, nomi provider/brand), "PPTX"/"DOCX", e i placeholder `{{...}}` (es. `"Hola {{name}}"`). Rispetta il tono UI (conciso, imperativo dove en lo è). Copri TUTTE le foglie (nessun residuo inglese).

- [ ] **Step 2: Verifica.**

Run: `cd apps/desktop && python3 -c "import json; [print(f, 'OK') for f in ['src/i18n/locales/es.json','src/plugins/presentations/locales/es.json','src/plugins/proattivita/locales/es.json'] if json.load(open(f))]"`
Then: `npm run test:electron` (il test di parità A1 deve restare verde: chiavi invariate).
Expected: JSON validi + parità verde.

- [ ] **Step 3: Commit.**

```bash
git add apps/desktop/src/i18n/locales/es.json apps/desktop/src/plugins/presentations/locales/es.json apps/desktop/src/plugins/proattivita/locales/es.json
git commit -m "feat(i18n): Spanish (es) translations"
```

---

### Task A3: Traduzione FRANCESE (fr)

**Files:** Modify `apps/desktop/src/i18n/locales/fr.json`, `apps/desktop/src/plugins/presentations/locales/fr.json`, `apps/desktop/src/plugins/proattivita/locales/fr.json`

- [ ] **Step 1: Traduci ogni valore da inglese a francese** — stesse regole del Task A2 (chiavi invariate, proper noun + `{{...}}` invariati, tono UI, copertura totale), in **francese**.

- [ ] **Step 2: Verifica.** JSON validi + `npm run test:electron` (parità verde). Comando come A2 con `fr`.

- [ ] **Step 3: Commit.**

```bash
git add apps/desktop/src/i18n/locales/fr.json apps/desktop/src/plugins/presentations/locales/fr.json apps/desktop/src/plugins/proattivita/locales/fr.json
git commit -m "feat(i18n): French (fr) translations"
```

---

### Task A4: Traduzione TEDESCO (de)

**Files:** Modify `apps/desktop/src/i18n/locales/de.json`, `apps/desktop/src/plugins/presentations/locales/de.json`, `apps/desktop/src/plugins/proattivita/locales/de.json`

- [ ] **Step 1: Traduci ogni valore da inglese a tedesco** — stesse regole (chiavi invariate, proper noun + `{{...}}` invariati, tono UI, copertura totale), in **tedesco**.

- [ ] **Step 2: Verifica.** JSON validi + `npm run test:electron` (parità verde). Comando come A2 con `de`.

- [ ] **Step 3: Commit.**

```bash
git add apps/desktop/src/i18n/locales/de.json apps/desktop/src/plugins/presentations/locales/de.json apps/desktop/src/plugins/proattivita/locales/de.json
git commit -m "feat(i18n): German (de) translations"
```

---

### Task B1: Electron main — IPC factory-reset + preload + coreBridge

**Files:**
- Modify: `apps/desktop/electron/main.cjs` (flag `isResetting`, respawn guard, IPC handler)
- Modify: `apps/desktop/electron/preload.cjs` (esporre `factoryReset`)
- Modify: `apps/desktop/src/lib/coreBridge.ts` (wrapper `factoryReset`)
- Test: `apps/desktop/tests/electron-main-names.test.mjs` copre già i typo (checkJs/TS2304); + build.

**Interfaces:**
- Produces: IPC `lfpa:factory-reset` → `{ ok: boolean }`; `window.localFirstDesktop.factoryReset()`; `coreBridge.factoryReset()`.

- [ ] **Step 1: `isResetting` + respawn guard.** In `electron/main.cjs`, accanto a `let isQuitting = false;` (riga ~29) aggiungi `let isResetting = false;`. Nel respawn del watchdog (grep `if (!isQuitting && !gatewayProcess) spawnGateway()`, riga ~424) aggiungi il guard: `if (!isQuitting && !isResetting && !gatewayProcess) spawnGateway();`.

- [ ] **Step 2: Handler IPC.** Aggiungi accanto agli altri `ipcMain.handle("lfpa:...")` (grep). Verifica in cima al file che `os`, `fs`, `path`, `session`, `app` siano già `require`d (electron espone `session`/`app`; se manca `os`/`fs`, aggiungi `const os = require("node:os");` / `const fs = require("node:fs");`):

```js
// Factory reset (Settings → danger zone): wipe ALL local state so the app restarts
// as a fresh install. The Electron main owns this because the gateway holds ~/.homun's
// SQLite files open and can't delete itself. Each step is best-effort/logged so a
// secondary failure never leaves the reset half-done — the ~/.homun wipe (step 2) is
// the one that matters. Onboarding reappears on its own (gateway needs_setup with an
// empty ~/.homun); no UI flag to clear beyond localStorage.
ipcMain.handle("lfpa:factory-reset", async () => {
  isResetting = true; // stop the watchdog from respawning the gateway mid-reset
  // 1) stop the gateway so it releases ~/.homun's SQLite handles
  try {
    if (gatewayProcess && !gatewayProcess.killed) {
      const child = gatewayProcess;
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        child.once("exit", finish);
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } finish(); }, 4000);
      });
    }
    gatewayProcess = null;
  } catch (e) { desktopLog.log(`factory-reset: gateway stop failed: ${e}`); }
  // 2) CRITICAL: wipe ~/.homun (chats, memory, vault-wrapped key, brand kit, prefs)
  try {
    await fs.promises.rm(path.join(os.homedir(), ".homun"), { recursive: true, force: true });
  } catch (e) { desktopLog.log(`factory-reset: rm ~/.homun failed: ${e}`); }
  // 3) clear the UI mirror (language/theme/settings in localStorage)
  try {
    await session.defaultSession.clearStorageData({ storages: ["localstorage"] });
  } catch (e) { desktopLog.log(`factory-reset: clearStorageData failed: ${e}`); }
  // 4) relaunch into a clean first run
  app.relaunch();
  app.exit(0);
  return { ok: true };
});
```

(Nota: la syskey OS-keychain del vault viene **intenzionalmente lasciata** — è orfana e innocua senza la wrapped-key già cancellata al passo 2; evitiamo una chiamata `security` fragile. Documentato nello spec.)

- [ ] **Step 3: Preload.** In `electron/preload.cjs`, dentro `exposeInMainWorld("localFirstDesktop", { ... })` aggiungi:

```js
  factoryReset: () => ipcRenderer.invoke("lfpa:factory-reset"),
```

- [ ] **Step 4: coreBridge wrapper.** In `apps/desktop/src/lib/coreBridge.ts`, aggiungi (safe su web dove non c'è `localFirstDesktop`):

```ts
export async function factoryReset(): Promise<{ ok: boolean }> {
  const api = (window as unknown as { localFirstDesktop?: { factoryReset?: () => Promise<{ ok: boolean }> } })
    .localFirstDesktop;
  if (!api?.factoryReset) return { ok: false };
  return api.factoryReset();
}
```

(Se `coreBridge.ts` ha un oggetto `coreBridge` con metodi, aggiungi anche `factoryReset` lì per coerenza col resto; segui il pattern del file.)

- [ ] **Step 5: Gate.**

Run: `cd apps/desktop && npm run build && npm run test:electron`
Expected: build verde; `electron-main-names` (checkJs/TS2304) verde — nessun nome indefinito nel nuovo handler (verifica che `session`/`os`/`fs`/`path`/`app`/`desktopLog`/`gatewayProcess` siano in scope).

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/electron/main.cjs apps/desktop/electron/preload.cjs apps/desktop/src/lib/coreBridge.ts
git commit -m "feat(settings): factory-reset IPC (kill gateway → wipe ~/.homun → clear localStorage → relaunch)"
```

---

### Task B2: SettingsView — abilita bottone + dialog conferma + i18n (5 lingue)

**Files:**
- Modify: `apps/desktop/src/components/SettingsView.tsx` (bottone + dialog)
- Modify: i 5 cataloghi main `apps/desktop/src/i18n/locales/{en,it,es,fr,de}.json` (desc aggiornata + chiavi conferma)

**Interfaces:** Consumes `factoryReset` (Task B1).

- [ ] **Step 1: Aggiungi le chiavi i18n in tutte e 5 le lingue.** In ogni `src/i18n/locales/<lng>.json`, sotto `settings`, aggiorna `deleteLocalDataDesc` e aggiungi le chiavi del dialog. Valori EN (autoritativi) — traduci per it/es/fr/de nella rispettiva lingua:

```
settings.deleteLocalDataDesc  (EN) "Erases EVERYTHING on this device — chats, memory, brand kit, and your saved API keys — and restarts the app as a fresh install. Irreversible."
settings.factoryResetConfirmTitle (EN) "Reset to factory settings?"
settings.factoryResetConfirmBody  (EN) "This permanently deletes all local data, including your API keys, and restarts Homun from onboarding. This cannot be undone."
settings.factoryResetConfirmCta   (EN) "Erase everything & restart"
```

Usa la chiave `settings.cancel` se esiste (grep `"cancel"` in en.json); altrimenti aggiungi `settings.cancel` (EN "Cancel") in tutte e 5. ⚠️ Le nuove chiavi vanno in **tutti e 5** i cataloghi o il test di parità (A1) fallisce.

- [ ] **Step 2: Abilita il bottone + dialog di conferma.** In `SettingsView.tsx`, la sezione `set-danger` (grep `deleteLocalData`). Rimuovi `disabled title={t("settings.availableSoon")}`, aggiungi uno stato di conferma e l'azione:

```tsx
// near the component's other useState
const [confirmReset, setConfirmReset] = useState(false);
const [resetting, setResetting] = useState(false);
// ... the danger row button:
<button
  className="set-btn danger"
  type="button"
  onClick={() => setConfirmReset(true)}
>
  {t("settings.deleteData")}
</button>
// ... a confirm dialog (render when confirmReset), reuse the app's modal styles if present:
{confirmReset && (
  <div className="set-confirm-scrim" role="dialog" aria-modal="true">
    <div className="set-confirm">
      <h3>{t("settings.factoryResetConfirmTitle")}</h3>
      <p>{t("settings.factoryResetConfirmBody")}</p>
      <div className="set-confirm-actions">
        <button className="auto-btn" type="button" disabled={resetting} onClick={() => setConfirmReset(false)}>
          {t("settings.cancel")}
        </button>
        <button
          className="set-btn danger"
          type="button"
          disabled={resetting}
          onClick={async () => { setResetting(true); await factoryReset(); }}
        >
          {t("settings.factoryResetConfirmCta")}
        </button>
      </div>
    </div>
  </div>
)}
```

Importa `factoryReset` da `../lib/coreBridge`. (Dopo `factoryReset()` l'app si riavvia da sola — non serve altro; `resetting` disabilita i bottoni nel frattempo.)

- [ ] **Step 3: CSS minimo del dialog.** In `apps/desktop/src/styles.css` aggiungi `.set-confirm-scrim` (overlay fixed, centrato) + `.set-confirm` (card) + `.set-confirm-actions` (flex end). Riusa le variabili di tema esistenti (`var(--surface)`, `var(--line)`, ecc.), coerente con gli altri overlay.

- [ ] **Step 4: Gate.**

Run: `cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron`
Expected: verdi (parità i18n verde: le nuove chiavi sono in tutti e 5). Se `check-ui-contract.mjs` lockava `availableSoon`/`disabled` sul bottone, aggiorna il lock.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/components/SettingsView.tsx apps/desktop/src/styles.css apps/desktop/src/i18n/locales apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(settings): enable factory reset with an explicit confirm dialog (5 languages)"
```

---

### Task B3: Gate completi + STATO

**Files:** Modify `docs/STATO.md`

- [ ] **Step 1: Gate completi.**

```bash
cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron && cd ..
cargo test -p local-first-desktop-gateway
python3 scripts/pre_release_gate.py
```
Expected: ALL GREEN. Se fallisce → BLOCKED, non scrivere STATO.

- [ ] **Step 2: STATO checkpoint** (IT, 2026-07-19): Settings — aggiunte lingue **es/fr/de** (cataloghi tradotti main+presentations+proattivita, il gateway le supportava già; test di parità chiavi anti-drift; fallbackLng en); **factory reset totale** al posto del bottone placeholder disabilitato (Electron main: kill gateway → `rm -rf ~/.homun` → clear localStorage → relaunch; conferma esplicita; onboarding riappare via gateway needs_setup; syskey keychain lasciata orfana-innocua). ⚠️ reset validato a schermo da Fabio (distruttivo).

- [ ] **Step 3: Commit.**

```bash
git add docs/STATO.md && git commit -m "docs: STATO checkpoint — settings languages + factory reset shipped"
```

---

## Note

- **Ordine consigliato**: A1 (scaffold+register+test) → A2/A3/A4 (traduzioni, parallelizzabili — file distinti per lingua) → B1 (electron reset) → B2 (UI+i18n conferma) → B3 (gate). B2 aggiunge nuove chiavi i18n in tutti e 5 i cataloghi (il test di parità A1 lo impone).
- **Fail-open**: reset per-passo loggato; lingue mancanti → fallback en.
- **Validazione reset**: distruttiva (cancella `~/.homun` + riavvia) → la prova end-to-end è a schermo di Fabio, non computer-verify. L'handler è tutto in try/catch loggati.
- Merge a `main` a fine slice, su richiesta di Fabio.
