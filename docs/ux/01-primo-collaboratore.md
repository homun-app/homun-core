# UX 01 — Dal bisogno al primo lavoro

Data: 15 settembre 2026. Stato: primo blocco prototipato, da provare con Fabio.

Riferimento: [visione del prodotto](../VISIONE-PRODOTTO.md).
Fabio ha approvato il passaggio al primo blocco del prototipo: bisogno,
collaboratore e incarico. Il dettaglio dei percorsi successivi resta una
proposta da validare. Questo documento non richiede modifiche al motore.

## Obiettivo

Una persona descrive un bisogno, prepara un collaboratore, gli affida un lavoro,
vede il metodo applicato e interviene soltanto nei punti necessari.

Il bot è agnostico. Preventivi, notizie e manutenzione tecnica usano gli stessi
elementi: responsabilità, conoscenze, strumenti, procedura, incarico e risultato.
I profili pronti sono configurazioni modificabili; non limitano i ruoli possibili.

## Perimetro del primo percorso

- Un progetto già selezionato e una postazione disponibile.
- Creazione di un collaboratore oppure assegnazione a uno esistente.
- Primo incarico manuale; proposta di renderlo ricorrente solo dopo la prova.
- Piano, risultato, attesa e intervento umano nello stesso dettaglio incarico.
- Modelli misti, deleghe e costi rappresentati come stati esplorabili.
- Installazione, accesso clienti, calendario completo e registrazione desktop
  restano percorsi successivi. Il primo utilizzo non li richiede.
- Il prototipo userà dati dimostrativi dichiarati: nessun collegamento, invio,
  costo o esecuzione simulata verrà presentato come reale.

## Scelta di ingresso proposta

Tre ingressi possibili: selezionare un profilo, descrivere il bisogno, disegnare
una procedura. Si propone il bisogno come ingresso principale, i profili come
suggerimenti facoltativi e la mappa come approfondimento del metodo.

La scelta riduce le decisioni iniziali. La descrizione libera può però essere
ambigua: Homun propone un riepilogo correggibile e chiede solo i dati mancanti
necessari al prossimo passo. Il prototipo rende visibili tali passaggi senza
richiedere generazione AI effettiva.

## 1. Descrivere il bisogno

Ingresso dalla Panoramica o dalla pagina Crea.

- Titolo: «Quale lavoro vuoi affidare?»
- Campo libero con esempi facoltativi e differenti per settore.
- Azione: «Prepara il collaboratore»; bozza conservata tornando indietro.
- Esempio: «Aiutami a seguire le richieste di preventivo e quelle senza risposta».
- Se esiste già un collaboratore pertinente, proporre «Affida a…» e lasciare
  disponibile «Crea un collaboratore». Non crearne uno per ogni incarico.

## 2. Preparare il collaboratore

Riepilogo compatto, modificabile, con una domanda mirata alla volta quando serve.

Visibile subito:

- Nome modificabile; responsabilità espressa in linguaggio naturale.
- Progetto di lavoro e risultato che deve aiutare a ottenere.
- Informazioni necessarie e strumenti richiesti, ciascuno con stato concreto.
- Autonomia proposta: in questo esempio prepara bozze e chiede prima di inviare.
- Politica AI e limite di spesa visibili prima dell'avvio.

Su richiesta: istruzioni complete, tono, modelli consentiti, regole per le
deleghe e dettagli dei collegamenti. Nessun modello remoto viene abilitato
silenziosamente. Una configurazione solo locale resta una scelta completa;
se non può svolgere un passaggio, il prodotto deve dichiararlo.

Uno strumento può risultare disponibile, da configurare o non disponibile.
Il bot può essere salvato incompleto; «Pronto» richiede le capacità necessarie
al lavoro selezionato. Se manca la posta, per la prima prova si può incollare
una richiesta e ottenere una bozza, esplicitando che l'invio resta escluso.

Azioni: «Salva collaboratore», «Prepara il primo lavoro», «Modifica».
Salvare il collaboratore non avvia messaggi o automazioni.

## 3. Concordare il metodo del primo lavoro

Mostrare un piano breve, modificabile, con risultato atteso e fonte dei dati.
Per l'esempio:

1. Leggere la richiesta e verificare quali informazioni sono presenti.
2. Recuperare le informazioni mancanti o formulare una domanda.
3. Preparare la bozza usando il listino e i materiali indicati.
4. Verificare completezza e corrispondenza con le fonti.
5. Presentare la bozza per approvazione.
6. Inviare quando approvato e quando il collegamento è disponibile.
7. Programmare il controllo della risposta, se richiesto dall'utente.

Ogni passaggio può espandere criterio di riuscita, strumenti, dipendenze e
comportamento in caso di problema. Il primo livello resta leggibile senza gergo.
Listino assente o ambiguo significa richiesta di informazioni, non prezzo inventato.

Azioni: «Avvia il lavoro», «Modifica il metodo», «Salva per dopo».
La spesa prevista, se disponibile, è etichettata come stima; assenza di una
stima non viene rappresentata con zero. Mostrare comunque il limite applicato.

## 4. Seguire il lavoro

La scheda resta identificabile quando cambia modello o viene coinvolto un altro
bot. In primo piano: titolo, responsabile, stato, scadenza, prossimo passo e costo.

Nel dettaglio:

- Risultato o bozza in posizione centrale quando disponibili.
- Checklist con passaggio corrente e verifiche, espandibile.
- Domande e decisioni dell'utente nel contesto del lavoro.
- Fonti, allegati e registro delle azioni su richiesta.
- Pausa e annullamento accessibili; un'azione già effettuata non viene descritta
  come annullata retroattivamente.

La bacheca e la conversazione aprono lo stesso incarico e ne mostrano lo stesso
stato. Il cambio modello non crea un nuovo collaboratore; una delega crea un
sottoincarico collegato, con responsabile e risultato propri.

## 5. Gestire attese, approvazioni e problemi

| Situazione | Informazione e azione visibili |
| --- | --- |
| Informazione mancante | Domanda precisa, fonte mancante, azione «Rispondi» |
| Attesa esterna | Interlocutore, richiesta inviata, eventuale data di ricontrollo |
| Attesa di un altro bot | Sottoincarico collegato e chi lo sta svolgendo |
| Bozza da approvare | Contenuto esatto e destinazione; «Approva e invia», «Chiedi modifiche» |
| Collegamento non disponibile | Passaggio bloccato; «Ricollega», con bozza e lavoro conservati |
| Verifica fallita | Cosa non soddisfa il criterio e proposta di correzione |
| Cambio modello | Motivo, modello impiegato, elaborazione locale/remota nei dettagli |
| Budget insufficiente | Spesa e limite; «Modifica limite» oppure «Lascia in pausa» |
| Lavoro interrotto | Ultimo passaggio verificato e cosa va controllato prima di riprendere |
| Esito di invio incerto | «Verifica in corso» o richiesta d'intervento; nessun reinvio automatico alla cieca |

Una correzione della bozza richiede la verifica della nuova versione. Un consenso
all'invio vale per il contenuto e la destinazione mostrati, non per modifiche successive.
Modelli e deleghe operano entro le regole e il budget dell'incarico.

## 6. Concludere e rendere ripetibile

Mostrare risultato, verifiche svolte, costo registrato ed eventuali attività aperte.
«Bozza pronta» non equivale a «Inviato»; «Inviato» non equivale a «Accettato dal cliente».

Il primo incarico può terminare con l'invio verificato. Un controllo futuro
della risposta diventa un lavoro collegato e pianificato, se abilitato.
L'utente vede quando e dove potrà essere eseguito. Se la postazione locale non
è disponibile, il lavoro non viene presentato come in esecuzione.

Azioni successive: «Affida un altro lavoro», «Salva questo metodo»,
«Ripeti automaticamente». La ricorrenza richiede evento/orario, responsabile,
autonomia e budget espliciti; non si attiva con il solo salvataggio del metodo.

Le correzioni possono proporre un aggiornamento della procedura o della memoria,
mostrando cosa si salva e per quale progetto. Il piano specifico può cambiare
senza modificare silenziosamente il metodo di tutti i lavori futuri.

## Costi e modelli: regole di presentazione

- Il costo dell'incarico comprende tentativi, cambi modello e sottoincarichi.
- Il dettaglio per bot deve riconciliarsi con il totale senza doppio conteggio.
- Dati mancanti: «Costo non disponibile» o «Parziale», non zero.
- Utilizzo locale: distinguere assenza di costo API da eventuali stime di
  energia/hardware. Non attribuire cifre prive di misurazione o ipotesi dichiarate.
- Il cambio automatico opera solo tra modelli già consentiti per quei dati.
- La politica visibile è indipendente da Ollama, Python o altri fornitori.

## Collegamento con l'interfaccia esistente

- `app.create.tsx`: evolvere il percorso guidato dando spazio al bisogno libero;
  nome, ruolo e tono restano riutilizzabili. Evitare profili obbligatori.
- `app.index.tsx`: riutilizzare la Panoramica e l'accesso ai collaboratori,
  aggiungendo accessi ai lavori e alle decisioni necessarie.
- Chat: collegare il dialogo a collaboratore e incarico corretti.
- Automazioni e FlowMap: riutilizzare la rappresentazione del metodo come
  livello di dettaglio, senza imporla per il primo avvio.
- Plugin: conservare il catalogo, ma permettere la configurazione dello strumento
  richiesto dal punto del percorso in cui serve.
- Nuovi elementi da prototipare: scheda lavoro, checklist verificabile,
  domanda/approvazione contestuale, dettaglio costi e conoscenze collegate.
- La gerarchia definitiva azienda/squadra/progetti resta aperta; questo percorso
  si svolge nel progetto selezionato senza fissare quella scelta architetturale.

## Verifica UX e prossimi passi

Il prototipo deve permettere di capire, senza spiegazione tecnica:

1. Chi è responsabile e quale risultato deve produrre.
2. Quali materiali/collegamenti mancano prima di iniziare.
3. Cosa è stato fatto, cosa è verificato e cosa deve ancora succedere.
4. Chi deve intervenire e con quale azione.
5. Quanto è costato il lavoro e quale limite rimane.
6. Qual è il risultato effettivo, comprese attività future e limiti.

Verificare poi lo stesso percorso con ricerca editoriale e manutenzione tecnica:
cambiano contenuti, strumenti e criteri; restano gli stessi componenti UX.

Il primo blocco è ora disponibile nella pagina Crea e nell'anteprima autonoma
`/prototypes/first-work.html`: bisogno libero, nuovo collaboratore, incarico,
metodo modificabile e riepilogo «Da fare · Demo». La bozza resta nella sessione
del browser. Non vengono eseguiti lavori o salvati bot sul backend.

Prossimo passo: provare con Fabio questo percorso e correggerne semplicità,
contenuti e priorità prima di estendere bacheca, verifiche e interventi umani.
Verifiche e limiti: [piano del primo lavoro](../superpowers/plans/2026-09-15-primo-lavoro.md).
