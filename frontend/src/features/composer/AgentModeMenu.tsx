import { useState } from "react";
import type { AgentInfo } from "../../client/types";
import { t } from "../../i18n";
import { GlyphIcon } from "../shared";

export function AgentModeMenu({
  agents,
  agent,
  mode,
  pinned,
  pending,
  onSelect,
  onManage,
}: {
  agents: AgentInfo[];
  agent: string;
  mode: string;
  pinned: boolean;
  pending: boolean;
  onSelect: (agent: string, mode: string) => void;
  onManage: () => void;
}) {
  const [hovered, setHovered] = useState(agent);
  const candidates = agents.filter((item) =>
    item.modes.some((entry) => entry.role !== "sub_agent"),
  );
  const selected = pinned
    ? agents.find((item) => item.name === agent)
    : (candidates.find((item) => item.name === hovered) ??
      candidates.find((item) => item.name === agent) ??
      candidates[0]);
  return (
    <div
      className="composer-agent-mode-menu"
      role="menu"
      aria-label={t("composer.mode.menu")}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="composer-agent-mode-columns">
        {!pinned && (
          <div
            className="composer-agent-mode-list"
            aria-label={t("composer.agent.pick")}
          >
            {candidates.map((item) => (
              <button
                key={item.name}
                type="button"
                role="menuitem"
                className={`model-picker-item${selected?.name === item.name ? " active" : ""}`}
                data-testid="composer-agent-item"
                aria-haspopup="menu"
                aria-expanded={selected?.name === item.name}
                disabled={pending}
                onMouseEnter={() => setHovered(item.name)}
                onFocus={() => setHovered(item.name)}
                onClick={() => setHovered(item.name)}
              >
                {item.name}
                <GlyphIcon name="chevron" />
              </button>
            ))}
          </div>
        )}
        <div
          className="composer-agent-mode-list"
          role="group"
          aria-label={selected?.name ?? t("composer.mode.menu")}
        >
          {pinned && (
            <div className="composer-mode-heading">
              {agent} · {t("composer.mode.pinned")}
            </div>
          )}
          {selected?.modes
            .filter((entry) => entry.role !== "sub_agent")
            .map((entry) => (
              <button
                key={entry.name}
                type="button"
                role="menuitemradio"
                aria-checked={selected.name === agent && entry.name === mode}
                data-testid="composer-mode-item"
                title={entry.description || undefined}
                className={`model-picker-item${selected.name === agent && entry.name === mode ? " active" : ""}`}
                disabled={pending}
                onClick={() => onSelect(selected.name, entry.name)}
              >
                <span>
                  {entry.name}
                  {entry.description && (
                    <small className="settings-row-sub">
                      {" "}
                      · {entry.description}
                    </small>
                  )}
                </span>
                {selected.name === agent && entry.name === mode && (
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
      <div className="model-picker-divider" />
      <button
        className="model-picker-item"
        type="button"
        role="menuitem"
        onClick={onManage}
      >
        {t("composer.agent.manage")}
      </button>
    </div>
  );
}
