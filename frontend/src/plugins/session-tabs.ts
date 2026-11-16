import type { InstalledPlugin } from "./types";
import type { SessionPluginTab } from "../client/types";

/** Selection is scoped to its invoking Session; declaration and enablement remain facts. */
export function sessionTabPlugins(
  entries: readonly InstalledPlugin[],
  enabled: (id: string) => boolean,
) {
  return entries.filter(
    (entry) =>
      entry.manifest.targets.includes("session-tab") &&
      enabled(entry.manifest.id),
  );
}
export function selectedSessionPlugin(
  selection: SessionPluginTab | null | undefined,
  sessionId: string | null,
  entries: readonly InstalledPlugin[],
): string | null {
  return selection &&
    selection.sessionId === sessionId &&
    entries.some((entry) => entry.manifest.id === selection.pluginId)
    ? selection.pluginId
    : null;
}

/**
 * Right plugin sidebar is only available when on an active conversation page
 * and at least one sidebar-targeted plugin is enabled and started in the session.
 */
export function hasActiveSessionSidebarPlugin(
  entries: readonly InstalledPlugin[],
  enabled: (id: string) => boolean,
  page: string,
  sessionId: string | null | undefined,
): boolean {
  if (page !== "conversation" || !sessionId) return false;
  return entries.some(
    (entry) =>
      entry.manifest.targets.includes("sidebar") &&
      enabled(entry.manifest.id) &&
      entry.status !== "disabled",
  );
}
