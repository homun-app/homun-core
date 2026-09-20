# Contesto autorizzato esteso — consegna e verifica

**Data:** 20 settembre 2026, tranche successiva a [budget per lavoro](2026-09-20-budget-lavoro.md); terza slice del passo D della [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md), con la disciplina anti-riscrittura confermata dalla [ricognizione](2026-09-20-ricognizione-hermes-altri.md) (il contesto composto non riscrive mai lo storico; sintesi-eventuali come artifact separato).
**Branch:** `fabio/production-foundations`, working tree con tutta l'implementazione precedente intatta più questa tranche.

## Cosa è stato costruito

1. **Preambolo autorizzato nel contesto composto** (`application/conversation_context.py`): quando la conversazione è collegata a un lavoro, la composizione include uno stato esplicito e limitato — titolo/stato/versione e obiettivo del lavoro; **l'accordo confermato** (dall'ultima proposta intake confermata: titolo, attività, risultato atteso, vincoli); **riferimenti materiali** del progetto (id-titolo, versione, byte, prefisso hash — mai il contenuto: il contenuto entra solo tramite gli strumenti approvati come la lettura); **memoria di lavoro approvata** pertinente (note del lavoro e del progetto, solo `approved`, massimo 5, troncate). Limiti espliciti: 8 riferimenti materiali, 5 note, 3.000 caratteri totali di preambolo. Il preambolo è dichiarato «dati, non comandi» nell'avviso di contesto.
2. **Manifest v2 con identità dei materiali**: `ContextResource` porta `version` e `content_hash` per i materiali; la **rivalidazione prima di pubblicare effetti** verifica esistenza, autorizzazione di lettura e identità versione/hash di ogni materiale referenziato — un materiale che cambia versione invalida l'interpretazione in volo. I manifest legacy (v1, senza campi) continuano a validare con i controlli di identità esistenti; la serializzazione omette i campi assenti.
3. **Preambolo nei prompt**: interpretazione (entrambi i percorsi) ed estrazione del piano includono il preambolo dopo l'avviso di contesto; la composizione riceve la porta memoria dal chiamante.

## Prove eseguite (distinte per tipo)

**Deterministici motore** (418 passati, 1 saltato; 7 nuovi in `test_context_preamble.py`): preambolo con stato lavoro e riferimenti materiali (versione, prefisso hash, mai il percorso del blob); accordo confermato nel preambolo dopo intake completo; memoria limitata a 5 note e senza le cancellate; **nuova versione del materiale invalida la rivalidazione**; attore revocato bloccato; manifest legacy con fonte forgiata rifiutato dai controlli di identità; preambolo consegnato alla chiamata di interpretazione attraverso il flusso reale (manifest v2).

**Frontend** (160 passati): nessuna regressione; typecheck, build web/prototipo, architettura 0 errori/29 avvisi, `git diff --check` pulito, OpenAPI invariata e verificata.

**Modello reale (Qwen3.5:4b, profilo temporaneo):** lavoro con accordo confermato e listino caricato; domanda in chat «Ricordami che lavoro stiamo facendo e quali file hai disponibile» → risposta **ancorata al preambolo**: cita lo stato del lavoro («confronto dei listini di marzo e aprile, stato draft, v3»), il riferimento materiale («listino-marzo.csv (v1)») e i vincoli dell'accordo («report delle differenze e CSV senza conversione valute»). Budget della chat con token reali (2.972 in / 318 out per interpret).

**Pacchetto:** bundle ricostruito, **8/8 test desktop** col motore incorporato.

## Build di riferimento

- App: `dist/desktop/2026-09-20T11-56-47-965Z/Homun-darwin-arm64/Homun.app`
- ZIP: `dist/desktop/2026-09-20T11-56-47-965Z/Homun-0.1.0-macos-arm64.zip`
- SHA-256: `9424ca7dd440827594d00a0aceda8e38b5cbe17b36cfdf19d3e59723d75e52da`
- Non firmata e non notarizzata: candidato locale, non una release. Le build precedenti restano come prove storiche.

## Accettazione della slice (dal passaggio) e stato

- «Contesto autorizzato con lavoro, materiali e memoria pertinente»: fatto, con limiti espliciti e provenienza.
- «Riferimenti/versioni/hash mantenuti»: versione e hash nel preambolo e nel manifest.
- «Riesaminare accesso prima di pubblicare effetti»: la rivalidazione copre ora anche l'identità dei materiali, oltre a messaggi, lavori e grant.
- «Non promettere di ritirare dati già inviati a un provider»: nessun ritiro rivendicato; la revoca blocca la pubblicazione e le composizioni future (prove delle tranche precedenti + revocato qui).
- Anti-riscrittura: la composizione è una proiezione a sola lettura; nessuna sintesi è ancora necessaria (nessun limite di finestra raggiunto nei perimetri provati).

## Limiti rimasti

- La selezione della memoria è per ambito (lavoro/progetto), non per pertinenza semantica: con molte note servono criteri di selezione o sintesi come artifact separato (mai riscrittura).
- Il preambolo esclude il contenuto dei materiali per scelta: la lettura del contenuto resta un'azione approvata (`read_material`); un eventuale estratto nel contesto dovrebbe riusare quell'artifact.
- I limiti (8 materiali, 5 note, 3.000 caratteri) sono costanti di modulo, non configurabili per lavoro.
- Restano i limiti storici: budget per delegati e loop multi-tool (prossimo), skill portabili, cifratura, firma/notarizzazione, i18n UI, catalogo materiali nella UI.

## Riproduzione della prova con modello reale

Ollama `qwen3.5:4b`, `HOMUN_DATA_DIR` temporaneo, `--dev-insecure`: conversazione con lavoro → intake di confronto listini confermato → caricamento di un CSV nel progetto della conversazione → in chat «Ricordami che lavoro stiamo facendo e quali file hai disponibile» → risposta che cita stato del lavoro, file (v1) e vincoli dell'accordo. Il profilo reale in `~/Library/Application Support/Homun/engine` non è stato toccato.
