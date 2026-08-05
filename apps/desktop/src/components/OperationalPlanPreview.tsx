import { Check, Clock3, ListTodo } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

type OperationalPlanItem = {
  detail: string;
  id: string;
  status: "done" | "running" | "waiting" | "blocked";
  title: string;
};

export function OperationalPlanPreview({
  collapsed,
  markdown,
}: {
  collapsed: boolean;
  markdown?: string;
}) {
  const { t } = useTranslation();
  const items = useMemo(() => parseOperationalPlanItems(markdown), [markdown]);
  if (!markdown || items.length === 0) {
    return null;
  }

  const blocked = items.filter((item) => item.status === "blocked");
  const completed = items.filter((item) => item.status === "done");
  const running = items.filter((item) => item.status === "running");
  const visibleItems = collapsed
    ? planPreviewItems(items, blocked)
    : items;

  return (
    <section className="operational-plan-preview" aria-label={t("chat.operationalPlan")}>
      <header>
        <span>
          <ListTodo size={16} />
          <strong>{t("chat.operationalPlan")}</strong>
        </span>
        <small>
          {completed.length} completati
          {running.length ? ` · ${running.length} in corso` : ""}
          {blocked.length ? ` · ${blocked.length} bloccati` : ""}
        </small>
      </header>
      <div className="operational-plan-steps">
        {visibleItems.map((item) => (
          <div className={`operational-plan-step ${item.status}`} key={item.id}>
            <span className="timeline-state">
              {item.status === "done" ? <Check size={12} /> : <Clock3 size={12} />}
            </span>
            <div>
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function parseOperationalPlanItems(markdown?: string): OperationalPlanItem[] {
  if (!markdown) return [];
  return markdown
    .split("\n")
    .map((line) => {
      const match = line.match(
        /^- \[([ x!\-])\] \*\*(.*?)\*\*(?: `[^`]+`)? \(`([^`]+)`\): (.*)$/,
      );
      if (!match) return null;
      return {
        status: planMarkerToStatus(match[1]),
        title: match[2],
        id: match[3],
        detail: match[4],
      } satisfies OperationalPlanItem;
    })
    .filter((item): item is OperationalPlanItem => item !== null);
}

function planMarkerToStatus(marker: string): OperationalPlanItem["status"] {
  if (marker === "x") return "done";
  if (marker === "-") return "running";
  if (marker === "!") return "blocked";
  return "waiting";
}

function planPreviewItems(
  items: OperationalPlanItem[],
  blocked: OperationalPlanItem[],
) {
  const importantIds = new Set([
    "source_trovatreno_extract",
    "source_trenitalia_extract",
    "source_italo_fill",
    "consolidate_options",
    "answer_and_next_gate",
  ]);
  const important = items.filter((item) => importantIds.has(item.id));
  const merged = [...blocked, ...important];
  const seen = new Set<string>();
  return merged
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .slice(0, 5);
}
