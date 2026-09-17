# Materiali e accessi per progetto

Richiesta: aggiungere file e cartelle ai progetti e scegliere chi può accedervi.
Implementato selettore file, import cartella con struttura relativa, creazione cartelle
annidate e navigazione. Oggetti File mantenuti solo in memoria della pagina; nessun
upload, lettura o indicizzazione. Cambiando sezione o progetto i dati rimangono,
ricaricando la pagina vengono persi. Cartelle vuote del disco non importabili con il
selettore directory: si possono creare nel progetto.

Accesso per elemento: ereditato o ristretto, intersezione con tutti gli antenati e
l'idoneità del progetto. Persone attive con grant documenti, bot partecipanti;
proprietario conserva l'accesso amministrativo. I discendenti non possono ampliare
l'accesso. Il pannello mostra accessi risultanti e ragioni di esclusione. Link alla
condivisione progetto. In futuro il motore dovrà applicare tali regole effettivamente.

Verifiche: 4 test delle restrizioni/ereditarietà, revoca progetto, cicli e parenti
mancanti; TypeScript e lint. Browser: cartella Riservati, revoca Vera, file indice.txt
con impossibilità di riabilitare Vera, import cartella con file e sottocartella,
navigazione e conservazione dei dati. Desktop/mobile ispezionati. Corretto overflow
causato dalla larghezza globale degli input sul selettore nascosto; viewport 390/390.
Build preview passata. Revisione UX complessiva rimane da svolgere.
