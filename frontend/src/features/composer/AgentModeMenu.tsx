import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { AgentInfo } from "../../client/types";
import { t } from "../../i18n";
import { GlyphIcon } from "../shared";

export function AgentModeMenu({
  agents,
  agent,
  agentComponent,
  mode,
  pinned,
  pending,
  onSelect,
}: {
  agents: AgentInfo[];
  agent: string;
  agentComponent?: string;
  mode: string;
  pinned: boolean;
  pending: boolean;
  onSelect: (agent: AgentInfo, mode: string) => void;
}) {
  const [hovered, setHovered] = useState<AgentInfo>();
  const [agentFilter, setAgentFilter] = useState("");
  const primaryPaneRef = useRef<HTMLDivElement>(null);
  const secondaryListRef = useRef<HTMLDivElement>(null);

  const allCandidates = agents.filter((item) =>
    item.modes.some((entry) => entry.role !== "sub_agent"),
  );
  const query = agentFilter.trim().toLowerCase();
  const candidates = allCandidates.filter((item) =>
    item.name.toLowerCase().includes(query),
  );
  const current = (item: AgentInfo) =>
    item.name === agent &&
    (pinned || agentComponent === undefined || item.component === agentComponent);
  const selected = pinned
    ? agents.find(current)
    : (candidates.find((item) => item === hovered) ??
      candidates.find(current) ??
      candidates[0]);
  const modeIsCurrent = (name: string) =>
    !!selected && current(selected) && name === mode;
  const visibleModes =
    selected?.modes.filter((entry) => entry.role !== "sub_agent") ?? [];

  const moveFocusInPane = (container: HTMLElement | null, delta: number) => {
    if (!container) return;
    const items = [
      ...container.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    ];
    if (!items.length) return;
    const currentIndex = items.findIndex((el) => el === document.activeElement);
    const nextIndex =
      currentIndex < 0
        ? delta > 0
          ? 0
          : items.length - 1
        : (currentIndex + delta + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  const onPrimaryKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (
      event.target instanceof HTMLInputElement &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocusInPane(primaryPaneRef.current, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocusInPane(primaryPaneRef.current, -1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      const firstMode =
        secondaryListRef.current?.querySelector<HTMLButtonElement>(
          "button:not(:disabled)",
        );
      firstMode?.focus();
    }
  };

  const onSecondaryKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocusInPane(secondaryListRef.current, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocusInPane(secondaryListRef.current, -1);
    } else if (event.key === "ArrowLeft" && !pinned) {
      event.preventDefault();
      const activeAgentBtn =
        primaryPaneRef.current?.querySelector<HTMLButtonElement>(
          "button.active:not(:disabled)",
        ) ??
        primaryPaneRef.current?.querySelector<HTMLButtonElement>(
          "button:not(:disabled)",
        );
      activeAgentBtn?.focus();
    }
  };

  return (
    <div
      className="composer-agent-mode-menu"
      role="menu"
      aria-label={t("composer.mode.menu")}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="composer-agent-mode-panes">
        {!pinned && (
          <div
            ref={primaryPaneRef}
            className="composer-agent-primary-pane"
            role="menu"
            aria-label={t("composer.agent.pick")}
            onKeyDown={onPrimaryKeyDown}
          >
            {(allCandidates.length > 5 || agentFilter.length > 0) && (
              <input
                type="search"
                className="settings-input composer-agent-search"
                placeholder={t("uiPolish.searchAgents")}
                aria-label={t("uiPolish.searchAgents")}
                value={agentFilter}
                onChange={(event) => setAgentFilter(event.target.value)}
              />
            )}
            {candidates.length === 0 && (
              <span className="composer-mode-heading">
                {t("uiPolish.noMatches")}
              </span>
            )}
            {candidates.map((item) => (
              <button
                key={JSON.stringify([item.name, item.component])}
                type="button"
                role="menuitem"
                className={`model-picker-item${selected === item ? " active" : ""}`}
                data-testid="composer-agent-item"
                aria-haspopup="menu"
                aria-expanded={selected === item}
                disabled={pending}
                onMouseEnter={() => setHovered(item)}
                onFocus={() => setHovered(item)}
                onClick={() => setHovered(item)}
              >
                <span className="composer-agent-item-label">{item.name}</span>
                <GlyphIcon name="chevron" />
              </button>
            ))}
          </div>
        )}
        <div
          className="composer-mode-secondary-pane"
          role="group"
          aria-label={selected?.name ?? t("composer.mode.menu")}
          onKeyDown={onSecondaryKeyDown}
        >
          {pinned && (
            <div className="composer-mode-heading">
              {agent} · {t("composer.mode.pinned")}
            </div>
          )}
          <div className="composer-mode-list" ref={secondaryListRef}>
            {visibleModes.map((entry) => (
              <button
                key={entry.name}
                type="button"
                role="menuitemradio"
                aria-checked={modeIsCurrent(entry.name)}
                data-testid="composer-mode-item"
                title={entry.description || undefined}
                className={`model-picker-item${modeIsCurrent(entry.name) ? " active" : ""}`}
                disabled={pending}
                onClick={() => selected && onSelect(selected, entry.name)}
              >
                <span className="composer-mode-item-text">
                  <span>{entry.name}</span>
                  {entry.description && (
                    <small className="settings-row-sub">
                      {" "}
                      · {entry.description}
                    </small>
                  )}
                </span>
                {modeIsCurrent(entry.name) && (
                  <GlyphIcon name="check" size={14} />
                )}
              </button>
            ))}
            {!selected && (
              <span className="composer-mode-heading">
                {t("composer.mode.empty")}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
