/** Italian dictionary for Homun UI (canonical reference) */
export const it = {
  common: {
    save: "Salva",
    cancel: "Annulla",
    close: "Chiudi",
    approve: "Approva",
    decline: "Rifiuta",
    refresh: "Aggiorna",
    copy: "Copia",
    copied: "Copiato!",
    download: "Scarica",
    search: "Cerca…",
    loading: "Caricamento…",
    done: "Fatto",
  },
  review: {
    eyebrow: "RISULTATO DA VERIFICARE",
    preview: "Anteprima",
    raw: "Grezzo",
    approve_and_conclude: "Approva il risultato e concludi il lavoro",
    approve_and_advance: "Approva e passa a «{next}»",
    request_changes: "Richiedi correzioni",
    corrections_placeholder: "Descrivi cosa correggere nei materiali o nel risultato",
    approved_status: "Risultato approvato: lavoro completato.",
    phase_verified: "Fase verificata: il lavoro passa a «{next}».",
    changes_requested_status: "Correzioni richieste. Seleziona i materiali aggiornati e prepara una nuova proposta da approvare.",
    files_produced: "File prodotti",
    files_produced_desc: "Copie salvate per la tua verifica. Non sono risultati già approvati.",
  },
  clarify: {
    clarification_needed: "Chiarimento richiesto",
    recommended: "Consigliato",
    confirm_choice: "Conferma chiarimento",
    additional_notes: "Note o precisazioni facoltative…",
    attach_file: "Allega documento o appunto",
  },
  gateway: {
    title: "Supervisione e Canali Esterni",
    description: "Collega Telegram o Slack per ricevere notifiche su chiarimenti e deliverable pronti, rispondendo direttamente dal cellulare.",
    authorized_channels: "Canali autorizzati",
    no_channels: "Nessun canale esterno collegato. Le notifiche e le decisioni restano esclusive del browser.",
    pending_requests: "Richieste di accoppiamento in attesa",
    pending_desc: "Questi codici sono stati inviati da Telegram o Slack e attendono la tua autorizzazione.",
    has_code_prompt: "Hai un codice ricevuto dal Bot?",
    has_code_desc: "Se hai avviato il bot su Telegram e ti ha fornito un codice a 8 caratteri, inseriscilo qui:",
    generate_title: "Genera codice di accoppiamento",
    generate_desc: "Crea un codice a 8 caratteri con validità di 1 ora da inviare al bot:",
    generate_btn: "Genera codice per {platform}",
    code_generated: "Codice generato con successo:",
    expires_in_60: "Scade tra 60 minuti",
    revoke: "Revoca",
  },
  preferences: {
    language: "Lingua dell'interfaccia",
    language_desc: "Seleziona la lingua per menu, messaggi e controlli di supervisione.",
    text_size: "Dimensione del testo",
    standard: "Standard",
    large: "Più grande",
    motion: "Animazioni",
    motion_desc: "Scorrimenti e transizioni; viene rispettata anche la preferenza del sistema.",
    shortcuts: "Scorciatoie",
  },
} as const;

type DeepStringRecord<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringRecord<T[K]>;
};

export type TranslationDictionary = DeepStringRecord<typeof it>;
