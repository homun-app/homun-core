# Homun — specifica di prodotto e motore v1

**Revisione:** 0.1 · 17 settembre 2026 · **Stato:** da analizzare con Fabio, non approvazione a implementare tutto.

Questo pacchetto consolida la conversazione e la struttura del prototipo. In caso di differenza, queste specifiche aggiornano le proposte dei precedenti documenti del 17 settembre; nessuna scelta ancora aperta viene trasformata in una decisione dell'utente.

## Percorso di lettura

1. [Prodotto, flussi e dati](01-prodotto-e-dati.md): ciò che Homun deve fare e le regole comuni.
2. [Agenti, esecuzioni e memoria](02-agenti-esecuzioni-memoria.md): come lavora un collaboratore e che cosa conserva.
3. [Impostazioni e permessi](03-impostazioni-e-permessi.md): configurazione completa, ambiti e responsabilità.
4. [API, client e rete](04-api-client-rete.md): Python, React/Flutter, tunnel e comunicazione tra motori.
5. [Accettazione e decisioni](05-accettazione-e-decisioni.md): prove, punti aperti e ordine di realizzazione.

Il [piano di sviluppo](../development/2026-09-17-piano-sviluppo.md) resta il backlog per fasi, da allineare alle decisioni prese su questo pacchetto. Il [prototipo](../ux/27-prototipo-conversazionale-consegna.md) è il riferimento UX, non il backend definitivo.

## Legenda

- **C — Confermato:** requisito esplicito o direzione accettata nella conversazione.
- **P — Proposto:** comportamento/default tecnico consigliato, da validare in questa revisione.
- **D — Da decidere:** scelta che cambia perimetro, dati o implementazione; ha un ID nel registro decisioni.

Le prescrizioni dei documenti descrivono il comportamento desiderato. Non dichiarano capacità già implementate. I default non espressamente confermati sono proposte.

## Decisioni consolidate

| Stato | Direzione |
|---|---|
| C | Motore Python indipendente dall'interfaccia |
| C | React/TypeScript come primo client; API riutilizzabili da un futuro client Flutter |
| C | Comunicazione remota/tunneling tra installazioni; dati locali e trasferimento soltanto del necessario |
| C | Cifratura dei dati; tecnica e recupero chiavi ancora da scegliere |
| C | Chat come ingresso principale; piani, richieste e risultati comprensibili nello stesso contesto |
| C | Agenti configurabili, team, progetti con più chat, materiali, plugin, automazioni e settings |
| C | Riutilizzare componenti esistenti per funzionare presto; componenti Homun sostituibili gradualmente |
| P | Pydantic AI per agenti e DBOS per durata delle esecuzioni |
| P | Una sola autorità per spazio nella prima rete, senza backend centrale Homun obbligatorio |
| P | Archivio conoscenze portabile e adattatore memoria; Mem0 OSS candidato, non adozione irrevocabile |
| P | HTTP/OpenAPI per comandi e letture, SSE per eventi, trasferimento file riprendibile |
| D | Trasporto tunnel, librerie cifratura, modelli iniziali, policy offline, framework memoria definitivo |

**Blockchain:** citata come possibile tecnologia dall'utente, non scelta. Raccomandazione corrente: cifratura convenzionale e registro verificabile, senza blockchain nella v1.

## Confini della v1

Beta: ciclo di lavoro reale, installazione Mac, collaborazione tra due o più app autorizzate, connessioni e memoria minime, automazioni su nodo acceso, backup/ripristino. API pronte per Flutter, ma implementazione dell'app Flutter non inclusa automaticamente.

Successivamente: gruppi, replica con failover automatico, editing offline concorrente completo, marketplace commerciale, Windows/Linux, dimostrazioni sul desktop, canali aggiuntivi. Nessun rinvio elimina i contratti necessari alla futura estensione.
