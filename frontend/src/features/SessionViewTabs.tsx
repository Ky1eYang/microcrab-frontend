import { t } from "../i18n";
export function SessionViewTabs({
  viewMode,
  onSelect,
  idPrefix = "view",
  panelId = "main-view-panel",
  plugins = [],
  selectedPlugin = null,
  onSelectPlugin,
}: {
  viewMode: "chat" | "trajectory";
  onSelect: (mode: "chat" | "trajectory") => void;
  idPrefix?: string;
  panelId?: string;
  plugins?: readonly { id: string; name: string }[];
  selectedPlugin?: string | null;
  onSelectPlugin?: (id: string) => void;
}) {
  return (
    <div className="header-subnav-row">
      <div className="header-subnav-tabs" role="tablist" aria-label={t("view.tabs")}>
        {(
          [
            ["chat", t("view.tab.chat")],
            ["trajectory", t("view.tab.trajectory")],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            id={`${idPrefix}-tab-${mode}`}
            className={`secondary-tab-btn${!selectedPlugin && viewMode === mode ? " active" : ""}`}
            role="tab"
            aria-selected={!selectedPlugin && viewMode === mode}
            aria-controls={panelId}
            onClick={() => onSelect(mode)}
          >
            <span>{label}</span>
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
