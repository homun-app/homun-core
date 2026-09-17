import { useContext, useState, useId } from "react";
import { ChevronDown, Check, Plus, X } from "lucide-react";
import { StudioMembersContext, matchesMember, type StudioMember } from "../../lib/studio-members";
import { StudioMemberCard } from "./StudioMemberCard";
export function StudioMemberPicker({
  label,
  options,
  value,
  onChange,
  emptyLabel = "Scegli collaboratori",
  multiple = false,
}: {
  label: string;
  options: StudioMember[];
  value: string[];
  onChange: (ids: string[]) => void;
  emptyLabel?: string;
  multiple?: boolean;
}) {
  const directory = useContext(StudioMembersContext);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const id = useId();
  const members = options.map((p) => ({ ...directory.find((m) => m.id === p.id), ...p }));
  const selected = members.filter((m) => value.includes(m.id));
  const visible = members.filter((m) => matchesMember(m, query));
  function toggle(memberId: string) {
    onChange(
      value.includes(memberId)
        ? value.filter((v) => v !== memberId)
        : multiple
          ? [...value, memberId]
          : [memberId],
    );
    if (!multiple) {
      setOpen(false);
      setQuery("");
    }
  }
  return (
    <div className="st-member-picker">
      <span className="st-picker-label">{label}</span>
      <button
        type="button"
        className="st-picker-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {value.length ? `Cambia selezione · ${value.length}` : emptyLabel}
        <ChevronDown size={15} />
      </button>
      {!open &&
        selected.map((m) => (
          <StudioMemberCard key={m.id} member={m}>
            <button
              type="button"
              className="st-icon"
              aria-label={`Rimuovi ${m.name}`}
              onClick={() => toggle(m.id)}
            >
              <X size={15} />
            </button>
          </StudioMemberCard>
        ))}
      {open && (
        <section
          id={id}
          className="st-member-selection"
          aria-label={label + " · scelta"}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <input
            autoFocus
            aria-label={`Cerca ${label.toLocaleLowerCase()}`}
            placeholder="Cerca nome, compito o specializzazione…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="st-member-selection-results">
            {visible.map((m) => (
              <StudioMemberCard key={m.id} member={m}>
                <button
                  type="button"
                  className="st-icon"
                  aria-label={`${value.includes(m.id) ? "Deseleziona" : "Seleziona"} ${m.name}`}
                  aria-pressed={value.includes(m.id)}
                  onClick={() => toggle(m.id)}
                >
                  {value.includes(m.id) ? <Check size={17} /> : <Plus size={17} />}
                </button>
              </StudioMemberCard>
            ))}
            {!visible.length && (
              <p className="st-muted">Nessun collaboratore corrisponde alla ricerca.</p>
            )}
          </div>
          <div className="st-member-picker-footer">
            <small>{value.length} selezionati · clicca un nome per il curriculum</small>
            <button type="button" className="st-text-link" onClick={() => setOpen(false)}>
              Fine
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
