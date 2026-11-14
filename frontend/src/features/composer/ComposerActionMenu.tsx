import { Icon } from "../shared";
import { t } from "../../i18n";

export type ComposerMenuAction = {
  id: string;
  section: "add" | "command";
  label: string;
  description: string;
  icon: string;
  /** Shown muted beside the title (e.g. /compact or @). */
  hint?: string;
  disabled?: boolean;
  /** Stable option id for aria-activedescendant when this row is the slash match. */
  optionId?: string;
  run: () => void;
};

/** Keep rendered rows and textarea keyboard selection on the same command set. */
export function matchingComposerActions(
  actions: ComposerMenuAction[],
  query: string,
) {
  const q = query.toLowerCase();
  return actions.filter(
    (action) =>
      action.section === "command" &&
      (action.id.startsWith(q) ||
        (action.hint ?? "").replace(/^\//, "").toLowerCase().startsWith(q)),
  );
}

/** One full-width composer menu for (+) and `/` (sections 添加 / 指令). */
export function ComposerActionMenu({
  actions,
  mode,
  query,
  activeId,
}: {
  actions: ComposerMenuAction[];
  /** `full` = (+) opens both sections; `slash` filters 指令. */
  mode: "full" | "slash";
  query: string;
  activeId?: string;
}) {
  const q = query.toLowerCase();
  const add = mode === "full" ? actions.filter((a) => a.section === "add") : [];
  const commands = actions.filter((a) => a.section === "command");
  const rows =
    mode === "slash" ? matchingComposerActions(actions, query) : commands;
  const unknown = mode === "slash" && q.length > 0 && rows.length === 0;

  return (
    <div
      className="composer-action-menu"
      role="listbox"
      id="composer-slash-palette"
      data-mode={mode}
      data-testid="composer-action-menu"
      aria-label={t("composer.slash.menu")}
    >
      {add.length > 0 && (
        <div className="composer-action-section">
          <div className="composer-action-section-label">
            {t("composer.menu.sectionAdd")}
          </div>
          {add.map((a) => (
            <ActionRow key={a.id} action={a} selected={false} />
          ))}
        </div>
      )}
      <div className="composer-action-section">
        {(mode === "full" || rows.length > 0 || unknown) && (
          <div className="composer-action-section-label">
            {t("composer.menu.sectionCommands")}
          </div>
        )}
        {unknown ? (
          <div className="composer-action-status" role="status">
            {t("composer.slash.unknown", { name: query })}
          </div>
        ) : (
          rows.map((a) => (
            <ActionRow
              key={a.id}
              action={a}
              selected={
                !!activeId && (a.optionId === activeId || a.id === activeId)
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

function ActionRow({
  action,
  selected,
}: {
  action: ComposerMenuAction;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      role="option"
      id={action.optionId ?? `composer-slash-${action.id}`}
      aria-selected={selected ? "true" : "false"}
      disabled={action.disabled}
      title={`${action.label}${action.hint ? ` ${action.hint}` : ""} — ${action.description}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => action.run()}
      className="composer-action-row"
    >
      <span className="composer-action-icon" aria-hidden="true">
        <Icon name={action.icon} size={16} />
      </span>
      <span className="composer-action-label">
        <span className="composer-action-title">{action.label}</span>
        {action.hint ? (
          <span className="composer-action-hint">{action.hint}</span>
        ) : null}
      </span>
      <span className="composer-action-desc">{action.description}</span>
    </button>
  );
}
