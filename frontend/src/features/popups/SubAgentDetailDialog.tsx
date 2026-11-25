import { referenceLabels } from "../referenceLabels";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../../state";
import { createTranscript } from "../../client/projector";
import { t } from "../../i18n";
import { Conversation } from "../conversation";
import { TrajectoryView } from "../trajectory";
import { SessionViewTabs } from "../SessionViewTabs";
import { childTranscript } from "../childTranscript";
import { childText } from "../childPresentation";
import type { NativeChildDetail } from "../../client/types";
import { ChildSessionDock } from "../composer/ChildSessionDock";
import "../../styles/child-content.css";

/** The normal conversation and inspector, scoped to parent-authorized read-only history. */
export function SubAgentDetailDialog() {
  const { state, dispatch } = useApp();
  const popup = state.popup;
  const sessionLabel = referenceLabels("session", [
    popup.parentId, popup.childId, ...(state.childList?.children ?? []).map((child) => child.id),
  ]);
  const detail = popup.detail as NativeChildDetail | undefined;
  const [viewMode, setViewMode] = useState<"chat" | "trajectory">("chat");
  const transcript = useMemo(
    () => (detail ? childTranscript(detail) : createTranscript()),
    [detail],
  );
  useEffect(() => setViewMode("chat"), [popup.childId]);
  const notices = (
    <>
      {popup.loading && (
        <p className="child-content-notice" role="status">
          {t("child.loading")}
        </p>
      )}
      {popup.error && (
        <p className="child-content-notice" role="alert">
          {t("child.readError", { error: popup.error })}
        </p>
      )}
      {popup.entryUnknown && <p className="child-content-notice" role="status">{t("childInput.entryUnknown")}</p>}
      {detail?.availability === "pending" && (
        <p className="child-content-notice" role="status">
          {t("child.pendingNotice")}
        </p>
      )}
      {detail?.availability === "unavailable" && (
        <p className="child-content-notice" role="status">
          {t("child.unavailableNotice")}
        </p>
      )}
      {detail?.messages.some((message) => message.content_omitted) && (
        <p className="child-content-notice" role="status">
          {t("child.omitted")}
        </p>
      )}
      {detail?.messages_truncated && detail.next_cursor == null && (
        <p className="child-content-notice" role="status">
          {t("child.messagesTruncated")}
        </p>
      )}
      {detail?.executions_truncated && (
        <p className="child-content-notice" role="status">
          {t("child.executionsTruncated")}
        </p>
      )}
      {detail?.availability === "persisted" && !detail.messages.length && (
        <p className="child-content-notice">{t("child.empty")}</p>
      )}
    </>
  );
  const footer = (
    <ChildSessionDock
      key={popup.childId}
      detail={detail}
      childId={popup.childId}
      loading={popup.loading === true}
      onEarlier={() => dispatch({ type: "LoadEarlierChildMessages" })}
      onRefresh={() => dispatch({ type: "RefreshSubAgentDetail" })}
    />
  );
  return (
    <section
      className="child-content-view"
      role="region"
      aria-label={t("child.content")}
      data-testid="child-content-view"
    >
      <SessionViewTabs
        modes={["chat", "trajectory"]}
        viewMode={viewMode}
        onSelect={setViewMode}
        idPrefix="child-view"
        panelId="child-view-panel"
      />
      <div
        id="child-view-panel"
        className="child-session-body"
        role="tabpanel"
        aria-labelledby={`child-view-tab-${viewMode}`}
      >
        <div
          className="conversation-chat-pane"
          style={{ display: viewMode === "chat" ? "flex" : "none" }}
        >
          <Conversation
            transcript={transcript}
            sessionId={popup.childId}
            readOnly
            notices={notices}
            footer={footer}
          />
        </div>
        {viewMode === "trajectory" && (
          <div className="conversation-chat-pane">
            {notices}
            {transcript && detail && (
              <TrajectoryView
                transcript={transcript}
                auditScope={{
                  parentId: popup.parentId,
                  childId: popup.childId,
                }}
                title={childText(detail.name) || sessionLabel(popup.childId)}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
