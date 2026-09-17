# Selezione condivisa dei collaboratori

StudioMemberCard e StudioMemberProfile sono riutilizzati nei team e in StudioMemberPicker. La rubrica StudioMembersContext fornisce i dati aggiornati: i selettori non mantengono copie autonome dei curriculum. Le opzioni ricevute dal chiamante restano il limite di selezione; la rubrica arricchisce i profili ma non amplia i permessi.

Ricerca testuale per nome, ruolo, responsabilità, specializzazioni e attività definite, con parole multiple e accenti normalizzati. Non è una ricerca semantica né una valutazione automatica delle capacità.

Selezione singola o multipla; clic sul nome apre il curriculum senza navigare o selezionare il membro. Scheda selezionata visibile con tipo, responsabilità e autonomia predefinita. I team conservano trascinamento, stellina e modifica della modalità.

Integrato in: assegnazione e contributi, proposte Home, creazione/gestione squadra progetto, passaggi e approvatori delle automazioni, filtro e responsabile del calendario/Kanban, partecipanti e approvatore del compito, richieste di intervento, accessi ai documenti, abilitazione plugin e operatori/approvatore del bot. Le tabelle amministrative dei ruoli restano dedicate alla gestione accessi.

Il modulo di assegnazione usa la larghezza del contenitore; il limite aggiunto di 920px è rimosso.

Verifiche: TypeScript, lint (avvisi preesistenti in StudioAccess), build; ricerca in 120 membri; browser per ricerca per competenze, mini curriculum, selezione singola/multipla, trascinamento e coordinatore, viewport mobile senza overflow.
