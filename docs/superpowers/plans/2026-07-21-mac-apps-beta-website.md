# Mac Apps Beta Website Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Communicate the verified Apple Silicon Mac Apps beta on homun.app through the existing visual system, a precise homepage distinction, complete English and Italian guides, security/settings links, and a changelog synchronized from the published desktop release.

**Architecture:** Keep the Astro marketing site and Starlight documentation unchanged structurally. Add one content contract test, update the existing computer feature row, add parallel EN/IT guide routes, and let the canonical GitHub release body populate the generated changelog through the existing product-data synchronization pipeline.

**Tech Stack:** Astro 6, Starlight, Tailwind CSS, Node test runner, generated GitHub release snapshots.

---

## File responsibility map

- `src/components/Features.astro`: concise public distinction between Contained Computer and Mac Apps Beta using the current `FeatureRow` design.
- `src/content/docs/guides/mac-apps-beta.md`: canonical English setup, privacy, safety, limits, and troubleshooting.
- `src/content/docs/it/guides/mac-apps-beta.md`: content-equivalent Italian guide.
- `astro.config.mjs`: Starlight navigation entry for both locales.
- `src/content/docs/{concepts,guides/settings,guides/security}.md`: cross-links and conceptual distinction.
- `src/content/docs/it/{concepts,guides/settings,guides/security}.md`: matching Italian cross-links.
- `scripts/check-mac-apps-beta.mjs`: public-claim and bilingual-route contract.
- `package.json`: include the new contract in the normal site gate.
- `src/data/releases.json`: generated changelog snapshot, updated only by `sync:product-data` after the desktop release is public.

### Task 1: Create an isolated website branch and a failing content contract

**Files:**
- Create worktree: `/Users/fabio/Projects/Homun/website/.worktrees/fabio/mac-apps-beta-site`
- Create: `scripts/check-mac-apps-beta.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create the isolated website worktree**

Run from `/Users/fabio/Projects/Homun/website`:

```bash
git status --short --branch
git worktree add .worktrees/fabio/mac-apps-beta-site -b fabio/mac-apps-beta-site main
```

Expected: main remains clean and all website edits occur in the new worktree.

- [ ] **Step 2: Add the public content contract**

Create `scripts/check-mac-apps-beta.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const strip = (html) => html
  .replace(/<[^>]+>/g, " ")
  .replace(/&(?:#39|apos);/g, "'")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");

const [homeHtml, englishHtml, italianHtml, config] = await Promise.all([
  read("../dist/index.html"),
  read("../dist/guides/mac-apps-beta/index.html"),
  read("../dist/it/guides/mac-apps-beta/index.html"),
  read("../astro.config.mjs"),
]);

const home = strip(homeHtml);
const english = strip(englishHtml);
const italian = strip(italianHtml);

for (const message of [
  "Contained Computer",
  "Mac Apps Beta",
  "Apple Silicon",
  "off by default",
  "only the apps you authorize",
]) {
  assert.ok(home.toLowerCase().includes(message.toLowerCase()), `Homepage is missing: ${message}`);
}

for (const message of [
  "Observe",
  "Control",
  "Accessibility",
  "Screen Recording",
  "Password managers",
  "Terminal",
  "Window captures stay on this Mac",
]) {
  assert.ok(english.toLowerCase().includes(message.toLowerCase()), `English guide is missing: ${message}`);
}

for (const message of [
  "Osserva",
  "Controlla",
  "Accessibilità",
  "Registrazione schermo",
  "gestori di password",
  "Terminale",
  "Le acquisizioni delle finestre restano su questo Mac",
]) {
  assert.ok(italian.toLowerCase().includes(message.toLowerCase()), `Italian guide is missing: ${message}`);
}

assert.ok(config.includes("guides/mac-apps-beta"), "Docs navigation is missing Mac Apps Beta");

for (const forbidden of [
  "control every app",
  "control your whole Mac",
  "works on Intel",
  "available on Windows",
  "available on Linux",
  "controlla tutto il Mac",
  "funziona su Intel",
  "disponibile su Windows",
  "disponibile su Linux",
]) {
  assert.ok(!`${home} ${english} ${italian}`.toLowerCase().includes(forbidden.toLowerCase()), `Forbidden claim: ${forbidden}`);
}

console.log("Mac Apps Beta public content contract passed");
```

- [ ] **Step 3: Add the test script to the normal gate**

Add:

```json
"test:mac-apps-beta": "node scripts/check-mac-apps-beta.mjs"
```

Append `&& npm run test:mac-apps-beta` to the existing `check` script after `test:homepage`.

- [ ] **Step 4: Build and verify RED**

Run:

```bash
npm run build
npm run test:mac-apps-beta
```

Expected: build succeeds, then the contract fails because the two guide routes and homepage claims do not exist.

- [ ] **Step 5: Commit the failing contract**

```bash
git add scripts/check-mac-apps-beta.mjs package.json
git commit -m "test(site): define mac apps beta public contract"
```

### Task 2: Update the homepage without introducing a new visual system

**Files:**
- Modify: `src/components/Features.astro`
- Test: `scripts/check-mac-apps-beta.mjs`

- [ ] **Step 1: Replace only the existing computer row content**

Use the current `FeatureRow`, current screenshot, current spacing, and this content:

```ts
{
  eyebrow: "Two execution surfaces",
  title: "Contained when it should be. Native when you allow it.",
  lead: "Use the Contained Computer for an isolated browser and shell. On Apple Silicon Macs, Mac Apps Beta can observe or control only the apps you authorize — off by default.",
  points: [
    "<span class='text-cream'>Contained Computer</span> — Docker-isolated browser and shell",
    "<span class='text-cream'>Mac Apps Beta</span> — real apps, Apple Silicon only",
    "Separate <span class='text-cream'>Observe or Control</span> grants for every app",
    "Your mouse or keyboard pauses Homun immediately",
  ],
  image: localComputer,
  alt: "Homun's contained computer, alongside the optional Mac Apps Beta",
  href: "/guides/mac-apps-beta/",
  reverse: true,
}
```

Do not add a second card, new badge component, custom background, or new image generation task.

- [ ] **Step 2: Build and inspect the homepage text**

Run:

```bash
npm run build
node -e 'const fs=require("fs");const s=fs.readFileSync("dist/index.html","utf8");for(const x of ["Contained Computer","Mac Apps Beta","Apple Silicon","off by default","only the apps you authorize"])if(!s.toLowerCase().includes(x.toLowerCase()))throw Error(x)'
```

Expected: command exits 0.

- [ ] **Step 3: Commit the homepage change**

```bash
git add src/components/Features.astro
git commit -m "feat(site): distinguish contained computer and mac apps beta"
```

### Task 3: Add the complete English guide

**Files:**
- Create: `src/content/docs/guides/mac-apps-beta.md`
- Modify: `astro.config.mjs`

- [ ] **Step 1: Create the English guide**

Use this complete content:

```markdown
---
title: Mac Apps Beta
description: Let Homun observe or control only the Mac apps you authorize, with separate grants and immediate takeover.
---

Mac Apps Beta lets Homun work with real applications on your Mac. It complements the [Contained Computer](/guides/local-computer/); it does not replace its Docker isolation.

:::caution[Beta availability]
Mac Apps Beta is available first on **Apple Silicon Macs**. It is included in the normal Homun app and is **off by default**.
:::

## Three separate gates

1. Enable **Mac Apps Beta** in **Settings → Computer**.
2. Grant **Accessibility** and **Screen Recording** in macOS System Settings.
3. Authorize each application in Homun as **Observe** or **Control**.

Enabling the beta never authorizes an application automatically. Homun verifies the effective macOS permission after you return to the app, so you do not need to refresh the page.

## Observe and Control

- **Observe** reads a bounded, redacted semantic view of the authorized window. It cannot click, type, scroll, or change the app.
- **Control** includes Observe and permits policy-approved actions. Consequential actions still pause immediately before the effect and ask for your approval.

Grants are tied to the application's signed identity. If its path or signature changes, Homun invalidates the old grant. Revoking a grant stops its active session and clears temporary state.

## What the model receives

Homun builds a small semantic structure from macOS Accessibility data and removes secure or unnecessary values before it reaches the model. **Window captures stay on this Mac** and are never sent to a local model or cloud provider in this beta. They do not become chat attachments, personal memory, or project memory automatically.

If Accessibility does not expose enough information, Homun asks you to take over or explains that the step cannot be completed. It does not silently upload the window.

## Always blocked

Mac Apps Beta cannot automate:

- password managers and Keychain;
- login, authentication, or macOS authorization windows;
- secure text fields and masked values;
- Terminal or other host-shell input;
- its own macOS permission controls.

Text visible inside an app is treated as untrusted content. It cannot grant itself permissions or override Homun's policy.

## Take over or stop

Moving the mouse, using the trackpad, or pressing a physical key pauses Homun immediately. The Computer activity card shows the active app, state, grant, and actions to **Pause**, **Stop**, or **Take control**. Homun resumes only after your explicit action.

Locking the Mac, sleeping it, switching users, disabling the beta, signing out of Homun, or revoking the grant stops or suspends the session. A factory reset removes the beta opt-in, Homun grants, journal, sockets, and temporary captures. macOS permission records remain controlled by System Settings.

## Set up

1. Open **Settings → Computer**.
2. Turn on **Mac Apps Beta**.
3. Open the Accessibility and Screen Recording panels from Homun and grant both permissions.
4. Return to Homun and wait for the status to update.
5. Choose one running application.
6. Select **Observe** or **Control**, then authorize it.
7. Ask Homun for one bounded task involving that app.

Start with an expendable document and a reversible action while the feature is in beta.

## Troubleshooting

### Permission still shows as missing

Return to Homun after changing System Settings. Screen Recording can require restarting the native helper or Homun. If the status remains unchanged, switch the permission off and on once, then reopen Homun.

### The application is not listed

Open the application and a normal document window. Protected, unsigned, background-only, and unsupported applications are intentionally excluded.

### Homun paused

Physical input, a changed window, a revoked grant, screen lock, or an approval timeout pauses or ends the session. Read the activity card before resuming; Homun never replays the previous mutation automatically.

### The task needs a browser or command

Use the [Contained Computer](/guides/local-computer/). Browser and shell work stay in Docker and do not move to the host merely because Mac Apps Beta is enabled.
```

- [ ] **Step 2: Add the navigation item after the contained computer**

Add:

```js
{ label: 'Mac Apps Beta', translations: { it: 'App del Mac Beta' }, slug: 'guides/mac-apps-beta' },
```

- [ ] **Step 3: Build the English route**

Run:

```bash
npm run build
test -f dist/guides/mac-apps-beta/index.html
```

Expected: both commands succeed.

- [ ] **Step 4: Commit English documentation**

```bash
git add src/content/docs/guides/mac-apps-beta.md astro.config.mjs
git commit -m "docs(site): add mac apps beta guide"
```

### Task 4: Add the content-equivalent Italian guide

**Files:**
- Create: `src/content/docs/it/guides/mac-apps-beta.md`

- [ ] **Step 1: Create the Italian guide**

Use this complete content:

```markdown
---
title: App del Mac Beta
description: Consenti a Homun di osservare o controllare solo le app del Mac che autorizzi, con permessi separati e passaggio di mano immediato.
---

App del Mac Beta permette a Homun di lavorare con applicazioni reali del tuo Mac. Affianca il [Computer contenuto](/it/guides/local-computer/), senza sostituirne l'isolamento Docker.

:::caution[Disponibilità beta]
App del Mac Beta è disponibile inizialmente sui **Mac Apple Silicon**. È inclusa nella normale app Homun ed è **disattivata per impostazione predefinita**.
:::

## Tre autorizzazioni distinte

1. Attiva **App del Mac Beta** in **Impostazioni → Computer**.
2. Concedi **Accessibilità** e **Registrazione schermo** nelle Impostazioni di Sistema di macOS.
3. Autorizza ogni applicazione in Homun come **Osserva** o **Controlla**.

Attivare la beta non autorizza automaticamente alcuna applicazione. Quando torni nell'app, Homun verifica il permesso macOS effettivo senza richiedere un aggiornamento manuale.

## Osserva e Controlla

- **Osserva** legge una vista semantica limitata e redatta della finestra autorizzata. Non può fare clic, digitare, scorrere o modificare l'app.
- **Controlla** include Osserva e consente le azioni ammesse dalla policy. Le azioni con conseguenze si fermano subito prima dell'effetto e richiedono comunque la tua approvazione.

I grant sono legati all'identità firmata dell'applicazione. Se percorso o firma cambiano, Homun invalida il vecchio grant. La revoca interrompe la sessione attiva e cancella lo stato temporaneo.

## Cosa riceve il modello

Homun crea una piccola struttura semantica dai dati di Accessibilità di macOS e rimuove valori sicuri o non necessari prima che raggiunga il modello. **Le acquisizioni delle finestre restano su questo Mac** e in questa beta non vengono mai inviate a un modello locale o a un provider cloud. Non diventano automaticamente allegati, memoria personale o memoria di progetto.

Se Accessibilità non espone informazioni sufficienti, Homun ti chiede di prendere il controllo oppure spiega che il passaggio non può essere completato. Non carica silenziosamente la finestra.

## Sempre bloccati

App del Mac Beta non può automatizzare:

- gestori di password e Portachiavi;
- finestre di login, autenticazione o autorizzazione macOS;
- campi di testo sicuri e valori mascherati;
- input nel Terminale o in altre shell dell'host;
- i propri permessi macOS.

Il testo visibile dentro un'app è trattato come contenuto non attendibile. Non può concedersi permessi né ignorare le policy di Homun.

## Prendi il controllo o interrompi

Muovere il mouse, usare il trackpad o premere un tasto fisico mette immediatamente Homun in pausa. La card Computer mostra app attiva, stato, grant e comandi per **Pausa**, **Interrompi** o **Prendi controllo**. Homun riparte soltanto dopo una tua azione esplicita.

Bloccare il Mac, mandarlo in stop, cambiare utente, disattivare la beta, uscire dall'account Homun o revocare il grant interrompe o sospende la sessione. Il ripristino di fabbrica elimina opt-in, grant Homun, journal, socket e acquisizioni temporanee. I permessi macOS restano gestiti dalle Impostazioni di Sistema.

## Configurazione

1. Apri **Impostazioni → Computer**.
2. Attiva **App del Mac Beta**.
3. Apri da Homun i pannelli Accessibilità e Registrazione schermo e concedi entrambi i permessi.
4. Torna in Homun e attendi l'aggiornamento dello stato.
5. Scegli una singola applicazione in esecuzione.
6. Seleziona **Osserva** o **Controlla**, quindi autorizzala.
7. Chiedi a Homun un task circoscritto che coinvolga quell'app.

Durante la beta, inizia con un documento sacrificabile e un'azione reversibile.

## Risoluzione dei problemi

### Il permesso risulta ancora mancante

Torna in Homun dopo la modifica nelle Impostazioni di Sistema. Registrazione schermo può richiedere il riavvio dell'helper nativo o di Homun. Se lo stato non cambia, disattiva e riattiva una volta il permesso, quindi riapri Homun.

### L'applicazione non compare

Apri l'applicazione e una normale finestra documento. Applicazioni protette, non firmate, senza interfaccia o non supportate vengono escluse intenzionalmente.

### Homun è in pausa

Input fisico, cambio di finestra, revoca del grant, blocco schermo o scadenza di un'approvazione sospendono o terminano la sessione. Leggi la card prima di riprendere: Homun non ripete automaticamente la modifica precedente.

### Il task richiede un browser o un comando

Usa il [Computer contenuto](/it/guides/local-computer/). Browser e shell restano in Docker e non passano all'host solo perché App del Mac Beta è attiva.
```

- [ ] **Step 2: Build and verify the Italian route**

Run:

```bash
npm run build
test -f dist/it/guides/mac-apps-beta/index.html
```

Expected: both commands succeed.

- [ ] **Step 3: Commit Italian documentation**

```bash
git add src/content/docs/it/guides/mac-apps-beta.md
git commit -m "docs(site): add italian mac apps beta guide"
```

### Task 5: Connect concepts, settings, and security in both languages

**Files:**
- Modify: `src/content/docs/concepts.md`
- Modify: `src/content/docs/it/concepts.md`
- Modify: `src/content/docs/guides/settings.md`
- Modify: `src/content/docs/it/guides/settings.md`
- Modify: `src/content/docs/guides/security.md`
- Modify: `src/content/docs/it/guides/security.md`

- [ ] **Step 1: Add Mac Apps to both concept tables**

English:

```markdown
| [Mac Apps Beta](/guides/mac-apps-beta/) | Optional Apple Silicon host-app access, off by default and granted per application. |
```

Italian:

```markdown
| [App del Mac Beta](/it/guides/mac-apps-beta/) | Accesso opzionale alle app host su Apple Silicon, disattivato di default e autorizzato per singola applicazione. |
```

- [ ] **Step 2: Split the Computer settings description**

English row:

```markdown
| **Computer** | Contained Docker computer plus optional Apple Silicon Mac Apps Beta | [Contained Computer](/guides/local-computer/) · [Mac Apps Beta](/guides/mac-apps-beta/) |
```

Italian row:

```markdown
| **Computer** | Computer Docker contenuto più App del Mac Beta opzionale su Apple Silicon | [Computer contenuto](/it/guides/local-computer/) · [App del Mac Beta](/it/guides/mac-apps-beta/) |
```

- [ ] **Step 3: Correct the containment statement in both security guides**

Replace the claim that all real-world execution happens only in Docker with two explicit boundaries.

English:

```markdown
## Two execution boundaries

Browser and shell work stays inside the [Contained Computer](/guides/local-computer/). On Apple Silicon Macs, the optional [Mac Apps Beta](/guides/mac-apps-beta/) crosses the host boundary only through a signed native helper, effective macOS permissions, and a separate grant for each app. It is off by default; protected apps, secure fields, authentication UI, and Terminal input remain blocked.
```

Italian:

```markdown
## Due confini di esecuzione

Browser e shell restano nel [Computer contenuto](/it/guides/local-computer/). Sui Mac Apple Silicon, la funzione opzionale [App del Mac Beta](/it/guides/mac-apps-beta/) supera il confine host soltanto attraverso un helper nativo firmato, permessi macOS effettivi e un grant separato per ogni app. È disattivata di default; app protette, campi sicuri, UI di autenticazione e input nel Terminale restano bloccati.
```

- [ ] **Step 4: Build and commit cross-links**

Run:

```bash
npm run build
```

Expected: zero broken internal routes during Astro build.

```bash
git add src/content/docs/concepts.md src/content/docs/it/concepts.md src/content/docs/guides/settings.md src/content/docs/it/guides/settings.md src/content/docs/guides/security.md src/content/docs/it/guides/security.md
git commit -m "docs(site): connect mac apps beta safety boundaries"
```

### Task 6: Turn the contract green and inspect the rendered site

**Files:**
- Verify: all website files changed in Tasks 1–5

- [ ] **Step 1: Run the focused public contract**

```bash
npm run build
npm run test:mac-apps-beta
```

Expected: `Mac Apps Beta public content contract passed`.

- [ ] **Step 2: Run the full website gate**

```bash
npm run check
git diff --check main...HEAD
```

Expected: every existing and new site test passes with no whitespace errors.

- [ ] **Step 3: Inspect responsive rendering**

Run:

```bash
npm run dev -- --host 127.0.0.1
```

Inspect homepage, English guide, and Italian guide at 1280×800, 1440×900, 390×844, and 430×932.

Expected: no horizontal scrolling, clipped copy, new nested containers, broken code styling, or inconsistent spacing. The updated row remains visually consistent with the surrounding feature rows.

- [ ] **Step 4: Commit any verified presentation corrections**

```bash
git add src/components/Features.astro src/content/docs astro.config.mjs scripts/check-mac-apps-beta.mjs package.json
git commit -m "fix(site): polish mac apps beta responsive presentation"
```

Skip this commit only if the visual inspection produces no changes.

### Task 7: Synchronize the published release into the changelog

**Files:**
- Generated: `src/data/releases.json`
- Read: published Mac Apps Beta GitHub release

- [ ] **Step 1: Confirm the desktop release is public**

Verify that the release body contains `Mac Apps Beta`, `Apple Silicon`, `off by default`, the security limitations, and `Roadmap: connected-actions, local-computer`.

Expected: the downloadable macOS arm64 assets and updater metadata exist before any website publication.

- [ ] **Step 2: Run the canonical product-data synchronization**

With the repository's normal GitHub synchronization environment configured:

```bash
npm run sync:product-data -- --write
```

Expected: `src/data/releases.json` gains the published release through the normal publication policy; no hand-edited changelog record is introduced.

- [ ] **Step 3: Verify the generated changelog entry**

Run:

```bash
node -e 'const r=require("./src/data/releases.json");const x=r.items[0];if(!x.highlights.some(v=>v.includes("Mac Apps Beta")))throw Error("latest release lacks Mac Apps Beta highlight");console.log(x.version,x.githubUrl)'
npm run test:product-data
npm run build
```

Expected: the first command prints the verified release version and URL; product-data and build pass.

- [ ] **Step 4: Commit the generated release projection**

```bash
git add src/data/releases.json
git commit -m "docs(site): publish mac apps beta changelog entry"
```

### Task 8: Merge, deploy, and verify the public site

**Files:**
- Verify: website branch diff and deployed routes

- [ ] **Step 1: Push the site branch for review**

```bash
git status --short
git push -u origin fabio/mac-apps-beta-site
```

Expected: clean branch and green website checks.

- [ ] **Step 2: Merge only after the desktop release is downloadable**

Expected: `main` includes homepage, guides, cross-links, contract, and synchronized release data in one reviewed publication boundary.

- [ ] **Step 3: Verify deployment**

Open and inspect:

```text
https://homun.app/
https://homun.app/guides/mac-apps-beta/
https://homun.app/it/guides/mac-apps-beta/
https://homun.app/changelog/
```

Expected: HTTPS 200, current styling, working internal links, correct EN/IT content, and a changelog entry pointing to the same published desktop version.

- [ ] **Step 4: Recheck forbidden claims on the deployed HTML**

Confirm the public pages do not claim Intel, Windows, Linux, access to every app, automatic permission grants, or screenshot delivery to models.
