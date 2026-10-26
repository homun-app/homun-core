// Tool base — stessi nomi e semantica dei tool verificati nel local-exec-daemon originale.
import type { ToolDef } from './llm'
import * as sandbox from '../sandbox'

export const toolDefs: ToolDef[] = [
  {
    name: 'run-command',
    description: "Esegue un comando shell nel computer dell'agente (sandbox persistente). Restituisce stdout/stderr e exit code.",
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
    name: 'read-credential',
    description: 'Legge una credenziale dal vault locale (AES-256-GCM). Il valore arriva a te ma NON viene scritto nel transcript visibile.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome della credenziale nel vault' }
      },
      required: ['name']
    }
  }
]

export interface ToolExecResult {
  output: string
  redactedOutput?: string // versione per il transcript (segreti mai in chiaro)
  meta: Record<string, unknown>
  images?: string[]  // base64 PNG per modelli vision
}

export async function executeTool(agentId: string, tool: string, input: Record<string, unknown>): Promise<ToolExecResult> {
  switch (tool) {
    case 'run-command': {
      const r = await sandbox.execCommand(agentId, String(input.command ?? ''), {
        timeoutMs: Math.min(600, Number(input.timeout ?? 120)) * 1000
      })
      const parts: string[] = []
      if (r.stdout) parts.push(r.stdout)
      if (r.stderr) parts.push('[stderr]\n' + r.stderr)
      parts.push(`[exit ${r.exitCode ?? 'killed'}${r.trimmed ? ' — output trimmed' : ''}]`)
      return { output: parts.join('\n'), meta: { exitCode: r.exitCode, trimmed: r.trimmed } }
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
    case 'read-credential': {
      const { revealSecret, listSecretNames } = await import('../vault')
      try {
        const value = await revealSecret(String(input.name ?? ''))
        return {
          output: `Credenziale "${input.name}": ${value}`,
          redactedOutput: `[credenziale "${input.name}" consegnata al modello — valore nascosto]`,
          meta: { vault: true }
        }
      } catch (e) {
        return { output: `${e instanceof Error ? e.message : String(e)}. Nomi disponibili: ${listSecretNames().join(', ') || '(vuoto)'}`, meta: { vault: true } }
      }
    }
    default: {
      if (tool.startsWith('mcp__')) {
        const { callTool } = await import('../mcp')
        const out = await callTool(tool, input)
        return { output: out.slice(0, 30_000), meta: { mcp: true } }
      }
      throw new Error(`Tool sconosciuto: ${tool}`)
    }
  }
}
