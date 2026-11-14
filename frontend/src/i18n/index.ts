import zhCN from "./locales/zh-CN.json" with { type: "json" };
import en from "./locales/en.json" with { type: "json" };
import {
  applyLocale,
  normalizeLocalePreference,
  type LocalePreference,
  type ResolvedLocale,
} from "./locale";

export type { LocalePreference, ResolvedLocale };
export {
  applyLocale,
  normalizeLocalePreference,
  resolveLocale,
  systemLocale,
} from "./locale";

const dictionaries: Record<ResolvedLocale, Record<string, string>> = {
  "zh-CN": zhCN as Record<string, string>,
  en: en as Record<string, string>,
};

let current: ResolvedLocale = "zh-CN";
const listeners = new Set<() => void>();
export function subscribeLocale(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setActiveLocale(locale: ResolvedLocale) {
  if (current === locale) return;
  current = locale;
  for (const listener of listeners) listener();
}

export function activeLocale(): ResolvedLocale {
  return current;
}

export function t(
  key: string,
  vars?: Record<string, string | number>,
  locale: ResolvedLocale = current,
): string {
  const dict = dictionaries[locale] ?? dictionaries["zh-CN"];
  let text = dict[key] ?? dictionaries["zh-CN"][key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/** Keep dictionary lookup in sync when preference changes. */
export function syncLocaleFromPreference(preference: LocalePreference) {
  const resolved = applyLocale(normalizeLocalePreference(preference));
  setActiveLocale(resolved);
  return resolved;
}
