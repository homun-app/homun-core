// Fase 16c correzioni (R5.1): i test di network-host — dove sta FISICAMENTE
// un provider. I casi richiesti: Ollama scoperto, openai-compatible su
// 127.0.0.1 e 127.0.0.2, [::1], foo.localhost, 192.168.1.5 e nas.local
// (rete), 169.254.169.254 (internet, MAI rete), api.example.com (internet).
import { describe, expect, it } from 'vitest'
import {
  providerPlace, isLoopbackHost, isPrivateNetworkHost, isLoopbackAddress,
  isCloudMetadataAddress, hostOfBaseUrl
} from '../network-host'

describe('R5.1 — predicati adattati da Rakazo', () => {
  it('isLoopbackHost: localhost, *.localhost, tutto 127.0.0.0/8, ::1 e forme mappate', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('foo.localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.0.0.2')).toBe(true)
    expect(isLoopbackHost('127.255.0.9')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true)
    // il punto finale NON si fida (va al DNS per alcuni resolver)
    expect(isLoopbackHost('localhost.')).toBe(false)
    expect(isLoopbackHost('128.0.0.1')).toBe(false)
    expect(isLoopbackHost('192.168.1.5')).toBe(false)
  })

  it('isLoopbackAddress: 127.0.0.0/8 e ::1 anche mappati', () => {
    expect(isLoopbackAddress('127.8.9.10')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.3')).toBe(true)
    expect(isLoopbackAddress('::ffff:10.0.0.1')).toBe(false)
  })

  it('isPrivateNetworkHost: .local, RFC 1918, CGNAT, ULA; MAI link-local né metadata', () => {
    expect(isPrivateNetworkHost('192.168.1.5')).toBe(true)
    expect(isPrivateNetworkHost('10.1.2.3')).toBe(true)
    expect(isPrivateNetworkHost('172.16.0.1')).toBe(true)
    expect(isPrivateNetworkHost('100.64.1.1')).toBe(true) // CGNAT/Tailscale
    expect(isPrivateNetworkHost('nas.local')).toBe(true)
    expect(isPrivateNetworkHost('fd00::5')).toBe(true) // ULA
    // link-local: mai (lì vivono i metadata)
    expect(isPrivateNetworkHost('169.254.169.254')).toBe(false)
    expect(isPrivateNetworkHost('fe80::1')).toBe(false)
    // metadata cloud per nome e per IPv6 (AWS IMDS fd00:ec2::254)
    expect(isCloudMetadataAddress('169.254.169.254')).toBe(true)
    expect(isCloudMetadataAddress('169.254.170.2')).toBe(true)
    expect(isCloudMetadataAddress('100.100.100.200')).toBe(true)
    expect(isCloudMetadataAddress('fd00:ec2::254')).toBe(true)
    // internet
    expect(isPrivateNetworkHost('8.8.8.8')).toBe(false)
    expect(isPrivateNetworkHost('api.example.com')).toBe(false)
  })
})

describe('R5.1 — providerPlace (decide l\'HOST, non il kind né discovered)', () => {
  it('Ollama scoperto → mac', () => {
    expect(providerPlace({ baseUrl: 'http://localhost:11434', discovered: true, kind: 'ollama' })).toBe('mac')
  })

  it('openai-compatible su 127.0.0.1 e su 127.0.0.2 → mac (un server remoto NON è «gratis e privato»)', () => {
    expect(providerPlace({ baseUrl: 'http://127.0.0.1:8000/v1', kind: 'openai-compatible' })).toBe('mac')
    expect(providerPlace({ baseUrl: 'http://127.0.0.2:8000/v1', kind: 'openai-compatible' })).toBe('mac')
  })

  it('[::1] → mac', () => {
    expect(providerPlace({ baseUrl: 'http://[::1]:8080/v1' })).toBe('mac')
  })

  it('foo.localhost → mac', () => {
    expect(providerPlace({ baseUrl: 'http://foo.localhost:3000' })).toBe('mac')
  })

  it('http://192.168.1.5 e nas.local → rete', () => {
    expect(providerPlace({ baseUrl: 'http://192.168.1.5:11434' })).toBe('rete')
    expect(providerPlace({ baseUrl: 'http://nas.local:11434' })).toBe('rete')
  })

  it('169.254.169.254 → internet, MAI rete', () => {
    expect(providerPlace({ baseUrl: 'http://169.254.169.254/latest/meta-data' })).toBe('internet')
  })

  it('https://api.example.com → internet', () => {
    expect(providerPlace({ baseUrl: 'https://api.example.com/v1' })).toBe('internet')
  })

  it('discovered e kind NON cambiano il posto: decide l\'host', () => {
    // uno scoperto è comunque su localhost
    expect(providerPlace({ baseUrl: 'http://127.0.0.1:11434', discovered: true })).toBe('mac')
    expect(providerPlace({ baseUrl: 'http://127.0.0.1:11434', discovered: false })).toBe('mac')
    // un openai-compatible REMOTO resta internet anche se il kind è «locale» di facciata
    expect(providerPlace({ baseUrl: 'https://api.example.com', kind: 'openai-compatible', discovered: true })).toBe('internet')
  })

  it('baseUrl senza scheme o rotto: host se leggibile, internet altrimenti', () => {
    expect(hostOfBaseUrl('127.0.0.1:11434')).toBe('127.0.0.1')
    expect(providerPlace({ baseUrl: '127.0.0.1:11434' })).toBe('mac')
    expect(providerPlace({ baseUrl: '' })).toBe('internet')
    expect(providerPlace({ baseUrl: '---' })).toBe('internet')
  })
})
