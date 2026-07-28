# Branch backlog — inventario e ordine (2026-07-27)

> Da dove ripartire dopo il censimento branch vs `main`.
> `main` locale ahead di `origin/main` (runtime + canali). Push solo a richiesta.

## Ordine mentale (una cosa per volta)

1. **Runtime caldo su `main`** — piano→engine, browse lifetime, tool honesty, turn-trace WHY, TestEnv. Validare live.
2. **Canali** — ✅ portato su `main` (2026-07-27). Smoke live: progetto aperto + inbound WhatsApp/Telegram.
3. **License** — portare `fabio/license-compliance` quando si prepara una release firmata.
4. **Launch media** — solo docs (`fabio/launch-media-production`); quando serve il video.
5. **Residui `piano-ui`** — audit mirato (live-workspace island, step indicators, anti-fluff). Non mergiare il branch intero.

---

## A1 — `fabio/fix-channel-lifecycle` — **PORTATO su `main` (2026-07-27)**

Cherry-pick: `cfc6d6d1` / `e5c43d9e` / `918b2994` + docs. Branch/worktree candidati
alla rimozione dopo smoke live WhatsApp (progetto aperto + inbound).

---

## A2 — `fabio/license-compliance` (+8, behind 159)

**Problema:** bundle distributable senza notice/font license complete; CI non blocca.

| Commit | Tipo | Portare? | Note |
| --- | --- | --- | --- |
| `832e2c8f` / `57c7928c` design+plan | docs | sì | Contesto |
| `ebdfa245` metadata FSL su crate/`package.json` + test | metadata | **SÌ** | Touch molti `Cargo.toml` → rebase attento |
| `9d146d19` pin runtime Python + skills LICENSE | **codice** | **SÌ** | Dockerfile/requirements |
| `ae93aa01` font LICENSE + `build_fonts.py` | **asset+script** | **SÌ** | Grosso ma meccanico |
| `ccfbf323` `license-compliance.mjs` staging | **script** | **SÌ** | Cuore del bundle |
| `6830ff85` CI verify + after-pack | **ci** | **SÌ** | Dopo che lo staging passa |
| `ca05993f` gap fix + `LICENSE_MANIFEST.json` | **fix** | **SÌ — ultimo** | Chiude il ramo |

**Quando:** prima di una release che pubblichi (canali già su `main`).
**Come:** branch fresco da `main`, cherry-pick in ordine, o `git merge --no-ff` solo se i conflitti Cargo.toml restano banali. Gate: test `license-*.test.mjs` + `verify-license-compliance`.

---

## Non portare / cestinabili

| Branch | Motivo |
| --- | --- |
| Worktree fluidità / browser / logical-chat / host-computer (merged tip) | `ahead=0` vs main |
| `fabio/host-computer-control-pre-integration` | 29/32 patch già su main; residuo = revert-pair + UI già mergiata |
| `origin/docs/codex-gap-analysis-2` | File già in tree |
| `origin/fix/default-display-name`, `origin/fixes/v0.1.1015` | Storia giugno, feature già riprese |
| `origin/feat/piano-ui-completion` | Non cancellare ancora: residui UX da auditare a parte; non mergiare intero. Stash WIP UI presente. |
| `fabio/launch-media-production` | Tenere; solo docs, zero urgenza runtime |

---

## `main` non pushato (contesto)

Runtime (11) + canali (6). Push solo a richiesta.
