# Registro delle capacità — consegna e verifica

**Data:** 20 settembre 2026, tranche successiva a [distinzione domanda/lavoro](2026-09-19-distinzione-domanda-lavoro.md).
**Perimetro:** prima slice della priorità C della [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md): estrarre dal confronto CSV un registro unico di capacità senza cambiarne il comportamento.
**Branch:** `fabio/production-foundations`, working tree con tutta l'implementazione precedente intatta più questa tranche.

## Cosa è stato costruito

1. **Registro puro** (`engine/src/homun/domain/capabilities.py`): fonte singola per `compare_csv` (eseguibile; versione tool `price-comparison-v1`; input/output tipizzati; effetti: artifact in revisione umana, nessun invio esterno; prerequisiti; limiti 2 MiB/material, 10.000 righe, 3 tentativi; timeout) e `general` (sola preparazione). Il confronto CSV attinge ora versione tool e limiti dal registro (`price_comparison_policy`/`price_comparisons` non li duplicano più). Essere registrati, esistere ed essere autorizzati restano concetti distinti: il registro descrive, le policy decidono, l'approvazione vincola argomenti e revisioni.
2. **Disponibilità interrogabile** (`policy/capabilities.py` + `GET /v1/workspaces/{ws}/capabilities`): catalogo per attore con `ready` e `eligible_materials` calcolati dallo stato corrente (materiali gestiti attivi entro i limiti, in progetti leggibili). Nessun permesso concesso.
3. **Intake alimentato dal registro**: la sintesi del brief riceve il catalogo reale e il prompt descrive le capacità da lì (niente più vocabolario hardcoded nel prompt, tolto anche «analista di listini»); la capability scelta è validata dal registro.
4. **Fallback collaboratore per roster vuoto** (scoperto in verifica): con un workspace al primo avvio il modello piccolo restituiva lavoro eseguibile senza collaboratore e la proposta moriva in modo recuperabile. Ora il registro porta un profilo riutilizzabile predefinito per le capacità eseguibili e il motore lo applica quando il roster è vuoto: la regola «eseguibile ⇒ collaboratore confermabile» non dipende dalla disciplina del modello. Nessun profilo viene creato senza conferma umana esplicita.

## Due difetti trovati e corretti durante la verifica col modello reale

- **Disponibilità mal presentata al modello:** la prima versione del catalogo verso il modello includeva `ready: false, materiali: 0`; il modello declassava le richieste CSV a `general` «perché i file non ci sono ancora» e copiava i prerequisiti dentro `changed_fields`. Correzione: il catalogo verso il modello è minimale (id, tipo, sommario, limiti) e il prompt impone di scegliere la capability da ciò che la persona chiede, mai dai materiali attuali; disponibilità e dettagli IO restano nell'endpoint HTTP.
- **Valori estranei in `changed_fields`:** vengono scartati prima della validazione (l'insieme dichiarato può solo restringersi: più conservazione, mai meno). Un test che si aspettava l'esito fatale è stato aggiornato alla nuova semantica.

## Prove eseguite (distinte per tipo)

**Deterministici motore** (387 passati, 1 saltato; nuovi in `test_capabilities.py` e `test_intake.py`): registro che rifiuta capacità sconosciute; sincronizzazione registro ↔ Literal del trasporto intake; identità/limiti del tool dal registro; catalogo con disponibilità reale (0/2 materiali; attore senza accesso vede 0); contratto HTTP del catalogo (404 su workspace errato); sintesi alimentata dal catalogo senza segnali di disponibilità; fallback roster vuoto end-to-end (proposta con nuovo profilo, conferma che richiede `create_agent`, nessun grant creato).

**Frontend:** 157 test passati, typecheck, build web/prototipo (nessun codice UI cambiato in questa tranche), architettura 0 errori/29 avvisi, `git diff --check` pulito, OpenAPI rigenerata e verificata con `--check`.

**Modello reale (Qwen3.5:4b, profili temporanei):** diagnosi con replay esatto dei messaggi di `synthesize` (output grezzo catturato per entrambi i difetti sopra); dopo le correzioni: proposta valida con `compare_csv` e collaboratore; conferma; precisazione solo-staffing con conservazione integrale del brief e diff veritiero; una formulazione indiretta («affidalo a Ada invece») è stata ignorata dal modello (diff vuoto corretto, nulla cambiato) e la formulazione esplicita ha prodotto `staffing: Bruno → Ada` con obiettivo identico — vizio di qualità del modello piccolo già documentato, non del motore.

**GUI (browser su motore temporaneo, roster vuoto):** richiesta di confronto → proposta valida con capacità CSV e scheda «È un nuovo collaboratore da creare… non aggiunge strumenti o permessi» con istruzioni del profilo predefinito; prima della correzione la stessa richiesta falliva due volte con `intake_invalid_response` (provato anche il percorso di recupero). Nota di metodo: invio via submit nativo del form per il problema di consegna tasti/click di questa sessione IAB, già documentato nella tranche precedente.

**Pacchetto:** build desktop riuscita, **8/8 test** col motore incorporato.

## Build di riferimento

- App: `dist/desktop/2026-09-20T09-16-05-003Z/Homun-darwin-arm64/Homun.app`
- ZIP: `dist/desktop/2026-09-20T09-16-05-003Z/Homun-0.1.0-macos-arm64.zip`
- SHA-256: `0947affd4b0a76d9d509fead97e683162a6dfab2068f2a0ea752e922289f1d82`
- Non firmata e non notarizzata: candidato locale, non una release. Le build precedenti restano come prove storiche.

## Accettazione della slice (dal passaggio) e stato

- «Tool assente/negato non viene proposto come eseguibile»: il registro è la sola fonte del vocabolario (test di sincronizzazione; capacità non registrate rifiutate).
- «Cambi di fonti o argomenti invalidano approvazioni; retry/restart non duplicano effetti»: invariati e coperti dalla suite CSV esistente (377→387 tutti verdi).
- «Output e contesto limitati»: limiti dal registro, applicati dove già applicati prima (nessun allargamento).
- Test e demo CSV conservati.

## Limiti rimasti

- Il registro descrive due capacità; la seconda capacità locale limitata del passaggio (lettura autorizzata di un materiale → artifact) non è ancora implementata: è il passo successivo naturale (C2).
- La disponibilità (`ready`/`eligible_materials`) è esposta ma non ancora consumata dalla UI; il modello non la vede di proposito.
- `changed_fields` tollera valori sconosciuti scartandoli: più conservazione, ma l'eco del modello non è registrata da nessuna parte (nessun audit dell'output scartato).
- La qualità del modello piccolo resta non certificata (già documentato): in questa tranche ha ignorato una formulazione indiretta di cambio collaboratore e, prima delle correzioni, declassava lavori eseguibili a `general`.
- Aperti i limiti storici: budget aggregati, delega operativa, skill portabili, cifratura, firma/notarizzazione, identità multiutente, test mount/unmount React del ciclo di refresh.

## Riproduzione della prova con modello reale

Come nelle tranche precedenti (Ollama `qwen3.5:4b`, `HOMUN_DATA_DIR` temporaneo, `--dev-insecure`, `npm run dev`): da workspace vuoto, richiesta di confronto listini → proposta con capacità CSV e profilo predefinito da creare; `curl -H "X-Homun-Actor-Id: person_fabio" .../v1/workspaces/ws_local/capabilities` per il catalogo con disponibilità. Il profilo reale in `~/Library/Application Support/Homun/engine` non è stato toccato.
