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
