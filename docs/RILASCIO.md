# Rilascio — Homun 0.3 (macOS arm64)

Come si esce, in breve. Tutto passa dalla CI di `homun-app/homun-core` (il
workflow `.github/workflows/build.yml`): firma, notarizzazione, feed di
aggiornamento e checksum nascono lì, mai dal Mac di chi sviluppa.

## Tagliare una versione di prova (il canale di prova)

```
git tag v0.3.1001-beta.1
git push origin v0.3.1001-beta.1
```

- La CI stampa la versione DAL TAG (`npm version` sul tag), costruisce, firma
  e notarizza, e pubblica su `homun-app/homun-releases` come **bozza**
  (`EP_DRAFT`). **La prova nasce bozza e diventa prerelease pubblica solo
  quando tutti i controlli sono verdi**: l'ULTIMO step della CI — dopo
  notarizzazione e graffaggio del dmg, `verify-release`, note dal CHANGELOG e
  `SHA256SUMS-mac.txt` — esegue `gh release edit … --draft=false --prerelease`
  e VERIFICA che la release risulti `isDraft=false` e `isPrerelease=true`
  (altrimenti la CI è rossa). Così una prova non verificata non sta mai nel
  feed, e non c'è mai una finestra con il file canale caricato ma lo zip no.
- Con `0.3.1001-beta.N` electron-builder pubblica il file canale
  `beta-mac.yml`: è quello che legge chi ha `allowPrerelease` acceso
  (l'interruttore «Ricevi le versioni di prova»).
- Chi ha il canale stabile — e Homun 2, che non imposta `allowPrerelease` —
  non la vede proprio: le prerelease restano fuori da `releases/latest`.
- Serve una sezione `## [0.3.1001-beta.N] — data` nel CHANGELOG: senza, la CI
  si ferma (mai una release senza note).

## Tagliare una versione stabile

```
git tag v0.3.1002
git push origin v0.3.1002
```

Un tag senza `-beta.` esce come **bozza**, come sempre: si rivede la release
su `homun-app/homun-releases` (dmg graffato, `SHA256SUMS-mac.txt`, note dal
CHANGELOG) e si pubblica A MANO. Solo allora entra nel feed di tutti.

## Caricare gli asset di Engramma (una volta per versione del motore)

La CI prende `engramma.darwin-arm64.node` (33 MB), `index.js` e `index.d.ts`
dagli asset della release fissata in `vendor/engramma/engramma.lock.json`
(`release: { repo, tag }` + hash e dimensioni: mai un file non verificato).
Gli asset vanno caricati DA SOLI, con `gh`, dai file di `vendor/engramma`
(che il lock ha già verificato):

```
gh release create engramma-fase-v0.4.3 \
  --repo homun-app/homun-core \
  --title "Engramma fase-v0.4.3" \
  --notes "Il motore Engramma agganciato da Homun (lock: fase-v0.4.3, commit bdb47871)." \
  vendor/engramma/engramma.darwin-arm64.node \
  vendor/engramma/index.js \
  vendor/engramma/index.d.ts
```

Prima di pubblicare, riscontro contro il lock (gli hash devono essere GIÀ
uguali: `prepare-engramma` esce senza toccare nulla):

```
shasum -a 256 vendor/engramma/engramma.darwin-arm64.node vendor/engramma/index.js vendor/engramma/index.d.ts
node -p "JSON.stringify(require('./vendor/engramma/engramma.lock.json').files, null, 2)"
```

Se il motore cambia versione: si aggiorna il crate, si ricompila, poi
`node scripts/prepare-engramma.mjs --update-lock` (riscrive hash E dimensioni
dalla sorgente) e si aggiornano `tag`, `version` e `release.tag` nel lock.
Attenzione: `--update-lock` legge dalla SORGENTE locale — se là si sta
lavorando a una versione nuova, il lock aggancia quella: fallo solo a
versione decisa.

## Cosa controllare in CI

- **Verde** su typecheck + test (mai una release da codice rosso).
- Lo step *Prepare native vendor assets* ha scaricato Engramma e llama-server
  dagli asset pubblici (nessun segreto) e verificato hash e dimensione.
- Lo step *Verify packaged app* stampa il JSON di `verify-release`: in
  `vendor.machO` ogni binario (llama-server, le dylib, il .node di Engramma)
  con `arch: arm64`, il Team ID dell'app e `runtime: true`; `notarized: true`.
- Lo step *Notarize and staple DMG* ha notarizzato e graffato il dmg e
  ricaricato quello buono sulla release (`--clobber`).
- Nella release ci sono: il dmg, lo zip, `SHA256SUMS-mac.txt` e il file canale
  giusto — `beta-mac.yml` per le prove, `latest-mac.yml` per le stabili.
- La release: **prerelease pubblica** per i `v*-beta.*` (la pubblica l'ultimo
  step *Publish prerelease*, col suo controllo `isDraft`/`isPrerelease`
  verde), **bozza** per le stabili; le note vengono dal CHANGELOG.
- Fuori da CI, sul Mac: `spctl -a -t open --context context:primary-signature -v <Homun.app>`.

## La prova a mano

Prima di pubblicare una stabile (o dopo ogni prova), la lista sta in
[PROVA-INSTALLAZIONE.md](PROVA-INSTALLAZIONE.md) — sezione 9 compresa
(canale di prova: 0.3.1001-beta.1 → beta.2 con l'interruttore acceso).
