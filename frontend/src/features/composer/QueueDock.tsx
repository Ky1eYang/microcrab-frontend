import { userTaskInputAllowed } from "../../client/session-kind";
import { ExpandableNotice } from "../ExpandableNotice";
import { useState } from "react";
import { activeSession, useApp } from "../../state";
import { hostReadiness } from "../../state/host-readiness";
import {
  inboxInputEditable,
  inboxItemKey,
  inboxMutationBusy,
  sessionInboxMutationBusy,
} from "../../state/inbox-draft";
import { t } from "../../i18n";
import { isNarrowViewport } from "../../client/viewport";
import { GlyphIcon, Icon } from "../shared";

export function QueueDock() {
  const { state, dispatch } = useApp();
  const [collapsedBySession, setCollapsed] = useState<{
    sessionId: string | null | undefined;
    value: boolean;
  }>(() => ({ sessionId: state.sessionId, value: isNarrowViewport() }));
  const collapsed =
    collapsedBySession.sessionId === state.sessionId
      ? collapsedBySession.value
      : isNarrowViewport();
  const items = [...state.transcript.steer, ...state.transcript.queue];
  const oldest = items.reduce<(typeof items)[number] | undefined>(
    (best, item) => (!best || Number(item.id) < Number(best.id) ? item : best),
    undefined,
  );
  const resumeVisible =
    state.transcript.inboxPaused &&
    !state.transcript.inboxActive &&
    state.transcript.sessionStatus === "idle";
  const staged = state.sessionId
    ? state.inboxRetrieved?.[state.sessionId]
    : undefined;
  const blocked =
    !userTaskInputAllowed(activeSession(state), state.publicState) ||
    state.connection !== "ws" ||
    !!state.sessionTransportRecovery ||
    !state.authSession?.authenticated ||
    !hostReadiness(state).ready ||
    state.historyMutationPending ||
    state.retryPending ||
    state.compactInflight ||
    state.isCreatingSession;
  const draftOccupied =
    !!state.composer.length ||
    !!state.composerImages.length ||
    state.imageIntakePending;
  if (!items.length && !staged) return null;
  return (
    <div className="queue-dock-card" data-testid="queue-dock">
      <button
        type="button"
        className="queue-dock-header"
        aria-expanded={!collapsed}
        aria-controls="queue-dock-list"
        onClick={() =>
          setCollapsed({ sessionId: state.sessionId, value: !collapsed })
        }
      >
        <span className="queue-dock-header-left">
          <span className="queue-dock-badge">{items.length}</span>
          <span className="queue-dock-title">{t("composer.inbox.title")}</span>
          <span className="queue-dock-summary">
            {t("composer.inbox.summary", {
              steer: state.transcript.steer.length,
              queue: state.transcript.queue.length,
            })}
          </span>
        </span>
        <span className="queue-dock-toggle-label">
          {t(collapsed ? "composer.inbox.expand" : "composer.inbox.collapse")}
          <GlyphIcon name="chevron" dir={collapsed ? "down" : "up"} />
        </span>
      </button>
      {draftOccupied && items.length > 0 && !staged && (
        <ExpandableNotice
          className="queue-dock-note"
          tone="neutral"
          marker="none"
          role={null}
          data-testid="inbox-draft-note"
          text={t("composer.inbox.draftOccupied")}
        />
      )}
      {staged && (
        <div
          className="composer-compact-status queue-dock-retrieved"
          data-testid="inbox-retrieved"
          role="status"
        >
          <span>{t("composer.inbox.retrieved")}</span>
          <button
            type="button"
            className="queue-item-action-btn"
            data-testid="inbox-restore"
            disabled={
              blocked || draftOccupied || !inboxInputEditable(staged.input)
            }
            title={
              draftOccupied ? t("composer.inbox.draftOccupied") : undefined
            }
            onClick={() => dispatch({ type: "RestoreInboxInput" })}
          >
            {t("composer.inbox.restore")}
          </button>
          <button
            type="button"
            className="queue-item-action-btn"
            data-testid="inbox-discard"
            onClick={() => dispatch({ type: "DiscardInboxInput" })}
          >
            {t("composer.inbox.discard")}
          </button>
        </div>
      )}
      {state.transcript.inboxPaused && (
        <div className="composer-compact-status" role="status">
          {t(
            state.retryOperationId
              ? "composer.inbox.resumeRetry"
              : "composer.inbox.paused",
          )}
        </div>
      )}
      {!collapsed && (
        <div className="queue-dock-list" id="queue-dock-list">
          {items.map((item) => {
            const key = inboxItemKey(
              item.sessionID,
              item.inboxId ?? "",
              item.id,
            );
            const mutation = state.inboxMutations?.[key];
            const pending = inboxMutationBusy(mutation?.status);
            const unsupported =
              !item.inboxId ||
              !Number.isSafeInteger(item.revision) ||
              !state.capabilities?.methods.includes("inbox.remove");
            const unavailable =
              blocked || unsupported || item.claimed || pending;
            const images = item.parts.filter(
              (part) => part.type === "image",
            ).length;
            const takeDisabled =
              unavailable ||
              draftOccupied ||
              !!staged ||
              !item.input ||
              !inboxInputEditable(item.input) ||
              sessionInboxMutationBusy(state.inboxMutations, state.sessionId);
            // First applicable fact explains why Retrieve is unavailable;
            // guards themselves are unchanged.
            const takeReason = !takeDisabled
              ? ""
              : item.claimed
                ? t("composer.inbox.claimed")
                : pending
                  ? t("composer.inbox.mutationPending")
                  : unsupported
                    ? t("composer.inbox.unsupported")
                    : blocked
                      ? t("composer.inbox.blocked")
                      : staged
                        ? t("composer.inbox.stagedFirst")
                        : draftOccupied
                          ? t("composer.inbox.draftOccupied")
                          : !item.input || !inboxInputEditable(item.input)
                            ? t("composer.inbox.notEditable")
                            : t("composer.inbox.mutationPending");
            const forceSendUnsupported =
              !item.inboxId ||
              !Number.isSafeInteger(item.revision) ||
              !state.capabilities?.methods.includes("inbox.update");
            const forceSendDisabled =
              item.mode !== "queue" ||
              blocked ||
              forceSendUnsupported ||
              item.claimed ||
              pending ||
              !state.transcript.inboxActive ||
              item.sessionID !== state.sessionId ||
              item.inboxId !== state.transcript.inboxId ||
              sessionInboxMutationBusy(state.inboxMutations, state.sessionId);
            const forceSendReason = !forceSendDisabled
              ? ""
              : item.claimed
                ? t("composer.inbox.claimed")
                : pending
                  ? t("composer.inbox.mutationPending")
                  : forceSendUnsupported
                    ? t("composer.inbox.unsupported")
                    : blocked
                      ? t("composer.inbox.blocked")
                      : !state.transcript.inboxActive
                        ? t("composer.inbox.forceSendUnavailable")
                        : t("composer.inbox.mutationPending");
            const itemStatus = item.claimed
              ? "claimed"
              : mutation?.error
                ? mutation.status === "unknown"
                  ? "unknown"
                  : "error"
                : pending
                  ? mutation?.status === "unknown"
                    ? "unknown"
                    : "pending"
                  : "ready";
            const action = {
              itemId: item.id,
              inboxId: item.inboxId,
              expectedRevision: item.revision,
            };
            return (
              <div
                key={`${item.inboxId}:${item.id}`}
                className="queue-dock-item-group"
                data-status={itemStatus}
              >
                <div
                  className={`queue-dock-item ${item.mode}`}
                  data-testid="queue-item"
                  data-inbox-id={item.id}
                  data-mode={item.mode}
                  data-claimed={item.claimed ? "true" : "false"}
                  aria-busy={pending}
                >
                  <span className={`queue-item-badge ${item.mode}`}>
                    {t(
                      item.mode === "steer"
                        ? "composer.inbox.steerLabel"
                        : "composer.inbox.queueLabel",
                    )}
                  </span>
                  <details className="queue-item-body">
                    {/* The summary stays visible when open, so the toggle never
                        disappears from under keyboard focus (Part B D3). */}
                    <summary
                      className="queue-item-text"
                      data-testid="queue-item-toggle"
                      title={item.prompt}
                    >
                      <span className="queue-item-preview">
                        {item.displayPrompt || item.prompt}
                      </span>
                      <span className="queue-item-collapse">
                        {t("composer.inbox.collapseFull")}
                      </span>
                    </summary>
                    <p
                      className="queue-item-full"
                      data-testid="queue-item-full"
                    >
                      {item.prompt}
                    </p>
                  </details>
                  {(images > 0 ||
                    item.claimed ||
                    itemStatus === "pending" ||
                    itemStatus === "unknown") && (
                    <span
                      className="queue-item-meta"
                      data-testid="queue-item-status"
                    >
                      {[
                        images > 0
                          ? t("composer.inbox.images", { count: images })
                          : "",
                        item.claimed ? t("composer.inbox.claimed") : "",
                        itemStatus === "pending"
                          ? t("composer.inbox.mutationPending")
                          : itemStatus === "unknown"
                            ? t("composer.inbox.mutationUnknown")
                            : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                  <div className="queue-item-actions">
                    {resumeVisible && oldest === item && (
                      <button
                        type="button"
                        className="queue-item-action-btn"
                        data-testid="inbox-resume"
                        disabled={
                          blocked ||
                          !!state.sessionAttachingId ||
                          state.inboxPending ||
                          !activeSession(state) ||
                          !!activeSession(state)?.archived ||
                          item.sessionID !== state.sessionId ||
                          item.inboxId !== state.transcript.inboxId ||
                          !item.inboxId ||
                          !Number.isSafeInteger(item.revision) ||
                          !Number.isSafeInteger(Number(item.id)) ||
                          item.claimed ||
                          !!state.retryOperationId ||
                          !state.capabilities?.methods.includes(
                            "inbox.resume",
                          ) ||
                          sessionInboxMutationBusy(
                            state.inboxMutations,
                            state.sessionId,
                          )
                        }
                        title={
                          state.retryOperationId
                            ? t("composer.inbox.resumeRetry")
                            : t("composer.inbox.resume")
                        }
                        onClick={() =>
                          dispatch({ type: "ResumeInboxInput", ...action })
                        }
                      >
                        {t("composer.inbox.resume")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="queue-item-action-btn"
                      data-testid="inbox-take"
                      disabled={takeDisabled}
                      aria-disabled={takeDisabled || undefined}
                      title={takeReason || t("composer.inbox.take")}
                      aria-describedby={
                        takeReason ? `queue-take-reason-${item.id}` : undefined
                      }
                      onClick={() =>
                        dispatch({ type: "TakeInboxInput", ...action })
                      }
                    >
                      {t("composer.inbox.take")}
                    </button>
                    {item.mode === "queue" && (
                      <button
                        type="button"
                        className="queue-item-action-btn"
                        data-testid="inbox-force-send"
                        disabled={forceSendDisabled}
                        title={forceSendReason || t("composer.inbox.forceSend")}
                        aria-label={t("composer.inbox.forceSend")}
                        onClick={() =>
                          dispatch({
                            type: "UpdateInboxInput",
                            ...action,
                            mode: "steer",
                          })
                        }
                      >
                        {t("composer.inbox.forceSend")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="queue-item-delete-btn"
                      data-testid="inbox-remove"
                      disabled={unavailable}
                      aria-label={t("composer.inbox.remove")}
                      title={
                        item.claimed
                          ? t("composer.inbox.claimed")
                          : t("composer.inbox.remove")
                      }
                      onClick={() =>
                        dispatch({ type: "RemoveInboxInput", ...action })
                      }
                    >
                      <Icon name="close" size={14} aria-hidden="true" />
                    </button>
                  </div>
                  {takeReason && (
                    <span hidden id={`queue-take-reason-${item.id}`}>
                      {takeReason}
                    </span>
                  )}
                </div>
                {mutation?.error && (
                  <ExpandableNotice
                    className="inline-notice queue-item-error"
                    tone={itemStatus === "unknown" ? "warn" : "danger"}
                    marker="none"
                    role="status"
                    data-testid="inbox-mutation-error"
                    text={mutation.error}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
