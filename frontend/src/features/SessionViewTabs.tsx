import type { SessionViewMode } from "../client/types";
import { t } from "../i18n";

export function SessionViewTabs<Mode extends SessionViewMode>({
  modes,
  viewMode,
  onSelect,
  idPrefix = "view",
  panelId = "main-view-panel",
  plugins = [],
  selectedPlugin = null,
  onSelectPlugin,
}: {
  modes: readonly Mode[];
  viewMode: Mode;
  onSelect: (mode: Mode) => void;
  idPrefix?: string;
  panelId?: string;
  plugins?: readonly { id: string; name: string }[];
  selectedPlugin?: string | null;
  onSelectPlugin?: (id: string) => void;
}) {
  return (
    <div className="header-subnav-row">
      <div className="header-subnav-tabs" role="tablist" aria-label={t("view.tabs")}>
        {modes.map((mode) => (
          <button
            key={mode}
            id={`${idPrefix}-tab-${mode}`}
            data-testid={mode === "chat" ? "tab-conversation" : "tab-trace"}
            className={`secondary-tab-btn${!selectedPlugin && viewMode === mode ? " active" : ""}`}
            role="tab"
            aria-selected={!selectedPlugin && viewMode === mode}
            aria-controls={panelId}
            onClick={() => onSelect(mode)}
          >
            <span>{t(`view.tab.${mode}`)}</span>
          </button>
        ))}
        {plugins.map((plugin) => (
          <button key={`plugin:${plugin.id}`} id={`${idPrefix}-tab-plugin-${plugin.id}`}
            className={`secondary-tab-btn${selectedPlugin === plugin.id ? " active" : ""}`}
            role="tab" aria-selected={selectedPlugin === plugin.id} aria-controls={panelId}
            data-testid="session-plugin-tab" onClick={() => onSelectPlugin?.(plugin.id)}>
            <span>{plugin.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
