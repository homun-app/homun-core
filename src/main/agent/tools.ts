// Tool base — stessi nomi e semantica dei tool verificati nel local-exec-daemon originale.
import type { ToolDef } from './llm'
import * as sandbox from '../sandbox'
import { resolveSecretRefs, redactSecrets } from './secrets'
import {
  writeMemory, updateMemory, deleteMemory, listMemories, searchMemoriesByQuery,
  type MemoryTier, type MemoryScope
} from './memory'
import { readSkillBody, writeSkill, listSkills } from './skills'

export const toolDefs: ToolDef[] = [
  {
    name: 'send_to_user',
    description: "Manda un messaggio all'utente in chat (markdown). È l'UNICO modo di parlare con l'utente: il testo che scrivi fuori dai tool non gli arriva. Puoi chiamarlo più volte in un turno: un messaggio breve di avanzamento prima di lavori lunghi, poi il risultato finale.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Il messaggio (markdown) da mostrare in chat' },
        urgent: { type: 'boolean', description: 'True solo se l\'utente deve agire entro poche ore; i messaggi non urgenti dei turni automatici aspettano la finestra di consegna' }
      },
      required: ['text']
    }
  },
  {
    name: 'ask_user',
    description: "Poni una domanda all'utente con scelte cliccabili. Crea un widget in chat e TERMINA il turno: la risposta arriva come nuovo messaggio utente. Preferisci le opzioni a testo libero: non chiedere mai a testo libero quando puoi offrire delle scelte.",
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'La domanda da mostrare' },
        helpText: { type: 'string', description: 'Spiegazione breve del perché della domanda (opzionale)' },
        options: {
          type: 'array',
          description: 'Le opzioni cliccabili (2-4)',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Etichetta del bottone' },
              value: { type: 'string', description: 'Valore associato (default: label)' },
              description: { type: 'string', description: 'Descrizione breve (opzionale)' },
              style: { type: 'string', enum: ['primary', 'default'], description: '"primary" per l\'azione consigliata (opzionale)' }
            },
            required: ['label']
          }
        },
        multiSelect: { type: 'boolean', description: 'True per permettere più selezioni con conferma (opzionale)' },
        allowCustom: { type: 'boolean', description: 'True per aggiungere un campo di testo libero (opzionale)' },
        dismissOnMoveOn: { type: 'boolean', description: 'True se il widget può essere scavalcato quando l\'utente scrive altro (opzionale)' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'draft_external',
    description: "Prepara un invio verso l'esterno (email, Slack, altro) come BOZZA con pulsanti Invia/Scarta/Modifica: l'invio vero avviene SOLO se l'utente clicca Invia. Gli invii verso l'esterno passano SEMPRE da una bozza.",
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['email', 'slack', 'other'], description: 'Canale di invio' },
        to: { type: 'string', description: 'Destinatario' },
        subject: { type: 'string', description: 'Oggetto (email, opzionale)' },
        body: { type: 'string', description: 'Corpo del messaggio' },
        via: {
          type: 'object',
          description: 'Il tool di invio da eseguire alla conferma (opzionale: senza, la bozza è solo testo)',
          properties: {
            tool: { type: 'string', description: 'Nome del tool MCP di invio (es. mcp__gmail__send_message)' },
            args: { type: 'object', description: 'Argomenti del tool di invio', additionalProperties: true }
          },
          required: ['tool', 'args']
        }
      },
      required: ['channel', 'to', 'body']
    }
  },
  {
    name: 'run-command',
    description: "Esegue un comando shell nel computer dell'agente (sandbox persistente). Restituisce stdout/stderr e exit code. Per usare una credenziale del vault scrivi {{secret:NOME}} dove serve il valore (es. `curl -H \"Authorization: Bearer {{secret:API_KEY}}\"`): viene sostituita al momento dell'esecuzione con la variabile d'ambiente $SANDBOT_SECRET_NOME e il valore non appare mai nel transcript.",
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Il comando da eseguire' },
        workingDirectory: { type: 'string', description: 'Directory di lavoro opzionale (default: home del box)' },
        timeout: { type: 'number', description: 'Timeout in secondi (default 120)' }
      },
      required: ['command']
    }
  },
  {
    name: 'read-file',
    description: "Legge il contenuto di un file nel computer dell'agente.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Percorso assoluto o relativo alla home' },
        offset: { type: 'number', description: 'Riga di inizio (opzionale)' },
        limit: { type: 'number', description: 'Numero massimo di righe (opzionale)' }
      },
      required: ['path']
    }
  },
  {
    name: 'write-file',
    description: "Scrive un file nel computer dell'agente (crea le directory se mancano).",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Percorso del file' },
        content: { type: 'string', description: 'Contenuto testuale completo' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list-directory',
    description: "Elenca il contenuto di una directory nel computer dell'agente.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Percorso della directory (default home)' }
      },
      required: ['path']
    }
  },
  {
    name: 'use-app',
    description: "Controlla il computer dell'utente (computer use). Azioni: screenshot (cattura lo schermo e lo vedi come immagine), click/double_click/right_click {x,y in pixel dell'immagine}, type {text}, key {key es. cmd+c, Return, tab}, open_app {app}. Flusso tipico: screenshot → guarda → azione → screenshot per verificare.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['screenshot', 'click', 'double_click', 'right_click', 'type', 'key', 'open_app'], description: 'Azione da eseguire' },
        x: { type: 'number', description: 'Coordinata X in pixel del screenshot' },
        y: { type: 'number', description: 'Coordinata Y in pixel del screenshot' },
        text: { type: 'string', description: 'Testo da digitare (action type)' },
        key: { type: 'string', description: 'Combo tasti (action key)' },
        app: { type: 'string', description: 'Nome app, preferisci il nome inglese (es. Calculator, Notes, Safari)' }
      },
      required: ['action']
    }
  },
  {
    name: 'list-credentials',
    description: "Elenca i NOMI delle credenziali disponibili nel vault locale. Il valore non si legge mai direttamente: si usa scrivendo {{secret:NOME}} nell'argomento command di run-command.",
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'update_memory',
    description: "Scrive, aggiorna o elimina una memoria persistente (file markdown che restano tra i turni). tier 'core' = fatti stabili (lingua, nome, preferenze: sempre nel contesto); tier 'log' = regole operative datate (sotto budget, le più recenti vincono). scope 'agent' (default) = solo questo bot; scope 'user' = condivisa da tutti i bot dell'utente. action 'write' crea (id generato dal sistema); 'update'/'delete' richiedono l'id avuto da write o recall_memory.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['write', 'update', 'delete'], description: "Azione sulla memoria" },
        id: { type: 'string', description: 'Id della memoria (per update/delete)' },
        content: { type: 'string', description: 'Il contenuto della memoria (per write/update)' },
        tier: { type: 'string', enum: ['core', 'log'], description: "core = fatto stabile, log = regola operativa" },
        scope: { type: 'string', enum: ['agent', 'user'], description: "agent = solo questo bot (default), user = tutti i bot" }
      },
      required: ['action', 'content', 'tier']
    }
  },
  {
    name: 'recall_memory',
    description: "Cerca nelle tue memorie (del bot e condivise dall'utente) per parole chiave, case-insensitive. Ritorna le prime 10 con id, tier e scope: usa gli id per update_memory.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Parole chiave da cercare' }
      },
      required: ['query']
    }
  },
  {
    name: 'skill',
    description: "Carica le istruzioni complete di una skill disponibile (nel system prompt vedi solo nome e descrizione). Chiamala quando una skill serve per il compito corrente, poi seguine le istruzioni.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome della skill (come elencato in "# Skill disponibili")' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_skill',
    description: "Crea o aggiorna una skill (procedura riutilizzabile con istruzioni complete). Richiede l'approvazione dell'utente: una skill cambia il tuo comportamento futuro. name solo [a-z0-9-], max 64 caratteri.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome della skill ([a-z0-9-], max 64)' },
        description: { type: 'string', description: 'Quando usare la skill (una riga, compare nel system prompt)' },
        content: { type: 'string', description: 'Le istruzioni complete della skill (markdown)' }
      },
      required: ['name', 'description', 'content']
    }
  },
  {
    name: 'search_connectors',
    description: "Cerca le app connettibili nel catalogo (\"Connetti app\") con lo stato di ciascuna: non connessa, connessa, da autorizzare. Usalo prima di offer_connector per trovare l'id esatto e per sapere se un connettore è già attivo.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Parole chiave (es. "email", "issue", "pagamenti"); vuoto = tutto il catalogo' }
      },
      required: ['query']
    }
  },
  {
    name: 'offer_connector',
    description: "OFFRE all'utente la connessione di un'app del catalogo: mostra in chat una card con il bottone \"Connetti\" e il motivo per cui servirebbe. NON puoi connettere da solo: la connessione avviene solo dal click dell'utente; quando avviene ricevi un messaggio di sistema e puoi proseguire. Trova l'id con search_connectors.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id del connettore dal catalogo (search_connectors)' },
        reason: { type: 'string', description: 'Perché questa app aiuterebbe (una frase, mostrata nella card)' }
      },
      required: ['id', 'reason']
    }
  },
  {
    name: 'send_to_agent',
    description: "Manda un messaggio a un altro bot dell'utente (delega, aggiornamenti, domande). Il destinatario lo riceve come evidenza in un blocco <messaggio_da_agente> e può risponderti con lo stesso tool. Cerca l'id con list_agents. Limiti anti-ciclo: catena massima di 3 passaggi e 10 messaggi per coppia di bot all'ora; la coda del destinatario ha lo stesso tetto dei messaggi dell'utente.",
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Id del bot destinatario (da list_agents)' },
        text: { type: 'string', description: 'Il messaggio per l\'altro bot (chiaro e autonomo: lui non vede la tua conversazione)' }
      },
      required: ['agentId', 'text']
    }
  },
  {
    name: 'list_agents',
    description: "Elenca gli ALTRI bot dell'utente (nome, id, descrizione, stato): serve per decidere a chi delegare con send_to_agent.",
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'propose_rule_change',
    description: "Proponi all'utente una regola di approvazione automatica (\"Continua da solo quando…\" / \"Fermati e chiedimi sempre quando…\") in linguaggio naturale, ad esempio dopo che ha approvato più volte la stessa azione. La regola NON viene salvata da te: l'utente la aggiunge solo se accetta la card. kind 'allow' = continua da solo, 'block' = chiedi sempre.",
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['allow', 'block'], description: "'allow' = continua da solo quando la regola è rispettata; 'block' = fermati e chiedi sempre" },
        text: { type: 'string', description: 'La regola in linguaggio naturale (una frase)' },
        why: { type: 'string', description: 'Perché questa regola aiuterebbe (una frase, mostrata nella card)' }
      },
      required: ['kind', 'text']
    }
  },
  {
    name: 'create_task',
    description: "Apre un TASK per un lavoro LUNGO in un thread separato: la chat principale resta pulita e il task ha un proprio contesto (solo il brief e le proprie entry). Usalo per ricerche, analisi o verifiche che richiedono molti passi; il task parte quando finisce il turno corrente (stessa coda, in serie). Il task NON vede questa conversazione: metti nel brief tutto il contesto (obiettivo, vincoli, dove cercare). Le domande che fai nel task (ask_user) arrivano comunque all'utente dalla vista del task.",
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Titolo breve del task (mostrato nella card in chat)' },
        brief: { type: 'string', description: 'Il compito completo con il contesto necessario: è tutto ciò che il task vedrà di questa conversazione' }
      },
      required: ['title', 'brief']
    }
  },
  {
    name: 'update_task',
    description: "Chiude un task tuo con l'esito: status 'done' (riuscito) o 'failed', con un summary BREVE di cosa è emerso o fatto. Il summary torna alla chat principale, che riferirà all'utente in un messaggio breve senza ripetere tutto il lavoro. Da chiamare SEMPRE quando un task finisce (o fallisce per un ostacolo).",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Id del task (dalla creazione con create_task)' },
        status: { type: 'string', enum: ['done', 'failed'], description: 'Esito finale' },
        summary: { type: 'string', description: 'Riepilogo breve: risultato, dati chiave, ostacoli' }
      },
      required: ['id', 'status', 'summary']
    }
  },
  {
    name: 'update_state',
    description: "Modifica il tuo stato. target 'memory' → come update_memory (action write/update/delete). target 'routine' → action: create (campi name, description, prompt, schedule cron a 5 campi OPPURE trigger di tipo schedule, timezone, provenance 'template' se crei le routine di un template; la routine nasce SEMPRE in pausa: chiedi all'utente se attivarla, l'attivazione richiede la sua approvazione), update (id + campi da cambiare), pause, resume, delete (id).",
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['routine', 'memory'], description: 'Cosa modificare' },
        action: { type: 'string', enum: ['create', 'update', 'pause', 'resume', 'delete', 'write'], description: 'Azione (write è per target memory)' },
        id: { type: 'number', description: 'Id della routine (update/pause/resume/delete) o della memoria (come stringa)' },
        name: { type: 'string', description: 'Nome della routine (create)' },
        description: { type: 'string', description: 'Descrizione breve (routine/skill)' },
        prompt: { type: 'string', description: 'Il prompt che la routine esegue' },
        schedule: { type: 'string', description: 'Schedule cron a 5 campi, es. "30 8 * * 1-5"' },
        trigger: { type: 'object', description: "In alternativa al cron: trigger di tipo schedule ({type:'schedule', kind:'cron', cron} o {type:'schedule', kind:'every', every, at, mode}); SOLO schedule: email/webhook/poll li configura l'utente", additionalProperties: true },
        provenance: { type: 'string', enum: ['template', 'agent'], description: "'template' SOLO nel turno di kickstart di un template (default e unico altro valore: agent)" },
        timezone: { type: 'string', description: 'Fuso orario della schedule (es. Europe/Rome)' },
        content: { type: 'string', description: 'Contenuto (per target memory)' },
        tier: { type: 'string', enum: ['core', 'log'], description: 'Tier della memoria (per target memory)' },
        scope: { type: 'string', enum: ['agent', 'user'], description: 'Scope della memoria (per target memory)' }
      },
      required: ['target', 'action']
    }
  }
]

export interface ToolExecResult {
  output: string
  meta: Record<string, unknown>
  images?: string[]  // base64 PNG per modelli vision
}

/** Azione su una memoria (update_memory e update_state target 'memory'). */
function runMemoryAction(agentId: string, input: Record<string, unknown>): ToolExecResult {
  const action = String(input.action ?? 'write')
  if (action === 'write') {
    const content = String(input.content ?? '')
    if (!content.trim()) return { output: 'Contenuto memoria vuoto: non scritto nulla.', meta: {} }
    const r = writeMemory(agentId, {
      content,
      tier: input.tier === 'core' ? 'core' : 'log',
      ...(input.scope === 'user' ? { scope: 'user' as MemoryScope } : {}),
      source: 'agent'
    })
    return { output: `Memoria creata (id ${r.id}, tier ${r.tier}, scope ${r.scope}).`, meta: { memoryId: r.id } }
  }
  if (action === 'update') {
    const r = updateMemory(agentId, {
      id: String(input.id ?? ''),
      ...(input.content !== undefined ? { content: String(input.content) } : {}),
      ...(input.tier === 'core' || input.tier === 'log' ? { tier: input.tier as MemoryTier } : {}),
      ...(input.scope === 'agent' || input.scope === 'user' ? { scope: input.scope as MemoryScope } : {})
    })
    return { output: `Memoria ${r.id} aggiornata (tier ${r.tier}, scope ${r.scope}).`, meta: { memoryId: r.id } }
  }
  if (action === 'delete') {
    const existed = deleteMemory(agentId, String(input.id ?? ''))
    return { output: existed ? `Memoria ${input.id} eliminata.` : `Memoria ${input.id} non trovata (già eliminata?).`, meta: {} }
  }
  return { output: `Azione memoria non valida: "${action}" (write | update | delete).`, meta: {} }
}

/** Contesto del turno in cui gira il tool (correzione A5): chi ha aperto il turno. */
export interface ToolTurnContext {
  turnInitiator?: string
}

/** Azione su una routine (update_state target 'routine'): validazione cron con parseCron del daemon. */
async function runRoutineAction(agentId: string, input: Record<string, unknown>, ctx: ToolTurnContext = {}): Promise<ToolExecResult> {
  const { parseCron } = await import('../../daemon/cron')
  const { createRoutine, updateRoutine, getRoutine, deleteRoutine } = await import('../store/db')
  const action = String(input.action ?? '')
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

  if (action === 'create') {
    const name = str(input.name)
    const prompt = str(input.prompt)
    if (!name) return { output: 'Routine non creata: manca il nome (campo name).', meta: {} }
    if (!prompt) return { output: 'Routine non creata: manca il prompt.', meta: {} }
    // fase 7: trigger opzionale di tipo schedule (stessa validazione delle
    // routine utente); poll e webhook restano configurabili solo dall'utente
    let trigger: import('../../shared/types').RoutineTrigger | null = null
    if (input.trigger !== undefined && input.trigger !== null) {
      const t = input.trigger as import('../../shared/types').RoutineTrigger
      if (!t || typeof t !== 'object' || t.type !== 'schedule') {
        return {
          output: 'Trigger non valido: update_state accetta solo trigger di tipo schedule (cron o "ogni X"); i trigger su email/webhook/poll si configurano dall\'utente nelle Impostazioni → routine.',
          meta: {}
        }
      }
      const errors = (await import('../../shared/triggers')).triggerShapeErrors(t)
      if (t.kind === 'cron' && !parseCron(t.cron)) errors.unshift(`cron non valido: "${t.cron}" (5 campi, es. "0 9 * * *")`)
      if (errors.length) return { output: `Trigger non valido: ${errors.join('; ')}.`, meta: {} }
      trigger = t
    }
    const schedule = str(input.schedule) ?? (trigger?.type === 'schedule' && trigger.kind === 'cron' ? trigger.cron : '')
    if (!trigger && (!schedule || !parseCron(schedule))) {
      return { output: `Schedule non valida: "${schedule ?? ''}" — usare un cron a 5 campi, es. "0 9 * * *", o un trigger schedule.`, meta: {} }
    }
    // le routine dell'agente nascono SEMPRE in pausa; correzione A5: la
    // provenance 'template' è accettata SOLO nel turno di kickstart di un
    // template (initiator TEMPLATE_IMPORT) — da qualsiasi altro turno la
    // routine è dell'agente
    const provenance = input.provenance === 'template' && ctx.turnInitiator === 'TEMPLATE_IMPORT' ? 'template' : 'agent'
    const r = createRoutine(agentId, name, prompt, schedule, {
      enabled: 0, provenance,
      description: str(input.description) ?? '', timezone: str(input.timezone) ?? '',
      ...(trigger ? { trigger } : {})
    })
    return {
      output: `Routine "${name}" creata in PAUSA (id ${r.id}, provenance ${provenance}, schedule "${schedule || 'da trigger'}"): non girerà finché l'utente non la attiva con resume.`,
      meta: { automation: { action: 'create', id: r.id, name } }
    }
  }

  const id = Number(input.id)
  if (!Number.isInteger(id) || id <= 0) return { output: `Id routine non valido: ${JSON.stringify(input.id)} (serve l'id numerico dalla creazione).`, meta: {} }
  if (action === 'delete') {
    const cur = getRoutine(id)
    if (!cur) return { output: `Routine ${id} non trovata.`, meta: {} }
    deleteRoutine(id)
    return { output: `Routine "${cur.title}" (id ${id}) eliminata.`, meta: { automation: { action: 'delete', id, name: cur.title } } }
  }
  const cur = getRoutine(id)
  if (!cur) return { output: `Routine ${id} non trovata: verifica l'id con l'utente o nelle Impostazioni → routine.`, meta: {} }

  if (action === 'pause') {
    updateRoutine(id, { enabled: 0 })
    return { output: `Routine "${cur.title}" messa in pausa.`, meta: { automation: { action: 'pause', id, name: cur.title } } }
  }
  if (action === 'resume') {
    updateRoutine(id, { enabled: 1 })
    return { output: `Routine "${cur.title}" attivata (schedule "${cur.schedule}").`, meta: { automation: { action: 'resume', id, name: cur.title } } }
  }
  if (action === 'update') {
    const schedule = str(input.schedule)
    if (schedule !== undefined && !parseCron(schedule)) {
      return { output: `Schedule non valida: "${schedule}" — usare un cron a 5 campi, es. "0 9 * * *".`, meta: {} }
    }
    updateRoutine(id, {
      ...(str(input.name) !== undefined ? { title: str(input.name) } : {}),
      ...(str(input.prompt) !== undefined ? { prompt: str(input.prompt) } : {}),
      ...(schedule !== undefined ? { schedule } : {}),
      ...(str(input.description) !== undefined ? { description: str(input.description) } : {}),
      ...(str(input.timezone) !== undefined ? { timezone: str(input.timezone) } : {})
    })
    return { output: `Routine "${cur.title}" aggiornata.`, meta: { automation: { action: 'update', id, name: str(input.name) ?? cur.title } } }
  }
  return { output: `Azione routine non valida: "${action}" (create | update | pause | resume | delete).`, meta: {} }
}

export async function executeTool(
  agentId: string,
  tool: string,
  input: Record<string, unknown>,
  ctx: ToolTurnContext = {}
): Promise<ToolExecResult> {
  switch (tool) {
    case 'run-command': {
      const raw = String(input.command ?? '')
      const timeoutMs = Math.min(600, Number(input.timeout ?? 120)) * 1000
      // §5.6: i riferimenti {{secret:NOME}} si risolvono SOLO qui, al momento
      // dell'esecuzione — il valore entra nell'env del processo, mai nel comando
      const { revealSecret, listSecretNames } = await import('../vault')
      const res = await resolveSecretRefs(raw, revealSecret)
      if (res.missing.length) {
        return {
          output: `Credenziali non presenti nel vault: ${res.missing.join(', ')}. Nomi disponibili: ${listSecretNames().join(', ') || '(vuoto)'}`,
          meta: { vault: true, missing: res.missing }
        }
      }
      const r = await sandbox.execCommand(agentId, res.command, { timeoutMs, env: res.env })
      const redact = (t: string) => redactSecrets(t, res.used)
      const parts: string[] = []
      if (r.stdout) parts.push(redact(r.stdout))
      if (r.stderr) parts.push('[stderr]\n' + redact(r.stderr))
      parts.push(`[exit ${r.exitCode ?? 'killed'}${r.trimmed ? ' — output trimmed' : ''}]`)
      // output già redatto: lo stesso testo va al modello e al transcript
      return {
        output: parts.join('\n'),
        meta: { exitCode: r.exitCode, trimmed: r.trimmed, secretRefs: res.used.map((s) => s.name) }
      }
    }
    case 'read-file': {
      let content = await sandbox.readFileInBox(agentId, String(input.path ?? ''))
      const off = Number(input.offset ?? 0)
      const lim = Number(input.limit ?? 0)
      const lines = content.split('\n')
      if (off || lim) content = lines.slice(off, lim ? off + lim : undefined).join('\n')
      if (content.length > 100_000) content = content.slice(0, 100_000) + '\n…[troncato]'
      return { output: content, meta: {} }
    }
    case 'write-file': {
      await sandbox.writeFileInBox(agentId, String(input.path ?? ''), String(input.content ?? ''))
      return { output: `Scritto ${input.path}`, meta: {} }
    }
    case 'list-directory': {
      const out = await sandbox.listDirectoryInBox(agentId, String(input.path ?? '.'))
      return { output: out, meta: {} }
    }
    case 'use-app': {
      const { executeUseApp } = await import('../computeruse')
      const r = await executeUseApp(input as unknown as Parameters<typeof executeUseApp>[0])
      return { output: r.output, meta: { computerUse: true, error: r.error ?? false }, images: r.images }
    }
    case 'list-credentials': {
      const { listSecretNames } = await import('../vault')
      const names = listSecretNames()
      return { output: names.length ? names.join('\n') : '(vault vuoto)', meta: { vault: true } }
    }
    case 'update_memory':
      return runMemoryAction(agentId, input)
    case 'recall_memory': {
      const found = searchMemoriesByQuery(listMemories(agentId), String(input.query ?? ''))
      if (!found.length) return { output: 'Nessuna memoria trovata per questa ricerca.', meta: {} }
      const lines = found.map((r) => `- [${r.id}] (${r.tier}/${r.scope}, aggiornata ${new Date(r.updatedAt).toISOString().slice(0, 10)}) ${r.content.replace(/\n+/g, ' ')}`)
      return { output: lines.join('\n'), meta: { memoryIds: found.map((r) => r.id) } }
    }
    case 'skill': {
      const body = readSkillBody(agentId, String(input.name ?? ''))
      return { output: body, meta: { skill: String(input.name ?? '') } }
    }
    case 'update_skill': {
      const name = String(input.name ?? '')
      // l'esistenza si guarda PRIMA della scrittura (dopo ci sarebbe sempre)
      const existed = listSkills(agentId).some((x) => x.name === name)
      const s = writeSkill(agentId, {
        name,
        description: String(input.description ?? ''),
        content: String(input.content ?? '')
      })
      return { output: `Skill "${s.name}" ${existed ? 'aggiornata' : 'creata'} (disponibile da subito in "# Skill disponibili").`, meta: { skill: s.name } }
    }
    case 'search_connectors': {
      // catalogo + stato di ogni connettore (il funnel §3ter T2-T3 parte da qui)
      const { loadCatalog, searchCatalog, connectorStatusLine } = await import('../connectors')
      type ConnectorState = import('../connectors').ConnectorState
      const states = (await import('../store/db')).getSetting<Record<string, ConnectorState>>('connectors.state', {})
      const found = searchCatalog(loadCatalog(), String(input.query ?? ''))
      if (!found.length) return { output: 'Nessun connettore trovato per questa ricerca.', meta: {} }
      return {
        output: found
          .map((e) => connectorStatusLine(e, states[e.id] ?? { status: 'not_connected', disabledTools: [], instructions: '' }))
          .join('\n'),
        meta: {}
      }
    }
    case 'update_state': {
      if (input.target === 'memory') return runMemoryAction(agentId, input)
      if (input.target === 'routine') return runRoutineAction(agentId, input, ctx)
      return { output: `Target update_state non valido: ${JSON.stringify(input.target)} (routine | memory).`, meta: {} }
    }
    case 'list_agents': {
      // fase 7: gli ALTRI bot dell'utente (nome, id, descrizione, stato)
      const { listAgents } = await import('../store/db')
      const others = listAgents().filter((a) => a.id !== agentId)
      if (!others.length) return { output: 'Nessun altro bot: sei l\'unico agente dell\'utente.', meta: {} }
      return {
        output: others.map((a) => `- ${a.name} (id ${a.id}) · stato: ${a.status}${a.description ? ` · ${a.description}` : ''}`).join('\n'),
        meta: {}
      }
    }
    case 'update_task': {
      // fase 8 (§3bis L7): chiusura del task — il summary torna alla chat
      // principale come job TASK_DONE (il bot riferisce in un messaggio breve)
      const id = Number(input.id)
      const status = input.status === 'failed' ? 'failed' : input.status === 'done' ? 'done' : null
      if (!Number.isInteger(id) || id <= 0 || !status) {
        return { output: 'update_task non valido: servono id, status ("done" | "failed") e summary.', meta: {} }
      }
      const { getTask, updateTask, db } = await import('../store/db')
      const { enqueueJob } = await import('../store/jobs')
      const t = getTask(id)
      if (!t) return { output: `Task ${id} non trovato.`, meta: {} }
      if (t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') {
        return { output: `Task "${t.title}" è già ${t.status}: non si riapre.`, meta: {} }
      }
      const summary = String(input.summary ?? '')
      updateTask(id, { status, ...(summary ? { summary } : {}) })
      const now = Date.now()
      enqueueJob(db(), {
        agentId: t.agent_id,
        kind: 'user-message',
        payload: {
          text: [
            `<task_done title="${t.title.replace(/"/g, "'")}" id="${id}" esito="${status}">`,
            summary || '(nessun summary)',
            '</task_done>',
            'Il task è finito: riferisci all\'utente con un MESSAGGIO BREVE (send_to_user) sull\'esito e al massimo un prossimo passo, senza ripetere tutto il lavoro.'
          ].join('\n'),
          initiator: 'TASK_DONE',
          // taskRef (NON taskId): il loop filtra le entry dei task per
          // meta.taskId e questo messaggio deve restare nella chat principale
          extraMeta: { taskTitle: t.title, taskRef: id }
        },
        runAt: now,
        now
      })
      return { output: `Task "${t.title}" chiuso (${status}): il summary è tornato alla chat principale, che riferirà all'utente.`, meta: { task: id } }
    }
    default: {
      if (tool.startsWith('mcp__')) {
        const { callTool, McpNeedsReconnectError } = await import('../mcp')
        try {
          const out = await callTool(tool, input)
          return { output: out.slice(0, 30_000), meta: { mcp: true } }
        } catch (e) {
          // fase 5: token scaduto → il loop mostra la card "Riconnetti"
          if (e instanceof McpNeedsReconnectError) {
            return {
              output: e.message,
              meta: { mcp: true, needsReconnect: { serverName: e.serverName, connectorId: e.serverId } }
            }
          }
          throw e
        }
      }
      throw new Error(`Tool sconosciuto: ${tool}`)
    }
  }
}
