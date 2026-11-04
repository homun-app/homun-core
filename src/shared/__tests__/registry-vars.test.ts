// Test PURI delle variabili dei remoti del registro (fase mcp-setup, M1/M3):
// template, risoluzione, pulizia dei valori che l'utente incolla, validazione
// degli host, etichetta umana e quando il pulsante del modulo è attivo.
import { describe, expect, it } from 'vitest'
import {
  cleanHostValue, cleanSecretValue, fillTemplate, hostValueError, missingTemplateVars,
  resolvedUrlOk, setupCanConnect, templateVarNames, urlVarIsRequired, varLabel
} from '../registry-vars'

describe('template {var}: nomi, riempimento, buchi (M1.1)', () => {
  it('i nomi delle variabili in ordine di prima comparsa, senza doppioni', () => {
    expect(templateVarNames('https://{a}/{b}/{a}')).toEqual(['a', 'b'])
    expect(templateVarNames('https://static.example/mcp')).toEqual([])
    expect(templateVarNames('Bearer {personal_access_token}')).toEqual(['personal_access_token'])
  })
  it('fillTemplate sostituisce; le variabili senza valore RESTANO letterali', () => {
    expect(fillTemplate('https://{host}/mcp', { host: 'chat.example.com' })).toBe('https://chat.example.com/mcp')
    expect(fillTemplate('https://{host}/mcp', {})).toBe('https://{host}/mcp')
    expect(fillTemplate('Bearer {tok}', { tok: 'xyz' })).toBe('Bearer xyz')
  })
  it('missingTemplateVars raccoglie i buchi (il server non parte con le graffe)', () => {
    expect(missingTemplateVars('https://chat.example.com/mcp')).toEqual([])
    expect(missingTemplateVars('https://{host}/mcp')).toEqual(['host'])
  })
  it('urlVarIsRequired: isRequired vince; un default basta; nell\'URL senza default è obbligatoria', () => {
    expect(urlVarIsRequired({ name: 'h', isRequired: true }, 'https://{h}/mcp')).toBe(true)
    expect(urlVarIsRequired({ name: 'h', default: 'x' }, 'https://{h}/mcp')).toBe(false)
    expect(urlVarIsRequired({ name: 'h' }, 'https://{h}/mcp')).toBe(true)
    // dichiarata ma NON nell'URL e non isRequired: facoltativa
    expect(urlVarIsRequired({ name: 'h' }, 'https://static.example/mcp')).toBe(false)
  })
})

describe('la pulizia dei valori incollati (M1.4 + M3)', () => {
  it('cleanHostValue toglie schema e barre: «https://chat.example.com/» → «chat.example.com»', () => {
    expect(cleanHostValue('https://chat.example.com/')).toBe('chat.example.com')
    expect(cleanHostValue('http://chat.example.com')).toBe('chat.example.com')
    expect(cleanHostValue(' chat.example.com ')).toBe('chat.example.com')
    expect(cleanHostValue('chat.example.com/')).toBe('chat.example.com')
  })
  it('cleanSecretValue toglie il «Bearer » già incollato: lo mette il template', () => {
    expect(cleanSecretValue('Bearer xyz123')).toBe('xyz123')
    expect(cleanSecretValue('bearer xyz123')).toBe('xyz123')
    expect(cleanSecretValue('xyz123')).toBe('xyz123')
  })
  it('hostValueError: niente / @ o spazi; vuoto è un errore', () => {
    expect(hostValueError('chat.example.com')).toBeNull()
    expect(hostValueError('')).toBe('vuoto')
    expect(hostValueError('chat.example.com/percorso')).toBe('/')
    expect(hostValueError('utente@chat.example.com')).toBe('@')
    expect(hostValueError('chat example.com')).toBe('spazi')
  })
  it('resolvedUrlOk: https in produzione, http SOLO col flag di test', () => {
    expect(resolvedUrlOk('https://chat.example.com/mcp')).toBe(true)
    expect(resolvedUrlOk('http://127.0.0.1:9999/mcp')).toBe(false)
    expect(resolvedUrlOk('http://127.0.0.1:9999/mcp', true)).toBe(true)
    expect(resolvedUrlOk('https://[non un url')).toBe(false)
  })
})

describe('l\'etichetta umana del campo (M3.1)', () => {
  it('mattermost_host → «Indirizzo del server Mattermost» (struttura, la UI traduce)', () => {
    expect(varLabel('mattermost_host', 'Mattermost')).toEqual({ addressOf: 'Mattermost' })
    expect(varLabel('service_url', 'X')).toEqual({ addressOf: 'X' })
  })
  it('altrimenti il nome pulito: personal_access_token → «Personal access token»', () => {
    expect(varLabel('personal_access_token', 'X')).toEqual({ plain: 'Personal access token' })
  })
})

describe('setupCanConnect: quando il pulsante è attivo (M3)', () => {
  const fields = [
    { name: 'mattermost_host', isRequired: true, isSecret: false },
    { name: 'extra', isRequired: false, isSecret: false }
  ]
  it('disattivo finché un campo obbligatorio è vuoto o non valido', () => {
    expect(setupCanConnect(fields, {}, { tokenRequired: false, token: '', tokenSaved: false })).toBe(false)
    expect(setupCanConnect(fields, { mattermost_host: 'chat.example.com' }, { tokenRequired: false, token: '', tokenSaved: false })).toBe(true)
    expect(setupCanConnect(fields, { mattermost_host: 'chat.example.com/percorso' }, { tokenRequired: false, token: '', tokenSaved: false })).toBe(false)
  })
  it('il valore già salvato vale; il token richiesto dev\'esserci (o essere già salvato)', () => {
    expect(setupCanConnect([{ name: 'h', isRequired: true, isSecret: false, value: 'x.example' }], {}, { tokenRequired: false, token: '', tokenSaved: false })).toBe(true)
    const tok = [{ name: 'h', isRequired: true, isSecret: false }]
    expect(setupCanConnect(tok, { h: 'x.example' }, { tokenRequired: true, token: '', tokenSaved: false })).toBe(false)
    expect(setupCanConnect(tok, { h: 'x.example' }, { tokenRequired: true, token: 'abc', tokenSaved: false })).toBe(true)
    expect(setupCanConnect(tok, { h: 'x.example' }, { tokenRequired: true, token: '', tokenSaved: true })).toBe(true)
  })
  it('una variabile segreta salvata basta; senza non si parte', () => {
    expect(setupCanConnect([{ name: 'k', isRequired: true, isSecret: true }], {}, { tokenRequired: false, token: '', tokenSaved: false })).toBe(false)
    expect(setupCanConnect([{ name: 'k', isRequired: true, isSecret: true, saved: true }], {}, { tokenRequired: false, token: '', tokenSaved: false })).toBe(true)
  })
})
