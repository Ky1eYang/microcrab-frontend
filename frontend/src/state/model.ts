import type {
  AppState,
  ModelChoice,
  NativeModelCatalog,
  DraftWorkspace,
  SessionView,
} from "../client/types";
import { createTranscript } from "../client/projector";
import { resolveApiBase } from "../client/api";
import * as storage from "../client/storage";
import { normalizeThemePreference, resolveTheme } from "../client/theme";
import { normalizeLocalePreference, syncLocaleFromPreference } from "../i18n";
export function initialState(): AppState {
  return {
    connection: "disconnected",
    page: "home",
    sessionId: null,
    sessionAttachingId: null,
    sessions: [],
    filter: "",
    transcript: createTranscript(),
    composer: "",
    composerImages: [],
    statistics: null,
    roundLimitRequests: [],
    imageIntakePending: false,
    modeSelectionPending: false,
    compactOperation: null,
    toast: null,
    popup: { type: "none" },
    menuSession: null,
    theme: normalizeThemePreference(storage.preference("theme")),
    resolvedTheme: resolveTheme(
      normalizeThemePreference(storage.preference("theme")),
    ),
    locale: normalizeLocalePreference(storage.preference("locale", "zh-CN")),
    resolvedLocale: (() => {
      const preference = normalizeLocalePreference(
        storage.preference("locale", "zh-CN"),
      );
      return syncLocaleFromPreference(preference);
    })(),
    compactInflight: false,
    railCollapsed: storage.preference("railCollapsed") === "true",
    rightRailCollapsed:
      storage.preference("rightRailCollapsed", "true") !== "false",
    rightOverlayOpen: false,
    rightRailWidth: Math.max(
      240,
      Math.min(2000, Number(storage.preference("rightRailWidth", 320)) || 320),
    ),
    conversationWidth: Math.max(
      640,
      Math.min(
        1400,
        Number(storage.preference("conversationWidth", 820)) || 820,
      ),
    ),
    apiBase: resolveApiBase(),
    sandboxSession: null,
    currentWorkspace: "",
    draftWorkspace: { kind: "none" },
    draftModel: null,
    modelSelectionPending: false,
    availableModels: [],
    board: {
      role: "",
      name: "",
      prefix: "",
      keyId: "",
      version: "",
      note: "",
      keys: [],
      status: null,
      sessions: [],
      audit: [],
      revealed: null,
    },
    showWorkspaceDropdown: false,
    menuProject: null,
    isCreatingSession: false,
    viewMode: "chat",
    showRunningToolsMenu: false,
    showSubagentsMenu: false,
    toastSeq: 0,
    knownProjects: [],
    conversationIds: [],
    capabilities: null,
    agents: [],
    projects: [],
    draftAgent: "",
    draftMode: "plan",
    policy: null,
    history: null,
  };
}
export function modelChoices(catalog: NativeModelCatalog): ModelChoice[] {
  return catalog.items.map((model) => ({
    id: model.id,
    name: model.name,
    providerId: model.provider_id,
    protocol: model.protocol,
    variants: model.variants,
    contextWindowTokens:
      typeof model.context_window_tokens === "number" &&
      Number.isSafeInteger(model.context_window_tokens) &&
      model.context_window_tokens > 0
        ? model.context_window_tokens
        : null,
  }));
}

export function selectedModel(state: AppState): ModelChoice | null {
  if (!state.sessionId)
    return state.draftModel ?? state.availableModels[0] ?? null;
  const selected =
    state.sessions.find((s) => s.id === state.sessionId)?.model ??
    state.transcript.model;
  if (!selected) return null;
  const catalog = state.availableModels.find(
    (m) =>
      m.id === selected.id &&
      (!selected.providerId || m.providerId === selected.providerId),
  );
  return {
    id: selected.id,
    name: catalog?.name ?? selected.id,
    providerId: selected.providerId ?? catalog?.providerId ?? "",
    protocol: catalog?.protocol,
    contextWindowTokens: catalog?.contextWindowTokens ?? null,
    variants: catalog?.variants ?? [],
    variant: selected.variant ?? null,
  };
}
export function workspaceLabel(w: DraftWorkspace) {
  return w.kind === "none"
    ? "No Project"
    : w.label?.trim() ||
        w.path?.split(/[\\/]/).filter(Boolean).at(-1) ||
        w.host ||
        "Project";
}
export function sessionActiveTime(session?: SessionView | null): number {
  if (!session) return 0;
  return Math.max(
    session.lastActiveAt ?? 0,
    session.time?.updated ?? 0,
    session.time?.created ?? 0,
  );
}

export function visibleSessions(value: AppState | SessionView[], filter = "") {
  const sessions = Array.isArray(value) ? value : value.sessions;
  const q = (Array.isArray(value) ? filter : value.filter).toLowerCase();
  return sessions
    .filter(
      (s) =>
        !s.parentID &&
        (!q ||
          `${s.title} ${s.id} ${s.directory ?? ""}`.toLowerCase().includes(q)),
    )
    .sort((a, b) => sessionActiveTime(b) - sessionActiveTime(a));
}
export function activeSession(state: AppState) {
  return state.sessions.find((s) => s.id === state.sessionId);
}
export function isBusy(state: AppState) {
  return (
    state.compactInflight ||
    state.isCreatingSession ||
    state.transcript.sessionStatus === "busy"
  );
}
export interface AppRoute {
  page: string;
  sessionId: string | null;
  parentId?: string | null;
  pluginId?: string | null;
}
const decodeSegment = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
export function sessionPath(id: string, parentId?: string | null) {
  const child = parentId
    ? `${encodeURIComponent(parentId)}/sub/${encodeURIComponent(id)}`
    : encodeURIComponent(id);
  return `session/${child}`;
}
export function parseLocation(pathname: string, hash: string): AppRoute {
  const clean = (s: string) => s.replace(/^#?\/?|\/$/g, "");
  const pathPart = clean(pathname);
  const hashPart = clean(hash);
  if (
    pathPart === "dashboard" ||
    hashPart === "dashboard" ||
    pathPart === "admin" ||
    hashPart === "admin"
  ) {
    return { page: "dashboard", sessionId: null };
  }
  const path = hashPart || pathPart;
  const plugin = /^(?:session\/([^/]+)\/)?plugins(?:\/([^/]+))?$/.exec(path);
  if (plugin)
    return {
      page: plugin[2] ? "plugin" : "plugins",
      sessionId: plugin[1] ? decodeSegment(plugin[1]) : null,
      pluginId: plugin[2] ? decodeSegment(plugin[2]) : null,
    };
  const nested =
    /^(?:session|s)\/([^/]+)\/sub\/([^/]+)$/.exec(path) ??
    /^(?:session|s)\/(main_[^/]+)\/(sub_[^/]+)$/.exec(path);
  if (nested)
    return {
      page: "conversation",
      sessionId: decodeSegment(nested[2]),
      parentId: decodeSegment(nested[1]),
    };
  const match = /^(?:session|s)\/([^/]+)$/.exec(path);
  return match
    ? { page: "conversation", sessionId: decodeSegment(match[1]) }
    : { page: "home", sessionId: null };
}
