import { useState, useSyncExternalStore } from "react";
import { ExpandableNotice } from "./ExpandableNotice";
import {
  discardRecoveredDrafts,
  recoveredDraftsSnapshot,
  subscribeRecoveredDrafts,
} from "../client/document-leave";
import { t } from "../i18n";
import { ContentDialog } from "./ContentDialog";
import { ContentViewer } from "./content-inspection/ContentViewer";

/** Outside the authenticated app: retained text has no save/effect authority. */
export function RecoveredDrafts() {
  const recovery = useSyncExternalStore(
    subscribeRecoveredDrafts,
    recoveredDraftsSnapshot,
  );
  const [confirm, setConfirm] = useState(false);
  if (!recovery) return null;
  return (
    <ContentDialog
      title={t("contentViewer.recoveredDrafts")}
      onClose={() => setConfirm(true)}
    >
      <div data-testid="recovered-document-drafts">
        <ExpandableNotice
          className="settings-description recovered-drafts-notice"
          tone="neutral"
          marker="none"
          role={null}
          text={t("contentViewer.recoveredNotice")}
        />
        {recovery.drafts.map((draft, index) => (
          <section key={index}>
            <h3>{draft.label}</h3>
            <ContentViewer
              source={draft.text}
              defaultFormat="raw"
              allowedFormats={["raw"]}
              title={draft.label}
            />
          </section>
        ))}
        {confirm && (
          <div role="alert">
            <p>{t("contentViewer.discardQuestion")}</p>
            <button className="ghost-btn" onClick={() => setConfirm(false)}>
              {t("contentViewer.keepDrafts")}
            </button>
            <button
              className="ghost-btn"
              onClick={() => {
                discardRecoveredDrafts();
                setConfirm(false);
              }}
            >
              {t("contentViewer.discard")}
            </button>
          </div>
        )}
      </div>
    </ContentDialog>
  );
}
