# Manus Screenshots Reference

Screenshots catturati il 2026-03-23 dalla sessione Chrome autenticata su manus.im/app.

## Come riprodurre
1. Login su https://manus.im/app
2. Screenshot manuale di ogni pagina (Cmd+Shift+4 su macOS)

## Pagine da catturare

| # | Pagina | URL/Percorso | Cosa mostra |
|---|--------|--------------|-------------|
| 01 | Home (collapsed sidebar) | /app | Hero "Cosa posso fare per te?", input, quick actions, promo card |
| 02 | Home (expanded sidebar) | /app (click toggle) | Sidebar completa: nav, progetti, compiti, footer |
| 03 | Agents | /app/agents | Hero illustration messaging apps, 4 feature cards, CTA Telegram |
| 04 | Search overlay | /app (click Search) | Command palette style, "Cerca compiti..." |
| 05 | Libreria | /app/library | Toolbar filtri/search/grid-list toggle, empty state |
| 06 | Chat view | /app/{task-id} | Messaggio utente + risposta agent + task steps + rating + suggestions |
| 07 | Settings > Account | #settings/account | Avatar, piano, crediti |
| 08 | Settings > Impostazioni | #settings | Lingua, tema (3 thumbnail), toggle comunicazioni |
| 09 | Settings > Utilizzo | #settings/usage | Piano, registro utilizzo tabella |
| 10 | Settings > Attività pianificate | #settings/scheduled-tasks | Tabs pianificato/completato, empty state |
| 11 | Settings > Mail Manus | #settings/mail-manus | Email config, workflow email, approved senders |
| 12 | Settings > Controlli dati | #settings/data-controls | 5 rows con "Gestisci" button |
| 13 | Settings > Browser cloud | #settings/cloud-browser | Toggle persistenza + cookies |
| 14 | Settings > Personalizzazione | #settings/personalization-center/profile | Profilo/Conoscenza tabs, istruzioni personalizzate |
| 15 | Settings > Skill | #settings/skills | Search + grid cards con toggle on/off |
| 16 | Settings > Connettori | #settings/connectors | Empty state MCP/API |
| 17 | Settings > Integrazioni | #settings/integrations | 4 cards (API, Zapier, Slack, Telegram) |

## Note
- Il design system completo e i token sono documentati in `../MANUS-ANALYSIS.md`
- Manus usa sfondo warm cream (#F5F0EB), non bianco puro
- Sidebar collassata = 56px solo icone, espansa = ~280px
- Settings = unico modal con nav sidebar interna (non pagine separate)
