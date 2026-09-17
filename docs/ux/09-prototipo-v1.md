# Prototipo v1 — perimetro di accettazione

> Revisione del 16 settembre 2026: questa baseline funzionale non costituisce una UX definitiva. La [revisione critica dell’insieme](11-revisione-critica-insieme.md) documenta i percorsi ancora incompleti e i nuovi criteri di accettazione.

La v1 rende verificabili i percorsi principali di uno spazio di lavoro misto persone/agenti.

## Inclusi
- Esplorazione con esempi e primo avvio separato senza esempi.
- Creazione collaboratore, incarico diretto, progetto e documenti.
- Home, calendario e Kanban alimentati dagli stessi incarichi.
- Richieste, solleciti, approvazioni, risultati e riutilizzo come procedura.
- Procedure sequenziali, configurazione di orari/intervalli/eventi, prove manuali e dipendenze.
- Provenienza dei costi dimostrativi per incarico e aggregazione per agente; limiti dichiarati.
- Marketplace, accessi e configurazione modelli come interazioni dimostrative.

## Fuori dalla v1 UX
- Esecuzione AI, invii esterni, pianificazione effettiva, credenziali e controllo accessi reale.
- Rami paralleli/condizionali e orchestrazione distribuita.
- Conservazione affidabile dei file e dati dopo il ricaricamento.

La limitazione sequenziale è esplicita. Una prova non deve essere presentata come esecuzione AI.

## Esito della chiusura v1

- Primo avvio: disponibile dal menu utente, in una nuova scheda (`?empty=1`) per preservare la sessione corrente. Verificato da spazio vuoto a primo agente e primo incarico.
- Costi: consuntivo dimostrativo per incarico, aggregazione coerente in Home, residuo e politica proposta al limite. Esempio verificato: 0,40 € su limite 1 € = 0,60 € residui; totale esempi 5,40 €.
- Consumi sconosciuti espliciti e distinti dallo zero; le simulazioni non si sommano due volte agli esempi.
- Dettaglio incarico: modifica titolo, responsabile e progetto; gli incarichi di procedura mantengono la provenienza.
- Aggiornare un documento condiviso riapre la verifica e riconcilia le dipendenze successive.
- Procedure: validazione dei responsabili rispetto alla squadra del progetto e conferma prima di scartare una bozza.
- Verifica browser a 1280 × 850 e 600 × 800; nessun overflow orizzontale rilevato nelle viste controllate.
- 41 test automatici su simulazioni, dipendenze, accessi ai file e costi. Controllo TypeScript e build del prototipo superati.

Questa è una baseline v1 del prototipo, non una release del motore. Le politiche di budget e di accesso descrivono l’interazione prevista; non sono garanzie di enforcement del backend.
