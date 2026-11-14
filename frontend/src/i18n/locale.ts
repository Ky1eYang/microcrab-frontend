/** Light locale preference — mirrors theme handling. */
export type LocalePreference = "zh-CN" | "en" | "system";
export type ResolvedLocale = "zh-CN" | "en";

export function normalizeLocalePreference(value: unknown): LocalePreference {
  return value === "en" || value === "zh-CN" || value === "system"
    ? value
    : "zh-CN";
}

export function systemLocale(): ResolvedLocale {
  try {
    const lang = (
      typeof navigator !== "undefined" ? navigator.language : "zh-CN"
    ).toLowerCase();
    return lang.startsWith("zh") ? "zh-CN" : "en";
  } catch {
    return "zh-CN";
  }
}

export function resolveLocale(preference: LocalePreference): ResolvedLocale {
  return preference === "system" ? systemLocale() : preference;
}

/** Sync <html lang> (+ data-locale for tests). */
export function applyLocale(preference: LocalePreference): ResolvedLocale {
  const resolved = resolveLocale(preference);
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.lang = resolved;
    root.dataset.locale = resolved;
    root.dataset.localePref = preference;
  }
  return resolved;
}
