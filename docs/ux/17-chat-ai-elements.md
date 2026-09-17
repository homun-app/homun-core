# Chat compatta e AI Elements

- Sidebar: un solo contenitore scorrevole per navigazione, squadra e progetti; profilo fisso. Scrollbar sottile, discreta, evidenziata al passaggio o al focus.
- Chat/Dashboard: switch a icone nella testata, con nomi accessibili e stato selezionato. Oggi/Calendario/Kanban sono tab secondarie sottolineate nella dashboard.
- Home: rimossi monogramma e intestazione duplicata; suggerimenti e compositore ravvicinati nello stato iniziale.
- Compositore condiviso `StudioChatInput`: PromptInput e provider di AI Elements, selezione/incolla/trascinamento allegati, rimozione, Invio/Shift+Invio, invio asincrono e recupero errore. Massimo 20 file, 25 MB per file.
- Home usa Conversation e Message di AI Elements; le conversazioni di persone, agenti e compiti usano lo stesso compositore e Message.
- L'adattatore converte soltanto allegati locali (blob/data URL) nel contratto File già usato dal prototipo. Nessun upload o invio remoto.
- Risposte Home ancora simulate. Il trasporto AI SDK verso il motore e i modelli resta da implementare; non viene introdotta una seconda integrazione AI nel prototipo.

## Verifica

Browser reale: testo e file conservati nel cambio Chat/Dashboard, invio allegato e successivo incarico, messaggio con allegato a Giulia, un solo scroll sidebar a 1280×650, nessuna eccedenza orizzontale a 390×844. Screenshot desktop, mobile e calendario controllati. TypeScript, lint dei file modificati e build del prototipo verificati. La build segnala dimensioni elevate dei chunk: ottimizzazione del caricamento ancora da affrontare.
