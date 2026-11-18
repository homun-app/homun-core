// Q7 (fase squadra): tre correzioni piccole dalla prova.
// 1) update_group con coordinatorId: il NOME esatto di un membro va bene;
//    se chi chiama è già coordinatore, «coordini già questa squadra»;
//    l'errore elenca id e nomi dei membri.
// 2) il brief dei sottoagenti porta la lingua della conversazione (la stessa
//    regola con cui il bot risponde all'utente) — prova con brief italiano.
// 3) web_fetch: il risultato comincia con una riga con stato HTTP e durata ms.
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as store from '../../store/db'
import { executeTool } from '../tools'
import { formatSubagentBrief } from '../../../shared/agent-message'
import { createGroup, getGroup } from '../../store/groups'
import { TEST_TMP_BASE } from '../../../test-tmp'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-squadra-correzioni-'))
  store.setDataDir(dir)
  store.db()
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  for (const t of ['entries', 'agents', 'groups', 'group_members', 'group_messages']) {
    store.db().exec(`DELETE FROM ${t}`)
  }
})

const run = (agentId: string, name: string, input: Record<string, unknown>) =>
  executeTool(agentId, name, input, {})

describe('Q7: update_group con coordinatorId', () => {
  const makeGroup = (): { gid: number; capo: string; treni: string; alloggio: string } => {
    const capo = store.createAgent('Capo', '')
    const treni = store.createAgent('Treni', '')
    const alloggio = store.createAgent('Alloggio', '')
    const g = createGroup('Weekend', '', capo.id, [treni.id, alloggio.id], capo.id)
    return { gid: g.id, capo: capo.id, treni: treni.id, alloggio: alloggio.id }
  }

  it('il NOME esatto di un membro va bene: diventa coordinatore', async () => {
    const { gid, capo, treni } = makeGroup()
    const r = await run(capo, 'update_group', { groupId: gid, coordinatorId: 'Treni' })
    expect(r.output).not.toContain('must be a member')
    expect(getGroup(gid)!.coordinator_id).toBe(treni)
  })

  it('chi chiama È GIÀ il coordinatore → «coordini già questa squadra»', async () => {
    const { gid, capo } = makeGroup()
    const r = await run(capo, 'update_group', { groupId: gid, coordinatorId: capo })
    expect(r.output).toContain('already coordinate')
  })

  it('l\'errore elenca gli ID e i NOMI dei membri', async () => {
    const { gid, capo } = makeGroup()
    const r = await run(capo, 'update_group', { groupId: gid, coordinatorId: 'agent_inesistente' })
    expect(r.output).toContain('Members:')
    expect(r.output).toContain('Capo')
    expect(r.output).toContain('Treni')
    expect(r.output).toContain('Alloggio')
    expect(r.output).toMatch(/agent_[0-9a-f]+/)
  })
})

describe('Q7: il brief del sottoagente porta la lingua della conversazione', () => {
  it('formatSubagentBrief con la lingua: la riga dice di rispondere in ITALIANO', () => {
    const brief = formatSubagentBrief('Musei', 'Controlla gli orari dei musei di Torino.', 'it')
    expect(brief).toContain('<brief titolo="Musei">')
    expect(brief.toLowerCase()).toContain('italian')
  })

  it('senza lingua resta il brief di oggi (nessuna riga di lingua)', () => {
    const brief = formatSubagentBrief('Musei', 'Check museum hours.')
    expect(brief.toLowerCase()).not.toContain('reply in italian')
  })
})

describe('Q7: il job del figlio riceve il brief con la lingua', () => {
  it('subagent-run con language it → l\'apertura del turno dice di scrivere in italiano', async () => {
    const { insertSubagent } = await import('../../store/subagents')
    const { enqueueJob } = await import('../../store/jobs')
    const { makeJobRunner } = await import('../../../daemon/run-job')
    const padre = store.createAgent('Padre lingua', '')
    insertSubagent(store.db(), { id: 'sub_lang', parentId: padre.id, parentTaskId: null, batchId: 'b1', title: 'Musei', brief: 'Controlla gli orari dei musei di Torino per il weekend.', deadlineAt: Date.now() + 60_000, createdAt: Date.now() })
    enqueueJob(store.db(), { agentId: 'sub_lang', kind: 'subagent-run', payload: { subagentId: 'sub_lang', first: true, language: 'it' }, runAt: Date.now(), now: Date.now() })
    const openings: string[] = []
    const runner = makeJobRunner(store.db(), (async (_id: string, text: string) => { openings.push(text); return undefined }) as never)
    const job = (await import('../../store/jobs')).listJobs(store.db()).find((j) => j.kind === 'subagent-run')!
    await runner(job, () => undefined)
    expect(openings[0]).toContain('<brief titolo="Musei">')
    expect(openings[0]).toContain('Italian')
    expect(openings[0]).toContain('Controlla gli orari dei musei')
  })
})

describe('Q7: web_fetch inizia con stato HTTP e durata', () => {
  it('la prima riga del result è «HTTP <stato> · <ms> ms»', async () => {
    // server finto su 127.0.0.1: risponde 200 dopo un attimo
    process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK = '1'
    const { createServer } = await import('node:http')
    const srv = createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html><body><h1>Torino</h1></body></html>')
      }, 30)
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as { port: number }).port
    const r = await run('agent_x', 'web_fetch', { url: `http://127.0.0.1:${port}/` })
    expect(r.output).toMatch(/^HTTP 200 · \d+ ms/)
    await new Promise<void>((r2) => srv.close(() => r2()))
    delete process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK
  })
})
