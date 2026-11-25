// F2 (fase fondamenta): LA PAGINA DEI COMPONENTI — solo di sviluppo e di
// test. Mostra OGNI componente di components/ui/ in OGNI stato, in chiaro e
// in scuro (il tema lo cambia la galleria con la classe `dark`): gli stati
// difficili da raggiungere navigando l'app si vedono qui, isolati.
//
// G2 (fase fondamenta-galleria): UNA SEZIONE PER VOLTA. Lo stato dell'arte
// (Storybook, Chromatic, toHaveScreenshot) è una cattura per STORIA: un pezzo
// piccolo e stabile per ogni gruppo di stati, non una pagina lunga in una
// foto sola (che non sta nel viewport e l'ultima demo la copre tutta). La
// galleria apre UNA sezione per scena: __galleriaComponenti.apri(sezione),
// con l'elenco da sezioni(). La radice della sezione porta il testid
// galleria-componenti-contenuto e l'id in data-sezione: la galleria controlla
// che stia INTERA nel viewport (niente pezzi tagliati in silenzio).
//
// NON entra nel build di produzione: la galleria compila questo modulo a
// parte (scripts/galleria-modulo.config.mjs) e lo carica con un import()
// dinamico dietro il controllo SANDBOT_TEST_GALLERIA=1 (App.tsx). Il
// marcatore «galleria-componenti» NON deve comparire in out/ — il test lo
// verifica a ogni fase.
//
// Regola per il futuro (docs/FATTO.md): un componente NUOVO in
// components/ui/ entra in questa pagina con tutti i suoi stati, in una
// SEZIONE che lo dichiara in `componenti` (la guardia componenti.test.ts
// controlla che ogni file di ui/ sia dichiarato da almeno una sezione).
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '@lingui/react'
import { i18n, activateUiLanguage } from '../lib/i18n'
// il CSS del modulo: tailwind lo scansiona dal sorgente; la galleria lo
// inietta a runtime (è un sovrainsieme identico del foglio dell'app: i token
// e le utility, già deduplicati per nome)
import '../styles.css'
import { Loader2, TriangleAlert, CircleHelp, CheckCircle2, Plus, Settings } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Stack } from '../components/ui/stack'
import { Row } from '../components/ui/row'
import { Grid } from '../components/ui/grid'
import { Text } from '../components/ui/text'
import { Icon } from '../components/ui/icon'
import { AppLogo } from '../components/ui/app-logo'
import { BotDot } from '../components/ui/bot-dot'
import { Avatar } from '../components/ui/avatar'
import { ListRow } from '../components/ui/list-row'
import { ListGroup } from '../components/ui/list-group'
import { Card } from '../components/ui/card'
import { EmptyState } from '../components/ui/empty-state'
import { Field } from '../components/ui/field'
import { Textarea } from '../components/ui/textarea'
import { Switch } from '../components/ui/switch'
import { Segmented } from '../components/ui/segmented'
import { SearchField } from '../components/ui/search-field'
import { FilterChipsScelta, FilterChipsMenu, FilterChipsInterruttore } from '../components/ui/filter-chips'
import { PageToolbar } from '../components/ui/page-toolbar'
import { ProposalCard } from '../components/ui/proposal-card'
import { Input, FIELD_CLASS } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { Notice } from '../components/ui/notice'
import { DataTable, Cell } from '../components/ui/data-table'
import { FlatList, FlatRow } from '../components/ui/flat-list'
import { Section } from '../components/ui/section'
import { PageHeader } from '../components/ui/page-header'
import { ColumnHead } from '../components/ui/column-head'
import { UnderlineTabs } from '../components/ui/underline-tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '../components/ui/dialog'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '../components/ui/dropdown-menu'
import { ModelPicker } from '../components/ui/ModelPicker'
import { ModelSelect } from '../components/ui/ModelSelect'
import { PageShell, PageColumn, type PageWidth } from '../components/ui/page-shell'
import { DocumentBody } from '../components/DocumentMarkdown'
import { BOT_FAMILIES, BOT_COLORS } from '../../../shared/avatar'

/** Le stesse tinte dei puntini di stato dei bot (Sidebar, ColorDot): 8 px, contrasto ≥ 3:1 in entrambi i temi. */
const PUNTINI = BOT_COLORS

/** Il markdown della sezione, in due parti (una pagina sola non sta in 800 px). */
const MD_PRIMA_PARTE = `# Il documento di prova

Tutti i casi del markdown, divisi in due scene.

## Titolo di secondo livello

Un paragrafo con del **grassetto** e del *corsivo* e un [collegamento](https://esempio.invalid), e un pezzo di \`codice in linea\`.

## Gli elenchi

Stretti (una riga per voce, con grassetto che NON deve spezzarli):

- la **prima** voce dell'elenco
- la seconda voce, pure con **due parole in grassetto**
- la terza

Larghi (più testo per voce):

- una voce con un testo molto più lungo che racconta due righe e ci sta, con **grassetto** in mezzo, perché la larghezza della pagina lo consente
- l'altra voce lunga, che si spezza quando serve e non prima
`

const MD_SECONDA_PARTE = `## Gli elenchi annidati

1. il primo passo
   - il primo sotto-passo
   - il secondo sotto-passo
2. il secondo passo

## Una tabella

| Voce | Importo | Nota |
|---|---|---|
| Materiali | 1.240 € | consegnati |
| Trasporti | 310 € | in ritardo |
| Totale | 1.550 € | |

## Una citazione

> Chi scrive regole piccole, le rispetta piccole.

\`\`\`sh
curl -s https://esempio.invalid/feed | head -n 20
\`\`\`
`

/** Una riga di etichetta: la scritta corta grigia sopra ogni campione. */
const Etichetta = ({ children }: { children: React.ReactNode }) => (
  <div className="text-caption text-muted-foreground mb-2">{children}</div>
)

/** Una riga di campioni: i pezzi affiancati, il testo sotto. */
const Riga = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="mb-8">
    <Etichetta>{label}</Etichetta>
    <div className="flex flex-wrap items-center gap-4">{children}</div>
  </div>
)

import type { ModelInfo } from '../../../shared/types'
const MODELLI: ModelInfo[] = [
  { id: 'finto', label: 'Finto locale', source: 'live', contextWindow: 131_072, vision: null, tools: null, thinkingLevels: [], cost: null, costSource: null, local: true },
  { id: 'finto-grande', label: 'Finto grande', source: 'live', contextWindow: 262_144, vision: null, tools: null, thinkingLevels: [], cost: null, costSource: null, local: true },
  { id: 'finto-remoto', label: 'Finto remoto', source: 'live', contextWindow: 65_536, vision: null, tools: null, thinkingLevels: [], cost: null, costSource: null, local: false }
]

/**
 * LE SEZIONI della pagina: la galleria fa UNA SCENA per sezione (in chiaro e
 * in scuro). `componenti` dichiara i file di components/ui/ che la sezione
 * mostra: la guardia (src/__tests__/guardie/componenti.test.ts) fallisce se
 * un file di ui/ non è dichiarato da NESSUNA sezione — un componente nuovo
 * entra qui con tutti i suoi stati.
 */
export const SEZIONI = [
  { id: 'impaginazione', titolo: 'stack, row e grid — impaginare', componenti: ['stack', 'row', 'grid'] },
  { id: 'testo', titolo: 'text e icon — testo e icone', componenti: ['text', 'icon'] },
  { id: 'identita', titolo: 'app-logo, bot-dot e avatar — identità', componenti: ['app-logo', 'bot-dot', 'avatar'] },
  { id: 'bottoni', titolo: 'button', componenti: ['button'] },
  { id: 'campi', titolo: 'input e select', componenti: ['input', 'select'] },
  { id: 'modulo', titolo: 'field, textarea, switch e segmented', componenti: ['field', 'textarea', 'switch', 'segmented'] },
  { id: 'avvisi', titolo: 'notice', componenti: ['notice'] },
  { id: 'tabella', titolo: 'data-table', componenti: ['data-table'] },
  { id: 'elenchi', titolo: 'flat-list, list-row e list-group', componenti: ['flat-list', 'list-row', 'list-group'] },
  { id: 'testate', titolo: 'section, page-header, column-head', componenti: ['section', 'page-header', 'column-head'] },
  { id: 'ricerca', titolo: 'search-field, filter-chips e page-toolbar', componenti: ['search-field', 'filter-chips', 'page-toolbar'] },
  { id: 'proposta', titolo: 'proposal-card — il bot propone, tu clicchi', componenti: ['proposal-card'] },
  { id: 'superfici', titolo: 'card e empty-state — superfici', componenti: ['card', 'empty-state'] },
  { id: 'schede', titolo: 'underline-tabs', componenti: ['underline-tabs'] },
  { id: 'dialogo', titolo: 'dialog aperto', componenti: ['dialog'] },
  { id: 'menu', titolo: 'dropdown-menu aperto', componenti: ['dropdown-menu'] },
  { id: 'modelli', titolo: 'ModelPicker e ModelSelect', componenti: ['ModelPicker', 'ModelSelect'] },
  { id: 'modelli-aperto', titolo: 'i selettori APERTI', componenti: ['ModelPicker', 'ModelSelect'] },
  { id: 'pillole', titolo: 'pillole e badge', componenti: [] },
  { id: 'gusci', titolo: 'page-shell — i tre gusci di larghezza', componenti: ['page-shell'] },
  { id: 'markdown-1', titolo: 'DocumentBody — titoli, grassetti ed elenchi', componenti: [] },
  { id: 'markdown-2', titolo: 'DocumentBody — elenchi annidati, tabella, citazione e codice', componenti: [] }
] as const

type IdSezione = (typeof SEZIONI)[number]['id']

/** La VERA pagina di una sezione, con tutti gli stati dei suoi componenti. */
const Sezione = ({ id }: { id: IdSezione }) => {
  const [tab, setTab] = useState('due')
  const [modello, setModello] = useState<string | null>('finto')
  const righeVuote: typeof righe = []
  const righe = [
    { id: 'r1', nome: 'Pastiera', data: '21/11', giudizio: 'ottima', lungo: 'un giudizio molto lungo che deve andare a capo troncato senza spingere la colonna di seguito oltre la sua larghezza' },
    { id: 'r2', nome: 'Risotto allo zafferano', data: '22/11', giudizio: 'buona', lungo: 'breve' }
  ]
  const colonne = [
    { id: 'nome', header: 'Ricetta', width: 200, cell: (r: typeof righe[0]) => <Cell>{r.nome}</Cell> },
    { id: 'data', header: 'Data', width: 90, cell: (r: typeof righe[0]) => <Cell secondary>{r.data}</Cell> },
    { id: 'giudizio', header: 'Giudizio', width: 110, cell: (r: typeof righe[0]) => <Cell>{r.giudizio}</Cell> },
    { id: 'lungo', header: 'Nota', width: 320, cell: (r: typeof righe[0]) => <Cell secondary>{r.lungo}</Cell> }
  ]
  const info = SEZIONI.find((s) => s.id === id)
  return (
    <div className="p-8" data-testid="galleria-componenti-contenuto" data-sezione={id}>
      <PageHeader title={info?.titolo ?? id} description="La pagina dei componenti è solo di sviluppo e di test: una sezione per volta, tutti gli stati, dal vivo." testId="galleria-page-header" />

      {id === 'modulo' && (
        <Section title="field, textarea, switch e segmented — il modulo" testId="galleria-section-modulo">
          <Riga label="field — etichetta · campo · aiuto · errore">
            <div className="flex items-start gap-4">
              <div className="flex w-60 flex-col gap-3">
                <Field label="Il nome" htmlFor="g-field-1"><Input id="g-field-1" placeholder="es. ricerche-estese" /></Field>
                <Field label="L'indirizzo" aiuto="Serve per le ricerche del bot." htmlFor="g-field-2"><Input id="g-field-2" placeholder="https://…" /></Field>
              </div>
              <div className="flex w-60 flex-col gap-3">
                <Field label="La chiave" errore="Troppo corta: ce ne vogliono 8." htmlFor="g-field-3"><Input id="g-field-3" aria-invalid="true" defaultValue="ak_" /></Field>
              </div>
            </div>
          </Riga>
          <Riga label="textarea — le tre altezze minime, poi cresce col testo">
            <div className="flex items-start gap-4">
              <Field label="La descrizione" htmlFor="g-ta-1"><Textarea id="g-ta-1" placeholder="cosa fa e quando usarla" /></Field>
              <Field label="Il messaggio" htmlFor="g-ta-2"><Textarea id="g-ta-2" min="md" defaultValue="La bozza del bot, che puoi ritoccare prima di inviarla." /></Field>
            </div>
          </Riga>
          <Riga label="switch — acceso/spento (le scelte sono Segmented)">
            <Switch checked onChange={() => undefined} label="Attivo" />
            <Switch checked={false} onChange={() => undefined} label="Attivo" />
            <Switch checked disabled onChange={() => undefined} label="Attivo (disattivato)" />
          </Riga>
          <Riga label="segmented — la scelta di un'impostazione, alta 36 (non un filtro)">
            <Segmented options={[{ value: 'sistema', label: 'Sistema' }, { value: 'chiaro', label: 'Chiaro' }, { value: 'scuro', label: 'Scuro' }]} value="chiaro" onChange={() => undefined} label="Tema" />
            <Segmented options={[{ value: 'sistema', label: 'Sistema' }, { value: 'chiaro', label: 'Chiaro' }, { value: 'scuro', label: 'Scuro' }]} value={null} onChange={() => undefined} label="Tema" disabled />
          </Riga>
        </Section>
      )}

      {id === 'bottoni' && (
        <Section title="button — tutte le varianti e taglie" testId="galleria-section-button">
          <Riga label="primary">
            <Button variant="primary">Aggiungi</Button>
            <Button variant="primary" size="sm">Piccolo</Button>
            <Button variant="primary" shape="control">Controllo</Button>
            <Button variant="primary" disabled>Disattivato</Button>
            <Button variant="primary" disabled><Loader2 className="size-4" />In caricamento</Button>
          </Riga>
          <Riga label="secondary">
            <Button variant="secondary">Secondario</Button>
            <Button variant="secondary" size="sm" shape="control">Controllo piccolo</Button>
            <Button variant="secondary" disabled>Disattivato</Button>
          </Riga>
          <Riga label="ghost">
            <Button variant="ghost">Fantasma</Button>
            <Button variant="ghost" size="sm">Piccolo</Button>
          </Riga>
          <Riga label="destructive">
            <Button variant="destructive">Elimina</Button>
            <Button variant="destructive" size="sm" shape="control">Piccolo</Button>
          </Riga>
          <Riga label="solo icona (aria-label)">
            <Button variant="ghost" icon aria-label="Aggiungi qualcosa"><Plus className="size-4" /></Button>
            <Button variant="secondary" icon aria-label="Impostazioni"><Settings className="size-4" /></Button>
          </Riga>
        </Section>
      )}

      {id === 'campi' && (
        <Section title="input e select — vuoto, pieno, con errore" testId="galleria-section-input">
          <Riga label="input">
            <Input className="w-56" placeholder="Vuoto" />
            <Input className="w-56" defaultValue="Pieno" />
            <Input className="w-56" placeholder="Con errore" aria-invalid="true" />
            <Input className="w-56" disabled defaultValue="Disattivato" />
          </Riga>
          <Riga label="select">
            <Select className="w-56" defaultValue=""><option value="">Scegli…</option><option value="a">Scelta A</option></Select>
            <Select className="w-56" defaultValue="a"><option value="a">Scelta A</option></Select>
            <Select className="w-56" defaultValue="a" aria-invalid="true"><option value="a">Con errore</option></Select>
          </Riga>
          <Riga label="le classi del campo da sole (FIELD_CLASS)">
            <input className="h-control w-56 rounded-control border border-input px-3 text-body" placeholder="campo grezzo" />
          </Riga>
        </Section>
      )}

      {id === 'avvisi' && (
        <Section title="notice — ogni gravità, con e senza azione" testId="galleria-section-notice">
          <div className="flex flex-col gap-3">
            <Notice icon={<CheckCircle2 className="size-4" />}>Tutto a posto: nessuna azione da fare.</Notice>
            <Notice icon={<TriangleAlert className="size-4" />} tone="warning">Un avviso giallo, senza azione.</Notice>
            <Notice icon={<TriangleAlert className="size-4" />} tone="destructive">Un errore permanente senza azione.</Notice>
            <Notice icon={<TriangleAlert className="size-4" />} tone="destructive" repeat={4} action={<Button variant="secondary" size="sm">Riprova</Button>}>
              Risposta vuota: il modello ha restituito solo ragionamento
            </Notice>
            <Notice icon={<CircleHelp className="size-4" />} tone="destructive" action={<Button variant="ghost" size="sm">Come si risolve</Button>}>
              Il comando non è riuscito
            </Notice>
          </div>
        </Section>
      )}

      {id === 'tabella' && (
        <Section title="data-table — righe, vuota, testo lungo" testId="galleria-section-data-table">
          <DataTable columns={colonne} rows={righe} rowKey={(r: typeof righe[0]) => r.id} testId="galleria-tabella" />
          <div className="mt-6">
            <DataTable columns={colonne} rows={righeVuote} rowKey={(r: typeof righe[0]) => r.id} empty="Nessuna ricetta: la tabella vuota." testId="galleria-tabella-vuota" />
          </div>
        </Section>
      )}

      {id === 'elenchi' && (
        <Section title="flat-list e list-row — le righe di elenco" testId="galleria-section-flat-list">
          <div className="mb-8">
            <Etichetta>list-row — segno · titolo · sottotitolo · metadato · azione (l'oggetto unico degli elenchi)</Etichetta>
            <div className="divide-y divide-border/50">
              <ListRow segno={<Avatar family="h-creature" color="c1" />} titolo="Turismo" sottotitolo="Server MCP · sul Mac" metadato="2 min fa" azione={<Button variant="secondary" size="sm">Apri</Button>} clickable />
              <ListRow segno={<AppLogo logo="gmail.svg" name="Gmail" className="size-8 text-body" />} titolo="Gmail" sottotitolo="Connettore · tramite Composio" azione={<Button variant="secondary" size="sm">Ricollega</Button>} />
            </div>
          </div>
          <div>
            <Etichetta>list-group — il titolo di sezione e le righe a filo, NESSUN riquadro grigio</Etichetta>
            <ListGroup titolo="Server collegati" azione={<Button variant="ghost" size="sm">Mostra tutto</Button>}>
              <ListRow segno={<AppLogo logo="asana.svg" name="Asana" className="size-8 text-body" />} titolo="Asana" sottotitolo="24 strumenti · tutti i bot" metadato="oggi" clickable />
              <ListRow segno={<BotDot color="c2" />} titolo="ricerche-estese" sottotitolo="stdio · sul Mac" azione={<Button variant="secondary" size="sm">Test</Button>} />
            </ListGroup>
          </div>
          <div className="mb-2">
            <Etichetta>flat-list (il pezzo di prima, finché le pagine non convertono)</Etichetta>
          </div>
          <FlatList testId="galleria-flat-list">
            <FlatRow title="La prima riga" subtitle="con un sottotitolo" trailing={<Button variant="ghost" size="sm" shape="control">Apri</Button>} />
            <FlatRow title="La seconda riga" subtitle="cliccabile" clickable onClick={() => undefined} />
          </FlatList>
        </Section>
      )}

      {id === 'testate' && (
        <Section title="section, page-header, column-head" testId="galleria-section-section">
          <div className="grid grid-cols-2 gap-8 items-start">
            <div>
              {/* C1: la «+» sembrava staccata dal suo blocco perché la demo metteva la fascia VUOTA col solo bottone — nel catalogo la riga si vede come la usa l'app: titolo a sinistra, azione a destra, il corpo sotto */}
              <div data-testid="galleria-column-head" className="overflow-hidden rounded-surface border border-border">
                <ColumnHead name="Le colonne di prova">
                  <PageColumn>
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span className="truncate text-title font-semibold">Una colonna</span>
                    </div>
                    <Button variant="ghost" icon aria-label="Aggiungi" className="no-drag"><Plus className="size-4" /></Button>
                  </PageColumn>
                </ColumnHead>
                <div className="flex h-24 items-center justify-center text-small text-muted-foreground">il corpo della colonna, sotto la fascia dei 52</div>
              </div>
              <div className="mt-4">
                <PageHeader title="Una testata di pagina" description="La descrizione sotto la testata." testId="galleria-page-header-2" />
              </div>
            </div>
            <div>
              <Section title="Una sezione con azione" action={<Button variant="ghost" size="sm">Mostra tutto</Button>}>
                <div className="text-body">Il contenuto della sezione.</div>
              </Section>
            </div>
          </div>
        </Section>
      )}

      {id === 'ricerca' && (
        <Section title="search-field — l'unica ricerca dell'app" testId="galleria-section-search">
          <Riga label="vuota, piena, e più larga (chi la usa lo decide)">
            <SearchField value="" onChange={() => undefined} placeholder="Cerca tra plugin e skill" ariaLabel="Cerca tra plugin e skill" testId="galleria-search" />
            <SearchField value="mater" onChange={() => undefined} placeholder="Cerca tra i documenti" ariaLabel="Cerca tra i documenti" />
            <SearchField value="" onChange={() => undefined} className="w-96" placeholder="Cerca in tutte le attività" ariaLabel="Cerca in tutte le attività" />
          </Riga>
          <Riga label="filter-chips — le tre varianti (scelta · menu · interruttore)">
            <div className="flex flex-wrap items-center gap-2">
              <FilterChipsScelta active count={12} onSelect={() => undefined}>Tutte</FilterChipsScelta>
              <FilterChipsScelta active={false} count={3} onSelect={() => undefined}>Dati tuoi</FilterChipsScelta>
              <FilterChipsScelta active={false} onSelect={() => undefined}>Pagamenti</FilterChipsScelta>
              <FilterChipsMenu label="Bot" value="tutti" options={[{ value: 'tutti', label: 'tutti' }, { value: 'competitoor', label: 'Competitoor' }, { value: 'ricerche', label: 'Ricerche' }]} onSelect={() => undefined} />
              <FilterChipsInterruttore active={false} onToggle={() => undefined}>Archiviati</FilterChipsInterruttore>
              <FilterChipsInterruttore active onToggle={() => undefined}>Archiviati (acceso)</FilterChipsInterruttore>
            </div>
          </Riga>
          <Riga label="page-toolbar — la barra della pagina: ricerca · pillole · vista">
            <div className="w-full rounded-surface border border-border p-3">
              <PageToolbar
                ricerca={<SearchField value="mater" onChange={() => undefined} placeholder="Cerca tra plugin e skill" ariaLabel="Cerca tra plugin e skill" />}
                pillole={<><FilterChipsScelta active count={12} onSelect={() => undefined}>Tutte</FilterChipsScelta><FilterChipsMenu label="Bot" value="tutti" options={[{ value: 'tutti', label: 'tutti' }]} onSelect={() => undefined} /></>}
                vista={<UnderlineTabs tabs={[['griglia', 'Griglia'], ['lista', 'Lista']] as never} value="griglia" onChange={() => undefined} testId="galleria-toolbar-tabs" />}
              />
            </div>
          </Riga>
        </Section>
      )}

      {id === 'superfici' && (
        <Section title="card — una forma sola per le card in chat e le schede della griglia" testId="galleria-section-card">
          <Riga label="col respiro di default (16) e senza">
            <Card>
              <Stack gap="tight">
                <Text weight="semibold">Una card in chat</Text>
                <Text size="small" tone="muted">Il contenuto decide il ritmo: il catalogo decide la forma.</Text>
              </Stack>
            </Card>
            <Card padding="none" className="w-40">
              <div className="flex h-16 items-center justify-center text-small text-muted-foreground">senza respiro</div>
            </Card>
          </Riga>
          <Riga label="empty-state — lo stato vuoto dice cosa fare">
            <div className="w-80 rounded-surface border border-border">
              <EmptyState icon={CircleHelp} titolo="Nessuna skill" frase="Creane una, importala, o chiedi a un bot di salvarne una." azione={<Button size="sm">Creane una</Button>} />
            </div>
          </Riga>
        </Section>
      )}

      {id === 'schede' && (
        <Section title="underline-tabs — otto schede, la seconda attiva" testId="galleria-section-tabs">
          <UnderlineTabs
            tabs={[['una', 'Prima'], ['due', 'Seconda'], ['tre', 'Terza'], ['quattro', 'Quarta scheda'], ['cinque', 'Quinta scheda'], ['sei', 'Sesta scheda'], ['sette', 'Settima scheda'], ['otto', 'Ottava scheda']]}
            value={tab}
            onChange={setTab}
            label="Le schede di prova"
            testId="galleria-tabs"
          />
          <div className="mt-4 text-body">Il contenuto della scheda «{tab}»: il filetto resta sotto la scheda attiva.</div>
        </Section>
      )}

      {id === 'dialogo' && (
        <Section title="dialog — aperto (scena sua: l'overlay copre il resto)" testId="galleria-section-dialog">
          <div className="h-64 relative">
            <Dialog open onOpenChange={() => undefined}>
              <DialogContent data-testid="galleria-dialogo">
                <DialogHeader>
                  <DialogTitle>Il dialogo di prova</DialogTitle>
                  <DialogDescription>La descrizione che spiega cosa fa.</DialogDescription>
                </DialogHeader>
                <div className="text-body">Il corpo del dialogo.</div>
                <DialogFooter>
                  <DialogClose asChild><Button variant="ghost">Annulla</Button></DialogClose>
                  <DialogClose asChild><Button variant="primary">Conferma</Button></DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </Section>
      )}

      {id === 'menu' && (
        <Section title="dropdown-menu — aperto (scena sua)" testId="galleria-section-menu">
          <div className="h-64 relative">
            <DropdownMenu open onOpenChange={() => undefined}>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm">Il menu aperto ▾</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent data-testid="galleria-menu">
                <DropdownMenuItem>Apri</DropdownMenuItem>
                <DropdownMenuItem>Rinomina</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>Archivia</DropdownMenuItem>
                <DropdownMenuItem className="text-destructive">Elimina</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </Section>
      )}

      {id === 'modelli' && (
        <Section title="ModelPicker e ModelSelect" testId="galleria-section-model">
          <Riga label="ModelPicker">
            <ModelPicker models={MODELLI} value={modello} onChange={setModello} placeholder="predefinito…" />
            <ModelPicker models={MODELLI} value={null} onChange={() => undefined} placeholder="nessun modello" />
            <ModelPicker models={MODELLI} value={modello} onChange={() => undefined} disabled />
            <ModelPicker models={MODELLI} value={null} onChange={() => undefined} pillTrigger={{ label: 'Altri modelli…' }} />
          </Riga>
          <Riga label="ModelSelect">
            <ModelSelect value={null} onChange={() => undefined} allowNone allowFollowMain />
            <ModelSelect value={{ providerId: 'finto', model: 'finto' }} onChange={() => undefined} />
          </Riga>
        </Section>
      )}

      {id === 'modelli-aperto' && (
        <Section title="i selettori di modello APERTI (scena loro, come il dialogo e il menu)" testId="galleria-section-model-open">
          <div className="flex items-start gap-8">
            <div>
              <Etichetta>ModelPicker aperto</Etichetta>
              <div className="relative h-64 w-80">
                <ModelPicker models={MODELLI} value="finto" onChange={() => undefined} placeholder="predefinito…" defaultOpen />
              </div>
            </div>
            <div>
              <Etichetta>ModelSelect aperto (popover, i provider sotto)</Etichetta>
              <div className="relative h-64 w-80">
                <ModelSelect value={null} onChange={() => undefined} allowNone allowFollowMain defaultOpen />
              </div>
            </div>
          </div>
        </Section>
      )}

      {id === 'pillole' && (
        <Section title="pillole, badge e puntini di stato" testId="galleria-section-puntini">
          <Riga label="pillole e badge">
            <Button variant="primary" size="sm">Pillola</Button>
            <span className="inline-flex items-center rounded-full bg-muted px-2 h-control-sm text-caption">badge neutro</span>
            <span className="inline-flex items-center rounded-full bg-destructive text-destructive-foreground px-2 h-control-sm text-caption">badge rosso</span>
          </Riga>
          {/* C1: la demo di fondamenta-galleria disegnava un CERCHIO qualsiasi — le famiglie si vedevano tutte uguali e il difetto sembrava dell'Avatar: la demo sbagliava. Ora rende il pezzo VERO del catalogo */}
          <Riga label="avatar — le cinque famiglie del disegno vero, a 32">
            <div className="flex items-center gap-4">
              {BOT_FAMILIES.map((f) => (
                <div key={f} className="flex items-center gap-2 rounded-full bg-muted px-3 py-1.5">
                  <Avatar family={f} color="c1" />
                  <span className="text-caption">{f}</span>
                </div>
              ))}
            </div>
          </Riga>
          <Riga label="le misure (20 · 32 · 40 · 64) e i colori c1–c4 sulla creatura">
            <div className="flex items-end gap-4">
              <Avatar family="h-creature" color="c1" size="sm" />
              <Avatar family="h-robo" color="c2" />
              <Avatar family="h-device" color="c3" size="lg" />
              <Avatar family="jelly" color="c4" size="xl" />
            </div>
          </Riga>
        </Section>
      )}

      {id === 'gusci' && (
        <Section title="page-shell — i due gusci di larghezza (reading e wide: la page di una volta è via)" testId="galleria-section-shell">
          {/* G2: ogni guscio sta in un riquadro relative ad altezza FISSA con
              overflow-hidden: PageShell è absolute inset-0, senza il riquadro
              l'ultimo guscio si stenderebbe su tutta la pagina (page-shell.tsx
              non si tocca) */}
          {(['reading', 'wide'] as PageWidth[]).map((w) => (
            <div key={w} className="relative mb-4 h-40 overflow-hidden rounded-surface border border-border">
              <PageShell width={w} testId={`galleria-shell-${w}`} headName="componenti"
                header={<PageHeader title={`Il guscio «${w}»`} testId={`galleria-shell-header-${w}`} />}
                contentClassName="py-4">
                <PageColumn width={w}>
                  <div className="text-body">Il contenuto del guscio «{w}»: la colonna centrata alla larghezza scelta.</div>
                </PageColumn>
              </PageShell>
            </div>
          ))}
        </Section>
      )}

      {id === 'proposta' && (
        <Section title="proposal-card — le quattro varianti della proposta in chat" testId="galleria-section-proposal">
          <div className="flex flex-col gap-6">
            <div>
              <Etichetta>server MCP (in attesa e collegata)</Etichetta>
              <div className="flex flex-col gap-4 lg:flex-row">
                <ProposalCard
                  testata={<div className="flex items-center gap-2"><AppLogo logo="asana.svg" name="Asana" className="size-8 text-body" /><Text weight="semibold">Aggiungi server MCP: Asana</Text></div>}
                  righe={<><Text size="small" tone="muted">Pubblicato da asana (dominio verificato) · remoto</Text><Text size="small" tone="muted">Accesso: con il tuo account (si apre il browser)</Text></>}
                  perché={<Text>Per cercare i task del tuo piano senza lasciare la chat.</Text>}
                  azioni={<><Button>Aggiungi</Button><Button variant="ghost">No</Button></>}
                />
                <ProposalCard
                  testata={<div className="flex items-center gap-2"><AppLogo logo="asana.svg" name="Asana" className="size-8 text-body" /><Text weight="semibold">Aggiungi server MCP: Asana</Text></div>}
                  stato={<Text size="small" tone="muted">✓ Asana collegato · 12 strumenti</Text>}
                />
              </div>
            </div>
            <div>
              <Etichetta>plugin da installare · plugin da accendere · app Composio</Etichetta>
              <div className="flex flex-col gap-4 lg:flex-row">
                <ProposalCard
                  testata={<div className="flex items-center gap-2"><AppLogo logo={null} name="Ricette" className="size-8 text-body" /><Text weight="semibold">Installa plugin: ricette-claude</Text></div>}
                  righe={<Text size="small" tone="muted">fiducia: marketplace ufficiale · commit 9c31f0aa2b4c · skill: ricette, spesa</Text>}
                  perché={<Text>Mi serve per salvare le ricette che trovi nei documenti.</Text>}
                  azioni={<><Button>Installa</Button><Button variant="ghost">No</Button></>}
                />
                <ProposalCard
                  testata={<div className="flex items-center gap-2"><AppLogo logo={null} name="Posta" className="size-8 text-body" /><Text weight="semibold">Accendi il plugin Posta</Text></div>}
                  righe={<Text size="small" tone="muted">Server MCP · sul Mac · spento</Text>}
                  perché={<Text>Per cercare la mail della prenotazione che ti ho chiesto.</Text>}
                  azioni={<><Button>Attiva</Button><Button variant="ghost">Non ora</Button></>}
                />
                <ProposalCard
                  avviso={<p className="rounded-control bg-destructive/15 px-3 py-2 text-small text-destructive">Proposta fatta dopo aver letto contenuti esterni: controlla che sia quello che volevi</p>}
                  testata={<div className="flex items-center gap-2"><AppLogo logo="gmail.svg" name="Gmail" className="size-8 text-body" /><Text weight="semibold">Collega Gmail</Text></div>}
                  righe={<Text size="small" tone="muted">App del catalogo · tramite Composio</Text>}
                  perché={<Text>Così posso cercare i messaggi quando me lo chiedi.</Text>}
                  azioni={<><Button>Connetti</Button><Button variant="ghost">No</Button></>}
                />
              </div>
            </div>
          </div>
        </Section>
      )}

      {id === 'markdown-1' && (
        <Section title="DocumentBody — titoli, grassetti ed elenchi (1ª parte)" testId="galleria-section-markdown-1">
          <PageColumn width="reading">
            <DocumentBody markdown={MD_PRIMA_PARTE} />
          </PageColumn>
        </Section>
      )}

      {id === 'identita' && (
        <Section title="app-logo — il file del catalogo o l'iniziale" testId="galleria-section-app-logo">
          <Riga label="da 32 (le righe) e da 40 (le testate di scheda)">
            <AppLogo logo="gmail.svg" name="Gmail" className="size-8 text-body" />
            <AppLogo logo="slack.svg" name="Slack" className="size-8 text-body" />
            <AppLogo logo="asana.svg" name="Asana" className="size-10 text-reading" />
            <AppLogo logo={null} name="Sconosciuta" className="size-8 text-body" />
            <AppLogo logo={null} name="App Nuova" className="size-10 text-reading" />
          </Riga>
          <Riga label="bot-dot — il colore del bot: tutti i sette, 8 px">
            <div className="flex items-center gap-4">
              {PUNTINI.map((c) => (
                <div key={c} className="flex items-center gap-2 rounded-full bg-muted px-3 py-1.5">
                  <BotDot color={c} testId={`bot-dot-${c}`} />
                  <span className="text-caption">{c}</span>
                </div>
              ))}
            </div>
          </Riga>
        </Section>
      )}

      {id === 'testo' && (
        <Section title="text — le sei taglie dei token, i toni e i pesi" testId="galleria-section-text">
          <Riga label="le sei taglie (ognuna con la sua interlinea)">
            <div className="flex flex-col gap-2">
              <Text size="page" weight="semibold">Titolo di pagina · 28</Text>
              <Text size="title" weight="semibold">Titolo di scheda · 20</Text>
              <Text size="reading">Testo di lettura · 16, quello dei documenti e dei messaggi</Text>
              <Text>Corpo · 14, il default dell'interfaccia</Text>
              <Text size="small" tone="muted">Seconda riga · 13, grigia</Text>
              <Text size="caption" tone="muted">Metadato · 12, orari e contatori</Text>
            </div>
          </Riga>
          <Riga label="i toni">
            <Text>normale</Text>
            <Text tone="muted">grigio</Text>
            <Text tone="destructive">errore</Text>
          </Riga>
          <Riga label="icon — le due misure dei token (16 nel testo, 20 nelle testate)">
            <div className="flex items-center gap-4 text-body">
              <Icon icon={Loader2} /> <Icon icon={TriangleAlert} size="lg" /> <Icon icon={CircleHelp} /> <Icon icon={CheckCircle2} size="lg" /> <Icon icon={Plus} /> <Icon icon={Settings} size="lg" />
            </div>
          </Riga>
          <Riga label="truncate: la riga che non ci sta si taglia col ellissi">
            <div className="w-56">
              <Text truncate size="small" tone="muted">una riga lunga che da sola non entrerebbe mai in questa larghezza</Text>
            </div>
          </Riga>
        </Section>
      )}

      {id === 'impaginazione' && (
        <Section title="stack — la colonna, con le distanze dei token" testId="galleria-section-stack">
          <Riga label="la colonna: gap block (16, il default) a confronto con tight (8) e section (32)">
            <div className="flex items-start gap-6">
              <div className="w-44 rounded-surface border border-border p-3">
                <Stack>
                  <div className="rounded-control bg-muted px-2 py-1 text-small">block · 16</div>
                  <div className="rounded-control bg-muted px-2 py-1 text-small">il default</div>
                </Stack>
              </div>
              <div className="w-44 rounded-surface border border-border p-3">
                <Stack gap="tight">
                  <div className="rounded-control bg-muted px-2 py-1 text-small">tight · 8</div>
                  <div className="rounded-control bg-muted px-2 py-1 text-small">il gruppo</div>
                </Stack>
              </div>
              <div className="w-44 rounded-surface border border-border p-3">
                <Stack gap="section">
                  <div className="rounded-control bg-muted px-2 py-1 text-small">section · 32</div>
                  <div className="rounded-control bg-muted px-2 py-1 text-small">le sezioni</div>
                </Stack>
              </div>
            </div>
          </Riga>
          <Riga label="row — la riga: allineamento e distanza una volta sola">
            <div className="flex flex-col gap-2">
              <Row>
                <Button variant="secondary" size="sm">un controllo</Button>
                <Button variant="ghost" size="sm">l'altro</Button>
                <span className="text-caption text-muted-foreground">e un metadato</span>
              </Row>
              <Row gap="block" align="baseline">
                <span className="text-title font-semibold">Un titolo</span>
                <span className="text-small text-muted-foreground">con la sua riga grigia, alla base</span>
              </Row>
            </div>
          </Riga>
          <Riga label="grid — le colonne uguali">
            <Grid cols={3} className="w-72">
              <div className="flex h-14 items-center justify-center rounded-surface border border-border text-small text-muted-foreground">una</div>
              <div className="flex h-14 items-center justify-center rounded-surface border border-border text-small text-muted-foreground">due</div>
              <div className="flex h-14 items-center justify-center rounded-surface border border-border text-small text-muted-foreground">tre</div>
            </Grid>
          </Riga>
        </Section>
      )}

      {id === 'markdown-2' && (
        <Section title="DocumentBody — tabella, citazione e codice (2ª parte)" testId="galleria-section-markdown-2">
          <PageColumn width="reading">
            <DocumentBody markdown={MD_SECONDA_PARTE} />
          </PageColumn>
        </Section>
      )}
    </div>
  )
}

/** L'host della pagina: un vaso fixed a tutta finestra, che la galleria apre e chiude tra le scene. */
let host: HTMLDivElement | null = null
let radice: ReturnType<typeof createRoot> | null = null

const monta = (id: IdSezione) => {
  if (!host) return
  radice?.unmount()
  radice = createRoot(host)
  radice.render(
    <I18nProvider i18n={i18n}>
      <Sezione id={id} />
    </I18nProvider>
  )
}

const apri = (id?: IdSezione) => {
  chiudi()
  host = document.createElement('div')
  host.dataset.testid = 'galleria-componenti'
  // la pagina di test sta sopra tutto; il tema (la classe dark) lo decide la galleria sull'<html>
  // z-index 40: SOPRA il contenuto normale dell'app (z-auto), SOTTO il livello
  // dei portali (z-50) — così i dialoghi e i menu APERTI delle sezioni loro si
  // vedono (montano a livello body e prima finivano sotto l'host). Gli overlay
  // dell'app sono chiusi da closeOverlays prima di ogni scena: nulla passa
  // sopra la pagina di test
  host.style.cssText = 'position:fixed;inset:0;z-index:40;background:var(--background);color:var(--foreground);overflow:auto'
  document.body.appendChild(host)
  monta(SEZIONI.find((s) => s.id === id) ? id! : SEZIONI[0]!.id)
}

const chiudi = () => {
  radice?.unmount()
  radice = null
  host?.remove()
  host = null
}

/** L'API che la galleria usa: apri(sezione)/chiudi() tra le scene, sezioni() per l'elenco. L'import del modulo NON apre nulla. */
;(window as unknown as Record<string, unknown>).__galleriaComponenti = { apri, chiudi, sezioni: () => SEZIONI.map((s) => s.id) }

// la lingua dell'interfaccia di prova (il sorgente è italiano: anche senza catalogo i testi sono giusti)
void activateUiLanguage('it')
