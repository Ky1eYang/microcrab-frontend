import { useEffect, useMemo, useState } from "react";
import { ExpandableNotice } from "../ExpandableNotice";
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
        <ExpandableNotice
          className="child-content-notice"
          tone="neutral"
          marker="none"
          role="status"
          text={t("child.loading")}
        />
      )}
      {popup.error && (
        <ExpandableNotice
          className="child-content-notice"
          tone="neutral"
          marker="none"
          role="alert"
          text={t("child.readError", { error: popup.error })}
        />
      )}
      {popup.entryUnknown && <p className="child-content-notice" role="status">{t("childInput.entryUnknown")}</p>}
      {detail?.availability === "pending" && (
        <ExpandableNotice
          className="child-content-notice"
          tone="neutral"
          marker="none"
          role="status"
          text={t("child.pendingNotice")}
        />
      )}
      {detail?.availability === "unavailable" && (
        <ExpandableNotice
          className="child-content-notice"
          tone="neutral"
          marker="none"
          role="status"
          text={t("child.unavailableNotice")}
        />
      )}
      {detail?.messages.some((message) => message.content_omitted) && (
        <ExpandableNotice
          className="child-content-notice"
          tone="neutral"
          marker="none"
          role="status"
          text={t("child.omitted")}
        />
      )}
      {detail?.messages_truncated && detail.next_cursor == null && (
        <ExpandableNotice
          className="child-content-notice"
          tone="neutral"
          marker="none"
          role="status"
          text={t("child.messagesTruncated")}
        />
      )}
      {detail?.executions_truncated && (
        <ExpandableNotice
          className="child-content-notice"
          tone="neutral"
          marker="none"
          role="status"
          text={t("child.executionsTruncated")}
        />
      )}
      {detail?.availability === "persisted" && !detail.messages.length && (
        <ExpandableNotice
          className="child-content-notice"
          tone="neutral"
          marker="none"
          role={null}
          text={t("child.empty")}
        />
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
                title={childText(detail.name) || popup.childId}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
