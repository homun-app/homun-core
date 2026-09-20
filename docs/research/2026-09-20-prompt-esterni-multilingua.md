# Prompt esterni e multilingua — consegna e verifica

**Data:** 20 settembre 2026, tranche successiva a [registro delle capacità](2026-09-20-registro-capacita.md).
**Richiesta di Fabio:** il sistema deve essere multilingua e i prompt vanno tenuti separati dal codice.
**Branch:** `fabio/production-foundations`, working tree con tutta l'implementazione precedente intatta più questa tranche.

## Cosa è stato costruito

1. **Prompt come dati del pacchetto** (`engine/src/homun/prompts/**.txt`): synthesize e classify dell'intake, istruzioni di interpretazione e pianificazione, hint di schema. Un modulo store (`models/prompt_store.py`) carica per nome, gestisce la catena di fallback linguistico (lingua richiesta → default → neutro → qualsiasi variante disponibile, mai un fallimento per una traduzione mancante) e sostituisce i segnaposti `{{nome}}` con sostituzione letterale (niente `str.format`, le graffe JSON restano sicure). Segnaposto irrisolti → errore immediato. `ModelRegistry` possiede lo store configurato con `HOMUN_LANGUAGE` (default `it`).
2. **Multilingua a due livelli.** Infrastruttura: varianti it/en di ogni template, selezione per workspace (`HOMUN_LANGUAGE`) e per richiesta (campo `language` opzionale su `POST /intake`, via API o passato automaticamente dal frontend). Comportamento: il classificatore rileva la lingua della richiesta (`language` nel JSON che già restituisce) e il frontend la inoltra alla proposta; il template viene scelto nella lingua giusta.
3. **Bundle e ricevuta**: i `.txt` dei prompt sono input di build e source hash sia in `tools/build_engine_bundle.py` sia nel controllo di congruenza di `apps/desktop/scripts/package-app.mjs` (i due hash allineati); hatchling e `collect_all` li includono nel binario — verificato nell'estratto del bundle.
4. **Contenuto del registro verso il modello rivisto**: resta nascosta solo la disponibilità (`ready`, materiali idonei), che causava il declassamento; il dettaglio IO (input/effetti/prerequisiti) torna al modello perché ancora la lingua dell'output e non ha mai causato il declassamento (verificato in entrambe le direzioni).

## Cosa ha richiesto attenzione (verifica col modello reale, temperatura 0)

Il modello locale Qwen3.5:4b è deterministico e molto sensibile ai byte del prompt; ogni esperimento è stato ripetuto 3 volte.

- **Il file italiano deve restare byte-identico al prompt verificato**: un ritorno a capo dopo "Schema:" bastava a invertire la scelta della capacità verso `general`. Il template `synthesize.it.txt` è la trascrizione esatta del testo inline verificato in C1; le regressioni osservate durante la tranche erano del modello, dimostrato rilanciando il prompt inline originale (falliva identico). conclusione: i file esterni non hanno cambiato il comportamento del percorso italiano.
- **La lingua di uscita del 4B segue la massa linguistica del contesto**, non le istruzioni: con template inglese e payload spogliato scriveva italiano; il dettaglio IO nei dati (che include descrizioni italiane) sposta l'ancoraggio. Con testo inglese sufficiente + template inglese l'output è inglese stabile (3/3); con richieste inglesi molto brevi il 4B ricade sull'italiano (verificato con testo corto/lungo a parità di `language='en'`). Le direttive di lingua esplicite nel prompt (provate in tre posizioni) non hanno migliorato il 4B e sono state rimosse: la catena strutturale (rilevamento + selezione template) è il meccanismo affidabile.
- **Il percorso di revisione conserva il brief precedente anche se la precisazione è in un'altra lingua**: comportamento voluto (B1), osservato in GUI con una richiesta inglese su una proposta italiana in attesa.

## Prove eseguite (distinte per tipo)

**Deterministici motore** (393 passati, 1 saltato; nuovi in `test_prompt_store.py`): sostituzione segnaposto e segnaposto irrisolto; catena di fallback che non fallisce mai per una traduzione mancante; presenza dei template di produzione in it+en e degli hint neutri; store configurato sul registry; fallback dello store per i fake di test; etichette del catalogo per lingua. Aggiornati: asserzioni della classificazione (tuple con lingua), catalogo verso il modello (solo disponibilità nascosta).

**Frontend** (158 passati): classificazione che restituisce `{kind, language}`; proposta che porta `language` solo se presente; routing che propaga la lingua con ricaduta sicura. Typecheck, build web/prototipo, architettura 0 errori/29 avvisi, `git diff --check` puliti, OpenAPI rigenerata e verificata.

**Modello reale (Qwen3.5:4b, profili temporanei)**: replay esatti con cattura dei byte per ogni diagnosi; catena completa su server: richiesta inglese → classify `{work_request, language:'en'}` → proposta con lingua → **brief in inglese con compare_csv** (3/3 con testo esteso); richiesta italiana default → brief in italiano con compare_csv (3/3); caso testo inglese breve documentato come limite del modello.

**GUI (browser su motore temporaneo):** moduli serviti verificati aggiornati (lingua propagata da classify a propose); richiesta inglese estesa da conversazione esistente → percorso di revisione che conserva il brief precedente (corretto); richiesta inglese breve → scheda italiana, coerente con il limite del modello verificato via API. Invio via submit nativo del form per il noto problema di consegna tasti della sessione IAB.

**Pacchetto:** bundle motore ricostruito con i prompt dentro (`_internal/homun/prompts/**`), ricevuta estesa, packaging allineato (il controllo "Stale engine source" ora copre anche i `.txt`), **8/8 test desktop** col motore incorporato.

## Build di riferimento

- App: `dist/desktop/2026-09-20T10-16-24-832Z/Homun-darwin-arm64/Homun.app`
- ZIP: `dist/desktop/2026-09-20T10-16-24-832Z/Homun-0.1.0-macos-arm64.zip`
- SHA-256: `b4f6b471b359279d76cfe0145b896b6984e3038713a4385647d9dea418ceb56f`
- Non firmata e non notarizzata: candidato locale, non una release. Le build precedenti restano come prove storiche.

## Limiti rimasti

- **La UI resta italiana**: l'i18n delle stringhe dell'interfaccia è un lavoro separato, non richiesto in questa tranche.
- **Il contenuto del registro capacità è in italiano** (sommari, profilo predefinito): il multilingua riguarda la lingua dell'output del brief, non la traduzione dei dati del registro.
- **Il 4B locale è il collo di bottiglia**: l'inglese è stabile con richieste con sufficiente segnale linguistico; richieste brevi in altra lingua ricadono sulla lingua del template. Un modello più capace sulla stessa infrastruttura non avrebbe questo limite. Lingue oltre it/en hanno il template solo se aggiunto (il fallback protegge).
- I prompt sono versionati col codice (comportamento del motore): editing a runtime o per-workspace richiederebbe provenienza/revisione, non previsto qui.
- La lingua rilevata dalla classificazione viaggia solo nel percorso del primo messaggio via frontend; una proposta inviata direttamente via API senza `language` usa il default del workspace (comportamento documentato nel contratto).
- Restano i limiti storici (budget aggregati, seconda capacità, cifratura, firma/notarizzazione, identità multiutente, test mount/unmount React).

## Riproduzione della prova con modello reale

Ollama `qwen3.5:4b`, `HOMUN_DATA_DIR` temporaneo, `--dev-insecure`: `POST /works/{id}/intake/classify` con testo inglese esteso → `{"kind":"work_request","language":"en"}`; `POST /works/{id}/intake` con lo stesso testo e `"language":"en"` → brief in inglese; senza `language` → italiano. Per un workspace in inglese: avviare il motore con `HOMUN_LANGUAGE=en`. Il profilo reale in `~/Library/Application Support/Homun/engine` non è stato toccato.
