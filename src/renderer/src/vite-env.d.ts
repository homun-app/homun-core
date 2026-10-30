/// <reference types="vite/client" />

// fase 17a (L1): i cataloghi .po li carica il renderer con import()
// dinamico; il plugin Vite di Lingui li trasforma in moduli { messages }.
declare module '*.po' {
  import type { Messages } from '@lingui/core'
  export const messages: Messages
}
