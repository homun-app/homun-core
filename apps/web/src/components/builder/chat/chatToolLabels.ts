/** Etichette amichevoli per l'avanzamento tool del run chat. */
const TOOL_LABELS: Record<string, string> = {
  web_search: "Ricerca web",
  web_fetch: "Lettura pagina",
  web_extract: "Estrazione pagina",
  x_search: "Ricerca social",
  browser_read: "Lettura browser",
  browser_navigate: "Navigazione browser",
  browser_fill: "Compilazione modulo",
  browser_click: "Click nel browser",
  terminal_execute: "Terminale",
  terminal_poll: "Attesa terminale",
  terminal_write: "Input terminale",
  execute_code: "Esecuzione codice",
  write_workspace_file: "Scrittura file",
  patch_workspace_file: "Modifica file",
  read_file: "Lettura file",
  list_files: "Elenco file",
  memory_save: "Salvataggio memoria",
  memory_search: "Ricerca memoria",
  materials: "Materiali",
  team: "Consultazione squadra",
  cronjob_manage: "Automazioni",
};

export function chatToolLabel(tool: string): string {
  return (
    TOOL_LABELS[tool] ??
    tool.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
  );
}
