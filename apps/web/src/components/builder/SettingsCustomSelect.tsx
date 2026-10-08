/**
 * Homun Settings Custom Select
 * Replaces native OS selects with a dark alpine forest dropdown menu,
 * custom chevron, keyboard accessibility, and rich options.
 */

import { useState, useRef, useEffect, isValidElement } from "react";
import { ChevronDown, Check, Search, X } from "lucide-react";

export type SelectOption = {
  value: string;
  label: string;
  desc?: string | undefined;
  subtitle?: string | undefined;
  badge?: string | undefined;
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
  variant?: "default" | "heading";
  searchable?: boolean;
  searchPlaceholder?: string;
  footerAction?: {
    label: string;
    onClick: () => void;
    icon?: React.ComponentType<{ size?: number; className?: string }> | React.ReactNode;
  };
  footerMeta?: string;
};

export function SettingsCustomSelect({
  value,
  onChange,
  options,
  placeholder = "Seleziona un'opzione...",
  ariaLabel,
  disabled = false,
  className = "",
  variant = "default",
  searchable,
  searchPlaceholder = "Cerca...",
  footerAction,
  footerMeta,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const isSearchable = searchable ?? (variant === "heading" || options.length >= 6);

  const filteredOptions = searchQuery.trim()
    ? options.filter((opt) => {
        const q = searchQuery.toLowerCase();
        return (
          opt.label.toLowerCase().includes(q) ||
          opt.desc?.toLowerCase().includes(q) ||
          opt.subtitle?.toLowerCase().includes(q) ||
          opt.badge?.toLowerCase().includes(q)
        );
      })
    : options;

  const selectedOption = options.find((opt) => opt.value === value);

  useEffect(() => {
    if (isOpen) {
      setSearchQuery("");
      setHighlightedIndex(0);
      if (isSearchable) {
        setTimeout(() => inputRef.current?.focus(), 40);
      }
    }
  }, [isOpen, isSearchable]);

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

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!isOpen) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      setIsOpen(false);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev + 1 < filteredOptions.length ? prev + 1 : 0));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev - 1 >= 0 ? prev - 1 : Math.max(0, filteredOptions.length - 1)));
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const target = filteredOptions[highlightedIndex];
      if (target) {
        handleSelect(target.value);
      }
    }
  }

  return (
    <div
      ref={containerRef}
      onKeyDown={handleKeyDown}
      className={`relative inline-block text-left w-full ${className}`}
      aria-label={ariaLabel}
    >
      {/* Trigger Button */}
      {variant === "heading" ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setIsOpen(!isOpen)}
          className={`flex items-center gap-2 px-2 py-1 -ml-1 text-xl font-bold text-[#1c2d22] hover:bg-[#203c32]/5 rounded-lg transition-colors focus:outline-none ${
            isOpen ? "bg-[#203c32]/5" : ""
          }`}
        >
          <span className="truncate">{selectedOption ? selectedOption.label : placeholder}</span>
          <ChevronDown
            size={18}
            className={`text-[#647a6d] transition-transform duration-200 shrink-0 ${
              isOpen ? "rotate-180 text-[#203c32]" : ""
            }`}
          />
        </button>
      ) : (
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
      )}

      {/* Floating Menu */}
      {isOpen && (
        <div
          className={`absolute z-50 mt-1.5 rounded-xl bg-white border border-[#dce4d5] shadow-xl shadow-black/10 overflow-hidden flex flex-col backdrop-blur-md animate-in fade-in-50 zoom-in-95 duration-100 ${
            variant === "heading" ? "w-[380px] max-w-[90vw]" : "w-full min-w-[240px]"
          }`}
        >
          {/* Sticky Search Header */}
          {isSearchable && (
            <div className="sticky top-0 z-10 bg-white border-b border-[#edf2e7] px-3 py-2 flex items-center gap-2">
              <Search size={14} className="text-[#647a6d] shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setHighlightedIndex(0);
                }}
                placeholder={searchPlaceholder}
                className="w-full text-xs text-[#1c2d22] placeholder:text-[#8ca39d] bg-transparent focus:outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="text-[#8ca39d] hover:text-[#1c2d22] transition-colors p-0.5"
                  title="Cancella ricerca"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          )}

          {/* Options List */}
          <div className="overflow-y-auto max-h-64 py-1">
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-4 text-xs text-[#647a6d] text-center">
                {searchQuery ? `Nessun risultato per «${searchQuery}»` : "Nessuna opzione"}
              </div>
            ) : (
              filteredOptions.map((opt, idx) => {
                const isSelected = opt.value === value;
                const isHighlighted = idx === highlightedIndex;
                const sub = opt.desc || opt.subtitle;
                return (
                  <div
                    key={opt.value}
                    onClick={() => handleSelect(opt.value)}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                    className={`flex items-center justify-between px-3 py-2 text-xs cursor-pointer transition-colors duration-100 ${
                      isSelected
                        ? "bg-[#edf2e7] text-[#203c32] font-semibold"
                        : isHighlighted
                        ? "bg-[#f7f9f5] text-[#1c2d22]"
                        : "text-[#263832] hover:bg-[#f7f9f5] hover:text-[#1c2d22]"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 pr-2">
                      {renderIcon(opt.icon, isSelected)}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 truncate">
                          <span className="truncate">{opt.label}</span>
                          {opt.badge && (
                            <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-[#edf2e7] text-[#556c5e] font-medium shrink-0">
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

          {/* Sticky Footer Action */}
          {(footerAction || footerMeta) && (
            <div className="sticky bottom-0 z-10 bg-[#fafcf8] border-t border-[#edf2e7] px-3 py-2 flex items-center justify-between gap-2">
              {footerAction ? (
                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false);
                    footerAction.onClick();
                  }}
                  className="flex items-center gap-1.5 text-xs font-semibold text-[#157a6e] hover:text-[#203c32] transition-colors"
                >
                  <span className="text-sm font-bold leading-none">+</span>
                  <span>{footerAction.label}</span>
                </button>
              ) : <div />}
              {footerMeta && (
                <span className="text-[10.5px] text-[#647a6d] font-medium shrink-0">
                  {footerMeta}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
