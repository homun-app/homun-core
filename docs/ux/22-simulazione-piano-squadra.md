# Secondo scenario: piano da Trello, Mattermost e wiki

Accesso: Automazioni → Prova la nuova esperienza · Piano con Elio.

## Esperienza da validare
Richiesta → scelta bacheca e fonti → piano motivato → correzione nella chat → conferma. Una sola scheda contiene configurazione, risultato e stato; i dettagli di configurazione si richiudono dopo la prova.

Due bacheche fittizie (Prodotto e Clienti) consentono di verificare che il modello visivo non dipenda da un dominio tecnico. Il risultato distingue un task bloccato da una dipendenza umana e un task pronto. Le fonti sono apribili; un impegno dichiarato da un collega non diventa una consegna certa.

## Simulazione
La chat riconosce esclusivamente le correzioni guidate “solo i task bloccati” e “mostra tutti”. Le altre richieste e gli allegati ricevono un avviso esplicito. Nessun servizio esterno è collegato; non vengono inviati solleciti, modificati task o create pianificazioni reali. Tutto si azzera uscendo.

Cambiare bacheca, fonti, orario o giorni invalida la prova e richiede una nuova anteprima. Correggere l’anteprima annulla la precedente conferma. Deselezionando una fonte spariscono le relative evidenze e sono esplicitate le informazioni non verificate.

## Indicazioni per il motore
- Separare dati osservati, proposte e azioni autorizzate.
- Conservare la provenienza delle priorità e delle dipendenze.
- Applicare la correzione allo stesso piano e alla futura routine, con nuova verifica.
- Non trasformare un suggerimento di sollecito in un messaggio inviato.
- Riutilizzare questa struttura con fonti e risultati diversi.

## Verifica browser
Blocco senza bacheca; piano Prodotto; fonti; correzione via chat; conferma simulata; cambio fonti e invalidazione; piano Clienti; assenza delle evidenze Mattermost quando escluso; ritorno a tutti i task. TypeScript e lint superati. Restano da definire accessi mancanti, errori delle fonti, costi e gestione del sollecito: non coperti da questo scenario.

## Seguito operativo sul risultato
La chat riconosce ora anche la richiesta guidata “Sposta il primo task in lavorazione e assegnalo a Giulia”. Presenta scheda, colonna e responsabile prima/dopo, da confermare. Senza identificazione della scheda chiede una scelta tra i due risultati; per destinazioni non riconosciute propone soltanto le colonne dimostrative esistenti. È possibile annullare senza cambiare la scheda.

La conferma aggiorna lo stato della bacheca simulata visibile nel risultato. Non modifica la routine, non verifica automaticamente il piano e non risolve la dipendenza umana. Nessuna chiamata a Trello. La correzione è un esempio predefinito, non un interprete generico delle azioni. È disponibile nello scenario Piano con Elio, non ancora nel pannello generico delle esecuzioni del centro Attività.

Verificato nel browser: richiesta ambigua bloccata fino alla scelta; conferma del primo task in lavorazione assegnato a Giulia; secondo task invariato; annullamento senza mutazioni; destinazione non riconosciuta che richiede selezione. TypeScript, lint e build del prototipo superati.
