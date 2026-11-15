import { useEffect, useId, useRef, useState } from "react";
import { t } from "../i18n";
import "./model-combobox.css";

export interface SelectOptionItem<T> {
  key: string;
  label: string;
  value: T;
  group?: string;
}

/** Filtering is a temporary query; only explicit selection changes the value. */
export function SearchableSelect<T>({
  label,
  options,
  valueKey,
  onChange,
  disabled = false,
}: {
  label: string;
  options: SelectOptionItem<T>[];
  valueKey: string;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const selected = options.find((option) => option.key === valueKey);
  const display =
    selected?.label ?? `${valueKey} (${t("settingsUX.unavailable")})`;
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = options.filter((option) =>
    terms.every((term) =>
      `${option.label} ${option.key} ${option.group ?? ""}`
        .toLocaleLowerCase()
        .includes(term),
    ),
  );
  const activeIndex = Math.max(0, Math.min(active, filtered.length - 1));
  useEffect(() => {
    if (open)
      document
        .getElementById(`${id}-opt-${activeIndex}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, id]);
  const show = () => {
    if (disabled) return;
    setQuery("");
    setActive(0);
    setOpen(true);
  };
  const choose = (index: number) => {
    if (disabled) return;
    const option = filtered[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    setQuery("");
    input.current?.focus();
  };
  return (
    <div
      className="model-combobox"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          setQuery("");
        }
      }}
    >
      <input
        id={id}
        ref={input}
        className="settings-input"
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open && !disabled}
        aria-controls={`${id}-list`}
        aria-activedescendant={
          open && !disabled && filtered.length
            ? `${id}-opt-${activeIndex}`
            : undefined
        }
        disabled={disabled}
        value={open && !disabled ? query : display}
        placeholder={open ? t("uiPolish.searchOptions") : undefined}
        onFocus={show}
        onClick={() => {
          if (!open) show();
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            setQuery("");
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) show();
            else if (filtered.length)
              setActive(
                (current) =>
                  (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    filtered.length) %
                  filtered.length,
              );
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            choose(activeIndex);
          } else if (event.key === "Tab") {
            setOpen(false);
            setQuery("");
          }
        }}
      />
      {open && !disabled && (
        <div
          className="model-combobox-menu"
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
        >
          {!filtered.length && (
            <p className="model-combobox-empty" role="status">
              {t("uiPolish.noMatches")}
            </p>
          )}
          {filtered.map((option, index) => (
            <div key={option.key}>
              {option.group && option.group !== filtered[index - 1]?.group && (
                <div className="model-combobox-group">{option.group}</div>
              )}
              <div
                id={`${id}-opt-${index}`}
                role="option"
                aria-selected={valueKey === option.key}
                className="model-combobox-option"
                data-active={index === activeIndex}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                {option.label}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
