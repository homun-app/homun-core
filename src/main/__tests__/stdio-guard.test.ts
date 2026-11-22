import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { guardStdioEpipe } from '../stdio-guard'

const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

describe('guardStdioEpipe', () => {
  it('un EPIPE su stdout/stderr (pipe chiuso) non diventa un Uncaught Exception', () => {
    const out = new EventEmitter()
    const errS = new EventEmitter()
    guardStdioEpipe([out, errS])
    expect(() => out.emit('error', err('EPIPE'))).not.toThrow()
    expect(() => errS.emit('error', err('EPIPE'))).not.toThrow()
  })

  it('gli altri errori dello stream restano errori', () => {
    const out = new EventEmitter()
    guardStdioEpipe([out])
    expect(() => out.emit('error', err('EIO'))).toThrow('EIO')
  })
})
