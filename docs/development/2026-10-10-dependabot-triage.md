# Triage avvisi Dependabot — 2026-10-10

Proposta di gestione per gli avvisi Dependabot che non si risolvono nel codice.
**Nulla di quanto segue è stato eseguito su GitHub**: ogni comando è pronto per
essere lanciato dopo approvazione. I gruppi C (alert 128, 148–152) e D/129 sono
risolti dalla PR «fix(deps): patch vulnerable dependencies and drop unused ones»
e si chiuderanno da soli al merge su `main`.

Riclassificazione rispetto alla ricognizione iniziale: il gruppo A contiene
**17** avvisi, non 14 — 14 su `hermes-requirements.txt` (131–144) più 3 su
`openhands-requirements.txt` (145–147). Verificato con
`gh api repos/homun-app/homun-core/dependabot/alerts -f state=open -f per_page=100`.

## Gruppo A — snapshot di evidenza archiviati (17 avvisi: 131–147)

`docs/research/evidence/2026-09-23-agent-runtime/hermes-requirements.txt` e
`openhands-requirements.txt` sono snapshot congelati dei requisiti di progetti
esterni (Hermes e OpenHands), raccolti come evidenza di ricerca. Non sono
manifesti installati: nessun ambiente, CI o build li consuma. La cartella
`docs/research/` è un archivio immutabile: i file non vanno modificati né
rinominati.

Motivo dismiss: **`not_used`** — «File di evidenza archiviato di progetti
esterni, non installato in nessun ambiente; la cartella docs/research/ è un
archivio immutabile».

### Nota su `exclude-paths` in `dependabot.yml`

Verificato sulla documentazione ufficiale aggiornata
([Dependabot options reference](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)):

> «Use `exclude-paths` to specify paths of directories and files that
> Dependabot should ignore when scanning for manifests and dependencies.»
> «All files and directories matching the specified paths are ignored during
> **update scans** for the given package-ecosystem entry.»

La reference disciplina le **scansioni di update** (PR di version update e di
security update): non c'è alcuna affermazione secondo cui `exclude-paths`
sopprima gli avvisi del prodotto Dependabot Alerts, che è configurato dalle
impostazioni del repository (Settings → Code security) e non dal
`dependabot.yml`. Un `dependabot.yml` con `exclude-paths` su `docs/research/**`
quindi **non chiuderebbe né prevenirebbe** questi 17 avvisi. Non si propone
alcun file di configurazione: per il gruppo A l'unica strada è il dismiss.
(Il repository oggi non ha alcun `dependabot.yml`; crearne uno solo per
l'esclusione non è utile e introdurrebbe PR di version update mai richieste.)

### Comandi dismiss pronti (gruppo A, motivo `not_used`)

```bash
for n in 131 132 133 134 135 136 137 138 139 140 141 142 143 144 145 146 147; do
  gh api -X PATCH "repos/homun-app/homun-core/dependabot/alerts/$n" \
    -f state=dismissed \
    -f dismissed_reason=not_used \
    -f dismissed_comment="Snapshot di evidenza archiviato (docs/research/evidence/2026-09-23-agent-runtime), requisiti di progetti esterni non installati in nessun ambiente. Archivio immutabile, nessuna azione possibile nel codice."
done
```

## Gruppo B — `uv.lock` inesistente su `main` (8 avvisi: 126, 127, 153–158)

Il manifest `uv.lock` **non esiste sul branch `main`**: l'avviso proviene dalla
storia di `origin/legacy/homun-core`. I lock reali del motore sono
`engine/requirements.lock` e `engine/requirements-packaging.lock`
(`engine/uv.lock` è ignorato da git, vedi `engine/.gitignore`).

Prova riproducibile:

```bash
$ git fetch origin main
$ git ls-tree origin/main --name-only | grep -c '^uv.lock$'
0
$ git cat-file -e origin/main:uv.lock
fatal: path 'uv.lock' does not exist in 'origin/main'
```

Motivo dismiss: **`inaccurate`** — «Il manifest uv.lock non esiste su main;
l'avviso deriva dalla storia del branch legacy homun-core».

(Nota: gli stessi 8 pacchetti sui lock reali del motore sono stati verificati
con `pip-audit` nella PR sopra citata — gruppo E — e due vulnerabilità reali
sono state corrette; `requirements.lock` e `requirements-packaging.lock` oggi
risultano puliti.)

### Comandi dismiss pronti (gruppo B, motivo `inaccurate`)

```bash
for n in 126 127 153 154 155 156 157 158; do
  gh api -X PATCH "repos/homun-app/homun-core/dependabot/alerts/$n" \
    -f state=dismissed \
    -f dismissed_reason=inaccurate \
    -f dismissed_comment="uv.lock non esiste su main (git cat-file -e origin/main:uv.lock fallisce); l'avviso proviene dalla storia di origin/legacy/homun-core. I lock reali del motore (engine/requirements*.lock) sono verificati con pip-audit nella PR fix(deps) del 2026-10-10."
done
```

## Gruppo D — residuo solo-build di `electron-builder` (alert 130)

L'alert 129 (`http-cache-semantics`, high) è risolto dalla PR
(`electron-builder` 26.15.3 → 26.17.0 porta `http-cache-semantics` 4.3.0,
fuori dal range vulnerabile `<=4.2.0`).

L'alert 130 (`sprintf-js`, medium) **non è correggibile**: a monte non esiste
alcuna versione patchata di `sprintf-js` (tutta la 1.x è vulnerabile) e le
vie pulite (roarr ≥ 4 / `@electron/get` ≥ 4) richiedono un bump major della
toolchain di download di Electron, escluso dalla policy. Esposizione
solo-build: il test di allowlist (`apps/desktop/tests/packaging.test.cjs`)
verifica che l'app pacchettizzata contenga esattamente `package.json` + `src`,
e l'unica dipendenza runtime è `electron-updater`; `sprintf-js` non è mai
incluso nell'app distribuita.

Motivo dismiss: **`tolerable_risk`** — «Dipendenza solo-build di
electron-builder, non inclusa nell'app distribuita (allowlist di packaging);
nessuna versione corretta disponibile senza bump major della toolchain di
download Electron».

### Comando dismiss pronto (gruppo D, motivo `tolerable_risk`)

```bash
gh api -X PATCH "repos/homun-app/homun-core/dependabot/alerts/130" \
  -f state=dismissed \
  -f dismissed_reason=tolerable_risk \
  -f dismissed_comment="Dipendenza solo-build (electron-builder -> @electron/get -> global-agent -> roarr -> sprintf-js): non compare nell'app distribuita, verificata dall'allowlist di packaging (apps/desktop/tests/packaging.test.cjs). Nessuna versione patchata di sprintf-js esiste; il fix richiede @electron/get >= 4 (major) che tocca il download di Electron."
```

## Nota — copertura parziale dell'override `katex` (alert 151)

L'override `katex` in `package.json` chiude l'alert 151 e porta a
0.19.0 la copia di KaTeX risolta da npm, usata dal rendering delle formule di
`MessageResponse` (`@streamdown/math` → `rehype-katex`), cioè dove arriva
testo esterno (output del modello, messaggi dei collaboratori).
La versione è stata portata da `^0.18.11` a `^0.19.0` (2026-10-15): la 0.18.11
era stata pubblicata per errore con cambiamenti incompatibili e npm avvisa di
usare la 0.19.0, che li ripubblica come release regolare (le note di rilascio
documentano come unica rottura la segnalazione dei glifi mancanti via strict
con codice `symbolNotInFont`; `rehype-katex` passa `strict: 'ignore'`, quindi
non ci tocca).

Verifica del rendering con la 0.19.0 (2026-10-15, dev server + componente
reale): inline `$$e^{i\pi}+1=0$$` e blocco con recinto `$$` su più righe sono
resi correttamente. Tre precisazioni emerse: il singolo dollaro `$...$` è
disattivato dal default di `@streamdown/math`
(`singleDollarTextMath: false`) e `\(...\)` non è supportato da remark-math;
il blocco display richiede il recinto su righe separate; il CSS
`katex/dist/katex.min.css` restituito da `getStyles()` oggi non è incluso da
nessuna pagina dell'app, quindi le formule arrivano senza foglio di stile.

La correzione **non copre** le formule dentro i diagrammi mermaid: `mermaid`
11.17.2 incorpora nella propria distribuzione una copia di **KaTeX 0.16.47**
(`node_modules/mermaid/dist/chunks/mermaid.esm/katex-*.mjs`), che nessun
override può sostituire e che `npm audit`/Dependabot non vedono, perché
leggono il lockfile e non il bundle. Il codice vulnerabile resta quindi
nell'app per quella strada, anche se l'alert risulterà chiuso.

Rischio residuo basso: l'advisory (GHSA-238p-pmpm-9mq7, severità low) è
sfruttabile solo in presenza di una prototype pollution già esistente
nell'applicazione. Effetto collaterale possibile: il CSS caricato è quello di
KaTeX 0.19 (`@streamdown/math` → `katex/dist/katex.min.css`), mentre mermaid
produce markup 0.16; poiché la 0.18 ha rinominato alcune classi interne, le
formule _dentro_ i diagrammi mermaid possono avere difetti di stile.

Da rivedere quando `mermaid` passerà a KaTeX ≥ 0.18.2: a quel punto l'override
diventa superfluo e va rimosso.

## Riepilogo

| Gruppo    | Avvisi                | Azione                                                                                                                |
| --------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A         | 131–147 (17)          | dismiss `not_used` (evidenza archiviata, non installata)                                                              |
| B         | 126, 127, 153–158 (8) | dismiss `inaccurate` (uv.lock assente su main)                                                                        |
| C         | 128, 148–152 (6)      | risolti dalla PR (lockfile radice aggiornato)                                                                         |
| D         | 129                   | risolto dalla PR (electron-builder 26.17.0)                                                                           |
| D         | 130                   | dismiss `tolerable_risk` (solo-build, no fix disponibile)                                                             |
| E (nuovo) | —                     | 4 vulnerabilità reali nei lock del motore trovate da pip-audit e corrette dalla PR (pydantic-ai 2.53.0, pyjwt 2.15.0) |
