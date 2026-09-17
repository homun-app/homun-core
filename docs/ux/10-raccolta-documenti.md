# Raccolta documenti unica

File, cartelle e note vivono nello stato condiviso dello spazio. La scheda Documenti del progetto è una vista filtrata della stessa raccolta, non una copia.

- Destinazione: spazio generale oppure uno o più progetti. La selezione vuota indica lo spazio generale; un materiale associato a più progetti resta unico. Il filtro permette di selezionare più progetti e cercarli.
- Condivisione: ereditata dallo spazio/progetto/cartella oppure ristretta a persone e agenti selezionati.
- L’accesso ereditato unisce gli agenti e le persone autorizzate dei progetti selezionati. Le restrizioni individuali e quelle delle cartelle restringono questa unione. Il proprietario mantiene la gestione.
- Le restrizioni delle cartelle si applicano ai discendenti. Spostare un elemento fuori da una cartella conserva le restrizioni effettive.
- Collegare un documento a un incarico non concede accesso al responsabile. Se manca l'accesso, il collegamento nuovo è disabilitato; un collegamento già presente segnala l'accesso da autorizzare.
- Aggiungi: Carica file, Carica cartella, Scrivi una nota, Nuova cartella.
- Carica cartella conserva sottocartelle e file. Le cartelle vuote non sono esposte dal selettore del browser e non sono importate; nessuna sincronizzazione del disco.
- I risultati condivisi da un incarico ereditano il suo progetto. Senza progetto sono inizialmente limitati al responsabile e al proprietario; destinazione e accessi sono modificabili dalla raccolta.
- Tutto resta in memoria nella pagina. I permessi descrivono e simulano la futura policy: non sono enforcement server.

Verifiche: nota creata nel progetto e visibile una sola volta nella raccolta generale; restrizione a Vera impedisce il collegamento a un incarico di Elio; importazione della struttura cartella/sottocartella/file. Test unitari su ambiti, restrizioni, collegamenti, percorsi, spostamenti e gerarchie non valide.

Verifica aggiuntiva: 100 progetti creati tramite UI (101 totali), ricerca dei progetti 099 e 100, creazione di una nota collegata a entrambi, filtro singolo e multiplo senza duplicati. Pulsanti di aggiunta misurati a 34 px.
