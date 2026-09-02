# Usage Scenarios

Verificato 2026-08-27 sul branch di lavoro corrente.

Questo catalogo definisce gli scenari d'uso che Homun deve sostenere prima di
essere considerato stabile. Gli scenari sono organizzati in due profili:

- `baseline`: smoke regolare, abbastanza piccolo da girare spesso contro un
  gateway locale o un'app installata;
- `extended`: scenario lab per combinazioni complesse tra modelli, memoria,
  privacy, tool, skill e automation.

Gli scenari live sono eseguiti da:

```bash
python3 scripts/production_smoke.py --profile baseline --gateway-base http://127.0.0.1:18765
python3 scripts/production_smoke.py --profile extended --gateway-base http://127.0.0.1:18765
```

Per separare regressioni correnti da debito storico del profilo reale, usare il
wrapper profilo pulito:

```bash
python3 scripts/clean_runtime_smoke.py --skip-smoke
python3 scripts/clean_runtime_smoke.py --profile baseline --scenario S1 --seed-config-from ~/.homun --copy-secrets --keep
python3 scripts/clean_runtime_smoke.py --profile all --scenario X5 --scenario X6 --seed-config-from ~/.homun --copy-secrets --keep
```

Il wrapper non cancella chat o DB reali: avvia un gateway su `HOMUN_DATA_DIR`
isolato, copia solo configurazione selezionata quando richiesto, lancia gli
scenari e poi esegue `audit_homun_state.py --data-dir` sullo stesso profilo.

## Baseline

| ID | Scenario | Domini | Successo minimo |
| --- | --- | --- | --- |
| `S1` | Simple no-tool chat | chat, model | turno `completed`, risposta senza dipendenze tool |
| `S2` | Personal memory recall | chat, memory, model | turno `completed`, risposta sintetica su memoria accessibile |
| `S3` | Vault reveal card | chat, privacy, vault, memory | setup record Vault identity smoke, marker `VAULT_REVEAL`, nessun valore sensibile raw |
| `S4` | Sensitive data proposal | chat, privacy, vault, memory | marker `VAULT_PROPOSE`, nessun valore sensibile raw |
| `S5` | Web discovery with sources | chat, browser, model | completamento con fonte/titolo, senza marker di reasoning |
| `S6` | Browser form fill | chat, browser, tool, model | evidenza semantica del campo compilato |
| `S7` | Dead URL plan settles | chat, browser, runtime, model | failure/settlement leggibile, nessun browser wait infinito |
| `S8` | Payment approval browser fixture | chat, browser, approval, tool, privacy | setup checkout HTTPS pubblico/configurabile, marker `PAYMENT_APPROVAL`, nessun completamento pagamento, nessun blocco browser |
| `S9` | Italian locale web discovery | chat, browser, locale, model | discovery italiana con fonti, non singola testata hardcoded |

## Extended

| ID | Scenario | Domini | Successo minimo |
| --- | --- | --- | --- |
| `X1` | Automation lifecycle probe | chat, automation, memory, tool | automation di test non attiva, stato/id/azione successiva chiari |
| `X2` | Skill and tool selection probe | chat, skill, tool, model | scelta skill/tool spiegabile, nessun file creato |
| `X3` | Memory privacy model interplay | chat, memory, privacy, model | preferenza non sensibile salvabile, nessun dato personale/secret in output |
| `X4` | Code workspace auto-routing probe | chat, code, model | workspace temporaneo reale, lettura file progetto, marker `CODE_CONTEXT_OK`, nessuna modifica file |
| `SUB1` | Agentic subagent runner probe | subagent, capability, model | `SubagentTask` esegue tool read fake, `status: Done`, output con `summary` |

## Regole Di Esecuzione

1. Usare profilo isolato quando si indagano regressioni, così DB/log sono
   attribuibili allo scenario.
2. Salvare per ogni run: `thread_id`, `turn_id`, `run_id`, stato terminale,
   testo finale redatto, output di `scripts/audit_homun_state.py`.
3. Se uno scenario live fallisce, aggiungere una fixture owner-level o una regola
   audit prima di dichiarare risolto il bug.
4. Non promuovere `extended` nel gate pre-release finché non ha rumore stabile e
   tempi accettabili su macchina locale.
5. Gli scenari con privacy/vault/payment devono creare precondizioni reali
   tramite gateway o fixture raggiungibile dal browser; un prompt che chiede al
   modello di simulare lo stato non e' uno scenario live valido.
6. `S3` deve restare valido anche se il modello riscrive la query
   `recall_memory`: l'intento di reveal deriva dal messaggio utente originale e
   deve arrivare al fallback Vault.
7. `S8` deve navigare una pagina `https://` pubblica o passata con
   `HOMUN_SMOKE_CHECKOUT_URL`; `data:`, `file://` e loopback locale non sono
   validi perche' possono produrre falsi positivi o blocchi di rete privata.
8. Le fixture persistenti create dal runner, come il record Vault smoke di `S3`,
   devono essere rimosse dal runner stesso; record preesistenti non vanno
   cancellati.
9. Gli scenari codice devono creare un workspace/cartella reale: senza workspace
   il turno `Auto` resta orchestrator e non prova il routing/capability coding.
10. `SUB1` e' un probe live separato dal runner HTTP finche' non esiste un
   trigger broker stabile per `subagent.*`. Comando verificato:

```bash
cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway orchestrated_subagent_gathers_on_gemma4 -- --ignored --nocapture
```
