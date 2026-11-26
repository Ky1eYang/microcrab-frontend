export const DASHBOARD_TABS = [
  "dashboard",
  "library",
  "keys",
  "logs",
  "plugins",
  "settings",
] as const;

export type DashboardTab = (typeof DASHBOARD_TABS)[number];

export type DashboardSubTab = "overview" | "cache";

export const CONSOLE_SETTINGS_SECTIONS = [
  "providers",
  "defaults",
  "preferences",
] as const;

export type ConsoleSettingsSection = (typeof CONSOLE_SETTINGS_SECTIONS)[number];

export interface DashboardLocation {
  tab: DashboardTab;
  subTab: DashboardSubTab;
  settings: ConsoleSettingsSection;
}

const VALID_TABS = new Set<string>(DASHBOARD_TABS);
const VALID_SETTINGS = new Set<string>(CONSOLE_SETTINGS_SECTIONS);

export function parseDashboardPath(raw: string): DashboardLocation | null {
  const clean = raw.replace(/^#?\/?|\/$/g, "");
  if (clean === "dashboard" || clean === "admin" || clean === "dashboard/overview") {
    return { tab: "dashboard", subTab: "overview", settings: "providers" };
  }
  if (clean === "dashboard/cache") {
    return { tab: "dashboard", subTab: "cache", settings: "providers" };
  }
  if (!clean.startsWith("dashboard/")) return null;
  const parts = clean.slice("dashboard/".length).split("/").filter(Boolean);
  const first = parts[0] ?? "dashboard";
  if (first === "settings") {
    const sec = parts[1];
    const settings = VALID_SETTINGS.has(sec ?? "")
      ? (sec as ConsoleSettingsSection)
      : "providers";
    return { tab: "settings", subTab: "overview", settings };
  }
  if (VALID_TABS.has(first)) {
    return { tab: first as DashboardTab, subTab: "overview", settings: "providers" };
  }
  return { tab: "dashboard", subTab: "overview", settings: "providers" };
}

export function dashboardHash(
  tab: DashboardTab,
  options?: { subTab?: DashboardSubTab; settings?: ConsoleSettingsSection },
): string {
  if (tab === "dashboard") {
    return options?.subTab === "cache" ? "#/dashboard/cache" : "#/dashboard";
  }
  if (tab === "settings") {
    return `#/dashboard/settings/${options?.settings ?? "providers"}`;
  }
  return `#/dashboard/${tab}`;
}
