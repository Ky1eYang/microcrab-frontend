import { useApp } from "../state";
import { t } from "../i18n";
import { Icon } from "./shared";

/** One command row in the conversation; successful settlement is the durable summary row. */
export function CompactionCommand() {
  const { state } = useApp();
  const operation = state.compactOperation;
  if (
    !operation ||
    operation.sessionId !== state.sessionId ||
    operation.status === "completed"
  )
    return null;
  const status = operation.outcomeUnknown ? "unknown" : operation.status;
  return (
    <article
      className="block compaction-command"
      data-testid="compact-lifecycle"
      data-status={status}
      data-role="system"
      role="status"
    >
      <div className="block-body">
        <div className="compaction-header-btn">
          <Icon name="compact" size={14} />
          <span className="compaction-title">
            /compact{operation.instruction ? ` ${operation.instruction}` : ""}
          </span>
          <span className="compaction-sep" aria-hidden="true" />
          <span className="compaction-stats-label">
            {t(`composer.compact.${status}`)}
          </span>
        </div>
        {operation.error?.message && (
          <div className="block-stream-error">{operation.error.message}</div>
        )}
      </div>
    </article>
  );
}
