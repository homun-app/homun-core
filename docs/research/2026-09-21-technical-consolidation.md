# Consolidamento tecnico — 21 settembre 2026

> Ripresa e completamento del piano `docs/superpowers/plans/2026-09-21-technical-consolidation.md`, interrotto a metà su un working tree non committato. Questa relazione registra cosa è stato integrato, con quali prove e quali limiti restano aperti.

## Stato alla ripresa

Il lavoro interrotto conteneva: routing dell'intake revisionato (con test), ciclo vita dei materiali (`project-materials-lifecycle`) con guardie e fallimenti tipizzati, componente `EngineResultReview` condiviso, modalità di cifratura esplicita lato motore con test isolati dal Keychain. Mancavano: un errore di tipi su `EngineResultReview` (exactOptionalPropertyTypes), il banner operativo a riposo (regressione scritta ma non soddisfatta) e il confine backup della cifratura (`create_backup(encryption_key=…)` non implementato).

## Completamenti

- **Review condivisa.** `EngineResultReview` tipizza `artifactId?: string | undefined`; il confronto CSV lo usa al posto dei controlli inline e la richiesta di correzioni obbliga un commento (`engine-work-review`).
- **Avvisi operativi.** `ConversationEngineBanner` a riposo sano non renderizza nulla; con connessione persa mostra l'avviso e un retry sempre abilitato (nessun controllo disabilitato); la simulazione resta etichettata «Fonte: simulazione».
- **Backup cifrato.** `create_backup`/`verify_backup`/`restore_backup` accettano `encryption_key`: la copia di backup usa lo stesso driver e la stessa chiave della sorgente (mai ritrasformata in chiaro), la verifica senza chiave o con chiave errata fallisce con `BackupError`, il restore copia i byte verificati. Le eccezioni `EncryptionError` di `_open_connection` sono mappate in `BackupError`.

## Verifica

- Suite: motore **453 superati, 1 saltato** (inclusi i 10 di cifratura con backup); frontend **183 superati** (incluse le regressioni avvisi, routing, materiali, review); typecheck e build puliti; architettura 15/15.
- GUI su profilo usa-e-getta (engine 8767, web 4185): banner assente a riposo; richiesta di lavoro dopo accordo di preparazione confermato → **proposta di revisione supervisionata** (capability aggiornata a confronto CSV); ciclo review completo — report → «Richiedi correzioni» con commento → lavoro riaperto e selezione nuovamente disponibile → secondo confronto → «Approva il risultato e concludi il lavoro» → stato Completato coerente in card, pannello e prossimo passo.

## Limiti e prossimi passi

- Un `prepare` con `expected_version` stantia fallisce con 409 mostrato come errore, senza recupero automatico dello stato: chiudere il ciclo con un refresh e ripetizione guidata.
- La cifratura resta una modalità esplicita (`HOMUN_WORKSPACE_KEY_FILE` o chiave passata): nessuna migrazione di workspace esistenti in chiaro, nessuna gestione della perdita/rotazione della chiave, distribuzione del wheel `sqlcipher3` da definire (D-CRYPTO-01).
- I backup v1 trasportano solo il database workspace: materiali e blob restano fuori dal perimetro.
- Il piano multi-fase (accordo → fasi con più collaboratori) resta il gap strutturale di prodotto registrato nella discussione del 21 settembre; la revisione supervisionata dell'accordo è il primo mattone già disponibile.
