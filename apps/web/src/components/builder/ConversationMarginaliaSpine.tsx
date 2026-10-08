import { useState } from "react";
import type { Work } from "./conversation-types";
import type { WorkIntakeState } from "@/hooks/useWorkIntake";
import { Bookmark, Sparkles, CheckCircle2, ShieldCheck, Layers, FileText, ArrowRight } from "lucide-react";
import "./conversation-marginalia.css";

export type SalientPoint = {
  id: string;
  category: string;
  title: string;
  detail: string;
  icon?: typeof Sparkles;
  actionLabel: string;
  targetSelector: string;
};

export function extractSalientPoints(work?: Work | undefined, intake?: WorkIntakeState | undefined): SalientPoint[] {
  if (!work) return [];
  const points: SalientPoint[] = [];

  // 1. Obiettivo concordato / Richiesta
  if (work.title && work.title !== "Nuova richiesta") {
    points.push({
      id: "objective",
      category: "Obiettivo concordato",
      title: work.title,
      detail: work.engineObjective ?? "Incarico principale definito con Homun.",
      icon: CheckCircle2,
      actionLabel: "Vedi obiettivo concordato",
      targetSelector: "#cw-intake-head",
    });
  }

  // 2. Nodi aperti / Chiarimenti necessari
  const reqs = intake?.proposal?.missing_information ?? [];
  if (reqs.length > 0) {
    points.push({
      id: "needs",
      category: "Nodi aperti",
      title: "Chiarimenti necessari",
      detail: reqs.join(" · "),
      icon: Sparkles,
      actionLabel: "Rispondi ai chiarimenti",
      targetSelector: "#cw-intake-needs",
    });
  }

  // 3. Staffetta Operativa / Fasi
  const steps = work.enginePlan ?? intake?.proposal?.plan_steps ?? [];
  if (steps.length > 0) {
    const doneCount = (work.enginePlan ?? []).filter((s) => s.status === "succeeded").length;
    points.push({
      id: "relay",
      category: "Staffetta operativa",
      title: `${steps.length} fasi previste`,
      detail: `${doneCount} di ${steps.length} completate. Passaggi di consegne tracciati.`,
      icon: Layers,
      actionLabel: "Visualizza passaggi staffetta",
      targetSelector: work.enginePlan?.length ? "#cw-relay-timeline" : "#cw-intake-relay",
    });
  }

  // 4. Presidio & Controllo Umano
  points.push({
    id: "governance",
    category: "Supervisione umana",
    title: "Cancello di controllo",
    detail: "Nessun comando critico o riavvio parte senza la tua esplicita autorizzazione.",
    icon: ShieldCheck,
    actionLabel: "Vai alla supervisione",
    targetSelector: "#cw-relay-checkpoint, #cw-intake-footer",
  });

  // 5. Vault / Output riutilizzabili
  if (work.engineLatestArtifact || (work.source === "engine" && work.engineStatus === "completed")) {
    points.push({
      id: "vault",
      category: "Vault di progetto",
      title: "Artefatti riutilizzabili",
      detail: "Documenti e dataset depositati per essere usati come base in future lavorazioni.",
      icon: FileText,
      actionLabel: "Vedi artefatti",
      targetSelector: "#cw-artifact-review, .cw-composer",
    });
  }

  return points;
}

function navigateToPoint(point: SalientPoint) {
  if (!point.targetSelector) return;
  const target = document.querySelector(point.targetSelector);
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("cw-highlight-pulse");
    setTimeout(() => target.classList.remove("cw-highlight-pulse"), 2200);

    // If there is an input or textarea inside, focus it
    const input = target.querySelector("input, textarea") as HTMLInputElement | HTMLTextAreaElement | null;
    if (input) {
      setTimeout(() => input.focus(), 350);
    }
  }
}

export function ConversationMarginaliaSpine({
  work,
  intake,
}: {
  work?: Work | undefined;
  intake?: WorkIntakeState | undefined;
}) {
  const [activePointId, setActivePointId] = useState<string | null>(null);
  const points = extractSalientPoints(work, intake);

  if (points.length === 0) return null;

  return (
    <aside className="cw-marginalia-spine" aria-label="Note a margine e punti salienti">
      <div className="cw-marginalia-track">
        {points.map((point) => {
          const isActive = activePointId === point.id;
          const Icon = point.icon ?? Bookmark;

          return (
            <div
              key={point.id}
              className={`cw-marginalia-item ${point.id === "needs" ? "has-badge" : ""}`}
              onMouseEnter={() => setActivePointId(point.id)}
              onMouseLeave={() => setActivePointId(null)}
            >
              <button
                type="button"
                className={`cw-marginalia-btn ${isActive ? "is-active" : ""}`}
                aria-label={`${point.category}: ${point.title} — clicca per aprire`}
                title={`${point.category}: ${point.title}`}
                onClick={() => {
                  setActivePointId((curr) => (curr === point.id ? null : point.id));
                  navigateToPoint(point);
                }}
              >
                <span className="cw-marginalia-dash" />
              </button>

              {isActive && (
                <div className="cw-marginalia-popover" role="tooltip">
                  <div className="cw-marginalia-popover__header">
                    <span className="cw-marginalia-popover__category">
                      ({point.category})
                    </span>
                    <Icon size={12} className="cw-marginalia-popover__icon" />
                  </div>
                  <strong className="cw-marginalia-popover__title">
                    {point.title}
                  </strong>
                  <p className="cw-marginalia-popover__detail">
                    {point.detail}
                  </p>
                  <button
                    type="button"
                    className="cw-marginalia-popover__action"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigateToPoint(point);
                    }}
                  >
                    <span>{point.actionLabel}</span>
                    <ArrowRight size={11} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
