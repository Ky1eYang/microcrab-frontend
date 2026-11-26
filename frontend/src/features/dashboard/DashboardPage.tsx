import React, { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import type {
  ConsoleSettingsSection,
  DashboardSubTab,
  DashboardTab,
} from "../../client/dashboard-route";
import { useNarrowViewport } from "../../client/viewport";
import { t } from "../../i18n";
import { Icon } from "../../shell/Icon";
import { useAppFields, useAppStore } from "../../state";
import { DashboardSidebar } from "./components/DashboardSidebar";

const OverviewTab = lazy(() =>
  import("./views/OverviewTab").then((m) => ({ default: m.OverviewTab })),
);
const CacheTab = lazy(() =>
  import("./views/CacheTab").then((m) => ({ default: m.CacheTab })),
);
const PersonalLibraryView = lazy(() =>
  import("./views/PersonalLibraryView").then((m) => ({
    default: m.PersonalLibraryView,
  })),
);
const ApiKeysView = lazy(() =>
  import("./views/ApiKeysView").then((m) => ({ default: m.ApiKeysView })),
);
const UsageLogsView = lazy(() =>
  import("./views/UsageLogsView").then((m) => ({ default: m.UsageLogsView })),
);
const PluginsView = lazy(() =>
  import("./views/PluginsView").then((m) => ({ default: m.PluginsView })),
);
const ConsoleSettingsView = lazy(() =>
  import("./views/ConsoleSettingsView").then((m) => ({
    default: m.ConsoleSettingsView,
  })),
);

export const DashboardPage: React.FC = () => {
  const { state, dispatch } = useAppFields([
    "dashboardTab",
    "dashboardSubTab",
    "consoleSettingsSection",
    "resolvedLocale",
    "authSession",
  ]);
  const store = useAppStore();
  const tab: DashboardTab = state.dashboardTab ?? "dashboard";
  const subTab: DashboardSubTab = state.dashboardSubTab ?? "overview";
  const settingsSection: ConsoleSettingsSection =
    state.consoleSettingsSection ?? "providers";

  const [animating, setAnimating] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrowViewport();

  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [tab, subTab, settingsSection]);

  const owner = state.authSession?.authenticated
    ? state.authSession.principal?.owner
    : undefined;

  const navigateDashboard = (next: {
    tab: DashboardTab;
    subTab?: DashboardSubTab;
    settings?: ConsoleSettingsSection;
  }) => {
    void dispatch({ type: "OpenDashboard", value: next });
  };

  const getTabTitle = () => {
    if (tab === "dashboard") return t("console.title.dashboard");
    return t(`console.nav.${tab}`);
  };

  const renderContent = () => {
    if (tab === "dashboard") {
      if (!owner) {
        return (
          <div className="sb-view-container">
            <div className="sb-card p-6 text-xs text-neutral-400" role="status">
              {t("usage.authRequired")}
            </div>
          </div>
        );
      }
      return subTab === "overview" ? (
        <OverviewTab owner={owner} api={store.api} refreshSignal={refreshTick} />
      ) : (
        <CacheTab owner={owner} api={store.api} refreshSignal={refreshTick} />
      );
    }
    if (tab === "library") {
      return <PersonalLibraryView refreshSignal={refreshTick} />;
    }
    if (tab === "keys") {
      return owner ? (
        <ApiKeysView owner={owner} refreshSignal={refreshTick} />
      ) : (
        <div className="sb-view-container">
          <div className="sb-card p-6 text-xs text-neutral-400" role="status">
            {t("usage.authRequired")}
          </div>
        </div>
      );
    }
    if (tab === "logs") {
      return owner ? (
        <UsageLogsView owner={owner} api={store.api} refreshSignal={refreshTick} />
      ) : (
        <div className="sb-view-container">
          <div className="sb-card p-6 text-xs text-neutral-400" role="status">
            {t("usage.authRequired")}
          </div>
        </div>
      );
    }
    if (tab === "plugins") {
      return <PluginsView />;
    }
    return (
      <ConsoleSettingsView
        section={settingsSection}
        onSelectSection={(sec) =>
          navigateDashboard({ tab: "settings", settings: sec })
        }
      />
    );
  };

  return (
    <div
      className="sb-dashboard-root sb-dash sb-dashboard-board board"
      data-testid="dashboard"
      data-animating={animating || undefined}
    >
      <DashboardSidebar
        currentTab={tab}
        onSelectTab={(nextTab) => navigateDashboard({ tab: nextTab })}
        onToggle={() => {
          setAnimating(true);
          window.setTimeout(() => setAnimating(false), 220);
        }}
        drawerOpen={drawerOpen}
        onCloseDrawer={() => setDrawerOpen(false)}
      />

      <div className="sb-dashboard-main">
        <header className="sb-dashboard-header">
          <div className="sb-dashboard-subbar">
            <div className="flex items-center gap-2 min-w-0">
              {narrow && (
                <button
                  type="button"
                  className="sb-btn sb-btn-ghost sb-btn-sm"
                  data-testid="header-open-rail"
                  aria-label={t("rail.expand")}
                  aria-expanded={drawerOpen}
                  onClick={() => setDrawerOpen((prev) => !prev)}
                >
                  <Icon name="menu" size={16} aria-hidden="true" />
                </button>
              )}
              <h1 id="console-heading" className="sb-dashboard-title" tabIndex={-1}>
                {getTabTitle()}
              </h1>
            </div>
            <div className="sb-dashboard-actions">
              <button
                type="button"
                className="sb-btn sb-btn-ghost sb-btn-sm"
                data-testid="dashboard-refresh"
                onClick={() => setRefreshTick((n) => n + 1)}
                title={t("console.refresh")}
              >
                <svg
                  className="w-3.5 h-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M23 4v6h-6M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                <span>{t("console.refresh")}</span>
              </button>
            </div>
          </div>
          {tab === "dashboard" && (
            <div className="sb-dashboard-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={subTab === "overview"}
                className={subTab === "overview" ? "active" : undefined}
                onClick={() =>
                  navigateDashboard({ tab: "dashboard", subTab: "overview" })
                }
              >
                {t("console.subtab.overview")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={subTab === "cache"}
                className={subTab === "cache" ? "active" : undefined}
                onClick={() =>
                  navigateDashboard({ tab: "dashboard", subTab: "cache" })
                }
              >
                {t("console.subtab.cache")}
              </button>
            </div>
          )}
        </header>

        <div ref={contentRef} className="sb-dashboard-content">
          <Suspense
            fallback={
              <div className="sb-view-container">
                <div className="sb-card p-6 text-xs text-neutral-400" role="status">
                  {t("console.loading")}
                </div>
              </div>
            }
          >
            {renderContent()}
          </Suspense>
        </div>
      </div>
    </div>
  );
};
