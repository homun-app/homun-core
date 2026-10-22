# Errori multilingua — il motore restituisce codici, la lingua la sceglie l'utente

Data: 2026-10-15 · Branch: `feat/i18n-errors` · Stato: **disegno in approvazione (Fase 0)**

## Principio

Il motore non compone frasi per l'utente negli errori: restituisce dati stabili e
leggibili da una macchina (`code`, `reason`, `params`, `message` tecnico in inglese).
La frase si compone nella lingua dell'utente da un **catalogo condiviso** da motore
e client, una voce per `reason`. È il modello di RFC 9457 (Problem Details): tipo
stabile + campi strutturati, testo leggibile separato.

## Dati raccolti (censimento AST su `engine/src`, non a intuito)

Censimento con parser AST di tutti i `raise` di classi `DomainError`
(`tools` di analisi riutilizzabili in `tools/census_domain_raises.py`):

| Classe                                 | raise   |
| -------------------------------------- | ------- |
| `ValidationError`                      | 581     |
| `ConflictError`                        | 199     |
| `PermissionDeniedError`                | 91      |
| `NotFoundError`                        | 84      |
| `BackendUnavailableError`              | 6       |
| `BudgetExhaustedError`                 | 3       |
| `CommandInProgressError`               | 2       |
| `DomainError`/`InvalidTransitionError` | 3       |
| **Totale**                             | **969** |

Più **100** `raise HTTPException(..., detail={"code", "message"})` letterali nelle
rotte → **1.069 corpi d'errore strutturati** complessivi (il «~1.370» del compito
includeva anche `HTTPException` con `detail` non dizionario; i numeri per classe
coincidono). Solo **14** messaggi di `raise` sono in italiano; il resto è già
inglese tecnico — la migrazione dei testi riguarda quindi quasi solo il client.

**Raggiungibilità dalle rotte usate dall'app web.** Grafo degli import da
`routes/materials`, `routes/reads`, `routes/domain`, `routes/sessions`,
`routes/domain_support` (le rotte richiamate da `apps/web/src/lib/engine-*` per
materiali, conversazioni, comandi, confronti prezzi): **375 moduli raggiunti, 869
raise su 969 (89%)**. Le differenze restanti sono canali in ingresso, tool
esterni e percorsi desktop.

Chokepoint già esistenti (nessuna nuova ghiacciaia da inventare):

- `routes/domain_support.py:27` `_http_error` mappa `code` → HTTP e compone
  `detail={"code","message"}`: **l'unico punto** dove le rotte serializzano
  `DomainError` (usato da quasi tutte le rotte; `routes/memory.py` ha un
  duplicato locale da unificare — «Reuse first»);
- `routes/domain.py:107-115` eventi SSE `error` con `{code, message}`;
- `routes/materials.py` e poche altre rotte alzano `HTTPException` con `detail`
  dizionario direttamente.

## 1. Corpo d'errore HTTP

Estensione **compatibile** dell'involucro attuale — nessun cliente si rompe:

```json
{
  "detail": {
    "code": "validation_error",
    "reason": "comparison.csv.not_utf8",
    "params": { "source": "listino.csv" },
    "message": "listino.csv: CSV must be UTF-8"
  }
}
```

- `code`: invariato (classe dell'errore, compatibilità totale);
- `reason`: **opzionale** nella transizione — chiave stabile a punti
  (`<area>.<soggetto>[.<dettaglio>]`), assente negli errori non ancora migrati;
- `params`: opzionale, valori semplici (stringhe/numeri) da inserire nella frase;
  **mai** segreti, token o percorsi assoluti dell'utente (test di onda 1);
- `message`: inglese tecnico per log e «Dettagli tecnici».

Stesso trattamento per gli eventi SSE `error` (stesso dizionario) e per i
`HTTPException` letterali delle rotte coinvolti dall'onda 1. I punti di
ri-wrapping tipo `routes/materials.py:33,64,123,157` (che oggi ricopiano
`str(exc)`) inoltrano `reason`/`params` dell'eccezione catturata.

**RFC 9457.** Ne adottiamo la semantica (tipo stabile + campi macchina + testo
separato), non la sintassi: niente `application/problem+json` né `type`/`title`
al livello principale in questa PR. Motivi: l'involucro `detail` annidato è il
contratto di ~30 rotte, degli eventi SSE e del desktop; cambiarlo ora romperebbe
tutti e tre per un guadagno estetico. Mappatura documentata per l'allineamento
futuro (dopo la migrazione completa): `reason` → `type` (URI
`https://homun.dev/errors/comparison.csv.not_utf8`), `code` → `status` +
categoria, titolo dalla voce `codes.<code>` del catalogo. Il campo libero
`reason`/`params` è comunque un'estensione legale di Problem Details.

## 2. Catalogo condiviso

**Posizione: `contracts/i18n/`** — un file JSON per lingua, chiavi = `reason`:

```
contracts/i18n/errors.it.json
contracts/i18n/errors.en.json
```

```json
{
  "$schema": "./errors.schema.json",
  "language": "it",
  "errors": {
    "comparison.csv.not_utf8": "Il file {source} deve essere salvato in UTF-8.",
    "budget.exhausted.delegate": "Il budget di {delegate} è esaurito: alzalo con «Imposta budget»."
  },
  "codes": {
    "validation_error": "La richiesta non è valida. Verifica i dati e riprova.",
    "version_conflict": "I dati sono cambiati mentre agivi. Ricarica e riprova."
  }
}
```

- `errors.*`: una voce per `reason`; segnaposto `{param}`, stessa sintassi di
  `formatString` nel client (`apps/web/src/lib/i18n/index.ts:51`).
- `labels.*`: le etichette tradotte dei valori interni (lati del confronto,
  stati del lavoro, tipi di materiale, entità policy). Un `params` che nomina
  un'etichetta interna — mai un dato inserito dall'utente — trasporta la
  **chiave** di questa sezione e la frase la interpola come `{param@label}`:
  **un solo meccanismo** (`formatErrorPlaceholders` nel client,
  `format_message` nel motore) risolve la chiave nella lingua corrente. Così
  l'utente non legge mai `left`/`right`, `draft`/`running` né `Material`.
- `codes.*`: la frase generica per ogni `code` (sostituisce le stringhe hardcoded
  in `homun-errors.ts`). Comprende anche i codici solo-client
  (`engine_unavailable`, `request_timeout`, …): una sola fonte.
- `errors.schema.json`: JSON Schema del catalogo (chiavi, segnaposto, lingua,
  convenzione `{param@label}`) per validare i file nel test di parità.

**Come lo legge il motore.** Nuovo modulo `engine/src/homun/i18n.py` con un
loader che risolve il catalogo in quest'ordine: `sys._MEIPASS/contracts/i18n`
(bundle PyInstaller) → `contracts/i18n` relativo alla radice del repo (install
editabile `pip install -e .`, test). Se il catalogo manca, errore esplicito al
primo utilizzo (first-class, niente fallback silenzioso a `message`).
`engine/packaging/homun-engine.spec` oggi usa `collect_all('homun')` e non vede
`contracts/`: aggiungiamo una riga `datas` per includere la directory e
verifichiamo con `python3 tools/build_engine_bundle.py` + `engine/packaging/smoke.py`.

**Come lo legge il client.** Import diretto dei JSON, senza copie né codegen:
alias `@homun/contracts/*` → `contracts/*` in `tsconfig.json` e
`apps/web/vite.config.ts` — stesso identico precedente di `@homun/ui` →
`packages/ui/src`. Nei test node (`tests/*.test.ts`, che già importano attraverso
le radici del repo) i JSON si importano con import attributes
(`with { type: "json" }`). Il dizionario UI (`locales/it.ts`/`en.ts`) resta dov'è:
il catalogo errori è un contratto motore↔client, non copia di prodotto.

**Plurali.** Nessuna voce dell'onda 1 conta oggetti (verificato: i parametri sono
nomi di file, limiti, id). Quando serviranno: il valore diventa
`{"one": "…", "other": "…"}` con `_format: "plural"` nel valore; il client
sceglie la forma con `Intl.PluralRules` della lingua corrente, il motore con un
selettore minimale (per it/en bastano `one`/`other`). Rimandato: niente
infrastruttura ICU ora.

## 3. La lingua dell'utente lato motore

- **La lingua è una preferenza della PERSONA, con la lingua del workspace come
  valore predefinito.** Il motore ha già più persone per workspace (F5:
  `Person`, `PersonDevice`, sessioni persona) e i messaggi sui canali vanno a
  una persona precisa. Catena di risoluzione, applicata da
  `application/ops/preferences.py::resolve_language`: **persona →
  conversazione (lingua rilevata) → workspace → inglese** (una richiesta
  esplicita per-request, campo `language` di intake, vince sulla catena perché
  serve al routing). La lingua della conversazione è quella che la persona
  scrive: il turno di ingresso la rileva senza chiamate extra — il modello la
  riporta nell'argomento comune `language` di ogni strumento, e al primo
  turno, prima che esista qualsiasi storia, la rileva il motore stesso dalle
  parole del messaggio (`homun.i18n.detect_language`: deterministico, parole
  grammaticali) così che già il primo prompt parli la lingua del messaggio —
  e il motore la ricorda sulla conversazione; la preferenza esplicita della
  persona vince sempre sulla rilevazione.
- **Persistenza**: chiavi nella tabella `meta` dello storage (`storage/schema.py`
  — key/value già libere, **schema v1 invariato**, nessuna migrazione):
  `language` per il workspace, `language:person:<person_id>` per ogni persona,
  `language:conversation:<conversation_id>` per la lingua rilevata di ogni
  conversazione.
- **Rotte**: `GET/PUT /v1/workspaces/{workspace_id}/people/{person_id}/language`
  per la persona (la propria lingua la imposta la persona stessa; quella di un
  altro serve l'autorità del workspace) e `GET/PUT
/v1/workspaces/{workspace_id}/language` per il default del workspace. Il PUT
  del workspace usa il controllo esistente `require_owner_or_admin`
  (`identity/invites.py`), nessun controllo scritto a mano: senza autorità,
  `permission_denied` con `reason=permission.workspace_authority_required`.
  Il client chiama la rotta persona dentro `setLanguage` con l'attore della
  sessione corrente (best-effort: se il motore è giù, il cambio lingua UI
  riesce comunque e la preferenza verrà rispedita al prossimo avvio). Snapshot
  OpenAPI rigenerato e committato.
- **Uso**: solo per i testi che il motore genera per quella persona (canali,
  chat, intake — `application/work/intake.py` risolve con `person_id=actor.id`).
  Le risposte d'errore HTTP restano **neutrali**: codici, mai frasi; traduce il
  client nella sua lingua corrente.
- **`Accept-Language`: valutato e rinviato.** La preferenza esplicita della
  persona è più forte e più semplice da diagnosticare di un header che può
  arrivare da proxy/desktop.

## 4. Regola di fallback

Composizione lato client (`homunErrorUserMessage`):

1. `reason` presente **e** con voce nel catalogo nella lingua corrente → quella
   frase con `params` (i valori mancanti restano letterali `{param}`);
2. altrimenti → frase generica `codes.<code>` nella lingua corrente;
3. lingua senza quella voce → inglese (`en`), stessa catena;
4. «Dettagli tecnici» sempre disponibili: `code`, `reason` (se c'è), `message`
   originale, codice motore. Il testo inglese tecnico non sparisce mai.

Nel motore la catena è la stessa (il loader espone `user_text(reason, params,
language)`), usata solo dai testi auto-generati. `looksLikeRawException` nel
client resta per gli errori non ancora migrati: con `reason` presente la copia
di prodotto vince sempre, senza annusare il testo.

## 5. Migrazione a ondate

Criterio: ondate per modulo, dimensione ~60–150 raise ciascuna, partendo dai
percorsi che l'utente vede più spesso. Universo raggiungibile dalle rotte web:
869 raise.

| Onda              | Moduli                                                                                                                                                                                     | raise                             | Note                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ----------------------------------------------------- |
| **1 (questa PR)** | sotto, 61 voci / ~74 siti                                                                                                                                                                  | 60 DomainError + 14 HTTPException | materiali+CSV, budget, permessi, conversazioni, piano |
| 2                 | `application/sessions/*` (143), `domain/clarification.py` (12), `domain/command_context.py` (10), testi motore monolingue (recovery narrator, interpretation notices)                      | ~165                              | sessioni native e conversazioni                       |
| 3                 | `application/agent/*` (175)                                                                                                                                                                | 175                               | run degli agenti                                      |
| 4                 | `domain/commands/*` restanti (137), resto `domain/*`                                                                                                                                       | ~145                              | delegation, routines, identity, external              |
| 5                 | `application/work/*` restante (113), `execution/*` (~61), `computer` (52), `automation` (23), `channels` (21), `models`/`tools`/`policy` residui, `HTTPException` letterali restanti (~86) | ~360                              | due sotto-ondate 5a/5b                                |

### Prima ondata — 61 voci (≈74 siti di raise)

Selezione dai dati di raggiungibilità: rotte richiamate da `apps/web`
(upload/lista/blob materiali, comandi conversazione e piano, confronto prezzi,
approvazioni di lettura) e i cinque domini richiesti. Ogni voce: `reason`
(`code`), parametri, punto di raise attuale.

**Materiali — rotta (`routes/materials.py`, HTTPException)**

| reason                                                      | params      | sito attuale                  |
| ----------------------------------------------------------- | ----------- | ----------------------------- |
| `materials.workspace_unknown` (`not_found`)                 | —           | 26, 56, 84, 115, 149 (5 siti) |
| `materials.upload.too_large` (`validation_error`, HTTP 413) | `max_bytes` | 88                            |
| `materials.blob.absent` (`not_found`)                       | —           | 164                           |
| `materials.blob.missing_on_disk` (`not_found`)              | —           | 171                           |
| `materials.blob.integrity_failed` (`version_conflict`)      | —           | 174                           |

**Materiali — ingest e sorgenti**

| reason                                                    | params        | sito attuale                                                      |
| --------------------------------------------------------- | ------------- | ----------------------------------------------------------------- |
| `materials.not_found` (`not_found`)                       | `material_id` | `materials/source.py:18` (+ inoltro nelle rotte 33, 64, 123, 157) |
| `materials.managed_required` (`validation_error`)         | —             | `materials/source.py:21`                                          |
| `materials.size_out_of_range` (`validation_error`)        | `max_bytes`   | `materials/source.py:23`                                          |
| `materials.source_unavailable` (`version_conflict`)       | —             | `materials/source.py:27`                                          |
| `materials.source_integrity_failed` (`version_conflict`)  | —             | `materials/source.py:30`                                          |
| `materials.command_identity_invalid` (`validation_error`) | —             | `application/work/material_ingest.py:33`                          |

**Materiali — comandi di dominio (`domain/commands/materials.py`)**

| reason                                | params                | sito    |
| ------------------------------------- | --------------------- | ------- |
| `materials.project_required`          | —                     | 21      |
| `materials.title_required`            | —                     | 25, 80  |
| `materials.kind_invalid`              | `kind` (eco utente)   | 28, 85  |
| `materials.source_uri_required`       | `kind@label`          | 32, 104 |
| `materials.status_invalid`            | `status` (eco utente) | 101     |
| `materials.content_hash_invalid`      | —                     | 145     |
| `materials.managed_path_invalid`      | —                     | 147     |
| `materials.prepared_metadata_invalid` | —                     | 149     |
| `materials.extraction_status_invalid` | —                     | 151     |

`kind_invalid`/`status_invalid` mostrano l'eco dell'input utente non valido
(il raise scatta solo fuori dall'enum, quindi il valore non è mai un'etichetta
interna); `source_uri_required` interpola la chiave
`materials.kind.note|link|file_ref` tramite `{kind@label}`.

**Approvazioni di lettura materiali (`application/work/material_reads.py`)**

| reason                                 | params | sito |
| -------------------------------------- | ------ | ---- |
| `reads.proposal_not_found`             | —      | 26   |
| `reads.material_not_found`             | —      | 34   |
| `reads.approval.persons_only`          | —      | 40   |
| `reads.approval.not_owner_or_reviewer` | —      | 42   |
| `reads.no_text_extract`                | —      | 68   |
| `reads.already_active`                 | —      | 84   |
| `reads.approval.mismatch`              | —      | 114  |
| `reads.source_changed`                 | —      | 117  |
| `reads.already_closed`                 | —      | 121  |
| `reads.work_changed`                   | —      | 123  |

**Confronto prezzi CSV (`tools/price_comparison.py` — gli unici messaggi oggi in italiano visibili all'utente)**

| reason                             | params                  | sito |
| ---------------------------------- | ----------------------- | ---- |
| `comparison.csv.payload_invalid`   | `side@label`, `max_mib` | 27   |
| `comparison.csv.not_utf8`          | `side@label`            | 31   |
| `comparison.csv.nul_not_allowed`   | `side@label`            | 33   |
| `comparison.csv.rows_limit`        | —                       | 57   |
| `comparison.csv.invalid_structure` | `side@label`            | 90   |
| `comparison.csv.max_rows_invalid`  | `min`, `max`            | 187  |

`side` vale la chiave `comparison.previous`/`comparison.updated` (label:
«listino precedente»/«listino aggiornato»); il testo dell'eccezione `csv`
non entra nei `params`, resta nel `message` tecnico.

**Budget (`domain/budget_ops.py`)**

| reason                      | params | sito   |
| --------------------------- | ------ | ------ |
| `budget.exhausted.work`     | —      | 45     |
| `budget.exhausted.delegate` | —      | 64, 72 |

`budget.exhausted.delegate` non porta `delegate`: sarebbe un id interno
(`person_…`/`agent_…`) non traducibile; l'id resta nel `message` tecnico e la
frase dice «un partecipante».

**Permessi (`policy/*`, `routes/domain_support.py`)**

| reason                                             | params       | sito                          |
| -------------------------------------------------- | ------------ | ----------------------------- |
| `permission.actor_header_missing` (`unauthorized`) | —            | `routes/domain_support.py:12` |
| `policy.conversation_not_found`                    | —            | `policy/work.py:10`           |
| `policy.work_not_found`                            | —            | `policy/work.py:31`           |
| `permission.persons_only.mcp_lifecycle`            | —            | `policy/work.py:56`           |
| `policy.contribution_not_found`                    | —            | `policy/work.py:63`           |
| `policy.entity_not_found`                          | `kind@label` | `policy/commands.py:10`       |
| `policy.intake_unconfirmed`                        | —            | `policy/intake.py:26`         |

**Messaggi e conversazioni**

| reason                                              | params                   | sito                                           |
| --------------------------------------------------- | ------------------------ | ---------------------------------------------- |
| `message.in_progress.same` (`command_in_progress`)  | —                        | `application/sessions/command_delivery.py:102` |
| `message.in_progress.other` (`command_in_progress`) | —                        | `application/sessions/command_delivery.py:104` |
| `message.superseded` (`version_conflict`)           | —                        | `application/sessions/command_delivery.py:168` |
| `work.transition_invalid` (`invalid_transition`)    | `from@label`, `to@label` | `domain/states.py:66`                          |

`from`/`to` valgono le chiavi `work.status.<stato>` (label della sezione
`labels`): la frase italiana dice «da “bozza” a “in esecuzione”», mai
`draft`/`running`.

**Piano (`domain/commands/plans.py` — 13 voci)**

| reason                                | params    | sito |
| ------------------------------------- | --------- | ---- |
| `plan.propose.state_invalid`          | —         | 17   |
| `plan.propose.needs_steps`            | —         | 20   |
| `plan.step.not_object`                | —         | 24   |
| `plan.step.fields_missing`            | —         | 29   |
| `plan.accept.missing`                 | —         | 79   |
| `plan.accept.incomplete`              | —         | 81   |
| `plan.revise.missing`                 | —         | 104  |
| `plan.revise.new_step_not_object`     | —         | 116  |
| `plan.revise.new_step_fields_missing` | —         | 120  |
| `plan.revise.insert_after_unknown`    | `step_id` | 132  |
| `plan.revise.step_remove_unknown`     | —         | 146  |
| `plan.revise.step_succeeded_locked`   | —         | 148  |
| `plan.revise.empty`                   | —         | 152  |

Esclusioni motivate (valutate e rinviate a onda 2+): `policy.event.*` (letture
dello stream eventi, rare), `budget.reservation_*` (riconciliazione interna),
resto di `materials/managed_blobs.py` (guasti di storage sysadmin).

Ogni sito migrato: `raise …Error("technical english message", reason="…",
params={…})` — `message` diventa inglese tecnico (per l'onda 1 quasi tutti
lo sono già; cambiano i 14 italiani, di cui 7 di price-comparison).

## 6. Il debito non può crescere (ratchet)

- Nuovo `tools/error-reasons-baseline.json` sul modello di
  `tools/architecture-baseline.json` (budget congelati che possono solo
  scendere):

  ```json
  {
    "description": "Error literals still without a stable `reason`. Never increase; lower after each migration wave.",
    "domain_raises_without_reason": 969,
    "http_details_without_reason": 100
  }
  ```

- Test del motore `engine/tests/test_error_reason_baseline.py` (poi in CI):
  census AST condiviso in `tools/census_domain_raises.py` (stesso parser di
  questo disegno) conta i `raise` di `DomainError` senza kwarg `reason` e gli
  `HTTPException` con `detail` dizionario senza `reason`; fallisce se un numero
  **sale**; il file baseline si può solo abbassare. Dopo l'onda 1:
  969 → 909 e 100 → 86.
- Il censimento conta i **siti di raise**, non le classi: nessuna scorciatoia
  tipo «un reason generico per modulo».

## Test (TDD, rossi prima dell'implementazione)

Motore:

- `DomainError(msg, reason=…, params=…)` produce `detail` con tutti e quattro i
  campi via `_http_error`; senza `reason` il corpo resta `{code, message}` (un
  errore vecchio non cambia forma);
- SSE `error` include `reason`/`params`;
- i parametri dell'onda 1 non contengono percorsi assoluti né segreti (check
  euristico sui letterali + allowlist delle chiavi).

Catalogo:

- ogni chiave di `errors`/`codes` esiste in **tutte** le lingue (parità, come
  `tests/ui-i18n.test.ts`);
- ogni segnaposto `{x}` usato nelle frasi è dichiarato nei `params` dei raise
  corrispondenti (test che incrocia catalogo e sorgente via census AST, per le
  voci dell'onda 1);
- `errors.schema.json` valida i file.

Client (`tests/`, node):

- stesso errore (`reason`+`params`) reso in italiano e in inglese;
- `reason` sconosciuta → frase `codes.<code>`; lingua mancante → inglese;
- `homun-errors.ts` non contiene più stringhe per l'utente;
- cambio lingua → gli errori già mostrati si aggiornano (notifica ricalcolata).

Playwright: carico un CSV non UTF-8 nel confronto prezzi → avviso in italiano;
cambio lingua in Impostazioni → lo stesso avviso è in inglese.

## Inventario dei testi del motore generati da sé (fuori dagli errori HTTP)

| Testo                                                                        | Oggi                                           | Piano                                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `models/intake.py` `_CATALOG_LABELS` (5 voci)                                | già it+en nel codice                           | **migrato al catalogo in questa PR** (unica serie già bilingue) |
| `application/agent/runs/recovery_narrator.py` (titolo + rapporto, ~10 frasi) | solo italiano                                  | onda 2                                                          |
| `application/sessions/interpretation.py:125,174` (2 notice)                  | solo italiano                                  | onda 2                                                          |
| `application/channels/conversation_bridge.py:153`                            | solo italiano                                  | onda 2                                                          |
| `homun/prompts/*.{it,en}.txt`                                                | template di modello, non frasi deterministiche | **fuori dal catalogo** (input ai prompt, non testo motore)      |
| `app.py` `HOMUN_STARTUP_FAILED`                                              | già neutro (reason codes sullo stdout)         | già conforme, nessun cambiamento                                |

## Rischi e note di implementazione

- Unificare `_http_error` di `routes/memory.py` su `domain_support` (duplicato).
- `HomunClientError` trasporta `reason`/`params` nuovi campi opzionali;
  `homunErrorFromHttp` e `homunErrorFromEngineEvent` li leggono dal `detail`/evento.
- Le etichette UI intorno all'errore (label, «Dettagli tecnici», «Copia») passano
  a `t()` nei dizionari UI: restano copia di prodotto, non catalogo errori.
- Nessun limite in `tools/architecture-baseline.json` viene toccato; nessun file
  web rimosso.
- `tools/export_openapi.py --write` dopo la nuova rotta `language`; snapshot
  committato.

## Esito implementazione (stessa data, PR di Fase 1)

- Il census finale scopre anche le **sottoclassi** di `DomainError` (17 classi
  custom, es. `MaterialTooLargeError`): i numeri veri con questo metodo sono
  **1150** raise senza reason prima dell'onda e **1088** dopo (62 siti
  migrati); i dettagli `HTTPException` letterali passano da **100** a **86**
  (14 siti). Il ratchet (`tools/error-reasons-baseline.json`) parte da lì.
- La prima ondata conta **63 voci** (le 62 delle tabelle + una settima del
  confronto CSV non elencata: `comparison.csv.header_missing`); il catalogo
  include anche `workspace.unknown`, `preferences.language_invalid` (nuova
  rotta) e le 5 voci `intake.catalog.*` portate dal codice: 70 frasi + 17
  generiche per `code`, per lingua.

## Correzioni post-review (stessa PR)

Invariant: **una frase mostrata all'utente è interamente nella sua lingua** —
nessun testo tecnico, nessuna etichetta interna, nessun messaggio di eccezione
nei `params`; il dettaglio tecnico sta solo in `message` («Dettagli tecnici»).

1. **Niente eccezioni grezze nei params.** `comparison.csv.invalid_structure`
   interpolava `str(exc)` della libreria csv: il param `detail` esce dai
   `params` e dalle frasi; l'eccezione resta nel `message`. Il ratchet lo
   impedisce per sempre: `tools/census_domain_raises.py::
params_with_raw_exception_text` segnala i params che referenziano un alias
   di `except` o chiamano `repr()` (test nel baseline).
2. **Le etichette interne sono chiavi del catalogo, non parole.** Nuova
   sezione `labels` del catalogo e UN solo meccanismo `{param@label}` risolto
   dalla lingua corrente, identico nei due lati (`format_message` nel motore,
   `formatErrorPlaceholders` nel client). Migrati: `side` del confronto
   (`comparison.previous`/`comparison.updated` → «listino precedente»/
   «listino aggiornato»), `kind` di `materials.source_uri_required`
   (`materials.kind.*`), `from`/`to` di `work.transition_invalid`
   (`work.status.*`), `kind` di `policy.entity_not_found` (`policy.entity.*`).
   `budget.exhausted.delegate` perde il param `delegate` (id attore interno,
   non traducibile). `kind_invalid`/`status_invalid` restano eco dell'input
   utente non valido (il raise scatta solo fuori enum). Test da entrambi i
   lati con param di esempio condivisi (`contracts/i18n/errors.samples.json`):
   ogni frase italiana composta non contiene enum noti, `left`/`right`, id di
   attori né chiavi di catalogo non risolte.
3. **La lingua è della persona.** §3 riscritto: catena persona → workspace →
   inglese (`resolve_language`), chiavi `language:person:<id>` in `meta`
   (schema invariato), rotte `people/{person_id}/language` (propria lingua:
   la persona; altrui: autorità workspace) e `language` del workspace riservata
   a `require_owner_or_admin` — che ora alza `permission_denied` con
   `reason=permission.workspace_authority_required` (voce di catalogo). Il
   ratchet scende di 1: 1088 → **1087**. Screenshot dell'errore confronto it/en
   in `docs/development/assets/confronto-errore-{it,en}.png` (notifica reale
   dell'app, corpo reale del motore; il pannello confronto non è raggiungibile
   dai mock engine perché `EngineWorkIntake` è montato solo dalla ChatStage
   in modalità simulazione).
