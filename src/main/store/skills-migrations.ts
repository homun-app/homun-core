// Fase skill (S2.4): migrazione una tantum dalla copia per bot
// (agents/<id>/skills/<name>/) alla LIBRERIA UNICA (skills/<name>/).
// Core puro sul filesystem (root e agenti passati come input, niente
// singleton: si testa su una cartella temporanea) + runner al primo avvio
// del daemon, con FLAG idempotente e PRIMA di tutto ciò che legge le skill.
//
//   • ogni agents/<id>/skills/<name>/ → skills/<name>/ con enabledFor [id]
//     e source 'migrated';
//   • stesso nome in due bot e CONTENUTO IDENTICO → una skill sola, con
//     enabledFor unito (le cartelle di ENTRAMBI i bot si tolgono a fine
//     corsa: la copia in libreria è quella del primo);
//   • stesso nome e contenuto DIVERSO → la seconda diventa
//     <name>-<slug-del-bot> (nome nel frontmatter e cartella insieme), con
//     una riga nel log;
//   • la cartella vecchia si cancella solo DOPO la copia riuscita: un errore
//     a metà lascia tutto com'era (le copie già fatte si tolgono) e la
//     migrazione riprova al prossimo avvio.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSetting, setSetting, dataDir, listAgents } from './db'
import { isValidSkillName, parseSkillMd, buildSkillMd } from '../../shared/skill-md'
import { skillsLibrary, saveSkillsLibrary } from '../agent/skills'
import type { SkillLibrarySettings } from '../../shared/types'

/** Il flag una tantum (idempotente): scritto SOLO a migrazione riuscita. */
export const SKILLS_MIGRATED_FLAG = 'skills.libraryMigrated'

export interface SkillMigrationConflict {
  bot: string
  name: string
  to: string
}

/** Il risultato del core: cosa è successo e il setting DA SCRIVERE. */
export interface SkillMigrationResult {
  /** le cartelle spostate (from → to) */
  moved: Array<{ from: string; to: string; bot: string }>
  /** nomi uniti perché identici in più bot (o uguali a una skill già in libreria) */
  merged: Array<{ name: string; bots: string[] }>
  /** stesso nome, contenuto diverso: rinominate */
  conflicts: SkillMigrationConflict[]
  /** non spostate (nome invalido o SKILL.md mancante): restano dov'erano */
  skipped: string[]
  /** il setting `skills.library` aggiornato (da scrivere SOLO se niente errori) */
  library: SkillLibrarySettings
  error?: string
}

/** Lo slug del nome del bot per i conflitti (esportato per i test). */
export function botSlug(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  return slug || 'bot'
}

/** Una skill da copiare in libreria. */
interface PlannedCopy {
  botId: string
  botName: string
  name: string
  fromDir: string
  target: string
  content: string
}

/**
 * Il core della migrazione (PURO sul filesystem di `root`): pianifica,
 * copia e — se TUTTO riesce — cancella le cartelle vecchie. Il setting in
 * output va scritto dal chiamante solo quando `error` è assente.
 */
export function migrateSkillFolders(input: {
  root: string
  agents: Array<{ id: string; name: string }>
  library: SkillLibrarySettings
  now?: number
}): SkillMigrationResult {
  const now = input.now ?? Date.now()
  const result: SkillMigrationResult = { moved: [], merged: [], conflicts: [], skipped: [], library: {} }
  const libRoot = join(input.root, 'skills')
  const taken = new Set<string>(Object.keys(input.library))
  if (existsSync(libRoot)) {
    for (const d of readdirSync(libRoot, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('.')) taken.add(d.name)
    }
  }
  const contentOf = new Map<string, string>()
  const existingContent = (target: string): string | null => {
    if (contentOf.has(target)) return contentOf.get(target)!
    try {
      return readFileSync(join(libRoot, target, 'SKILL.md'), 'utf8')
    } catch {
      return null
    }
  }
  const planned: PlannedCopy[] = []
  // le cartelle dei bot in MERGE (contenuto identico): si tolgono a commit riuscito
  const mergeRemovals: string[] = []
  // per ogni target: i bot che la USANO (il primo la crea, gli altri uniscono)
  const botsOf = new Map<string, string[]>()

  for (const agent of input.agents) {
    const agentSkills = join(input.root, 'agents', agent.id, 'skills')
    let dirs
    try {
      dirs = readdirSync(agentSkills, { withFileTypes: true })
    } catch {
      continue // niente skill per questo bot
    }
    for (const ent of dirs) {
      if (!ent.isDirectory()) continue
      if (!isValidSkillName(ent.name) || !existsSync(join(agentSkills, ent.name, 'SKILL.md'))) {
        result.skipped.push(`agents/${agent.id}/skills/${ent.name}`)
        continue
      }
      const fromDir = join(agentSkills, ent.name)
      const content = readFileSync(join(fromDir, 'SKILL.md'), 'utf8')
      let target = ent.name
      if (taken.has(target)) {
        const already = existingContent(target)
        if (already !== null && already === content) {
          // contenuto identico: una skill sola, il bot si AGGIUNGE
          botsOf.set(target, [...(botsOf.get(target) ?? []), agent.id])
          result.merged.push({ name: target, bots: [agent.id] })
          // la sua cartella si cancellerà a commit riuscito
          mergeRemovals.push(fromDir)
          continue
        }
        // contenuto diverso: <name>-<slug del bot> (poi -2, -3…)
        for (let i = 0; ; i++) {
          const candidate = i === 0 ? `${ent.name}-${botSlug(agent.name)}` : `${ent.name}-${botSlug(agent.name)}-${i + 1}`
          if (!taken.has(candidate)) { target = candidate; break }
        }
        result.conflicts.push({ bot: agent.name, name: ent.name, to: target })
      }
      taken.add(target)
      contentOf.set(target, content)
      botsOf.set(target, [...(botsOf.get(target) ?? []), agent.id])
      planned.push({ botId: agent.id, botName: agent.name, name: ent.name, fromDir, target, content })
    }
  }

  // fase 1: le COPIE; un errore qui lascia tutto com'era (le copie si tolgono)
  const created: string[] = []
  try {
    mkdirSync(libRoot, { recursive: true })
    for (const p of planned) {
      const dest = join(libRoot, p.target)
      mkdirSync(dest, { recursive: true })
      created.push(dest)
      cpSync(p.fromDir, dest, { recursive: true })
      // il nome nel frontmatter segue la cartella (nome e cartella insieme)
      const parsed = parseSkillMd(p.content)
      if (parsed.ok && parsed.skill.name !== p.target) {
        writeFileSync(join(dest, 'SKILL.md'), buildSkillMd({ ...parsed.skill, name: p.target }))
      }
      result.moved.push({ from: p.fromDir, to: dest, bot: p.botName })
    }
  } catch (e) {
    for (const dir of created) rmSync(dir, { recursive: true, force: true })
    result.moved = []
    result.error = e instanceof Error ? e.message : String(e)
    return result
  }

  // fase 2: riuscito tutto — le cartelle VECCHIE si cancellano (DOPO le copie);
  // la skills/ del bot si toglie se resta VUOTA (le skill saltate la lasciano)
  for (const p of planned) rmSync(p.fromDir, { recursive: true, force: true })
  for (const dir of mergeRemovals) rmSync(dir, { recursive: true, force: true })
  const touched = new Set([...planned.map((p) => join(p.fromDir, '..')), ...mergeRemovals.map((d) => join(d, '..'))])
  for (const parent of touched) {
    try {
      if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true })
    } catch { /* già via */ }
  }

  // il setting: enabledFor = i bot che la usano; source 'migrated'
  const lib: SkillLibrarySettings = { ...input.library }
  for (const [target, bots] of botsOf) {
    const cur = lib[target] ?? { enabledFor: [] as string[], source: 'migrated' as const, createdAt: now, updatedAt: 0 }
    lib[target] = {
      ...cur,
      source: 'migrated',
      enabledFor: [...new Set([...cur.enabledFor, ...bots])],
      updatedAt: now
    }
  }
  result.library = lib
  return result
}

/** Le cartelle dei bot in MERGE (contenuto identico): si tolgono a commit riuscito. */

/**
 * Il runner (primo avvio del daemon): legge gli agenti VERI, gira il core e
 * scrive il setting `skills.library` + il flag. I conflitti finiscono nel
 * log. Un errore NON scrive il flag: si riprova al prossimo avvio.
 */
export function migrateAgentSkills(): SkillMigrationResult {
  if (getSetting<boolean>(SKILLS_MIGRATED_FLAG, false)) {
    return { moved: [], merged: [], conflicts: [], skipped: [], library: skillsLibrary() }
  }
  const agents = listAgents().map((a) => ({ id: a.id, name: a.name }))
  const library = skillsLibrary()
  const result = migrateSkillFolders({ root: dataDir(), agents, library })
  if (result.error) {
    console.error(`[sandbotd] migrazione skill rinviata al prossimo avvio: ${result.error}`)
    return result
  }
  saveSkillsLibrary(result.library)
  setSetting(SKILLS_MIGRATED_FLAG, true)
  const conflictNote = result.conflicts.length
    ? ` (${result.conflicts.length} conflitti rinumerati: ${result.conflicts.map((c) => `${c.name} (${c.bot}) → ${c.to}`).join(', ')})`
    : ''
  console.log(`[sandbotd] migrazione skill: ${result.moved.length} cartelle spostate nella libreria${conflictNote}${result.skipped.length ? `, ${result.skipped.length} saltate` : ''}`)
  return result
}
