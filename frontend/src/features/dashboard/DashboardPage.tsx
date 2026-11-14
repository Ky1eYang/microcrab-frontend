import React, { lazy, Suspense, useState } from "react";
import { unsupported } from "../../client/unsupported";
import { useApp } from "../../state";
import { DashboardSidebar } from "./components/DashboardSidebar";

const OverviewTab = lazy(() =>
  import("./views/OverviewTab").then((m) => ({ default: m.OverviewTab })),
);
const CacheTab = lazy(() =>
  import("./views/CacheTab").then((m) => ({ default: m.CacheTab })),
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
const OpsMonitoringView = lazy(() =>
  import("./views/admin/OpsMonitoringView").then((m) => ({
    default: m.OpsMonitoringView,
  })),
);
const UserManagementView = lazy(() =>
  import("./views/admin/UserManagementView").then((m) => ({
    default: m.UserManagementView,
  })),
);
const ChannelManagementView = lazy(() =>
  import("./views/admin/ChannelManagementView").then((m) => ({
    default: m.ChannelManagementView,
  })),
);
const NoticeManagementView = lazy(() =>
  import("./views/admin/NoticeManagementView").then((m) => ({
    default: m.NoticeManagementView,
  })),
);
const IpManagementView = lazy(() =>
  import("./views/admin/IpManagementView").then((m) => ({
    default: m.IpManagementView,
  })),
);
const AuditLogView = lazy(() =>
  import("./views/admin/AuditLogView").then((m) => ({
    default: m.AuditLogView,
  })),
);
const SystemSettingsView = lazy(() =>
  import("./views/admin/SystemSettingsView").then((m) => ({
    default: m.SystemSettingsView,
  })),
);
const AccountManagementView = lazy(() =>
  import("./views/admin/AccountManagementView").then((m) => ({
    default: m.AccountManagementView,
  })),
);
const CouponView = lazy(() =>
  import("./views/admin/CouponView").then((m) => ({ default: m.CouponView })),
);
const GroupManagementView = lazy(() =>
  import("./views/admin/GroupManagementView").then((m) => ({
    default: m.GroupManagementView,
  })),
);
const RedeemCodeView = lazy(() =>
  import("./views/admin/RedeemCodeView").then((m) => ({
    default: m.RedeemCodeView,
  })),
);
const SubscriptionView = lazy(() =>
  import("./views/admin/SubscriptionView").then((m) => ({
    default: m.SubscriptionView,
  })),
);

export const DashboardPage: React.FC = () => {
  const { state, dispatch } = useApp();
  const board = state.board;

  // Determine user role and default perspective
  const role = board.role || "user";
  const privileged = role === "admin" || role === "super_admin";
  const [tab, setTab] = useState("dashboard");
  const [dashboardSubTab, setDashboardSubTab] = useState<"overview" | "cache">(
    "overview",
  );
  const [animating, setAnimating] = useState(false);

  const reportUnsupported = (operation: string) => {
    try {
      // TODO: Load real dashboard metrics through native management commands.
      unsupported(operation);
    } catch (error) {
      void dispatch({
        type: "ShowToast",
        text: error instanceof Error ? error.message : String(error),
        kind: "warn",
      });
    }
  };

  const renderContent = () => {
    if (privileged) {
      if (tab === "ops") return <OpsMonitoringView />;
      if (tab === "users") return <UserManagementView />;
      if (tab === "groups") return <GroupManagementView />;
      if (tab === "channels") return <ChannelManagementView />;
      if (tab === "subscriptions") return <SubscriptionView />;
      if (tab === "accounts") return <AccountManagementView />;
      if (tab === "notices") return <NoticeManagementView />;
      if (tab === "ip") return <IpManagementView />;
      if (tab === "redeems") return <RedeemCodeView />;
      if (tab === "coupons") return <CouponView />;
      if (tab === "audit") return <AuditLogView />;
      if (tab === "system") return <SystemSettingsView />;
    }
    switch (tab) {
      case "dashboard":
        return dashboardSubTab === "overview" ? <OverviewTab /> : <CacheTab />;
      case "keys":
        return <ApiKeysView />;
      case "logs":
        return <UsageLogsView />;
      case "plugins":
        return <PluginsView />;
      case "settings":
        return (
          <div className="sb-view-container space-y-4">
            <div className="sb-card p-4">
              <h2 className="text-xs font-semibold text-neutral-200">
                个人设置 (Account & Preferences)
              </h2>
              <p className="text-[11px] text-neutral-500 mt-0.5">
                查看当前账号绑定信息、默认路由端点及缓存预警
              </p>
            </div>
            <div className="sb-card p-4 space-y-3 text-xs">
              <div className="sb-terminal-box p-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-dash-soft text-neutral-200 flex items-center justify-center text-xs font-bold font-mono">
                    {board.name
                      ? board.name.substring(0, 2).toUpperCase()
                      : "ME"}
                  </div>
                  <div>
                    <div className="text-white font-medium font-mono">
                      {state.authSession?.principal?.display_name || "未登录"} (
                      {"示例账号区域"})
                    </div>
                    <div className="text-[11px] text-neutral-500 mt-0.5">
                      角色权限:{" "}
                      <span className="text-emerald-400 font-mono">
                        {board.role || "user"}
                      </span>
                    </div>
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 font-mono text-[10px]">
                  示例
                </span>
              </div>

              <div className="space-y-2.5 pt-1">
                <div className="flex items-center justify-between py-1.5 border-b border-dash-line">
                  <div>
                    <div className="text-neutral-200">中转服务端点</div>
                    <div className="text-neutral-500 text-[11px] font-mono">
                      {state.apiBase}
                    </div>
                  </div>
                  <span className="text-emerald-400 font-mono text-[11px]">
                    {state.connection}
                  </span>
                </div>

                <div className="flex items-center justify-between py-1.5 border-b border-dash-line">
                  <div>
                    <div className="text-neutral-200">低缓存命中率告警阈值</div>
                    <div className="text-neutral-500 text-[11px]">
                      单日缓存命中率低于 60% 时自动标记告警
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={false}
                    readOnly
                    className="accent-ink w-4 h-4 cursor-pointer"
                  />
                </div>

                <div className="flex items-center justify-between py-1.5">
                  <span className="text-neutral-400">系统内核版本</span>
                  <span className="font-mono text-neutral-300 bg-dash-terminal px-2 py-0.5 rounded border border-dash-line">
                    {board.version || "服务端未提供"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        );
      default:
        return <OverviewTab />;
    }
  };

  // Get active tab title label for the sub-header
  const getTabTitle = () => {
    if (tab === "dashboard") return "用量与缓存仪表盘";
    const titleMap: Record<string, string> = {
      ops: "运维监控",
      users: "用户管理",
      groups: "分组管理",
      channels: "渠道管理",
      subscriptions: "订阅管理",
      accounts: "账号管理",
      notices: "公告管理",
      ip: "IP 管理",
      redeems: "兑换码",
      coupons: "优惠码",
      logs: "使用记录",
      audit: "操作日志",
      settings: "设置",
      system: "系统设置",
      keys: "API 密钥",
      plugins: "插件管理",
    };
    return titleMap[tab] || "控制台";
  };

  return (
    <div
      className="sb-dashboard-root sb-dash sb-dashboard-board board"
      data-animating={animating || undefined}
    >
      {/* Sidebar Rail */}
      <DashboardSidebar
        currentTab={tab}
        privileged={privileged}
        onSelectTab={setTab}
        onToggle={() => {
          setAnimating(true);
          window.setTimeout(() => setAnimating(false), 220);
        }}
      />

      {/* Main Workspace Body */}
      <div className="sb-dashboard-main">
        <header className="sb-dashboard-header">
          <div className="sb-dashboard-subbar">
            <h1 aria-label="看板" className="sb-dashboard-title">
              {getTabTitle()}
            </h1>
            <div className="sb-dashboard-actions">
              {privileged && (
                <span>
                  工作区{" "}
                  {board.status?.workspaceRoot || board.status?.workspace || ""}
                </span>
              )}
              <button
                type="button"
                className="sb-btn sb-btn-ghost sb-btn-sm"
                onClick={() => reportUnsupported("刷新仪表盘统计数据")}
                title="刷新数据"
              >
                <svg
                  className="w-3.5 h-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M23 4v6h-6M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                <span>刷新</span>
              </button>
            </div>
          </div>
          {tab === "dashboard" && (
            <div className="sb-dashboard-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={dashboardSubTab === "overview"}
                className={
                  dashboardSubTab === "overview" ? "active" : undefined
                }
                onClick={() => setDashboardSubTab("overview")}
              >
                概况
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={dashboardSubTab === "cache"}
                className={dashboardSubTab === "cache" ? "active" : undefined}
                onClick={() => setDashboardSubTab("cache")}
              >
                缓存命中率
              </button>
            </div>
          )}
        </header>

        {/* View Content Area */}
        <div
          className="sb-dashboard-content"
          onClickCapture={(event) => {
            // TODO: Replace mock management mutations with native commands per view.
            const target = event.target;
            if (!(target instanceof Element)) return;
            const button = target.closest("button");
            const label = button?.textContent?.trim() || "切换启用状态";
            const mutation =
              target.closest('.sb-switch, input[type="checkbox"]') ||
              button?.matches(".sb-modal-footer .sb-btn-primary") ||
              (button &&
                /保存|安装并启用|立即发布|立即生成|删除|解绑|测速|启用中|已封禁|生效中|已停用|创建.*密钥|吊销|撤销/.test(
                  label,
                )) ||
              (tab === "redeems" && button && /复制/.test(label));
            if (mutation) {
              event.preventDefault();
              event.stopPropagation();
              reportUnsupported(`${getTabTitle()}：${label}`);
            }
          }}
          onChangeCapture={(event) => {
            if (tab === "users" && event.target instanceof HTMLSelectElement) {
              event.preventDefault();
              event.stopPropagation();
              reportUnsupported("修改用户角色");
            }
          }}
          onSubmitCapture={(event) => {
            event.preventDefault();
            event.stopPropagation();
            reportUnsupported(`${getTabTitle()}：提交配置`);
          }}
        >
          <div
            className="settings-feedback-banner"
            role="status"
            data-testid="dashboard-unsupported-notice"
          >
            示例界面：统计、图表、账单、密钥、插件及管理列表为原版演示数据，不代表当前服务的真实状态。
            [unsupported] TODO(dashboard
            APIs)：当前服务尚未提供这些管理接口；修改操作会返回未支持错误。
          </div>
          <Suspense fallback={null}>{renderContent()}</Suspense>
        </div>
      </div>
    </div>
  );
};
