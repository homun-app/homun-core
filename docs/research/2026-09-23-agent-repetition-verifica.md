# Risposte dominate da ripetizioni

H06 resta parziale. Il parser nativo rileva risposte lunghe dominate da
ripetizioni prima di accettare il finale o le chiamate di strumenti. Restituisce
`agent_model_repetition`, non ritentabile: niente artifact, testo degenerato in
cronologia o tool dispatch. I consumi dichiarati dal provider vengono conservati
e addebitati. Lo stesso parser protegge i riepiloghi del contesto.

Algoritmo derivato da Hermes `agent/repetition_guard.py`, commit c9dca726:
almeno 400 caratteri, almeno 5 ripetizioni, dominanza di metà testo e finestre
esatte di 60 caratteri; testi con almeno 5 righe e maggioranza di righe distinte
sono esclusi. Homun conta finestre non sovrapposte: una correzione rispetto al
riferimento per non classificare un singolo separatore lungo come ripetizione
dominante. Le soglie restano euristiche, non valutazione semantica del contenuto.

## Evidenze

- RED iniziale: due risposte `stop` degeneravano in successo, due `length`
  venivano classificate solo come troncate; modulo guardia assente.
- **843 test engine passati, 1 saltato**; dopo la correzione del conteggio,
  **46 test mirati passati**, inclusi tutti i 10 test delle ripetizioni.
- Revisione indipendente ha trovato il caso del report di 495 caratteri con
  separatore da 72 trattini; regressione riprodotta e corretta. Seconda revisione:
  nessun ulteriore blocco concreto.
- OpenAI e Ollama, `stop` e `length`, consumi preservati e codice non ritentabile.
  Test del run completo: nessuno strumento eseguito, nessun artifact, due soli
  messaggi iniziali conservati; riavvio SQLite mantiene il fallimento senza IO.
- Tabelle e batch SQL con righe distinte passano. Architettura 0 errori,
  35 avvisi dimensionali preesistenti; OpenAPI invariato.
- [Prova HTTP e Ollama](evidence/2026-09-23-hermes-parity/agent_repetition.json):
  server HTTP locale reale con risposta ripetitiva iniettata, una richiesta,
  errore tipizzato con i contatori dichiarati 17/600. Separatamente Ollama reale
  `qwen3.5:4b` genera una risposta normale oltre 400 caratteri, accettata.
  Non è una prova di un modello reale entrato spontaneamente in un loop.
  Script riproducibile: `agent_repetition.py <output.json>` con PYTHONPATH=engine/src.

## Limiti

Il controllo avviene dopo la risposta HTTP completa: non interrompe lo streaming
e non risparmia i token già generati. Non riconosce loop semantici, ripetizioni
tra chiamate o stallo degli strumenti. Un testo volutamente molto ripetitivo
può soddisfare l'euristica. La continuazione dei troncamenti utili, il fallback
del provider e altre capacità H06 restano da implementare. Nessuna parità
complessiva dichiarata; notice MIT aggiornata, nessun runtime Hermes.
