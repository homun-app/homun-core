import type { AutonomyMode } from "../../lib/studio-supervision";
import { autonomyLabels, autonomyDescriptions } from "../../lib/studio-autonomy";
export function StudioAutonomy({
  mode,
  onChange,
}: {
  mode: AutonomyMode;
  onChange: (mode: AutonomyMode) => void;
}) {
  return (
    <details className="st-agent-autonomy">
      <summary aria-label="Autonomia predefinita">
        <span className={`st-mode-badge ${mode}`}>{autonomyLabels[mode]} ▾</span>
        <small>Nuovi compiti</small>
      </summary>
      <div className="st-autonomy-popover">
        <strong>Modalità predefinita</strong>
        <p>
          Ogni compito ha la propria modalità. Questa scelta propone il valore iniziale e non
          modifica i compiti esistenti.
        </p>
        {(Object.keys(autonomyLabels) as AutonomyMode[]).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={mode === value}
            onClick={() => onChange(value)}
          >
            <strong>
              {autonomyLabels[value]} {mode === value ? "✓" : ""}
            </strong>
            <small>{autonomyDescriptions[value]}</small>
          </button>
        ))}
      </div>
    </details>
  );
}
