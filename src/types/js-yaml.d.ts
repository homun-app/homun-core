// Dichiarazione locale di js-yaml 4.3.2 (fase skill S1): il pacchetto non
// porta i tipi suoi e @types/js-yaml non è fra le dipendenze ammesse. Qui
// c'è SOLO la superficie usata da shared/skill-md: load con uno schema
// standard (JSON_SCHEMA / FAILSAFE_SCHEMA — mai tipi custom) e dump.
declare module 'js-yaml' {
  export type YamlSchema = 'json' | 'failsafe' | 'core'
  export interface LoadOptions {
    schema?: unknown
    onWarning?: (e: unknown) => void
    json?: boolean
  }
  export interface DumpOptions {
    schema?: unknown
    indent?: number
    lineWidth?: number
    noRefs?: boolean
  }
  export function load(text: string, opts?: LoadOptions): unknown
  export function dump(value: unknown, opts?: DumpOptions): string
  export const JSON_SCHEMA: unknown
  export const FAILSAFE_SCHEMA: unknown
  export const CORE_SCHEMA: unknown
  export const DEFAULT_SCHEMA: unknown
  const jsYaml: {
    load: typeof load
    dump: typeof dump
    JSON_SCHEMA: unknown
    FAILSAFE_SCHEMA: unknown
    CORE_SCHEMA: unknown
    DEFAULT_SCHEMA: unknown
  }
  export default jsYaml
}
