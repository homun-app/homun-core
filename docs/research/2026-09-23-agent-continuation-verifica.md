# Continuazione testuale durevole

H06 resta parziale. I nuovi run nativi possono continuare una risposta terminata
con `length` quando contiene testo visibile, senza chiamate di strumenti o tag
di ragionamento. Il trasporto conserva l'errore tipizzato e i consumi dichiarati;
la logica applicativa accetta e salva il frammento prima della richiesta seguente.
I run precedenti mantengono il fallimento terminale su troncamento.

## Contratto

Massimo tre inviti a continuare, 64.000 caratteri di frammenti e risposta finale,
limiti globali di tentativi/budget invariati. Nessun aumento automatico dell'output
massimo. Se i consumi dichiarati mostrano meno di 512 token liberi nel contesto,
non si aggiungono altri frammenti. Il normale pianificatore del contesto continua
a operare tra le richieste. Il quarto troncamento termina senza artifact.

Ogni frammento e l'invito successivo sono registrati atomicamente con i controlli
di autorità, epoch, lease e correzioni. Il provider resta fuori dalle transazioni.
Solo una risposta finale completa produce l'artifact ricomposto. I frammenti
canonici restano intatti: la ricomposizione modifica la decisione di consegna,
non inventa una risposta del provider nella cronologia.

La concatenazione è esatta: non aggiunge separatori dentro URL, parole o JSON.
Creazione e ripresa dopo arresto condividono lo stesso contratto validato di
64k caratteri per i nuovi run. Una risposta che supera il limite viene rifiutata
con i consumi conosciuti comunque addebitati. Una nuova chiamata di strumenti
abbandona la ricomposizione testuale precedente e riprende il ciclo agente.
Correzione/redirect azzerano la ricomposizione; pausa/ripresa conserva i pezzi
accettati. Risposte tardive dopo un controllo non diventano nuovi frammenti.

## Evidenze

- RED iniziale: frammento non trasportato nell'errore, ripresa e continuazioni
  fallivano subito. **870 test engine passati, 1 saltato**, più **63 controlli
  finali** (incluso un ulteriore test aggiunto dopo l'avvio della suite completa).
- Riavvio SQLite tra frammento e seguito; arresto dopo decisione e prima della
  pubblicazione; risultato oltre 16k dopo ripresa; nessuna consegna duplicata.
- Esaurimento continuazioni, limiti globali, spazio residuo, legacy, tag di
  ragionamento, filtro contenuto, argomenti tool troncati, errore temporaneo del
  provider tra frammenti, fonte modificata e controlli durante IO.
- Revisione indipendente: corretti due blocchi (newline dentro token e limite
  diverso alla ripresa). Nuova verifica: 26 test passati, nessun altro blocco.
- Architettura 0 errori, 35 avvisi dimensionali preesistenti; OpenAPI invariato.
- [Prova HTTP + Ollama](evidence/2026-09-23-hermes-parity/agent_continuation.json):
  prima risposta troncata iniettata via server HTTP locale, contesto chiuso e
  ricreato, seguito generato realmente da Ollama `qwen3.5:4b`. Due richieste,
  stati `running` → `completed`, un artifact con i due punti richiesti. Primo
  punto presente una sola volta; consumi della fixture e del modello registrati.
  Non è una prova di troncamento spontaneo di Ollama: l'interruzione è iniettata.
  Script: `agent_continuation.py <output.json>`, PYTHONPATH=engine/src.

## Limiti aperti

Non continua stream interrotti, ragionamento senza risposta visibile o argomenti
di tool incompleti. Non cambia provider né aumenta i limiti approvati. La qualità
del seguito dipende dal modello: può ripetere o omettere testo, e non si tenta
una deduplicazione euristica che altererebbe dati/identificatori. Il fallimento
per esaurimento non presenta il parziale come consegna riuscita. Resta la
revisione umana Homun. H06 completo e H01–H46 non sono dichiarati raggiunti.

Derivato da Hermes `turn_truncation.py` e prompt di `conversation_loop.py`, commit
c9dca726, con notice MIT. Concatenazione esatta e persistenza appartengono a Homun;
nessuna dipendenza runtime Hermes.
