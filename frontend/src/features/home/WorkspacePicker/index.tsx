import { useEffect, useId, useRef, useState } from "react";
import { useAppFields, workspaceLabel } from "../../../state";
import type { NativeProject } from "../../../client/types";
import {
  hostLocator,
  hostPreferenceScope,
} from "../../../client/host-locators";
import { t } from "../../../i18n";
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
  const [expandedHosts, setExpandedHosts] = useState<Set<string>>(new Set());
  const [queries, setQueries] = useState<Record<string, string>>({});
  const hostTriggers = useRef(new Map<string, HTMLButtonElement>());
  const lastHost = useRef<string | null>(null);
  const hostIdPrefix = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const scope = hostPreferenceScope(state.apiBase, state.authSession);
  const groups = hostGroups(state.projects, (p) => hostLocator(scope, p));
  const recent = recentProjects(state.projects, state.sessions);

  useEffect(() => {
    if (!state.showWorkspaceDropdown) {
      setExpandedHosts(new Set());
      setQueries({});
      lastHost.current = null;
    }
  }, [state.showWorkspaceDropdown]);

  const close = () => {
    void dispatch({ type: "CloseDropdowns" });
  };

  const toggleHost = (hostId: string) => {
    lastHost.current = hostId;
    setExpandedHosts((prev) => {
      const next = new Set(prev);
      if (next.has(hostId)) {
        next.delete(hostId);
      } else {
        next.add(hostId);
      }
      return next;
    });
  };

  const renderProject = (project: NativeProject) => {
    const selected = ws.projectId === project.id;
    const availability = projectAvailability(project, state.hostConnection);
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
        <span className="ws-item-name">{project.name}</span>
        <span className="picker-project-status" data-status={availability}>
          <Icon
            name={
              availability === "online"
                ? "dot"
                : availability === "offline"
                  ? "warning"
                  : "info"
            }
            aria-hidden="true"
          />
          {t(`home.picker.${availability}`)}
        </span>
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
        <span className="workspace-badge-text">
          {ws.kind === "none" ? t("home.picker.noProject") : workspaceLabel(ws)}
        </span>
        <GlyphIcon
          name="chevron"
          dir="down"
          className="workspace-badge-chevron"
        />
      </button>
      {state.showWorkspaceDropdown && (
        <div
          className="home-dropdown-menu workspace-dropdown-menu"
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
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              if (expandedHosts.size) {
                const focused = (e.target as HTMLElement).closest<HTMLElement>(
                  "[data-picker-host]",
                )?.dataset.pickerHost;
                const host =
                  focused != null && expandedHosts.has(focused)
                    ? focused
                    : lastHost.current != null &&
                        expandedHosts.has(lastHost.current)
                      ? lastHost.current
                      : [...expandedHosts].at(-1)!;
                setExpandedHosts((previous) => {
                  const next = new Set(previous);
                  next.delete(host);
                  return next;
                });
                hostTriggers.current.get(host)?.focus({ preventScroll: true });
              } else {
                close();
                trigger.current?.focus({ preventScroll: true });
              }
            }
            if (["ArrowDown", "ArrowUp"].includes(e.key)) {
              if (
                e.nativeEvent.isComposing ||
                e.altKey ||
                e.ctrlKey ||
                e.metaKey ||
                e.shiftKey
              )
                return;
              const target = e.target as HTMLElement;
              if (target instanceof HTMLInputElement) {
                // Search enters its own filtered results, never another Host's
                // buttons. An empty result keeps focus in the editable query.
                const results = target
                  .closest(".workspace-host-submenu")
                  ?.querySelectorAll<HTMLButtonElement>(
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
                ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ),
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
                  : (index +
                      (e.key === "ArrowDown" ? 1 : -1) +
                      buttons.length) %
                    buttons.length;
              buttons[next]?.focus();
            }
          }}
        >
          {/* Recent Projects Section */}
          {recent.length > 0 && (
            <div className="workspace-menu-section" data-testid="picker-recent">
              <div className="dropdown-section-title">
                {t("home.picker.recent")}
              </div>
              {recent.map(renderProject)}
            </div>
          )}

          {/* Host Groups Section */}
          {groups.length > 0 && (
            <div className="workspace-menu-section" data-testid="picker-hosts">
              <div className="dropdown-section-title">
                {t("home.picker.hostSection")}
              </div>
              {groups.map((group) => {
                const isExpanded = expandedHosts.has(group.id);
                const displayLabel =
                  group.label || t("home.picker.unassignedHost");
                return (
                  <div
                    key={group.id}
                    className="workspace-host-group"
                    data-picker-host={group.id}
                  >
                    <button
                      ref={(node) => {
                        if (node) hostTriggers.current.set(group.id, node);
                        else hostTriggers.current.delete(group.id);
                      }}
                      type="button"
                      className="workspace-host-toggle"
                      data-host-id={group.id}
                      aria-expanded={isExpanded}
                      aria-controls={`${hostIdPrefix}-${encodeURIComponent(group.id)}`}
                      onClick={() => toggleHost(group.id)}
                    >
                      <Icon
                        name="folder"
                        size={14}
                        className="ws-host-folder-icon"
                      />
                      <span className="ws-item-name">{displayLabel}</span>
                      <GlyphIcon
                        name="chevron"
                        className={
                          isExpanded
                            ? "ws-host-chevron expanded"
                            : "ws-host-chevron"
                        }
                      />
                    </button>
                    {isExpanded && (
                      <div
                        className="workspace-host-projects workspace-host-submenu"
                        id={`${hostIdPrefix}-${encodeURIComponent(group.id)}`}
                        data-testid="picker-host-submenu"
                        role="group"
                        aria-label={
                          group.label || t("home.picker.unassignedHost")
                        }
                        onFocus={() => {
                          lastHost.current = group.id;
                        }}
                      >
                        <input
                          type="search"
                          className="settings-input"
                          autoFocus
                          aria-label={t("home.picker.searchProjects")}
                          placeholder={t("home.picker.searchProjects")}
                          value={queries[group.id] ?? ""}
                          onChange={(event) =>
                            setQueries((previous) => ({
                              ...previous,
                              [group.id]: event.target.value,
                            }))
                          }
                        />
                        <div className="workspace-project-list">
                          {filterProjects(
                            group.projects,
                            queries[group.id] ?? "",
                          ).map(renderProject)}
                          {!filterProjects(
                            group.projects,
                            queries[group.id] ?? "",
                          ).length && (
                            <p role="status">{t("home.picker.noMatch")}</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="dropdown-divider" />

          {/* New Project */}
          <button
            className="workspace-menu-item text-only"
            type="button"
            data-testid="picker-create-project"
            onClick={() => {
              void dispatch({ type: "OpenCreateProjectDialog" });
              close();
            }}
          >
            <span className="ws-item-name">{t("home.picker.newProject")}</span>
          </button>

          <div className="dropdown-divider" />

          {/* No Project */}
          <button
            className="workspace-menu-item text-only"
            type="button"
            data-testid="home-project-item"
            data-active={ws.kind === "none"}
            onClick={() => {
              void dispatch({
                type: "SelectDraftWorkspace",
                value: { kind: "none" },
              });
              close();
            }}
          >
            <span className="ws-item-name">{t("home.picker.noProject")}</span>
            {ws.kind === "none" && (
              <span className="ws-item-check">
                <GlyphIcon name="check" size={14} />
              </span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
