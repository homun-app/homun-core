/**
 * Homun Settings Custom Select
 * Replaces native OS selects with a dark alpine forest dropdown menu,
 * custom chevron, keyboard accessibility, and rich options.
 */

import { useState, useRef, useEffect, isValidElement } from "react";
import { ChevronDown, Check } from "lucide-react";

export type SelectOption = {
  value: string;
  label: string;
  desc?: string;
  subtitle?: string;
  badge?: string;
  icon?: React.ComponentType<{ size?: number; className?: string }> | React.ReactNode;
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
};

export function SettingsCustomSelect({
  value,
  onChange,
  options,
  placeholder = "Seleziona un'opzione...",
  ariaLabel,
  disabled = false,
  className = "",
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  function handleSelect(val: string) {
    onChange(val);
    setIsOpen(false);
  }

  function renderIcon(icon: SelectOption["icon"], isSelected: boolean) {
    if (!icon) return null;
    if (isValidElement(icon)) {
      return (
        <span className={`${isSelected ? "text-[#203c32]" : "text-[#647a6d]"} shrink-0 flex items-center`}>
          {icon}
        </span>
      );
    }
    // Component type (function or forwardRef object like Lucide icon)
    const Comp = icon as React.ComponentType<{ size?: number; className?: string }>;
    return <Comp size={14} className={`${isSelected ? "text-[#203c32]" : "text-[#647a6d]"} shrink-0`} />;
  }

  return (
    <div
      ref={containerRef}
      className={`relative inline-block text-left w-full ${className}`}
      aria-label={ariaLabel}
    >
      {/* Trigger Button */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-xs rounded-lg transition-all duration-150 ${
          disabled
            ? "opacity-50 cursor-not-allowed bg-[#edf2e7] text-[#8ca39d]"
            : "bg-white hover:bg-[#f7f9f5] text-[#1c2d22] border border-[#dce4d5] hover:border-[#97ac68] focus:outline-none focus:ring-1 focus:ring-[#203c32]/30"
        } ${isOpen ? "border-[#203c32] ring-1 ring-[#203c32]/20" : ""}`}
      >
        <div className="flex items-center gap-2 truncate">
          {renderIcon(selectedOption?.icon, true)}
          <span className="truncate font-medium">
            {selectedOption ? selectedOption.label : placeholder}
          </span>
          {selectedOption?.badge && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#edf2e7] text-[#203c32] shrink-0 font-medium">
              {selectedOption.badge}
            </span>
          )}
        </div>
        <ChevronDown
          size={14}
          className={`text-[#647a6d] transition-transform duration-200 shrink-0 ${
            isOpen ? "rotate-180 text-[#203c32]" : ""
          }`}
        />
      </button>

      {/* Floating Menu */}
      {isOpen && (
        <div className="absolute z-50 mt-1.5 w-full min-w-[220px] rounded-xl bg-white border border-[#dce4d5] shadow-xl shadow-black/10 py-1.5 max-h-60 overflow-y-auto backdrop-blur-md animate-in fade-in-50 zoom-in-95 duration-100">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-xs text-[#647a6d] text-center">Nessuna opzione</div>
          ) : (
            options.map((opt) => {
              const isSelected = opt.value === value;
              const sub = opt.desc || opt.subtitle;
              return (
                <div
                  key={opt.value}
                  onClick={() => handleSelect(opt.value)}
                  className={`flex items-center justify-between px-3 py-2 text-xs cursor-pointer transition-colors duration-100 ${
                    isSelected
                      ? "bg-[#edf2e7] text-[#203c32] font-semibold"
                      : "text-[#263832] hover:bg-[#f7f9f5] hover:text-[#1c2d22]"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0 pr-2">
                    {renderIcon(opt.icon, isSelected)}
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 truncate">
                        <span className="truncate">{opt.label}</span>
                        {opt.badge && (
                          <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-[#edf2e7] text-[#556c5e]">
                            {opt.badge}
                          </span>
                        )}
                      </div>
                      {sub && (
                        <p className="text-[10.5px] text-[#647a6d] m-0 truncate leading-snug">
                          {sub}
                        </p>
                      )}
                    </div>
                  </div>
                  {isSelected && <Check size={13} className="text-[#203c32] shrink-0" />}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
