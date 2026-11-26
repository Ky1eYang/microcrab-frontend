import type { ReactNode } from "react";
import type { DashboardTab } from "../../../client/dashboard-route";
import { t } from "../../../i18n";
import { useAppDispatch, useAppFields } from "../../../state";
import { Icon } from "../../../shell/Icon";
import { UserCard } from "../../../shell/UserCard";
import { useNarrowViewport } from "../../../client/viewport";

interface NavItem {
  id: DashboardTab;
  labelKey: string;
  icon: ReactNode;
}

const ITEMS: NavItem[] = [
  { id: "dashboard", labelKey: "console.nav.dashboard", icon: <Icon name="dashboard" size={15} /> },
  { id: "library", labelKey: "console.nav.library", icon: <Icon name="box" size={15} /> },
  { id: "keys", labelKey: "console.nav.keys", icon: <Icon name="key" size={15} /> },
  { id: "logs", labelKey: "console.nav.logs", icon: <Icon name="history" size={15} /> },
  { id: "plugins", labelKey: "console.nav.plugins", icon: <Icon name="plugins" size={15} /> },
  { id: "settings", labelKey: "console.nav.settings", icon: <Icon name="settings" size={15} /> },
];

export function DashboardSidebar({
  currentTab,
  onSelectTab,
  onToggle,
  drawerOpen = false,
  onCloseDrawer,
}: {
  currentTab: DashboardTab;
  onSelectTab: (tabId: DashboardTab) => void;
  onToggle?: () => void;
  drawerOpen?: boolean;
  onCloseDrawer?: () => void;
}) {
  const { state } = useAppFields(["railCollapsed", "resolvedLocale"]);
  const dispatch = useAppDispatch();
  const narrow = useNarrowViewport();

  const pickTab = (id: DashboardTab) => {
    onSelectTab(id);
    if (narrow) onCloseDrawer?.();
  };

  if (!narrow && state.railCollapsed) {
    return (
      <nav
        className="session-rail collapsed-rail"
        aria-label={t("rail.dashboard")}
      >
        <div className="rail-top-actions">
          <button
            className="rail-icon-btn"
            type="button"
            title={t("rail.expand")}
            aria-label={t("rail.expand")}
            onClick={() => {
              onToggle?.();
              void dispatch({ type: "ToggleRail" });
            }}
          >
            <Icon name="sidebar" size={18} />
          </button>
          <button
            className="rail-icon-btn"
            type="button"
            data-testid="dashboard-back"
            title={t("console.back")}
            aria-label={t("console.back")}
            onClick={() => void dispatch({ type: "CloseDashboard" })}
          >
            <Icon name="chat" size={18} />
          </button>
        </div>
        <div className="rail-bottom-actions">
          <UserCard compact />
        </div>
      </nav>
    );
  }

  const expanded = (
    <nav className="session-rail expanded-rail" aria-label={t("rail.dashboard")}>
      <div className="session-rail-header">
        <div className="rail-header-brand">
          <span className="rail-brand" translate="no">microcrab</span>
        </div>
        <div className="rail-header-tools">
          <button
            className="rail-tool-btn"
            type="button"
            title={narrow ? t("common.close") : t("rail.collapse")}
            aria-label={narrow ? t("common.close") : t("rail.collapse")}
            onClick={() => {
              if (narrow) onCloseDrawer?.();
              else {
                onToggle?.();
                void dispatch({ type: "ToggleRail" });
              }
            }}
          >
            <Icon name="sidebar" />
          </button>
        </div>
      </div>
      <div className="rail-new-chat-container">
        <button
          className="session-rail-new-btn"
          type="button"
          data-testid="dashboard-back"
          onClick={() => void dispatch({ type: "CloseDashboard" })}
        >
          <Icon name="chat" />
          <span>{t("console.back")}</span>
        </button>
      </div>
      <div className="session-rail-scroll-content">
        <div className="rail-section-group">
          <div className="rail-section-header-row">
            <span className="rail-section-title">{t("console.group.mine")}</span>
          </div>
          <div className="session-rail-subnav">
            {ITEMS.map((item) => (
              <button
                key={item.id}
                className="subnav-item-btn"
                type="button"
                data-active={currentTab === item.id}
                data-testid={`dashboard-nav-${item.id}`}
                onClick={() => pickTab(item.id)}
              >
                {item.icon}
                <span>{t(item.labelKey)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="session-rail-footer">
        <UserCard />
      </div>
    </nav>
  );

  if (narrow) {
    return drawerOpen ? (
      <>
        <div
          className="rail-drawer-backdrop"
          data-testid="dashboard-drawer-backdrop"
          aria-hidden="true"
          onClick={onCloseDrawer}
        />
        {expanded}
      </>
    ) : null;
  }

  return expanded;
}
