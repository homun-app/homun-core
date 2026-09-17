import { Children, isValidElement, type ReactNode } from "react";
import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

/** Inline content keeps the menu inside the native dialog's top layer. */
export function ConversationSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: (string | { value: string; label: string; disabled?: boolean })[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger aria-label={label} className="cv-select-trigger">
        <Select.Value />
        <Select.Icon>
          <ChevronDown size={15} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Content
        className="cv-select-menu"
        position="popper"
        align="end"
        sideOffset={7}
        collisionPadding={12}
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        <Select.ScrollUpButton className="cv-select-scroll">
          <ChevronUp size={14} />
        </Select.ScrollUpButton>
        <Select.Viewport className="cv-select-options">
          {options.map((option) => (
            <Select.Item
              key={typeof option === "string" ? option : option.value}
              value={typeof option === "string" ? option : option.value}
              disabled={typeof option === "string" ? false : !!option.disabled}
              className="cv-select-option"
            >
              <Select.ItemText>
                {typeof option === "string" ? option : option.label}
              </Select.ItemText>
              <Select.ItemIndicator>
                <Check size={15} />
              </Select.ItemIndicator>
            </Select.Item>
          ))}
        </Select.Viewport>
        <Select.ScrollDownButton className="cv-select-scroll">
          <ChevronDown size={14} />
        </Select.ScrollDownButton>
      </Select.Content>
    </Select.Root>
  );
}

/** Adapter for existing option lists; renders the same shared picker everywhere. */
export function ConversationSelectField({
  children,
  value,
  onChange,
  disabled,
  "aria-label": label,
}: {
  children: ReactNode;
  value: string;
  onChange: (event: { target: { value: string } }) => void;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  function text(node: ReactNode): string {
    return Children.toArray(node)
      .map((child) =>
        isValidElement<{ children?: ReactNode }>(child)
          ? text(child.props.children)
          : String(child),
      )
      .join("");
  }
  const options = Children.toArray(children)
    .filter(isValidElement<{ value?: string; disabled?: boolean; children?: ReactNode }>)
    .map((child) => ({
      value: String(child.props.value ?? text(child.props.children)) || "__homun_none__",
      label: text(child.props.children),
      disabled: !!child.props.disabled,
    }));
  return (
    <ConversationSelect
      label={label || "Scegli un’opzione"}
      value={value || "__homun_none__"}
      options={options}
      disabled={!!disabled}
      onChange={(v) => onChange({ target: { value: v === "__homun_none__" ? "" : v } })}
    />
  );
}
