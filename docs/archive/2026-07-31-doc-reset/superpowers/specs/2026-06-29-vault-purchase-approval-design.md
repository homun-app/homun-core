# Vault personale e acquisti approvati

Data: 2026-06-29

## Stato

Design approvato per MVP. Questa spec definisce il perimetro prima del piano di implementazione.

## Obiettivo

Permettere a Homun di gestire dati personali sensibili e completare acquisti reali solo con
autorizzazione forte dell'utente. Il sistema deve restare local-first, auditabile e coerente con
ADR 0021: un solo loop agentico guardato, con nuovi tool/policy attorno al loop esistente, non un
secondo motore.

## Non-obiettivi MVP

- Nessun salvataggio di CVV/CV2, neanche cifrato.
- Nessun pagamento autonomo senza approval esplicita.
- Nessun inserimento di segreti del Vault nel prompt completo del modello.
- Nessun TOTP proprietario nell'MVP: arrivera' con l'app mobile.
- Nessun vault cloud o sincronizzazione multi-device.

## Principi

1. Il Vault non e' memoria.
2. La memoria normale non conserva in chiaro dati classificati critici.
3. Ogni accesso al Vault passa da tool mediati, policy e audit.
4. Ogni pagamento finale richiede riepilogo, approval e PIN locale.
5. CVV/CV2 e' un dato one-shot: vive solo in memoria volatile per la singola transazione.
6. Se merchant, importo, prodotto o metodo cambiano dopo l'approvazione, l'approvazione decade.

## Modello Vault

Il Vault e' una singola area sensibile con categorie interne e policy diverse per categoria:

- `payments`: carte senza CVV, billing profile, intestatario, circuito, scadenza, ultime 4 cifre.
- `identity`: documenti, codice fiscale, dati anagrafici.
- `health`: allergie e informazioni sanitarie.
- `vehicles`: targhe, veicoli, assicurazioni.
- `credentials`: credenziali, token e dati di accesso, con policy piu' restrittiva.
- `private_notes`: dati sensibili generici non classificati altrove.

Su macOS, l'MVP usa Keychain per i segreti ad alta sensibilita' quando disponibile. Il DB locale
mantiene solo metadati non sensibili e riferimenti (`vault_ref`). Le categorie non-card possono usare
lo stesso pattern: contenuto cifrato in backend sicuro, metadati minimi nel DB.

## Classificazione e memoria

Ogni input utente destinato a memoria passa prima da un classificatore di sensibilita':

```text
chat input -> sensitive classifier -> redaction/memory + proposta Vault
```

Comportamento MVP:

1. Se non ci sono dati sensibili, il flusso memoria resta invariato.
2. Se viene rilevato un dato sensibile, Homun propone una card "Salvare nel Vault?".
3. Se l'utente accetta, Homun salva un record strutturato cifrato nel Vault.
4. Se l'utente rifiuta, Homun non salva nel Vault strutturato.
5. In entrambi i casi, la memoria normale salva solo testo redatto o un `vault_ref`, mai il valore
   critico in chiaro.

Esempi:

- "Preferisco partire da Napoli" -> memoria normale.
- "La mia targa e' AB123CD" -> proposta Vault categoria `vehicles`; memoria redatta.
- "Sono allergico alla penicillina" -> proposta Vault categoria `health`; memoria redatta.
- "La mia carta e' ..." -> proposta Vault categoria `payments`; memoria redatta.

## Accesso ai dati sensibili

Il modello non riceve dump del Vault. Puo' chiedere accesso tramite tool dedicati:

- `vault_search`: trova record disponibili per categoria/scopo, senza rivelare segreti.
- `vault_get_field`: restituisce un singolo campo necessario per una finalita' dichiarata.
- `vault_fill_browser_field`: compila direttamente un campo browser con un valore del Vault, senza
  esporre il valore al testo del modello quando possibile.

Ogni chiamata include:

- categoria richiesta;
- finalita';
- dominio/sito o tool target;
- thread/run id;
- motivo testuale;
- livello di sensibilita';
- esito policy.

## Acquisti e pagamenti

Homun puo' cercare, confrontare, compilare e preparare un ordine. Il click finale di pagamento e'
consentito solo nel seguente flusso:

1. Homun arriva alla pagina finale di checkout.
2. Costruisce una `Payment Approval Card` con merchant, dominio, importo, valuta, prodotto/tratta,
   metodo di pagamento, eventuali commissioni, timestamp e screenshot o hash dello stato pagina.
3. La card viene mostrata in chat e puo' essere notificata su Telegram.
4. L'utente approva.
5. Nell'app locale Homun l'utente inserisce PIN locale e CVV/CV2 one-shot.
6. Homun ricontrolla che merchant, dominio, importo, prodotto e metodo siano invariati.
7. Se tutto coincide, compila il CVV e clicca il pulsante finale di pagamento.
8. L'audit locale registra la transazione senza salvare CVV/CV2.

Telegram puo' trasportare il riepilogo e l'intenzione di autorizzare, ma PIN e CVV/CV2 si inseriscono
solo nell'app locale. Questo evita che segreti di pagamento passino da canali remoti.

## PIN locale

Il PIN locale e' il fattore operativo dell'MVP:

- autorizza una singola transazione o accesso sensibile;
- ha timeout breve;
- ha tentativi limitati;
- non cifra da solo il Vault;
- non sostituisce CVV/CV2;
- non viene inviato a Telegram o ad altri canali.

In futuro, il PIN potra' essere affiancato o sostituito da TOTP gestito dall'app mobile Homun.

## Policy di invalidazione

Una payment approval e' valida solo per l'esatto stato approvato. Viene invalidata se cambia uno di:

- merchant o dominio;
- importo o valuta;
- prodotto, tratta, data, orario o quantita';
- metodo di pagamento;
- presenza di nuove commissioni;
- sessione browser o pagina finale;
- timeout approvazione.

In caso di invalidazione Homun deve fermarsi, spiegare la differenza e chiedere nuova approval.

## UI MVP

Nuove superfici:

- sezione Vault separata dalla memoria;
- card "Dato sensibile rilevato";
- form Vault per categoria;
- Payment Approval Card;
- dialog locale PIN + CVV one-shot;
- audit view minimale per accessi Vault e transazioni.

La sezione Vault deve essere chiaramente separata da Memory. Se un dato sensibile appare in memoria,
deve essere redatto o referenziato, non visibile in chiaro.

## Audit

L'audit locale registra:

- chi ha richiesto accesso al Vault;
- categoria e campo richiesto;
- dominio/tool target;
- approval id;
- esito policy;
- per i pagamenti: merchant, importo, valuta, metodo, timestamp e stato finale.

L'audit non registra CVV/CV2, PIN o PAN completo in chiaro.

## Error handling

- Classificazione incerta: proporre Vault senza salvare automaticamente.
- Utente rifiuta Vault: redigere comunque dalla memoria normale se il dato e' critico.
- PIN errato: bloccare dopo tentativi limitati e richiedere nuova approval.
- CVV mancante: restare in attesa, non procedere.
- Checkout cambia dopo approval: invalidare e chiedere nuova approval.
- Browser non riesce a cliccare o compilare: fermarsi con stato pagina e prossimo passo manuale.

## Test richiesti

- Classifier: esempi per carte, targhe, salute, documenti, credenziali e preferenze non sensibili.
- Memory redaction: nessun dato critico finisce in chiaro nella memoria normale.
- Vault access: `vault_get_field` restituisce solo il campo autorizzato.
- Browser fill: compilazione diretta senza loggare il segreto.
- Payment approval: click finale bloccato senza approval.
- PIN/CVV: CVV non persistito e PIN non accettato via canali remoti.
- Invalidation: cambio prezzo/merchant/prodotto annulla l'approvazione.
- Audit: eventi presenti, segreti assenti.

## Sequenza MVP

1. Schema Vault + backend sicuro locale.
2. Sensitive classifier + redaction prima dell'estrazione memoria.
3. UI Vault e proposta salvataggio.
4. Tool di accesso Vault minimizzati.
5. Payment Approval Card e policy di blocco click finale.
6. PIN locale + CVV one-shot.
7. Audit e test end-to-end su un checkout controllato prima di siti reali.
