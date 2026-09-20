# Desktop Electron

Shell Electron 44.4.3 e candidato macOS arm64 autonomo con Python incorporato. La build locale non è ancora una release certificata. Vedi [artefatto e prove](../../docs/research/2026-09-19-conversational-intake-ux-verification.md).

```sh
npm ci
npm run engine:install
npm run desktop:dev
npm run desktop:test
# Build autonoma su macOS arm64 con uv disponibile
npm run desktop:build
```

La shell carica la build React dall'origine fissa `homun://app`, con sandbox,
context isolation, Node disabilitato e CSP. Il preload espone soltanto la base URL
locale. Le chiamate API attraversano un proxy ristretto nel processo principale:
il token effimero non entra nel renderer, nei dati persistiti o negli argomenti CLI.

Il processo principale avvia il proprio Python su una porta loopback assegnata dal
sistema e verifica health con autenticazione. Ogni route, comprese letture e health,
richiede la sessione. Una directory ha un unico proprietario. La chiusura attende
l'arresto; cancellazione durante startup e morte improvvisa del proprietario sono
coperte dai test. Il pipe del genitore permette al motore di terminare anche dopo
SIGKILL del desktop. In caso di blocco, l'arresto scala a SIGKILL dopo 10 secondi;
i dati persistiti saranno recuperati all'avvio seguente.

Dati: `<Electron userData>/engine`; per prove usare `HOMUN_DESKTOP_DATA_DIR` e
`HOMUN_DESKTOP_PROFILE` verso directory temporanee. Il profilo desktop usa memoria
SQLite; non avvia servizi Mem0 esterni. Non migra automaticamente il precedente
`~/Library/Application Support/Homun2/engine`.

`electron apps/desktop/src/main.cjs --smoke` verifica renderer, proxy, rifiuto delle
richieste esterne e prova un roundtrip safeStorage su un valore sintetico, se disponibile.
`HOMUN_DESKTOP_SCREENSHOT` salva la finestra di prova. Questo smoke richiede una
sessione grafica utilizzabile. Il primo tentativo con Mac bloccato non era riuscito; successivamente è stata completata una verifica nativa distinta di chat, intake, confronto CSV, report e riavvio. Questo non certifica automaticamente tutti i controlli dello smoke, incluso safeStorage. I test automatici del processo e del proxy restano evidenza distinta dalla GUI.

## Restano requisiti di release

Il percorso packaged è predisposto per `resources/engine/homun-engine` e `resources/web`,
ed è ora popolato dal bundle PyInstaller autonomo. È disponibile uno ZIP locale
con Homun.app. **Firma Developer ID, notarizzazione, aggiornamento e rollback
non sono ancora certificati**. Non creare un installer che
dipenda dal virtualenv di sviluppo. La prova grafica del percorso documentato è passata; restano Mac pulito senza Python/Node, copertura completa di CSP e accessibilità, upgrade e altre piattaforme. Download di report/CSV è provato nel percorso demo, non per ogni possibile artifact. Gli attuali lock filesystem sono macOS/Linux, non Windows.

Il token di sessione protegge il confine locale ed è associato dal launcher al
profilo `person_fabio`, già usato dal client. Il renderer non può impersonare un
altro attore tramite header. Lavori, run ed eventi applicano i permessi correnti;
i metadati dei grant sono visibili al soggetto o all'amministratore del progetto.
Restano da definire provisioning e autenticazione di identità multiutente esterne. safeStorage non cifra workspace,
blob o ricevute e non definisce recupero chiavi. Nessun segreto reale viene migrato.

Riferimenti usati: [sicurezza Electron](https://www.electronjs.org/docs/latest/tutorial/security),
[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
