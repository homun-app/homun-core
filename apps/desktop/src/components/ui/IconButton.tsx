import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FocusEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from "react";
import {
  combineAriaDescribedBy,
  computeTooltipPlacement,
  menuPlacementEvents,
  observeGeometryChanges,
  optionalAriaPressed,
} from "../../lib/layeredMenuState";

export type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "aria-pressed" | "children"> {
  label: string;
  children: ReactNode;
  tooltip?: string;
  badge?: ReactNode;
  badgeLabel?: string;
  pressed?: boolean;
  size?: IconButtonSize;
}

export function IconButton({
  label,
  children,
  tooltip,
  badge,
  badgeLabel,
  pressed,
  size = "md",
  className,
  type = "button",
  onFocus,
  onPointerEnter,
  ...buttonProps
}: IconButtonProps) {
  const tooltipId = useId();
  const badgeDescriptionId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [tooltipPlacement, setTooltipPlacement] = useState({
    top: 0,
    left: 0,
    maxWidth: 240,
    maxHeight: 240,
    vertical: "below" as "above" | "below",
  });
  const classes = ["ui-icon-button", className].filter(Boolean).join(" ");
  const primitiveBadgeDescription = typeof badge === "string" || typeof badge === "number"
    ? String(badge).trim()
    : undefined;
  const badgeDescription = badge != null
    ? badgeLabel?.trim() || primitiveBadgeDescription || undefined
    : undefined;
  const describedBy = combineAriaDescribedBy(
    buttonProps["aria-describedby"],
    tooltip ? tooltipId : undefined,
    badgeDescription ? badgeDescriptionId : undefined,
  );

  const updateTooltipPlacement = useCallback(() => {
    const button = buttonRef.current;
    const tooltipElement = tooltipRef.current;
    if (!button || !tooltipElement) return;
    const tooltipRect = tooltipElement.getBoundingClientRect();
    const next = computeTooltipPlacement({
      anchor: button.getBoundingClientRect(),
      tooltipWidth: tooltipRect.width,
      tooltipHeight: tooltipRect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setTooltipPlacement((current) => (
      current.top === next.top
        && current.left === next.left
        && current.maxWidth === next.maxWidth
        && current.maxHeight === next.maxHeight
        && current.vertical === next.vertical
        ? current
        : next
    ));
  }, []);

  useLayoutEffect(() => {
    if (!tooltip) return;
    updateTooltipPlacement();
    menuPlacementEvents.forEach(({ type: eventType, capture }) => {
      window.addEventListener(eventType, updateTooltipPlacement, capture);
    });
    const stopObserving = observeGeometryChanges(
      typeof window.ResizeObserver === "function" ? window.ResizeObserver : undefined,
      [buttonRef.current, tooltipRef.current],
      updateTooltipPlacement,
    );
    return () => {
      menuPlacementEvents.forEach(({ type: eventType, capture }) => {
        window.removeEventListener(eventType, updateTooltipPlacement, capture);
      });
      stopObserving();
    };
  }, [tooltip, updateTooltipPlacement]);

  const handleFocus: FocusEventHandler<HTMLButtonElement> = (event) => {
    updateTooltipPlacement();
    onFocus?.(event);
  };

  const handlePointerEnter: PointerEventHandler<HTMLButtonElement> = (event) => {
    updateTooltipPlacement();
    onPointerEnter?.(event);
  };

  return (
    <button
      {...buttonProps}
      ref={buttonRef}
      type={type}
      className={classes}
      data-size={size}
      aria-label={label}
      aria-pressed={optionalAriaPressed(pressed)}
      aria-describedby={describedBy}
      onFocus={handleFocus}
      onPointerEnter={handlePointerEnter}
    >
      <span className="ui-icon-button__icon" aria-hidden="true">
        {children}
      </span>
      {badge != null ? (
        <span className="ui-icon-button__badge" aria-hidden="true">{badge}</span>
      ) : null}
      {badgeDescription ? (
        <span id={badgeDescriptionId} className="ui-visually-hidden">{badgeDescription}</span>
      ) : null}
      {tooltip ? (
        <span
          ref={tooltipRef}
          role="tooltip"
          className="ui-tooltip"
          id={tooltipId}
          data-placement={tooltipPlacement.vertical}
          style={{
            top: tooltipPlacement.top,
            left: tooltipPlacement.left,
            maxWidth: tooltipPlacement.maxWidth,
            maxHeight: tooltipPlacement.maxHeight,
          }}
        >
          {tooltip}
        </span>
      ) : null}
    </button>
  );
}
