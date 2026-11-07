// Fase eval-deboli (D1): i primitivi scritti come stringhe dal modello si
// convertono al tipo dichiarato nello schema JSON del tool — prova della
// funzione PURA coerceToolArgs (mai l'input modificato, mai i tipi sbagliati).
import { describe, expect, it } from 'vitest'
import { coerceToolArgs } from '../tool-args'

/** lo schema VERO di run-command (riga per riga da tools.ts) */
const RUN_COMMAND_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The command to run' },
    workingDirectory: { type: 'string', description: 'Optional working directory (default: the computer home)' },
    timeout: { type: 'number', description: 'Timeout in seconds (default 120; background commands use the 6-hour cap)' },
    background: { type: 'boolean', description: 'True for long commands: runs in background' }
  },
  required: ['command']
}

describe('fase eval-deboli (D1): coerceToolArgs converte SOLO verso il tipo dello schema', () => {
  it('background: "true" → true (il caso 17 dell\'eval: il controllo === true ripartiva)', () => {
    expect(coerceToolArgs({ command: 'npm run build', background: 'true' }, RUN_COMMAND_SCHEMA)).toEqual({
      command: 'npm run build', background: true
    })
  })

  it('timeout: "90" → 90 (stringa numerica finita su campo number)', () => {
    expect(coerceToolArgs({ command: 'x', timeout: '90' }, RUN_COMMAND_SCHEMA).timeout).toBe(90)
  })

  it('"abc" su un campo number resta "abc" (non si convertono i valori non numerici)', () => {
    expect(coerceToolArgs({ command: 'x', timeout: 'abc' }, RUN_COMMAND_SCHEMA).timeout).toBe('abc')
  })

  it('command: "true" su un campo STRING resta stringa (la conversione segue lo schema, non il valore)', () => {
    expect(coerceToolArgs({ command: 'true' }, RUN_COMMAND_SCHEMA).command).toBe('true')
  })

  it('scende nelle properties degli oggetti e negli items degli array', () => {
    const schema = {
      type: 'object',
      properties: {
        deep: {
          type: 'object',
          properties: {
            kill: { type: 'boolean' },
            limit: { type: 'integer' }
          }
        },
        tags: { type: 'array', items: { type: 'integer' } }
      }
    }
    const out = coerceToolArgs({ deep: { kill: ' false ', limit: '3.5' }, tags: ['1', 'x', 2], altro: 'true' }, schema)
    expect(out).toEqual({ deep: { kill: false, limit: '3.5' }, tags: [1, 'x', 2], altro: 'true' })
  })

  it('i tipi in array valgono se CONTENGONO il tipo (["boolean","null"] converte "true")', () => {
    const schema = { type: 'object', properties: { flag: { type: ['boolean', 'null'] }, n: { type: ['number', 'string'] } } }
    expect(coerceToolArgs({ flag: 'True', n: '42' }, schema)).toEqual({ flag: true, n: 42 })
  })

  it('l\'input NON viene modificato (oggetto nuovo in uscita)', () => {
    const input = { command: 'npm run build', background: 'true' }
    const out = coerceToolArgs(input, RUN_COMMAND_SCHEMA)
    expect(out).not.toBe(input)
    expect(out).toEqual({ command: 'npm run build', background: true })
    expect(input).toEqual({ command: 'npm run build', background: 'true' })
  })

  it('schema assente → identico (stesso riferimento, nessuna conversione)', () => {
    const args = { command: 'x', background: 'true' }
    expect(coerceToolArgs(args, undefined)).toBe(args)
  })

  it('le chiavi fuori schema, null e i valori già del tipo giusto restano invariati', () => {
    const out = coerceToolArgs(
      { command: 'x', background: true, timeout: 30, extra: 'true', niente: null },
      RUN_COMMAND_SCHEMA
    )
    expect(out).toEqual({ command: 'x', background: true, timeout: 30, extra: 'true', niente: null })
  })

  it('integer: "7" → 7, "7.5" resta "7.5" (solo interi), booleano non diventa numero', () => {
    const schema = { type: 'object', properties: { i: { type: 'integer' } } }
    expect(coerceToolArgs({ i: '7' }, schema).i).toBe(7)
    expect(coerceToolArgs({ i: '7.5' }, schema).i).toBe('7.5')
    expect(coerceToolArgs({ i: true }, schema).i).toBe(true)
  })
})
