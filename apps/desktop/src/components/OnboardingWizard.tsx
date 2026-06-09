import { BookOpen, Plug, Sparkles, X } from "lucide-react";

// First-run wizard: a new user lands on guidance, not empty screens. Points to the two
// things that make Homun useful — connectors (Composio/MCP) and skills.
export function OnboardingWizard({
  onClose,
  onGoConnectors,
  onGoSkills,
}: {
  onClose: () => void;
  onGoConnectors: () => void;
  onGoSkills: () => void;
}) {
  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true">
      <div className="onboarding-card">
        <button className="onboarding-close" type="button" onClick={onClose} aria-label="Chiudi">
          <X size={16} />
        </button>
        <div className="onboarding-icon">
          <Sparkles size={26} />
        </div>
        <h2>Benvenuto in Homun</h2>
        <p>
          Il tuo assistente locale. Per renderlo davvero utile, collega i tuoi strumenti — tutto
          resta sul tuo dispositivo.
        </p>
        <div className="onboarding-steps">
          <button type="button" className="onboarding-step" onClick={onGoConnectors}>
            <Plug size={18} />
            <div>
              <strong>Collega i connettori</strong>
              <span>Gmail, Calendar e 1000+ servizi via Composio, oppure server MCP.</span>
            </div>
          </button>
          <button type="button" className="onboarding-step" onClick={onGoSkills}>
            <BookOpen size={18} />
            <div>
              <strong>Aggiungi skill</strong>
              <span>Capacità pronte dal catalogo (es. la metodologia HomunCoder).</span>
            </div>
          </button>
        </div>
        <button type="button" className="onboarding-skip" onClick={onClose}>
          Inizia subito →
        </button>
      </div>
    </div>
  );
}
