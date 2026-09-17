import { useState } from "react";
import {
  MoreHorizontal,
  FolderInput,
  FolderPlus,
  Repeat2,
  Unlink,
  ArrowLeft,
  ChevronRight,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@homun/ui/components/popover";
export function ConversationActions({
  title,
  projects,
  current,
  onMove,
  onCreate,
  onRepeat,
  onRename,
  onArchive,
  onDelete,
}: {
  title: string;
  projects: { id: string; name: string }[];
  current?: string;
  onMove: (id: string) => void;
  onCreate: () => void;
  onRepeat?: () => void;
  onRename?: (name: string) => void;
  onArchive?: () => void;
  onDelete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("");
  const [name, setName] = useState(title);
  const [moving, setMoving] = useState(false);
  function act(fn: () => void) {
    fn();
    setOpen(false);
  }
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) {
          setMoving(false);
          setMode("");
          setName(title);
          setQuery("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          className="cv-chat-more"
          aria-label={`Azioni: ${title}`}
          title="Azioni conversazione"
        >
          <MoreHorizontal size={17} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} collisionPadding={12} className="cv-chat-menu">
        {mode === "rename" ? (
          <div className="cv-menu-edit">
            <strong>Rinomina conversazione</strong>
            <input
              autoFocus
              aria-label="Nuovo titolo della conversazione"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) act(() => onRename?.(name.trim()));
              }}
            />
            <button disabled={!name.trim()} onClick={() => act(() => onRename?.(name.trim()))}>
              Salva nome
            </button>
            <button onClick={() => setMode("")}>Annulla</button>
          </div>
        ) : mode === "delete" ? (
          <div className="cv-menu-edit">
            <strong>Eliminare questa conversazione?</strong>
            <p>
              Vengono rimossi messaggi e passaggi collegati. I materiali restano nella raccolta. Le
              automazioni collegate saranno messe in pausa.
            </p>
            <button className="cv-danger" onClick={() => act(() => onDelete?.())}>
              Elimina conversazione
            </button>
            <button onClick={() => setMode("")}>Annulla</button>
          </div>
        ) : moving ? (
          <>
            <button className="cv-menu-back" onClick={() => setMoving(false)}>
              <ArrowLeft size={14} />
              Sposta in un progetto
            </button>
            <input
              aria-label="Cerca progetto di destinazione"
              autoFocus
              placeholder="Cerca progetto…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="cv-chat-destinations">
              {projects
                .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
                .map((p) => (
                  <button
                    key={p.id}
                    disabled={p.id === current}
                    onClick={() => act(() => onMove(p.id))}
                  >
                    {p.name}
                    {p.id === current ? " · attuale" : ""}
                  </button>
                ))}
              {!projects.some((p) => p.name.toLowerCase().includes(query.toLowerCase())) && (
                <small>{projects.length ? "Nessun risultato" : "Non hai ancora progetti."}</small>
              )}
            </div>
            <button onClick={() => act(onCreate)}>
              <FolderPlus size={15} />
              Crea un nuovo progetto
            </button>
          </>
        ) : (
          <>
            {onRename && <button onClick={() => setMode("rename")}>Rinomina</button>}
            <button onClick={() => setMoving(true)}>
              <FolderInput size={15} />
              Sposta in un progetto
              <ChevronRight size={13} className="cv-menu-arrow" />
            </button>
            <button onClick={() => act(onCreate)}>
              <FolderPlus size={15} />
              Crea progetto da questa chat
            </button>
            {current && (
              <button onClick={() => act(() => onMove(""))}>
                <Unlink size={15} />
                Togli dal progetto
              </button>
            )}
            {onArchive && <button onClick={() => act(onArchive)}>Archivia conversazione</button>}
            {onDelete && <button onClick={() => setMode("delete")}>Elimina…</button>}
            {onRepeat && (
              <button onClick={() => act(onRepeat)}>
                <Repeat2 size={15} />
                Rendi ricorrente
              </button>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
