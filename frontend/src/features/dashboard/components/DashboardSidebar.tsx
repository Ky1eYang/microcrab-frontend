import type { ReactNode } from "react";
import { useApp } from "../../../state";
import { Icon } from "../../../shell/Icon";
import { UserCard } from "../../../shell/UserCard";

interface NavItem {
  id: string;
  label: string;
  icon: ReactNode;
  admin?: boolean;
}

const items: NavItem[] = [
  {
    id: "dashboard",
    label: "仪表盘",
    icon: <Icon name="dashboard" size={15} />,
  },
  {
    id: "library",
    label: "个人内容库",
    icon: <Icon name="box" size={15} />,
  },
  { id: "keys", label: "API 密钥", icon: <Icon name="key" size={15} /> },
  { id: "logs", label: "使用记录", icon: <Icon name="history" size={15} /> },
  { id: "plugins", label: "插件管理", icon: <Icon name="plugins" size={15} /> },
  { id: "settings", label: "设置", icon: <Icon name="settings" size={15} /> },
  {
    id: "ops",
    label: "运维监控",
    icon: <Icon name="activity" size={15} />,
    admin: true,
  },
  {
    id: "users",
    label: "用户管理",
    icon: <Icon name="users" size={15} />,
    admin: true,
  },
  {
    id: "groups",
    label: "分组管理",
    icon: <Icon name="layers" size={15} />,
    admin: true,
  },
  {
    id: "channels",
    label: "渠道管理",
    icon: <Icon name="globe" size={15} />,
    admin: true,
  },
  {
    id: "subscriptions",
    label: "订阅管理",
    icon: <Icon name="credit-card" size={15} />,
    admin: true,
  },
  {
    id: "accounts",
    label: "账号管理",
    icon: <Icon name="user-check" size={15} />,
    admin: true,
  },
  {
    id: "notices",
    label: "公告管理",
    icon: <Icon name="bell" size={15} />,
    admin: true,
  },
  {
    id: "ip",
    label: "IP 管理",
    icon: <Icon name="shield" size={15} />,
    admin: true,
  },
  {
    id: "redeems",
    label: "兑换码",
    icon: <Icon name="gift" size={15} />,
    admin: true,
  },
  {
    id: "coupons",
    label: "优惠码",
    icon: <Icon name="ticket" size={15} />,
    admin: true,
  },
  {
    id: "audit",
    label: "操作日志",
    icon: <Icon name="clock" size={15} />,
    admin: true,
  },
  {
    id: "system",
    label: "系统设置",
    icon: <Icon name="sliders" size={15} />,
    admin: true,
  },
];

export function DashboardSidebar({
  currentTab,
  privileged,
  onSelectTab,
  onToggle,
}: {
  currentTab: string;
  privileged: boolean;
  onSelectTab: (tabId: string) => void;
  onToggle?: () => void;
}) {
  const { state, dispatch } = useApp();
  const visible = items.filter((item) => !item.admin || privileged);
  const own = visible.filter((item) => !item.admin);
  const managed = visible.filter((item) => item.admin);
  if (state.railCollapsed)
    return (
      <nav
        className="session-rail collapsed-rail"
        aria-label="Dashboard collapsed"
      >
        <div className="rail-top-actions">
          <button
            className="rail-icon-btn"
            type="button"
            title="展开侧边栏"
            aria-label="Expand sidebar"
            onClick={() => {
              onToggle?.();
              dispatch({ type: "ToggleRail" });
            }}
          >
            <Icon name="sidebar" size={18} />
          </button>
          <button
            className="rail-icon-btn"
            type="button"
            title="返回会话"
            aria-label="Back to sessions"
            onClick={() => dispatch({ type: "Navigate", value: "" })}
          >
            <Icon name="chat" size={18} />
          </button>
        </div>
        <div className="rail-bottom-actions">
          <UserCard compact />
        </div>
      </nav>
    );
  return (
    <nav className="session-rail expanded-rail" aria-label="Dashboard">
      <div className="session-rail-header">
        <div className="rail-header-brand">
          <span className="rail-brand">microcrab</span>
        </div>
        <div className="rail-header-tools">
          <button
            className="rail-tool-btn"
            type="button"
            title="收起侧边栏"
            aria-label="Collapse sidebar"
            onClick={() => {
              onToggle?.();
              dispatch({ type: "ToggleRail" });
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
          onClick={() => dispatch({ type: "Navigate", value: "" })}
        >
          <Icon name="chat" />
          <span>返回会话</span>
        </button>
      </div>
      <div className="session-rail-scroll-content">
        <div className="rail-section-group">
          <div className="rail-section-header-row">
            <span className="rail-section-title">我的</span>
          </div>
          <NavGroup
            items={own}
            currentTab={currentTab}
            onSelectTab={onSelectTab}
          />
        </div>
        {!!managed.length && (
          <div className="rail-section-group">
            <div className="rail-section-header-row">
              <span className="rail-section-title">管理</span>
            </div>
            <NavGroup
              items={managed}
              currentTab={currentTab}
              onSelectTab={onSelectTab}
            />
          </div>
        )}
      </div>
      <div className="session-rail-footer">
        <UserCard />
      </div>
    </nav>
  );
}

function NavGroup({
  items,
  currentTab,
  onSelectTab,
}: {
  items: NavItem[];
  currentTab: string;
  onSelectTab: (tabId: string) => void;
}) {
  return (
    <div className="session-rail-subnav">
      {items.map((item) => (
        <button
          key={item.id}
          className="subnav-item-btn"
          type="button"
          data-active={currentTab === item.id}
          onClick={() => onSelectTab(item.id)}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
