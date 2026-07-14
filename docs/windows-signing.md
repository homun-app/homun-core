# Firma automatica dei pacchetti Windows (Certum SimplySign)

Obiettivo: firmare l'installer `.exe` in CI con il certificato **Certum "Open Source
Developer"** (cloud, SimplySign), così Windows non lo segnala come editore sconosciuto e
l'auto-update resta valido.

> **Certificato & licenza.** È un cert Certum *Open Source Code Signing* (CN "Open Source
> Developer Fabio Cantone"). Certum ha **esaminato il repository `homun-core` e ne ha
> autorizzato la firma**. ⚠️ Questo cert copre **solo `homun-core`** (open): i **plugin/parti
> commerciali NON vanno firmati con questo certificato** (Certum revoca i cert Open Source usati
> su software a distribuzione commerciale) — per quelli servirà un cert Certum *standard*.

## Perché questa architettura

- **Runner Windows + `signtool` + smart-card virtuale SimplySign.** È il percorso
  *ufficiale Certum su Windows* ed evita le quirk PKCS#11/`libp11` che in locale (macOS)
  bloccavano la firma con `CKR_FUNCTION_FAILED`. La smart-card virtuale, dopo il login,
  compare nel *Windows certificate store* e `signtool` la usa nativamente.
- **Si firma sullo stesso runner del build** (`windows-latest`), quindi una volta integrato
  in `build.yml`, electron-builder firma *durante* il build e `latest.yml` (che contiene lo
  sha512 dell'exe per l'updater) resta coerente senza rigenerazioni.

## Il pezzo fragile: il login headless

SimplySign **non ha una CLI di login**. Il 2FA è un TOTP standard (SHA256/6/30s): dal seed
estratto dal QR originale generiamo l'OTP con codice inline, poi si guida il dialog di login
via `SendKeys` (email di login + OTP). Questo è GUI-automation e **va tarato su una run reale**
(titolo finestra, numero di TAB, tempi). Lo script cattura uno screenshot in caso di errore.

- Script: [`scripts/simplysign-login.ps1`](../scripts/simplysign-login.ps1)
- Harness isolato: [`.github/workflows/sign-win-test.yml`](../.github/workflows/sign-win-test.yml)

## Secrets richiesti (repo `homun-app/homun-core`)

| Secret | Cos'è |
| --- | --- |
| `SIMPLYSIGN_TOTP_SEED` | segreto Base32 del TOTP (dal QR `otpauth://…?secret=…`) |
| `SIMPLYSIGN_LOGIN` | email di login SimplySign (dal QR: fabio.cantone.dev@gmail.com) |
| `SIMPLYSIGN_DESKTOP_URL` | URL diretto dell'installer **Windows** di SimplySign Desktop |

> **Niente `SIMPLYSIGN_PIN`.** Il token SimplySign riporta `pin min/max: 0/0` (nessun PIN
> imposto): la firma è autorizzata dalla **sessione** (email + OTP), non da un PIN separato.
> Se una run in CI dimostrasse il contrario, aggiungeremo il secret allora.

Impostazione (i valori restano nel tuo terminale, non in chat):

```bash
# seed estratto dal file locale, senza stamparlo:
tr -d '\n\r' < ~/Documents/otpauthuri.txt \
  | sed -nE 's/.*[?&]secret=([A-Za-z0-9]+).*/\1/Ip' \
  | gh secret set SIMPLYSIGN_TOTP_SEED --repo homun-app/homun-core
gh secret set SIMPLYSIGN_LOGIN      --repo homun-app/homun-core   # incolli l'email di login
gh secret set SIMPLYSIGN_DESKTOP_URL  --repo homun-app/homun-core   # incolli l'URL installer Win
```

> 🔒 Dopo aver impostato il seed, **cancella `~/Documents/otpauthuri.txt`** e conservane il
> valore solo in un password manager: è il tuo secondo fattore di firma.

## Come iterare (bottom-up)

1. Imposta i secret sopra.
2. Lancia a mano `sign-win-test.yml` (Actions → Run workflow). Firma un `.exe` di test,
   **non** tocca i rilasci.
3. Se fallisce, scarica l'artifact `login-screenshot`, aggiusta i `TODO(ci)` nello script
   (titolo finestra, TAB, `Start-Sleep`, step di "attivazione token", gestione PIN).
4. Ripeti finché `signtool verify` è verde e l'artifact `signed-test-exe` è firmato.

## Integrazione in `build.yml` — FATTA ✅

Nel job `build` (matrix `platform == win`, runner `windows-latest`), sui **tag** `v*`:
1. **`SimplySign install + headless login (Windows)`** (`continue-on-error`): scarica l'MSI,
   `msiexec /quiet`, esegue `scripts/simplysign-login.ps1` → il cert entra nello store, e imposta
   l'output `signed=true`.
2. **`Build installer (Windows · signed)`** (`continue-on-error`): `electron-builder --win` con la
   config firma passata **via CLI** (electron-builder 25 → sotto `win.signtoolOptions`):
   ```
   -c.win.signtoolOptions.certificateSubjectName="Open Source Developer Fabio Cantone"
   -c.win.signtoolOptions.publisherName="Open Source Developer Fabio Cantone"
   -c.win.signtoolOptions.rfc3161TimeStampServer=http://time.certum.pl
   ```
   Firma durante il build → `latest.yml` (sha512) resta corretto in automatico.
3. **`Build installer (Windows · unsigned … fallback)`**: gira se il login o la firma falliscono
   (o su non-tag) → esce **non firmato download-only** come prima. Un intoppo SimplySign **non
   blocca mai il rilascio**.

⚠️ **La config firma è SOLO via CLI sullo step firmato, MAI in `package.json`**: se fosse fissa
in `package.json`, ogni build non-firmata (non-tag / login fallito) proverebbe a firmare e
fallirebbe. `apps/desktop/package.json` resta invariato.

(Opzionale, futuro) abilitare l'auto-install Windows: oggi `CAN_AUTO_INSTALL` in `electron/main.cjs`
è solo `darwin`; con l'exe firmato si può estendere a `win32`.

## Alternativa (se il GUI-login resta troppo fragile)

**SSL.com eSigner** ha una GitHub Action ufficiale + API REST pensata per il CI (niente GUI
headless), e con cert EV dà trust SmartScreen immediato. Costo maggiore, cert diverso. Azure
Trusted Signing sarebbe il più pulito ma è geobloccato US/Canada (non disponibile in Italia).
