import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useAppFields, workspaceLabel } from "../../../state";
import type { NativeProject } from "../../../client/types";
import {
  hostLocator,
  hostPreferenceScope,
} from "../../../client/host-locators";
import { isNarrowViewport } from "../../../client/viewport";
import { t } from "../../../i18n";
import { projectHostTerminal } from "../../../state/host-readiness";
import { GlyphIcon } from "../../shared";
import { Icon } from "../../../shell/Icon";
import {
  filterProjects,
  projectAvailability,
  projectsByName,
  recentProjects,
} from "./projects";

type View = "default" | "all";

/** Grayscale highlight of every case-insensitive match. */
function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (
    let at = lower.indexOf(needle);
    at >= 0;
    at = lower.indexOf(needle, from)
  ) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + q.length)}</mark>);
    from = at + q.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

const isLoopback = (endpoint: string | null | undefined) => {
  if (!endpoint) return false;
  try {
    const host = new URL(endpoint).hostname;
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
  } catch {
    return false;
  }
};

/** P1 single-column workspace picker: pinned search, Recent (5) and an
 * "All projects (N)" list, Other workspaces and a pinned New project. */
export function WorkspacePicker() {
  const { state, dispatch } = useAppFields([
    "draftWorkspace",
    "apiBase",
    "authSession",
    "projects",
    "hostConnection",
    "sessions",
    "showWorkspaceDropdown",
    "resolvedLocale",
  ]);
  const ws = state.draftWorkspace;
  const open = state.showWorkspaceDropdown;
  const [view, setView] = useState<View>("default");
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const scope = hostPreferenceScope(state.apiBase, state.authSession);

  useEffect(() => {
    setView("default");
    setQuery("");
    if (!open) return;
    // Desktop keyboards land in search; touch keeps the on-screen keyboard shut.
    if (!isNarrowViewport()) search.current?.focus({ preventScroll: true });
  }, [open, scope, state.apiBase]);

  useEffect(() => {
    if (!open) return;
    const resize = () => {
      const element = menu.current;
      if (!element || isNarrowViewport()) return;
      const viewportBottom = window.visualViewport
        ? window.visualViewport.offsetTop + window.visualViewport.height
        : window.innerHeight;
      element.style.setProperty(
        "--picker-available-height",
        `${Math.max(160, viewportBottom - element.getBoundingClientRect().top - 16)}px`,
      );
    };
    resize();
    // The New chat stage is vertically centred, so late content (recent
    // cards, banners) moves the trigger: re-measure when the stage resizes.
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    const stage = menu.current?.closest(".home-center-stage");
    if (stage) observer?.observe(stage);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, [open]);

  const locale = state.resolvedLocale;
  const sorted = projectsByName(state.projects, locale);
  const recent = recentProjects(state.projects, state.sessions);
  const searching = query.trim().length > 0;
  const matches = searching
    ? projectsByName(filterProjects(state.projects, query), locale)
    : [];
  const fallbackList = recent.length ? recent : sorted.slice(0, 5);
  const showAllEntry =
    sorted.length > 0 && (recent.length > 0 || sorted.length > 5);

  const close = (restoreFocus = false) => {
    void dispatch({ type: "CloseDropdowns" });
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };

  const hostFallback = (project: NativeProject) => {
    if (!project.host_id) return t("home.picker.unassignedHost");
    const endpoint = hostLocator(scope, project);
    if (!endpoint || isLoopback(endpoint)) return t("home.picker.thisComputer");
    try {
      return new URL(endpoint).host;
    } catch {
      return t("home.picker.thisComputer");
    }
  };

  const renderProject = (project: NativeProject) => {
    const selected = ws.projectId === project.id;
    const availability = projectAvailability(
      project,
      state.hostConnection,
      projectHostTerminal(state, project.id),
    );
    const secondary = project.root || hostFallback(project);
    return (
      <button
        key={project.id}
        type="button"
        className="workspace-menu-item picker-row home-project-item"
        data-testid="home-project-item"
        data-picker-row=""
        data-project-id={project.id}
        data-active={selected}
        title={`${project.name}\n${secondary}`}
        onClick={() => {
          void dispatch({ type: "SelectKnownProject", value: project.id });
          close();
        }}
      >
        <Icon
          name="folder"
          size={14}
          className="ws-project-folder-icon"
          aria-hidden="true"
        />
        <span className="picker-row-text">
          <span className="ws-item-name">{highlight(project.name, query)}</span>
          <span className="picker-row-sub">{highlight(secondary, query)}</span>
        </span>
        {availability !== "online" && availability !== "unknown" && (
          <span className="picker-project-status" data-status={availability}>
            {t(`home.picker.${availability}`)}
          </span>
        )}
        {selected && (
          <span className="ws-item-check">
            <GlyphIcon name="check" size={14} />
          </span>
        )}
      </button>
    );
  };

  const otherRow = (flavor: "chat_only" | "browser_sandbox") => {
    const sandboxRow = flavor === "browser_sandbox";
    const selected = ws.kind === flavor;
    const nameId = `${titleId}-${flavor}-name`;
    const descId = `${titleId}-${flavor}-desc`;
    return (
      <div className="picker-other-row" key={flavor}>
        <button
          className="workspace-menu-item picker-row"
          type="button"
          data-testid="home-project-item"
          data-picker-row=""
          data-host-flavor={flavor}
          data-active={selected}
          aria-labelledby={nameId}
          aria-describedby={descId}
          onClick={() => {
            void dispatch({
              type: "SelectDraftWorkspace",
              value: { kind: flavor },
            });
            close();
          }}
        >
          <Icon
            name={sandboxRow ? "box" : "chat"}
            size={14}
            className="ws-project-folder-icon"
            aria-hidden="true"
          />
          <span className="picker-row-text">
            <span className="ws-item-name" id={nameId}>
              {t(
                sandboxRow
                  ? "home.picker.browserSandbox"
                  : "home.picker.chatOnly",
              )}
            </span>
            <span className="picker-row-desc" id={descId}>
              {t(
                sandboxRow
                  ? "home.picker.browserSandboxDesc"
                  : "home.picker.chatOnlyDesc",
              )}
            </span>
          </span>
          {selected && (
            <span className="ws-item-check">
              <GlyphIcon name="check" size={14} />
            </span>
          )}
        </button>
      </div>
    );
  };

  const moveFocus = (target: HTMLElement, key: "ArrowDown" | "ArrowUp") => {
    const rows = [
      ...(menu.current?.querySelectorAll<HTMLElement>(
        "[data-picker-row]:not(:disabled)",
      ) ?? []),
    ];
    if (!rows.length) return false;
    const down = key === "ArrowDown";
    if (target === search.current) {
      rows[down ? 0 : rows.length - 1].focus();
      return true;
    }
    const index = rows.indexOf(target);
    if (index < 0) return false;
    const next = index + (down ? 1 : -1);
    if (next < 0 || next >= rows.length) search.current?.focus();
    else rows[next].focus();
    return true;
  };

  return (
    <div
      className="home-workspace-selector-wrap"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        ref={trigger}
        className="home-workspace-badge-btn"
        title={`${t("home.pickWorkspace")}\n${workspaceLabel(ws)}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => void dispatch({ type: "ToggleWorkspaceDropdown" })}
      >
        <Icon
          name={
            ws.kind === "chat_only"
              ? "chat"
              : ws.kind === "browser_sandbox"
                ? "box"
                : "folder"
          }
          size={14}
          className="workspace-badge-icon"
          aria-hidden="true"
        />
        <span className="workspace-badge-text">{workspaceLabel(ws)}</span>
        <GlyphIcon
          name="chevron"
          dir="down"
          className="workspace-badge-chevron"
        />
      </button>
      {open && (
        <>
          <div
            className="picker-sheet-backdrop"
            aria-hidden="true"
            onClick={() => close(true)}
          />
          <div
            ref={menu}
            className="home-dropdown-menu workspace-dropdown-menu workspace-picker-menu"
            data-testid="home-project-picker"
            data-view={searching ? "search" : view}
            role="dialog"
            aria-labelledby={`${titleId}-title`}
            onBlur={(e) => {
              if (
                e.relatedTarget instanceof Node &&
                !e.currentTarget.parentElement?.contains(e.relatedTarget)
              )
                close();
            }}
            onKeyDown={(e) => {
              if (
                e.nativeEvent.isComposing ||
                e.altKey ||
                e.ctrlKey ||
                e.metaKey ||
                e.shiftKey
              )
                return;
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close(true);
                return;
              }
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              if (moveFocus(e.target as HTMLElement, e.key)) e.preventDefault();
            }}
          >
            <div className="picker-sheet-head">
              <span id={`${titleId}-title`}>{t("home.pickWorkspace")}</span>
              <button
                type="button"
                className="action-icon-btn picker-sheet-close"
                aria-label={t("common.close")}
                onClick={() => close(true)}
              >
                <Icon name="close" size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="picker-search">
              <Icon
                name="search"
                size={14}
                className="picker-search-icon"
                aria-hidden="true"
              />
              <input
                ref={search}
                type="search"
                className="settings-input"
                aria-label={t("home.picker.searchProjects")}
                placeholder={t("home.picker.searchProjects")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="picker-scroll" data-testid="picker-list">
              {searching ? (
                <div
                  className="workspace-menu-section"
                  data-testid="picker-search-results"
                >
                  <div className="dropdown-section-title" role="status">
                    {matches.length
                      ? t("home.picker.matchCount", { n: matches.length })
                      : t("home.picker.noMatch")}
                  </div>
                  {matches.map(renderProject)}
                </div>
              ) : view === "all" ? (
                <div
                  className="workspace-menu-section"
                  data-testid="picker-all"
                >
                  <button
                    type="button"
                    className="picker-all-head"
                    data-testid="picker-all-back"
                    data-picker-row=""
                    onClick={() => {
                      setView("default");
                      search.current?.focus({ preventScroll: true });
                    }}
                  >
                    <Icon name="arrow-left" size={14} aria-hidden="true" />
                    <span>
                      {t("home.picker.allProjectsByName")} ({sorted.length})
                    </span>
                  </button>
                  {sorted.map(renderProject)}
                </div>
              ) : (
                <>
                  {fallbackList.length > 0 && (
                    <div
                      className="workspace-menu-section"
                      data-testid="picker-recent"
                    >
                      <div className="dropdown-section-title">
                        {t(
                          recent.length
                            ? "home.picker.recent"
                            : "home.picker.allProjects",
                        )}
                      </div>
                      {fallbackList.map(renderProject)}
                    </div>
                  )}
                  {showAllEntry && (
                    <button
                      type="button"
                      className="workspace-menu-item picker-row picker-all-entry"
                      data-testid="picker-all-projects"
                      data-picker-row=""
                      onClick={() => {
                        setView("all");
                        requestAnimationFrame(() =>
                          menu.current
                            ?.querySelector<HTMLElement>(
                              '[data-testid="picker-all-back"]',
                            )
                            ?.focus({ preventScroll: true }),
                        );
                      }}
                    >
                      <span className="ws-item-name">
                        {t("home.picker.allProjects")} ({sorted.length})
                      </span>
                      <GlyphIcon
                        name="chevron"
                        className="picker-all-chevron"
                      />
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="picker-other" data-testid="picker-other-workspaces">
              <div className="dropdown-section-title">
                {t("home.picker.otherWorkspaces")}
              </div>
              {otherRow("chat_only")}
              {otherRow("browser_sandbox")}
            </div>
            <div className="picker-foot">
              <button
                className="workspace-menu-item picker-row"
                type="button"
                data-testid="picker-create-project"
                data-picker-row=""
                onClick={() => {
                  void dispatch({ type: "OpenCreateProjectDialog" });
                  close();
                }}
              >
                <Icon
                  name="plus"
                  size={14}
                  className="ws-project-folder-icon"
                  aria-hidden="true"
                />
                <span className="ws-item-name">
                  {t("home.picker.newProject")}
                </span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
