# Manus.im Design Analysis

> Analisi dettagliata della UI di Manus (manus.im/app) per adottare lo stesso linguaggio visivo in Homun.
> Catturata il 2026-03-23 dalla versione Manus 1.6 Lite.
> Screenshots di riferimento: `docs/design/manus-screenshots/` (catturati manualmente dalla sessione browser).
>
> **Pagine analizzate**: Home, Agents, Search (overlay), Libreria, Chat view (con task steps),
> Settings modal (Account, Impostazioni, Utilizzo, Attività pianificate, Mail, Data Controls,
> Browser Cloud, Personalizzazione, Skill, Connettori, Integrazioni).

---

## Design Philosophy

Manus segue un design **editoriale minimalista** — ogni pixel ha uno scopo. Zero decorazione, zero rumore.
Lo stile è riconducibile a: **Linear.app + Notion + Apple Settings** mescolati con un tocco warm/organico.

### Tratti chiave
- **Warm neutrals**: sfondo crema/beige (#F5F0EB circa), non bianco puro — crea un senso di comfort e premium
- **Mono-accent**: zero colori brand invadenti. L'unico colore è blu (#0066FF) usato solo per toggle attivi e CTA primarie
- **Typography-driven**: la gerarchia si crea con peso e dimensione del font, non con colori o bordi
- **Generous whitespace**: enorme respiro tra gli elementi, niente affollamento
- **Subtle borders**: bordi quasi invisibili (1px, ~#E5E0DB), ombre leggerissime (0 2px 8px rgba(0,0,0,0.04))
- **Icon-first navigation**: sidebar a icone, tooltip on hover, espande a testo solo con toggle
- **Modal-centric settings**: tutte le impostazioni in un unico modal con sidebar nav interna

---

## Layout Structure

### Global Shell
```
┌──────────────────────────────────────────────────────┐
│ [Logo] [Title v]                    [🔔] [✨1300] [👤]│  ← Topbar (h: ~56px)
├────┬─────────────────────────────────────────────────┤
│ 📝 │                                                 │
│ 🤖 │              Main Content Area                  │
│ 🔍 │           (centrato, max-width ~800px)          │
│ 📚 │                                                 │
│    │                                                 │
│    │                                                 │
│ ── │                                                 │
│ 📁 │                                                 │
│ +  │                                                 │
│ ── │                                                 │
│ 📋 │                                                 │
│    │                                                 │
│    │                                                 │
│ ── │                                                 │
│ ⚙️ │                                    from ∞ Meta  │
│ 🧩 │                                                 │
│ 🖥️ │                                                 │
└────┴─────────────────────────────────────────────────┘
  56px                    rest
```

### Sidebar (~56px collapsed, ~280px expanded)
- **Collapsed**: solo icone, 24x24px, grigio #666, spacing 40px verticale
- **Expanded**: icona + label, font-weight 400, hover: bg rgba(0,0,0,0.04) border-radius 8px
- **Active item**: bg rgba(0,0,0,0.06), font-weight 500
- **Toggle**: icona panel in top-right del sidebar header
- **Dividers**: linea sottile tra sezioni (nav principale / progetti / compiti / footer)
- **Footer**: referral banner, 3 icone utility (settings, integrations, devices), "from ∞ Meta"

### Sidebar Items (top to bottom)
1. **Logo + Version** (Manus 1.6 Lite ↓ dropdown) — in noi: "homun" + versione
2. **Nuovo compito** (📝) — equivalente: "Nuova chat"
3. **Agents** (🤖) — equivalente: "Agenti"
4. **Cerca** (🔍) — command palette overlay
5. **Libreria** (📚) — equivalente: "Libreria" o "Knowledge"
6. ── separator ──
7. **Progetti** section con + button — equivalente: "Sessioni" o "Progetti"
8. **Nuovo progetto** — inline
9. ── separator ──
10. **Tutti i compiti** con filtro — lista conversazioni/task
11. ── separator (bottom) ──
12. **Referral banner** (arrotondato, icona + testo + chevron)
13. **Settings / Integrations / Devices** (3 icone)
14. **"from ∞ Meta"** — in noi: versione o credits

### Topbar (in chat view)
- Left: **"Manus 1.6 Lite"** con dropdown chevron (model selector)
- Right: **"✨ Inizia prova gratuita"** (sparkle icon, testo blu), **"↗ Condividi"**, **user icon**, **copy icon**, **⋯ more**

---

## Pages Detail

### 1. Home (Nuovo compito)
- **Hero text**: "Cosa posso fare per te?" — font serif-like, ~32px, centered, bold
- **Plan badge**: "Piano gratuito | Inizia la prova gratuita" — pill shape in alto, testo grigio + blu link
- **Input area**: card bianca con shadow leggera, border-radius 16px
  - Placeholder: "Assegna un compito o poni una domanda"
  - Textarea auto-grow
  - Bottom toolbar: [+] [🔗connettori] .................. [😊emoji] [🎙️voice] [⬆️send]
  - Send button: cerchio con freccia su, grigio quando vuoto, colorato quando attivo
- **Connectors banner**: sotto l'input, "🔗 Collega i tuoi strumenti a Manus" + icone servizi (Chrome, Gmail, Drive, Calendar, Slack, GitHub, Notion) + X close
- **Quick actions**: 5 pill/chip button orizzontali
  - "📄 Crea presentazioni" | "🌐 Crea sito web" | "📱 Sviluppa app" | "✨ Progetta" | "Altro"
  - Stile: bg white, border 1px #E5E0DB, border-radius 24px, icon + text, hover: shadow
- **Promo card**: in basso, card con immagine + "Scarica Manus per Windows o macOS" + dots carousel

### 2. Agents
- **Hero illustration**: floating messaging app icons (Telegram, WhatsApp, LINE, Messenger) intorno a un mockup chat
- **Title**: "Distribuisci il tuo agente per" — serif, centered
- **4 feature cards**: grid 4 colonne equal
  - Icona in alto (outline, 32px)
  - Titolo bold
  - Descrizione 2 righe, grigio
  - Border: 1px #E5E0DB, border-radius 12px, padding 24px
- **CTA**: bottone nero "🔵 Inizia su Telegram" (icona Telegram bianca)
- **Coming soon**: "Prossimamente: WhatsApp, Messenger, Line" — grigio, icone piccole

### 3. Cerca (Search)
- **Overlay modal**: centrato, bg white, max-width ~640px, border-radius 16px, shadow
- **Search input**: icona 🔍 + "Cerca compiti..." + X close
- **First result**: "➕ Nuovo compito" — always first
- **Results**: lista con icona + titolo, hover highlight

### 4. Libreria (Library)
- **Toolbar**:
  - Left: "⚙️ Tutti ↓" (filter dropdown) + "⭐ I miei preferiti" (toggle)
  - Right: "🔍 Cerca file" (search) + grid/list view toggle (2 icone)
- **Grid/List toggle**: 2 icone affiancate, active ha bg grigio
- **Empty state**: icona archivio (56px, grigio), "Niente nella libreria", descrizione, bottone nero "📝 Nuovo compito"
- **Pattern**: identico a file manager moderno (Google Drive / Notion)

### 5. Chat View (conversazione attiva)
- **User message**: allineato a destra, bg bianco, border-radius 16px, padding 16px, shadow leggera
- **Agent response**: allineato a sinistra, no bg (testo diretto su sfondo crema)
  - Header: icona manus + "manus" in bold
  - Testo con **bold** per dati chiave
- **Task steps** (collapsible):
  - ✅ cerchio verde + "Recuperare e comunicare l'orario attuale" + chevron ↑↓
  - Sub-step indentato: icona terminale + descrizione
  - Step in progress: 🔵 cerchio blu + "Pensando" + timer "0:07"
- **Completion banner**: "✅ Attività completata" (verde) + rating "Com'è stato questo risultato?" ⭐⭐⭐⭐⭐
- **Upsell banner**: card grigia con icona sparkle + testo + CTA "Inizia la prova gratuita" (nero)
- **Follow-up suggestions**: "Suggerimenti per ulteriori approfondimenti"
  - 3 righe: icona chat bubble + testo suggerimento + freccia →
  - Divisi da linea sottile
- **Bottom status bar** (sticky):
  - Screenshot thumbnail del tool output (mini preview)
  - ✅ "Recuperare e comunicare l'orario attuale" — step tracker "1/1" con collapse
- **Input (in chat)**: stessa struttura della home ma senza le quick actions
  - Placeholder: "Invia un messaggio a Manus"
  - Stop button (quadrato nero) appare durante elaborazione

---

## Settings Modal

### Structure
- **Overlay**: backdrop blur leggero, bg rgba(0,0,0,0.3)
- **Modal**: bg white, border-radius 16px, max-width ~900px, max-height ~80vh
- **2-column layout**: sidebar nav (250px) + content area (rest)
- **Close**: X button in alto a destra del content

### Nav Sidebar (dentro il modal)
- Logo "manus" con icona in top
- Items: icona (20px) + label, vertical list, spacing 8px
- Active: bg grigio chiaro, border-radius 8px
- Separator prima di "Ottieni aiuto" (link esterno con ↗)

### Settings Sections

#### Account
- Avatar (64px circle) + Nome + Email
- Action icons: API key, logout
- **Plan card**: bordata, "Gratis" + "Aggiorna" button nero
  - Crediti: icona sparkle + "Crediti ⓘ" ............... 1,000
  - Sub-detail: "Crediti gratuiti" .................... 1,000
  - Rinnovo giornaliero: icona calendario + label ⓘ ..... 300
  - Sub-detail: "Aggiorna a 300 alle 00:00 ogni giorno"

#### Impostazioni (Settings)
- **Generale** section header (piccolo, grigio, uppercase-like)
  - Lingua: label + select dropdown
- **Aspetto**: 3 visual thumbnails (Chiaro/Scuro/Segui sistema)
  - 120x80px circa, border-radius 8px
  - Active: bordo blu 2px
  - Below: label centrato
- **Preferenze di comunicazione**: 2 toggle rows
  - Title bold + description grigia sotto + toggle switch a destra
- **Gestisci Cookie**: label + "Gestisci" button outlined

#### Utilizzo (Usage)
- Plan card (stessa struttura di Account)
- "Utilizzo del sito web e fatturazione" — link row con icona + chevron →
- **Registro utilizzo**: tabella (Dettagli | Data | Variazione crediti)
  - Header grigio, rows con bordo bottom

#### Attività pianificate (Scheduled Tasks)
- **Tabs**: "Pianificato" | "Completato" — pill tabs, active ha bg grigio
- **Table header**: Titolo | Pianifica a | Stato
- **Empty state**: icona calendario (48px) + testo + "+ Nuova pianificazione" button outlined

#### Mail Manus
- **Info banner**: icona + testo + "Scopri di più ↗" link
- **Tabs**: Impostazioni | Posta in arrivo
- **Form rows**: Label + description a sinistra, valore/azione a destra
  - Email: "fabio011@manus.bot" con icona edit ✏️
  - Workflow email: "+ Aggiungi email del flusso di lavoro"
  - Approved senders: lista con icona mail + indirizzo + ⋯ menu

#### Controlli sui dati (Data Controls)
- **Simple list**: 5 rows
  - Label a sinistra + "Gestisci" button outlined a destra
  - Divider tra rows
  - Items: compiti condivisi, file condivisi, siti web, app, domini acquistati

#### Browser cloud
- Toggle row: label + description + link "Scopri di più" + switch
- "Cookies e altri dati del sito web" + "Gestisci" button

#### Personalizzazione
- **Tabs**: Profilo | Conoscenza ⓘ
- **Profilo**:
  - 2 inputs inline: Soprannome + Occupazione
  - Textarea "Più informazioni su di te" (con char count 0/2000)
  - Help text sotto
  - Textarea "Istruzioni personalizzate" (con char count 0/3000)
  - "Annulla" + "Salva" buttons (save = nero filled)
- **Conoscenza**: (non esplorata, probabilmente RAG/docs)

#### Skill
- **Search bar**: icona filtro + "🔍 Cerca Skill" + "Ufficiale" badge button
- **CTA banner**: icona + "Aggiungi skill personalizzate" + descrizione + "+ Aggiungi ↓" dropdown
- **Skill cards**: grid 2 colonne
  - Nome bold + toggle switch a destra
  - Descrizione troncata (2 righe)
  - Footer: "⏱ Ufficiale · Aggiornato il 13 mar 2026" + ⋯ menu
  - Alcune con badge ✨ (premium/featured)

#### Connettori
- **Empty state**: icona connettore (48px) + "Collega Manus con le tue app quotidiane, API e MCP" + "+ Aggiungi connettori" button

#### Integrazioni
- **Subtitle**: "Crea flussi di lavoro tra le tue app preferite"
- **4 cards** grid 2x2:
  - Icona servizio (40px) + Titolo bold + Descrizione + "Vai alla configurazione >" link
  - Cards: API Manus, Zapier, Slack, Telegram

---

## Design Tokens (estimated)

### Colors
```
--bg-page:        #F5F0EB  (warm cream/beige)
--bg-surface:     #FFFFFF  (cards, modals, inputs)
--bg-hover:       rgba(0,0,0,0.04)
--bg-active:      rgba(0,0,0,0.06)
--bg-muted:       #F8F5F1  (subtle sections)

--border-default: #E5E0DB  (warm gray, very subtle)
--border-focus:   #0066FF  (blue, only on focus/active)

--text-primary:   #1A1A1A  (near black)
--text-secondary: #666666  (descriptions)
--text-tertiary:  #999999  (placeholders, timestamps)
--text-link:      #0066FF  (blue, used sparingly)

--accent-blue:    #0066FF  (toggles, active states, links)
--accent-green:   #22C55E  (success checkmarks)
--accent-black:   #1A1A1A  (primary CTA buttons)

--shadow-card:    0 2px 8px rgba(0,0,0,0.04)
--shadow-modal:   0 8px 32px rgba(0,0,0,0.12)
```

### Typography
```
--font-family:    'Inter' or similar system sans-serif
--font-hero:      serif or semi-serif for hero titles ("Cosa posso fare per te?")

--text-xs:        12px / 16px
--text-sm:        13px / 18px  (metadata, timestamps)
--text-base:      14px / 20px  (body, descriptions)
--text-lg:        16px / 24px  (section titles, nav items)
--text-xl:        20px / 28px  (page titles in modal)
--text-2xl:       24px / 32px  (page headers)
--text-hero:      32px / 40px  (home hero, serif)
```

### Spacing
```
--space-1: 4px
--space-2: 8px
--space-3: 12px
--space-4: 16px
--space-5: 20px
--space-6: 24px
--space-8: 32px
--space-10: 40px
--space-12: 48px
--space-16: 64px
```

### Border Radius
```
--radius-sm:   6px   (small buttons, badges)
--radius-md:   8px   (cards, nav items, inputs)
--radius-lg:   12px  (feature cards)
--radius-xl:   16px  (modals, main input, chat bubbles)
--radius-full: 9999px (pills, avatars, toggle tracks)
```

---

## Interaction Patterns

### Sidebar
- Collapsed by default (solo icone)
- Click toggle per espandere/collassare
- Tooltip on hover quando collapsed
- Active state: bg grigio chiaro + font weight 500
- Smooth transition (200ms ease)

### Input Area
- Auto-grow textarea (min 1 row, max ~5 rows)
- Send button: grigio disabled → accent quando c'è testo
- Bottom toolbar sempre visibile
- Connector banner dismissibile (X close)

### Task Steps (chat)
- Collapsible con chevron
- In progress: animazione pulsante sul cerchio blu
- Completed: ✅ verde statico
- Sub-steps indentati con icona terminale
- Step tracker bottom bar: sticky, mostra progresso globale

### Empty States
- Sempre: icona grande (48-56px) centrata + titolo bold + descrizione + CTA button
- Tonalità: grigio medio, non triste — incoraggiante

### Modals
- Backdrop dimmed con blur leggero
- Animazione: scale(0.95) + opacity → scale(1) + opacity(1)
- Close: X button oppure click backdrop
- Internal scroll nel content area, nav sidebar fissa

### Cards
- Bordo sottile 1px
- Hover: ombra leggermente più marcata
- Border-radius consistente (12px feature cards, 16px main cards)
- Padding generoso (24px)

---

## Key Differences: Manus vs Current Homun

| Aspetto | Manus | Homun attuale |
|---------|-------|---------------|
| Sfondo | Warm cream #F5F0EB | Dark olive/moss |
| Sidebar | Icon-only collapsed, 56px | Full sidebar with text always |
| Settings | Single modal with nav | Separate full pages |
| Chat | Clean message flow + task steps | Tool timeline sidebar |
| Typography | Serif hero + sans body | Monospace throughout |
| Empty states | Illustrated + CTA | Minimal text |
| Input | Auto-grow + bottom toolbar | Fixed height |
| Quick actions | Pill chips below input | None |
| Follow-up | Suggestion rows after response | None |
| Color usage | Near-zero color, only blue accents | Olive/green accent system |
| Shadows | Ultra-subtle (0.04 opacity) | More pronounced |
| Border radius | Large (12-16px) | Smaller (4-8px) |

---

## Adoption Plan for Homun

### What to copy 1:1
1. **Warm background** — switch from dark olive to warm cream/beige
2. **Icon-only sidebar** — collapsible, 56px collapsed, ~280px expanded
3. **Settings as modal** — merge all settings pages into one modal with nav
4. **Chat task steps** — collapsible steps with ✅/🔵 status icons
5. **Empty states** — icon + title + description + CTA pattern everywhere
6. **Input area** — auto-grow + bottom toolbar + connector banner
7. **Follow-up suggestions** — after each completed task
8. **Card design** — subtle border, generous padding, large radius
9. **Typography hierarchy** — serif hero, sans-serif body, weight-based hierarchy
10. **Rating on completion** — "Com'è stato questo risultato?" ⭐⭐⭐⭐⭐

### What to adapt (not copy)
- **Brand identity**: Homun logo and name, not Manus
- **Skill cards**: adapt their pattern but keep our data model
- **Connectors**: map to our MCP recipes
- **Agent page**: adapt for our multi-agent system
- **Color accent**: keep configurable, but default to blue like Manus
