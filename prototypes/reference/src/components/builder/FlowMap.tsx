import { Plus, Trash2, Zap } from "lucide-react";
import { getPlugin } from "@/lib/plugins";
import { actionOf, triggerOf, type AutomationDraft } from "@/lib/builder";

function Node({
  eyebrow,
  title,
  subtitle,
  active,
  tone = "step",
  onClick,
  onRemove,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string | undefined;
  active?: boolean | undefined;
  tone?: "trigger" | "step";
  onClick?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onClick}
        className={`group w-56 rounded-2xl border p-4 text-left transition-colors ${
          active ? "border-primary bg-primary/10" : "border-border bg-card hover:border-primary/60"
        }`}
      >
        <span
          className={`eyebrow flex items-center gap-1.5 ${tone === "trigger" ? "text-accent" : "text-muted-foreground"}`}
        >
          {tone === "trigger" && <Zap className="size-3" />}
          {eyebrow}
        </span>
        <span className="mt-2 block text-sm font-semibold leading-snug text-foreground">
          {title}
        </span>
        {subtitle && (
          <span className="mt-1 block truncate text-xs text-muted-foreground">{subtitle}</span>
        )}
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label="Rimuovi passaggio"
          onClick={onRemove}
          className="absolute -right-2 -top-2 rounded-full border border-border bg-background p-1.5 text-muted-foreground transition-colors hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function Connector() {
  return (
    <div className="flex h-16 w-full items-center justify-center md:h-auto md:w-10">
      <div className="h-full w-px bg-gradient-to-b from-primary/60 to-primary/20 md:h-px md:w-full md:bg-gradient-to-r" />
    </div>
  );
}

/** Mappa visiva dell'automazione: si legge da sinistra a destra. */
export function FlowMap({
  draft,
  selected,
  onSelectTrigger,
  onSelectStep,
  onRemoveStep,
  onAddStep,
}: {
  draft: AutomationDraft;
  selected?: { kind: "trigger" } | { kind: "step"; index: number } | null;
  onSelectTrigger?: () => void;
  onSelectStep?: (index: number) => void;
  onRemoveStep?: (index: number) => void;
  onAddStep?: () => void;
}) {
  const trigger = triggerOf(draft);
  return (
    <div
      className="overflow-x-auto rounded-2xl border border-border/70 p-6"
      style={{
        backgroundImage:
          "radial-gradient(color-mix(in oklab, var(--border) 90%, transparent) 1px, transparent 1px)",
        backgroundSize: "18px 18px",
      }}
    >
      <div className="flex flex-col items-center md:flex-row md:items-stretch">
        <Node
          tone="trigger"
          eyebrow="Quando"
          title={trigger?.label ?? "Scegli cosa fa partire tutto"}
          subtitle={draft.triggerPluginId ? getPlugin(draft.triggerPluginId)?.name : undefined}
          active={selected?.kind === "trigger"}
          onClick={onSelectTrigger}
        />
        {draft.steps.map((step, i) => (
          <div key={i} className="flex flex-col items-center md:flex-row">
            <Connector />
            <Node
              eyebrow={`Poi · passo ${i + 1}`}
              title={actionOf(step)?.label ?? "Scegli l'azione"}
              subtitle={getPlugin(step.pluginId)?.name}
              active={selected?.kind === "step" && selected.index === i}
              onClick={() => onSelectStep?.(i)}
              onRemove={onRemoveStep ? () => onRemoveStep(i) : undefined}
            />
          </div>
        ))}
        {onAddStep && (
          <div className="flex flex-col items-center md:flex-row">
            <Connector />
            <button
              type="button"
              onClick={onAddStep}
              className="flex w-56 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border p-4 text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
            >
              <Plus className="size-4" />
              <span className="text-xs font-medium">Aggiungi un passaggio</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
