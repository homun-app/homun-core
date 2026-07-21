import { useEffect, useId, useRef, useState, type CSSProperties, type FocusEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { UsageDailySeries } from "../lib/coreBridge";
import {
  buildCalendarDays,
  resolvedProviderLabel,
  routeLabel,
  totalKnownCost,
  totalTokens,
  type CalendarDay,
  type UsageCalendarWindowLike,
} from "../lib/usageCalendar";
import { formatCount, formatMicrousd } from "../lib/usageViewModel";

interface UsageCalendarProps {
  series: UsageDailySeries;
  window: UsageCalendarWindowLike;
  locale?: string;
  density?: "compact" | "comfortable";
  onSelectDay?: (dayEpoch: number) => void;
  providerLabels?: Record<string, string>;
}

interface TooltipState {
  day: CalendarDay;
  left: number;
  top: number;
  placement: "above" | "below";
}

export function UsageCalendar({
  series,
  window,
  locale,
  density = "comfortable",
  onSelectDay,
  providerLabels = {},
}: UsageCalendarProps) {
  const { t } = useTranslation();
  const tooltipId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const days = buildCalendarDays(series, window);
  const leading = days.length ? new Date(days[0].day_epoch * 1_000).getUTCDay() : 0;
  const lastDayEpoch = days.at(-1)?.day_epoch ?? null;

  useEffect(() => {
    if (window !== "home-26w") return;
    const scrollNode = scrollRef.current;
    if (scrollNode) scrollNode.scrollLeft = scrollNode.scrollWidth;
  }, [window, days.length, lastDayEpoch]);

  function showDay(day: CalendarDay, target: HTMLElement) {
    const rect = target.getBoundingClientRect();
    const width = Math.min(296, Math.max(220, windowWidth() - 24));
    const left = Math.max(12, Math.min(windowWidth() - width - 12, rect.left + rect.width / 2 - width / 2));
    const placement = rect.top > 210 ? "above" : "below";
    setTooltip({
      day,
      left,
      top: placement === "above" ? rect.top - 10 : rect.bottom + 10,
      placement,
    });
  }

  function handleMouseEnter(day: CalendarDay, event: MouseEvent<HTMLButtonElement>) {
    showDay(day, event.currentTarget);
  }

  function handleFocus(day: CalendarDay, event: FocusEvent<HTMLButtonElement>) {
    showDay(day, event.currentTarget);
  }

  return (
    <div className={`usage-calendar usage-calendar--${density}`}>
      <div className="usage-calendar-scroll" ref={scrollRef}>
        <div
          className="usage-calendar-grid"
          role="grid"
          aria-label={t("settings.usage.calendar.ariaLabel")}
        >
          {Array.from({ length: leading }, (_, index) => (
            <span className="usage-calendar-pad" aria-hidden="true" key={`pad-${index}`} />
          ))}
          {days.map((day) => {
            const date = formatDay(day.day_epoch, locale);
            const tokens = totalTokens(day);
            const stateLabel = day.state === "unavailable"
              ? t("settings.usage.calendar.unavailable")
              : day.state === "zero"
                ? t("settings.usage.calendar.noActivity")
                : t("settings.usage.calendar.daySummary", {
                    calls: formatCount(day.logical_calls, locale),
                    tokens: formatCount(tokens, locale),
                  });
            return (
              <button
                className={`usage-calendar-day is-${day.state} level-${day.intensity}`}
                type="button"
                role="gridcell"
                aria-label={`${date}. ${stateLabel}`}
                aria-disabled={day.state === "unavailable"}
                aria-describedby={tooltip?.day.day_epoch === day.day_epoch ? tooltipId : undefined}
                data-day-epoch={day.day_epoch}
                key={day.day_epoch}
                onMouseEnter={(event) => handleMouseEnter(day, event)}
                onMouseLeave={() => setTooltip(null)}
                onFocus={(event) => handleFocus(day, event)}
                onBlur={() => setTooltip(null)}
                onClick={() => {
                  if (day.state !== "unavailable") onSelectDay?.(day.day_epoch);
                }}
              />
            );
          })}
        </div>
      </div>
      <div className="usage-calendar-legend" aria-hidden="true">
        <span>{t("settings.usage.calendar.less")}</span>
        {[0, 1, 2, 3, 4].map((level) => <i className={`level-${level}`} key={level} />)}
        <span>{t("settings.usage.calendar.more")}</span>
      </div>
      {tooltip && (
        <UsageDayTooltip
          id={tooltipId}
          day={tooltip.day}
          locale={locale}
          providerLabels={providerLabels}
          style={{ left: tooltip.left, top: tooltip.top }}
          placement={tooltip.placement}
        />
      )}
    </div>
  );
}

function UsageDayTooltip({
  id,
  day,
  locale,
  placement,
  style,
  providerLabels,
}: {
  id: string;
  day: CalendarDay;
  locale?: string;
  placement: "above" | "below";
  style: CSSProperties;
  providerLabels: Record<string, string>;
}) {
  const { t } = useTranslation();
  const cost = day.cost_breakdown;
  const knownCost = totalKnownCost(day);
  const coverageTotal = day.known_usage_attempts + day.unknown_usage_attempts;
  const usageCoverage = coverageTotal
    ? Math.round((day.known_usage_attempts / coverageTotal) * 100)
    : 0;
  return (
    <div
      className={`usage-calendar-tooltip is-${placement}`}
      id={id}
      role="tooltip"
      style={style}
    >
      <strong>{formatDay(day.day_epoch, locale)}</strong>
      {day.state === "unavailable" ? (
        <p>{t("settings.usage.calendar.unavailableDetail")}</p>
      ) : day.state === "zero" ? (
        <p>{t("settings.usage.calendar.noActivity")}</p>
      ) : (
        <>
          <dl>
            <div><dt>{t("settings.usage.metrics.calls")}</dt><dd>{formatCount(day.logical_calls, locale)}</dd></div>
            <div><dt>{t("settings.usage.models.tokens")}</dt><dd>{formatCount(totalTokens(day), locale)}</dd></div>
            <div><dt>{t("settings.usage.models.cost")}</dt><dd>{formatMicrousd(knownCost, locale)}</dd></div>
          </dl>
          <p className="usage-calendar-route">
            {routeLabel({
              dominant_provider: resolvedProviderLabel(day.dominant_provider, providerLabels),
              dominant_model: day.dominant_model,
            }, t("settings.usage.calendar.unknownRoute"))}
          </p>
          {(usageCoverage < 100 || (cost.cost_coverage_percent ?? 0) < 100) && (
            <small>{t("settings.usage.calendar.coverage", {
              usage: usageCoverage,
              cost: cost.cost_coverage_percent ?? 0,
            })}</small>
          )}
        </>
      )}
    </div>
  );
}

function formatDay(dayEpoch: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(dayEpoch * 1_000);
}

function windowWidth(): number {
  return typeof window === "undefined" ? 1_280 : window.innerWidth;
}
