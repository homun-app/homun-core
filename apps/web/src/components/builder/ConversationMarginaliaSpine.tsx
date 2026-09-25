import { useState } from "react";
import type { Work } from "./conversation-types";
import type { WorkIntakeState } from "@/hooks/useWorkIntake";
import { Bookmark, Sparkles, CheckCircle2, ShieldCheck, Layers, FileText } from "lucide-react";
import "./conversation-marginalia.css";

export type SalientPoint = {
  id: string;
  category: string;
  title: string;
  detail: string;
  icon?: typeof Sparkles;
  targetMessageIndex?: number;
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
    });
  }

  // 4. Presidio & Controllo Umano
  points.push({
    id: "governance",
    category: "Supervisione umana",
    title: "Cancello di controllo",
    detail: "Nessun comando critico o riavvio parte senza la tua esplicita autorizzazione.",
    icon: ShieldCheck,
  });

  // 5. Vault / Output riutilizzabili
  if (work.engineLatestArtifact || (work.source === "engine" && work.engineStatus === "completed")) {
    points.push({
      id: "vault",
      category: "Vault di progetto",
      title: "Artefatti riutilizzabili",
      detail: "Documenti e dataset depositati per essere usati come base in future lavorazioni.",
      icon: FileText,
    });
  }

  return points;
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
              className="cw-marginalia-item"
              onMouseEnter={() => setActivePointId(point.id)}
              onMouseLeave={() => setActivePointId(null)}
            >
              <button
                type="button"
                className={`cw-marginalia-dash ${isActive ? "is-active" : ""}`}
                aria-label={`${point.category}: ${point.title}`}
              />

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
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
