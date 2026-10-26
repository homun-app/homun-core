import { describe, expect, it } from 'vitest'
import { targetKey } from '../permission-rules'

describe('targetKey', () => {
  it('run-command: usa la prima parola del comando', () => {
    expect(targetKey('run-command', { command: 'git status' })).toBe('git')
    expect(targetKey('run-command', { command: '  ls   -la ' })).toBe('ls')
  })

  it('run-command: comando vuoto o mancante → stringa vuota', () => {
    expect(targetKey('run-command', {})).toBe('')
    expect(targetKey('run-command', { command: '   ' })).toBe('')
  })

  it('tool file: usa il path', () => {
    expect(targetKey('read-file', { path: '/tmp/a.txt' })).toBe('/tmp/a.txt')
    expect(targetKey('write-file', { path: '/tmp/b.txt' })).toBe('/tmp/b.txt')
    expect(targetKey('list-directory', { path: '/tmp' })).toBe('/tmp')
  })

  it('tool file: path mancante → stringa vuota', () => {
    expect(targetKey('read-file', {})).toBe('')
  })

  it('use-app: scope per azione', () => {
    expect(targetKey('use-app', { action: 'screenshot' })).toBe('screenshot')
    expect(targetKey('use-app', {})).toBe('')
  })

  it('tool sconosciuto → *', () => {
    expect(targetKey('qualunque', { x: 1 })).toBe('*')
    // solo i nomi tool esatti hanno una chiave specifica
    expect(targetKey('run_command', { command: 'ls' })).toBe('*')
  })
})
