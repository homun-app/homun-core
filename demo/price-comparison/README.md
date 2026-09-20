# Demo confronto listini

Tutti i prodotti, i nomi e i prezzi sono inventati. Questo catalogo di cancelleria serve a provare Homun: non contiene dati di clienti, fornitori o marchi reali.

## Materiali

- `listino-agosto.csv`: listino di partenza, 16 righe dati.
- `listino-settembre.csv`: nuovo listino, 15 righe dati.
- `expected-results.json`: risultati attesi specificati indipendentemente dal codice del motore.

I CSV usano UTF-8, separatore `;`, intestazioni `sku;name;price;currency` e prezzi con punto decimale. La valuta è EUR, salvo un USD intenzionale per verificare il controllo delle valute. Il prezzo mancante resta vuoto.

## Prompt da incollare nella chat

> Confronta il listino di agosto con quello di settembre. Usa agosto come base e abbina gli articoli per SKU esatto, distinguendo maiuscole e minuscole. Mostrami aumenti, diminuzioni, prezzi invariati, nuovi articoli e articoli rimossi, con variazione assoluta e percentuale. Segnala separatamente duplicati, prezzi mancanti e valute diverse senza correggerli o inventare valori. Se il prezzo iniziale è zero, indica la percentuale come non calcolabile. Prepara un report e un CSV scaricabili. Suggerisci un collaboratore adatto o proponi di crearne uno; caricherò i file dopo la conferma.

Apri **Nuova conversazione** e invia il prompt. Homun propone titolo, obiettivo, risultato atteso e collaboratore. Verifica che **Attività prevista** sia il confronto prezzi fra due CSV; puoi correggere la proposta prima di confermarla. **Conferma e affida** assegna un collaboratore esistente; **Crea il collaboratore e affida** crea il profilo mostrato e lo assegna. Nessuna delle due azioni esegue il confronto.

Dopo la conferma, seleziona i CSV nei campi **Listino precedente** e **Listino aggiornato**. Premi **Prepara il confronto**, verifica i materiali e poi **Approva ed esegui confronto**. Il JSON è il riferimento per verificare il risultato, non un documento da dare all'agente come risposta già pronta. La sintesi della richiesta usa il modello configurato; il confronto numerico è deterministico e locale. Le conversazioni precedenti prive di accordo conservano la scheda dedicata.

## Risultati attesi

| Esito | Articoli |
| --- | ---: |
| Confrontabili | 9 |
| Aumentati | 4 |
| Diminuiti | 3 |
| Invariati | 2 |
| Nuovi | 3 |
| Rimossi | 3 |
| SKU esclusi per anomalie | 3 |

Il motore emette 4 segnalazioni per i 3 SKU esclusi: due occorrenze duplicate, un prezzo mancante e un cambio valuta.

Il totale di un'unità per ciascuno dei 9 articoli confrontabili passa da 207,50 EUR a 187,00 EUR, con differenza di −20,50 EUR. Non è una stima di spesa: mancano le quantità acquistate. Nuovi, rimossi e SKU esclusi non entrano in questi totali.

## Anomalie intenzionali

- `OFFICE-112` compare due volte in agosto (righe CSV 13 e 14). Lo SKU va escluso interamente dal confronto. La riga valida di settembre non deve diventare un nuovo articolo.
- `OFFICE-113` ha il prezzo vuoto in agosto (riga CSV 15) e 11,00 EUR in settembre. Anche questo SKU va escluso su entrambi i lati, senza falso nuovo articolo e senza trasformare il vuoto in zero.
- `OFFICE-114` passa da EUR a USD. Nessuna conversione è autorizzata: va segnalato ed escluso.
- `OFFICE-108` passa da 0,00 a 3,00 EUR. È un aumento di 3,00 EUR; la percentuale è non calcolabile, non 0% o infinito.
- `CASE-01` esiste solo in agosto e `case-01` solo in settembre. Con corrispondenza esatta sono rispettivamente rimosso e nuovo.

Il maggiore aumento assoluto è `OFFICE-108` (+3,00 EUR). Tra le percentuali calcolabili il maggiore è `OFFICE-101` (+20%). La maggiore diminuzione assoluta è `OFFICE-105` (−20,00 EUR); in percentuale è `OFFICE-103` (−25%).

## Riproduzione del materiale

I dati sono stati scritti come celle tipizzate tramite `@oai/artifact-tool`, con il runtime condiviso di Codex. La documentazione pubblica e la ricerca mirata nell'help non esponevano un'esportazione CSV: il builder in `.support/build.mjs` serializza pertanto le celle con il separatore richiesto. I PNG in `.support` sono anteprime di verifica. Non servono al motore e non occorre allegarli.

L'oracolo JSON è manuale e non importa l'implementazione del confronto. I numeri attesi sono invarianti di questa fixture; modificarne i CSV richiede una revisione esplicita dell'oracolo.

Per rigenerare, crea temporaneamente `.support/node_modules` come link alla cartella `node_modules` restituita da `load_workspace_dependencies`, esegui `.support/build.mjs` con il relativo Node e rimuovi il link. Il builder non rigenera l'oracolo.

## Risultato eseguito nell’app

Il 19 settembre 2026 la prova completa è stata eseguita nella finestra nativa di Homun, inclusi riavvio prima dell’approvazione e recupero del risultato dopo riavvio. I file `confronto-listini.md` e `confronto-listini.csv` sono stati scaricati dalla GUI: contengono l’output reale del motore, verificato contro il JSON atteso. Il lavoro resta in revisione umana.
