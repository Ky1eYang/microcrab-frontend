/**
 * Theme preference handling.
 *
 * The stored preference (`microcrab.ui.theme`) is one of system | light | dark
 * and defaults to system. `<html data-theme>` always carries the resolved scheme
 * (light | dark) because CSS keys only on that attribute; `data-theme-pref`
 * mirrors the preference for tests and agents. index.html runs an inline copy of
 * `resolveTheme` before first paint so a reload never flashes the wrong scheme.
 */
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const DARK_QUERY = "(prefers-color-scheme: dark)";

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function systemTheme(): ResolvedTheme {
  try {
    return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

/** Write both theme attributes on <html> and return the resolved scheme. */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePref = preference;
  return resolved;
}

/** Follow OS scheme changes; returns an unsubscribe function. */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const query = matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
