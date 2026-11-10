# Prova d'installazione — Homun 0.3 (macOS arm64)

> Lista da seguire A MANO (te o io) con la build **firmata** su un Mac pulito
> o su un utente di prova, PRIMA di pubblicare la draft della release.
> Prendata dalla lista di Homunbot e riscritta per Homun 0.3 (niente engine
> Python, niente Linux/Windows: la prima versione è solo macOS arm64).
> Ogni punto ✅ o ❌ con una riga di note; un ❌ blocca la pubblicazione.

## Preparazione

- [ ] Un utente di prova del Mac (Impostazioni › Utenti e gruppi › aggiungi,
      Standard), SENZA strumenti di sviluppo: è l'utente «pulito».
- [ ] La build firmata da provare: scarica dalla **draft** su
      `homun-app/homun-releases` (per l'aggiornamento dal feed usa quella
      pubblicata, vedi sotto).
- [ ] Se serve ripartire da zero: trascina `Homun.app` nel cestino, togli
      `~/Library/Application Support/sandbot` e la voce
      «Homun» in Impostazioni › Generali › Elementi login. MAI cancellare
      `…/Homun2` o `…/Homun`: sono i dati di Homun 2 (il punto 7 li usa).

## 1. Gatekeeper

- [ ] Scarica il `.dmg` con Safari (mette la quarantina, come un utente vero).
- [ ] Apri il dmg, trascina `Homun.app` in Applicazioni, espelli il volume.
- [ ] Prima apertura con doppio click: nessun avviso di Gatekeeper
      (firmata + notarizzata); se compare «Homun non può essere aperto»,
      ❌ — la notarizzazione non è valida.
- [ ] Verifica firme da Terminale (nell'utente di prova o nel tuo):
      `codesign -dv --verbose=4 /Applications/Homun.app` mostra
      «Developer ID Application: …» e
      `spctl --assess --verbose /Applications/Homun.app` dice
      «accepted, source=Notarized Developer ID».
- [ ] `shasum -a 256 -c` contro la riga di `SHA256SUMS-mac.txt` scaricata.

## 2. Primo avvio

- [ ] La finestra si apre, il Dock mostra Homun, niente finestra di Terminale.
- [ ] Nella chat compare il bot principale; l’onboarding propone il
      provider (senza reti reali configura un provider locale o salta).
- [ ] **La riga del rinnovo**: con una cartella di Homun 2 presente
      (`~/Library/Application Support/Homun2/engine`), al PRIMO avvio compare
      una volta «Homun è stato rinnovato…». «Mostra nel Finder» apre la
      cartella GIUSTA (Homun2). La ✕ la fa sparire per sempre (al riavvio
      non torna). I dati di Homun 2 restano INTATTI (controlla a mano).
- [ ] La cartella dati della 0.3 è `…/Application Support/sandbot` (nuova, vuota).

## 3. Elementi login (Avvia all'accesso)

- [ ] Impostazioni › Generali › «Avvia all'accesso»: attivalo.
- [ ] macOS 13+ mostra la richiesta in Impostazioni › Generali › Elementi
      login: se la riga di Homun dice «richiede approvazione», l'app lo dice
      in parole e «Apri Elementi login» apre la pagina giusta.
- [ ] Esci e rientra nel tuo utente: il daemon parte da solo (niente
      finestra, ma il bot risponde alla routine / al messaggio).
- [ ] Disattiva lì nell'app: la voce sparisce anche da Elementi login.
- [ ] Al momento giusto (dopo la disinstallazione, punto 8) la voce sparisce
      da sé quando cancelli l'app.

## 4. Docker assente, poi presente

- [ ] Senza Docker Desktop: apri il pannello Computer di un bot — la riga
      «Per il computer dei bot serve Docker Desktop: installalo e aprilo,
      poi Riprova» col link; NESSUN errore tecnico.
- [ ] Installa/apri Docker Desktop, premi «Riprova»: la riga sparisce,
      terminale e schermo del box funzionano (il box si costruisce alla
      prima uso).
- [ ] I permessi di Accessibilità e Registrazione schermo si chiedono SOLO
      quando una funzione li usa davvero (use-app / schermo): mai all'avvio.

## 5. La migrazione delle chiavi (con un dato vero creato prima)

- [ ] PRIMA di installare la 0.3, nell'utente di prova, crea la condizione
      vecchia: installa una build ≤16c della stessa serie dati e salva una
      chiave nel vault (o una chiave provider). Questo lascia le voci
      `sandbot-*-key` nel Portachiavi.
- [ ] Apri la 0.3: le chiavi migrano in `…/sandbot/data/keys.json`
      (permessi 600) e le voci `sandbot-vault-key`, `sandbot-connectors-key`,
      `sandbot-providers-key` SPARISCONO dal Portachiavi
      (`security find-generic-password -s sandbot-vault-key` → non trovata).
- [ ] Il segreto creato prima si rilegge (vault funziona).

## 6. Aggiornamento da Homun 2 (0.2.1004 → 0.3.1000) dal feed

- [ ] Nell'utente di prova installa Homun 2 0.2.1004 (l'ultima) e
      avviala una volta.
- [ ] Pubblica la draft della 0.3.1000 (il feed è pubblico solo dopo publish).
- [ ] Apri Homun 2: entro poco arriva «È disponibile Homun 0.3.1000» con le
      note dal CHANGELOG → «Scarica» → avanzamento visibile → «Riavria ora».
- [ ] Dopo l'installazione: la nuova app si apre al posto della vecchia
      (stesso bundle id, stessa cartella di installazione), la riga del
      rinnovo compare (punto 2), i dati di Homun 2 restano al loro posto.
- [ ] Il daemon della vecchia versione non resta in giro:
      `ps aux | grep -i homun` mostra solo processi della 0.3.

## 7. Aggiornamento 0.3.1000 → 0.3.1001

- [ ] Tagga e pubblica una 0.3.1001 qualsiasi (anche solo changelog).
- [ ] Apri la 0.3.1000: entro 6 ore (o subito con «Controlla aggiornamenti» in
      Impostazioni › Generali) arriva la proposta con le note.
- [ ] «Scarica» → avanzamento (finestra + Dock) → «Alla chiusura»:
      chiudi l'app, RIAPRI: la versione in Impostazioni è 0.3.1001.
- [ ] Durante un aggiornamento con un turno del bot IN CORSO: il daemon dà
      al turno fino a 10 s per chiudersi; se non basta, il turno riprende
      dopo il riavvio come dopo un crash (niente lavoro perso).

## 8. Disinstallazione (cosa resta e come toglierlo)

- [ ] Trascina Homun.app nel cestino: la voce di Elementi login sparisce da
      sé (il plist sta nel bundle); nessun processo resta attivo.
- [ ] Resta `~/Library/Application Support/sandbot` (bot, routine, vault):
      si cancella A MANO se lo vuoi — dentro c'è il DB e `keys.json`.
- [ ] `security find-generic-password -s sandbot-vault-key` → non trovata
      (le chiavi migravano in keys.json, non resta Portachiavi).
- [ ] Homun 2 non è mai stato toccato: `…/Homun2` c'è ancora, intatto.

## 9. Canale di prova (0.3.1001-beta.1 → 0.3.1001-beta.2)

> Le prerelease le riceve SOLO chi accende l'interruttore: con il canale
> stabile (e in Homun 2) non compaiono mai. Da seguire a mano, come il resto.

- [ ] Installa `0.3.1001-beta.1` dal dmg (è una prerelease pubblicata su
      `homun-app/homun-releases`) nell'utente di prova del Mac. Apri
      Impostazioni › Generali: sotto «Controlla aggiornamenti» accendi
      «Ricevi le versioni di prova», poi chiudi l'app.
- [ ] Dopo il tag di `0.3.1001-beta.2` (rilasciata come prerelease),
      riapri l'app e usa «Controlla aggiornamenti»: la 0.3.1001-beta.2 è
      OFFERTA con le note → «Scarica» → avanzamento → «Riavria ora».
      Riaperta l'app, in Impostazioni › Generali si legge `0.3.1001-beta.2`.
- [ ] Dopo l'aggiornamento i dati sono a posto: bot, chat, routine e chiavi
      come prima; `ps aux | grep -i homun` mostra UN solo daemon, quello
      della versione nuova (nessun processo della beta.1 resta in giro).
- [ ] Il modello integrato (se installato) risponde ancora e la memoria
      Engramma funziona (il bot ricorda ciò che ricordava prima).
- [ ] Il passaggio da Homun 2 alla 0.3 NON si può provare qui: Homun 2 non
      vede le prerelease — resta per la stabile (sezione 6).

## Esiti

| Sezione | Esito | Note |
| --- | --- | --- |
| 1 Gatekeeper | ⏸ | |
| 2 Primo avvio | ⏸ | |
| 3 Elementi login | ⏸ | |
| 4 Docker | ⏸ | |
| 5 Migrazione chiavi | ⏸ | |
| 6 0.2.1004 → 0.3.1000 | ⏸ | |
| 7 0.3.1000 → 0.3.1001 | ⏸ | |
| 8 Disinstallazione | ⏸ | |
| 9 Canale di prova | ⏸ | |

Ogni ❌ blocca la pubblicazione della draft: niente «poi si sistema».
