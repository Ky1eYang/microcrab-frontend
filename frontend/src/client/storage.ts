import { reportDiagnostic } from "./diagnostics";
/** Persist presentation preferences only. Credentials and server ownership never live here. */
const PRESENTATION = new Set([
  "theme",
  "railCollapsed",
  "rightRailCollapsed",
  "rightRailWidth",
  "conversationWidth",
  "locale",
]);
export function readPreference(key: string, fallback: any = null): any {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch (error) {
    reportDiagnostic("storage", "readPreference", error, undefined, "warn");
    return fallback;
  }
}
export function preference(name: string, fallback: any = null) {
  return PRESENTATION.has(name)
    ? readPreference(`microcrab.ui.${name}`, fallback)
    : fallback;
}
export function savePreference(name: string, value: unknown) {
  if (!PRESENTATION.has(name)) return;
  try {
    localStorage.setItem(`microcrab.ui.${name}`, String(value));
  } catch (error) {
    reportDiagnostic("storage", "savePreference", error, undefined, "warn");
  }
}
