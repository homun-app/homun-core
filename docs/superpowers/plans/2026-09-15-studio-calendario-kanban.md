# Calendario e Kanban

Direzione autorizzata: estendere Oggi con calendario e bacheca, mostrando incarichi, scadenze, passaggi e attese da persone o agenti. Mantenere la grafica Studio e la natura dimostrativa.

## Piano

1. Estendere l'incarico condiviso con scadenza, inizio facoltativo, stato e passaggi. Estrarre il form riusabile.
2. Aggiungere Calendario settimanale e agenda con navigazione date e incarichi senza scadenza; Kanban con cinque stati e dettaglio modificabile.
3. Mostrare per ogni passo bloccato chi deve intervenire e cosa manca. Rendere esplicito lo sblocco manuale della demo.
4. Collegare le viste allo stato unico della home, del progetto e della conversazione. Gli incarichi sono dati in memoria, non eventi esterni.
5. Verificare compilazione e browser: creazione con scadenza, cambio vista, modifica e blocco/sblocco, layout mobile.

## Scelte UX

Le colonne raggruppano gli incarichi; il dettaglio espone la checklist dei passaggi. Questo mantiene la bacheca leggibile senza moltiplicare le schede per ogni microazione. La scadenza indica quando il risultato serve; l'inizio facoltativo indica quando lavorarci. I blocchi indicano persona/agente e motivo. Nessuna integrazione calendar esterna o interpretazione AI dei messaggi in questa fase.

## Risultato e verifiche

Implementati form unico, stati condivisi, scadenza e inizio, calendario settimanale/agenda, Kanban filtrabile e checklist con attese da persone e bot. Home e conversazioni aprono lo stesso incarico; i progetti mostrano stato e scadenza. Un esempio di preventivo mostra il listino atteso da Giulia.

Verificati nel browser: creazione con data, presenza in agenda e conversazione, riapertura del dettaglio, sblocco da persona, avanzamento checklist, sincronizzazione stato calendario/Kanban, blocco da agente. Ispezionati screenshot desktop e mobile; pagina larga 390 px su viewport 390 px per entrambe le viste. TypeScript e build prototipo passati, lint dei file modificati senza errori.

Limiti: stati aggiornati manualmente per la prova UX, nessuna dipendenza automatica tra esecuzioni, nessuna interpretazione AI della chat, nessun calendario esterno o notifica. Dati in memoria fino al ricaricamento.
