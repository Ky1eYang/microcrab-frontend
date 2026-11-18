import { useEffect, useId, useRef, useState } from "react";
import { useAppFields, workspaceLabel } from "../../../state";
import type { NativeProject } from "../../../client/types";
import {
  hostLocator,
  hostPreferenceScope,
} from "../../../client/host-locators";
import { t } from "../../../i18n";
import { projectHostTerminal } from "../../../state/host-readiness";
import { GlyphIcon, Icon } from "../../shared";
import {
  filterProjects,
  hostGroups,
  projectAvailability,
  recentProjects,
} from "./projects";

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
  // Empty string is a valid unassigned Host identity; only null closes the pane.
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  const [queries, setQueries] = useState<Record<string, string>>({});
  const hostTriggers = useRef(new Map<string, HTMLButtonElement>());
  const search = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const hostIdPrefix = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!state.showWorkspaceDropdown) return;
    const resize = () => {
      const element = menu.current;
      if (!element) return;
      const viewportBottom = window.visualViewport
        ? window.visualViewport.offsetTop + window.visualViewport.height
        : window.innerHeight;
      element.style.setProperty(
        "--picker-available-height",
        `${Math.max(80, viewportBottom - element.getBoundingClientRect().top - 16)}px`,
      );
    };
    resize();
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, [state.showWorkspaceDropdown, activeHostId]);
  const scope = hostPreferenceScope(state.apiBase, state.authSession);
  const groups = hostGroups(state.projects, (p) => hostLocator(scope, p));
  const recent = recentProjects(state.projects, state.sessions);
  const activeGroup =
    activeHostId !== null
      ? (groups.find((group) => group.id === activeHostId) ?? null)
      : null;
  const queryFor = (id: string) =>
    Object.prototype.hasOwnProperty.call(queries, id)
      ? (queries[id] ?? "")
      : "";
  const flyoutQuery = activeGroup ? queryFor(activeGroup.id) : "";
  const filteredProjects = activeGroup
    ? filterProjects(activeGroup.projects, flyoutQuery)
    : [];

  useEffect(() => {
    setActiveHostId(null);
    setQueries({});
    pendingFocus.current = null;
  }, [state.showWorkspaceDropdown, scope]);

  useEffect(() => {
    if (activeGroup && pendingFocus.current === activeGroup.id) {
      pendingFocus.current = null;
      search.current?.focus({ preventScroll: true });
      search.current?.scrollIntoView({ block: "nearest" });
    }
  }, [activeGroup?.id]);

  const close = () => {
    void dispatch({ type: "CloseDropdowns" });
  };
  const activateHost = (id: string) => {
    // Hover previews never move focus. Click, tap and keyboard deliberately enter
    // the search pane, including a click on an already-hovered Host.
    if (activeHostId === id) {
      search.current?.focus({ preventScroll: true });
      search.current?.scrollIntoView({ block: "nearest" });
    } else {
      pendingFocus.current = id;
      setActiveHostId(id);
    }
  };
  const closePane = () => {
    if (activeHostId === null) return;
    pendingFocus.current = null;
    const host = hostTriggers.current.get(activeHostId);
    setActiveHostId(null);
    host?.focus({ preventScroll: true });
    host?.scrollIntoView({ block: "nearest" });
  };

  const renderProject = (project: NativeProject) => {
    const selected = ws.projectId === project.id;
    const availability = projectAvailability(project, state.hostConnection, projectHostTerminal(state, project.id));
    return (
      <button
        key={project.id}
        type="button"
        className="workspace-menu-item text-only home-project-item"
        data-testid="home-project-item"
        data-project-id={project.id}
        data-active={selected}
        title={project.root}
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
        <span className="ws-item-name">{project.name}</span>
        {availability !== "online" && (
          <span className="picker-project-status" data-status={availability}>
            <Icon
              name={availability === "unknown" ? "info" : "warning"}
              aria-hidden="true"
            />
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

  return (
    <div
      className="home-workspace-selector-wrap"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        ref={trigger}
        className="home-workspace-badge-btn"
        title={t("home.pickWorkspace")}
        aria-haspopup="dialog"
        aria-expanded={state.showWorkspaceDropdown}
        onClick={() => void dispatch({ type: "ToggleWorkspaceDropdown" })}
      >
        <span className="workspace-badge-text">{workspaceLabel(ws)}</span>
        <GlyphIcon
          name="chevron"
          dir="down"
          className="workspace-badge-chevron"
        />
      </button>
      {state.showWorkspaceDropdown && (
        <div
          ref={menu}
          className="home-dropdown-menu workspace-dropdown-menu workspace-cascading-menu"
          data-testid="home-project-picker"
          role="dialog"
          aria-label={t("home.pickWorkspace")}
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
            const target = e.target as HTMLElement;
            const pane = target.closest<HTMLElement>("[data-picker-pane]");
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              if (activeHostId !== null) closePane();
              else {
                close();
                trigger.current?.focus({ preventScroll: true });
              }
              return;
            }
            if (
              e.key === "ArrowRight" &&
              target instanceof HTMLButtonElement &&
              target.dataset.hostId !== undefined
            ) {
              e.preventDefault();
              activateHost(target.dataset.hostId);
              return;
            }
            if (
              e.key === "ArrowLeft" &&
              pane?.dataset.pickerPane === "projects" &&
              !(target instanceof HTMLInputElement)
            ) {
              e.preventDefault();
              closePane();
              return;
            }
            if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
            if (target instanceof HTMLInputElement) {
              const results = pane?.querySelectorAll<HTMLButtonElement>(
                "button[data-project-id]:not(:disabled)",
              );
              if (!results?.length) return;
              e.preventDefault();
              results[e.key === "ArrowDown" ? 0 : results.length - 1].focus();
              return;
            }
            if (
              target.isContentEditable ||
              target instanceof HTMLTextAreaElement
            )
              return;
            const buttons = [
              ...(pane?.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ) ?? []),
            ];
            if (!buttons.length) return;
            e.preventDefault();
            const index = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              index < 0
                ? e.key === "ArrowDown"
                  ? 0
                  : buttons.length - 1
                : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                  buttons.length;
            buttons[next]?.focus();
          }}
        >
          <div className="workspace-primary-pane" data-picker-pane="hosts">
            {recent.length > 0 && (
              <div
                className="workspace-menu-section"
                data-testid="picker-recent"
              >
                <div className="dropdown-section-title">
                  {t("home.picker.recent")}
                </div>
                {recent.map(renderProject)}
              </div>
            )}
            {recent.length > 0 && groups.length > 0 && (
              <div className="dropdown-divider" />
            )}
            {groups.length > 0 && (
              <div
                className="workspace-menu-section"
                data-testid="picker-hosts"
              >
                <div className="dropdown-section-title">
                  {t("home.picker.hostSection")}
                </div>
                {groups.map((group) => {
                  const isExpanded = activeHostId === group.id;
                  return (
                    <div
                      key={group.id}
                      className="workspace-host-group"
                      data-picker-host={group.id}
                      onPointerEnter={(e) => {
                        if (e.pointerType !== "mouse") return;
                        // Do not unmount a focused search/results pane during passive
                        // pointer travel. Deliberate click/keyboard can always switch.
                        if (
                          document.activeElement?.closest(
                            '[data-picker-pane="projects"]',
                          )
                        )
                          return;
                        pendingFocus.current = null;
                        setActiveHostId(group.id);
                      }}
                    >
                      <button
                        ref={(node) => {
                          if (node) hostTriggers.current.set(group.id, node);
                          else hostTriggers.current.delete(group.id);
                        }}
                        type="button"
                        className="workspace-host-toggle"
                        data-host-id={group.id}
                        data-active={isExpanded}
                        aria-expanded={isExpanded}
                        aria-controls={`${hostIdPrefix}-${encodeURIComponent(group.id)}`}
                        onClick={() => activateHost(group.id)}
                      >
                        <Icon
                          name="folder"
                          size={14}
                          className="ws-host-folder-icon"
                          aria-hidden="true"
                        />
                        <span className="ws-item-name">
                          {group.label || t("home.picker.unassignedHost")}
                        </span>
                        <GlyphIcon
                          name="chevron"
                          className={
                            isExpanded
                              ? "ws-host-chevron expanded"
                              : "ws-host-chevron"
                          }
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="dropdown-divider" />
            <button
              className="workspace-menu-item text-only"
              type="button"
              data-testid="picker-create-project"
              onClick={() => {
                void dispatch({ type: "OpenCreateProjectDialog" });
                close();
              }}
            >
              <span className="ws-item-name">
                {t("home.picker.newProject")}
              </span>
            </button>
            <div className="dropdown-divider" />
            {(["chat_only", "browser_sandbox"] as const).map((flavor) => (
              <button
                className="workspace-menu-item text-only"
                type="button"
                data-testid="home-project-item"
                key={flavor}
                data-host-flavor={flavor}
                title={t(
                  flavor === "chat_only"
                    ? "home.picker.chatOnlyDesc"
                    : "home.picker.browserSandboxDesc",
                )}
                data-active={ws.kind === flavor}
                onClick={() => {
                  void dispatch({
                    type: "SelectDraftWorkspace",
                    value: { kind: flavor },
                  });
                  close();
                }}
              >
                <span className="ws-item-name">
                  {t(
                    flavor === "chat_only"
                      ? "home.picker.chatOnly"
                      : "home.picker.browserSandbox",
                  )}
                </span>
                {ws.kind === flavor && (
                  <span className="ws-item-check">
                    <GlyphIcon name="check" size={14} />
                  </span>
                )}
              </button>
            ))}
          </div>
          {activeGroup && (
            <div
              className="workspace-host-projects workspace-host-submenu workspace-flyout-pane"
              key={activeGroup.id}
              id={`${hostIdPrefix}-${encodeURIComponent(activeGroup.id)}`}
              data-testid="picker-host-submenu"
              data-picker-pane="projects"
              role="group"
              aria-label={activeGroup.label || t("home.picker.unassignedHost")}
            >
              <div className="workspace-flyout-search">
                <input
                  ref={search}
                  type="search"
                  className="settings-input"
                  aria-label={t("home.picker.searchProjects")}
                  placeholder={t("home.picker.searchProjects")}
                  value={flyoutQuery}
                  onChange={(event) =>
                    setQueries((previous) => ({
                      ...previous,
                      [activeGroup.id]: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="workspace-project-list">
                {filteredProjects.map(renderProject)}
                {!filteredProjects.length && (
                  <p className="workspace-flyout-empty" role="status">
                    {t("home.picker.noMatch")}
                  </p>
                )}
              </div>
              <div className="workspace-flyout-foot">
                <span className="ws-item-name">
                  {activeGroup.label || t("home.picker.unassignedHost")}
                </span>
                <span>
                  {filteredProjects.length}/{activeGroup.projects.length}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
