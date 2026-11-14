import { useEffect, useId, useRef, useState } from "react";
import type { NativeModelSelection } from "../client/types";
import { t } from "../i18n";
import "./model-combobox.css";

export interface ModelOption {
  label: string;
  value: NativeModelSelection;
}
export const modelKey = (value?: NativeModelSelection | null) =>
  value
    ? JSON.stringify([value.provider_id, value.model, value.variant ?? null])
    : value === null
      ? "current"
      : "inherit";

function readRecent(key?: string): string[] {
  if (!key) return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .slice(0, 5)
      : [];
  } catch {
    return [];
  }
}

/** Search is a temporary query; only an explicit option selection changes the DTO. */
export function ModelCombobox({
  label,
  models,
  value,
  onChange,
  allowCurrent = false,
  recentScope,
  disabled = false,
}: {
  label: string;
  models: ModelOption[];
  value?: NativeModelSelection | null;
  onChange: (value: NativeModelSelection | null | undefined) => void;
  allowCurrent?: boolean;
  recentScope?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const storageKey = recentScope
    ? `microcrab.settingsUX.models.v1:${recentScope}`
    : undefined;
  const [history, setHistory] = useState(() => ({
    key: storageKey,
    items: readRecent(storageKey),
  }));
  const recent =
    history.key === storageKey ? history.items : readRecent(storageKey);
  const selectedKey = modelKey(value);
  const catalog = models.map((model) => ({
    ...model,
    key: modelKey(model.value),
    group: model.value.provider_id,
  }));
  const selected = catalog.find((model) => model.key === selectedKey);
  const fallback =
    value && !selected
      ? `${value.model} · ${value.provider_id}${value.variant ? ` · ${value.variant}` : ""} (${t("settingsUX.unavailable")})`
      : undefined;
  const display =
    selected?.label ??
    fallback ??
    t(value === null ? "ownerSettings.currentModel" : "ownerSettings.inherit");
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = catalog.filter((model) => {
    const text =
      `${model.label} ${model.value.provider_id} ${model.value.model} ${model.value.variant ?? ""}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const recentOptions = query.trim()
    ? []
    : recent.flatMap((key) => {
        const model = filtered.find((item) => item.key === key);
        return model ? [{ ...model, group: t("settingsUX.recent") }] : [];
      });
  const recentKeys = new Set(recentOptions.map((item) => item.key));
  const options = [
    {
      key: "inherit",
      label: t("ownerSettings.inherit"),
      value: undefined,
      group: "",
    },
    ...(allowCurrent
      ? [
          {
            key: "current",
            label: t("ownerSettings.currentModel"),
            value: null,
            group: "",
          },
        ]
      : []),
    ...(fallback
      ? [{ key: selectedKey, label: fallback, value, group: "" }]
      : []),
    ...recentOptions,
    ...filtered
      .filter((item) => !recentKeys.has(item.key))
      .sort((a, b) => a.group.localeCompare(b.group)),
  ];
  const activeIndex = Math.min(active, options.length - 1);
  useEffect(() => {
    if (open)
      document
        .getElementById(`${id}-${activeIndex}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, id]);
  const show = () => {
    setHistory({ key: storageKey, items: readRecent(storageKey) });
    setQuery("");
    setActive(0);
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    if (option.value && storageKey) {
      const items = [
        option.key,
        ...readRecent(storageKey).filter((key) => key !== option.key),
      ].slice(0, 5);
      try {
        localStorage.setItem(storageKey, JSON.stringify(items));
      } catch {
        /* Optional local preference. */
      }
      setHistory({ key: storageKey, items });
    }
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
        ref={input}
        className="settings-input"
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-${activeIndex}` : undefined}
        disabled={disabled}
        value={open ? query : display}
        placeholder={open ? t("settingsUX.searchModels") : undefined}
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
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            setQuery("");
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) show();
            else
              setActive(
                (current) =>
                  (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    options.length) %
                  options.length,
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
      {open && (
        <div
          className="model-combobox-menu"
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
        >
          {!filtered.length && query.trim() && (
            <p className="model-combobox-empty" role="status">
              {t("settingsUX.noModels")}
            </p>
          )}
          {options.map((option, index) => (
            <div key={option.key}>
              {option.group && option.group !== options[index - 1]?.group && (
                <div className="model-combobox-group">{option.group}</div>
              )}
              <div
                id={`${id}-${index}`}
                role="option"
                aria-selected={selectedKey === option.key}
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
