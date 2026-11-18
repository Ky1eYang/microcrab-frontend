import { useState } from "react";
import type { NativeChildDetail, NativeUsage } from "../../client/types";
import { t } from "../../i18n";
import { ContentDialog } from "../ContentDialog";
import { Payload } from "../Payload";
import { childText } from "../childPresentation";
import { Icon } from "../shared";
import { ChildTurnComposer } from "./ChildTurnComposer";
import { StatisticsOverview } from "./StatisticsDock";

/** Explicit child evidence only; the shared controls never read the parent's input or statistics. */
export function ChildSessionDock({
  detail,
  childId,
  loading,
  onRefresh,
  onEarlier,
}: {
  detail?: NativeChildDetail;
  childId: string;
  loading: boolean;
  onRefresh: () => void;
  onEarlier: () => void;
}) {
  const [metadataOpen, setMetadataOpen] = useState(false);
  const usage: NativeUsage | null =
    detail?.usage &&
    typeof detail.usage === "object" &&
    !Array.isArray(detail.usage)
      ? (detail.usage as NativeUsage)
      : null;
  const status =
    !childText(detail?.status) || detail?.status === "unknown"
      ? t("child.unknown")
      : childText(detail?.status);
  const metadataButton = (
    <button
      type="button"
      className="dock-pill-btn child-metadata-trigger"
      data-testid="child-metadata"
      aria-haspopup="dialog"
      aria-expanded={metadataOpen}
      onClick={() => setMetadataOpen(true)}
    >
      <Icon name="info" className="dock-icon" />
      <span className="dock-pill-label">{t("child.metadata")}</span>
    </button>
  );
  return (
    <div className="composer-stack" data-testid="child-session-dock">
      <ChildTurnComposer
        detail={detail}
        childId={childId}
        loading={loading}
        onRefresh={onRefresh}
        onEarlier={onEarlier}
      />
      <StatisticsOverview
        statistics={null}
        usage={usage}
        scopeId={`child-${childId}`}
        right={metadataButton}
      />
      {metadataOpen && (
        <ContentDialog
          maximizable
          title={t("child.metadata")}
          onClose={() => setMetadataOpen(false)}
        >
          <div className="child-session-metadata">
            <div className="dock-stat-row">
              <span className="dock-stat-label">{t("child.status")}</span>
              <span className="dock-stat-val">{status}</span>
            </div>
            <div className="dock-stat-row">
              <span className="dock-stat-label">{t("child.availability")}</span>
              <span className="dock-stat-val">
                {t(`child.${detail?.availability ?? "unavailable"}`)}
              </span>
            </div>
            {detail &&
              (
                [
                  ["receipt", detail.receipt],
                  ["history", detail.history],
                  ["executions", detail.executions],
                ] as const
              ).map(([key, value]) => (
                <section className="child-overview-section" key={key}>
                  <h3>{t(`child.${key}`)}</h3>
                  <Payload
                    value={value}
                    testid={`child-${key}-payload`}
                    variant="trajectory"
                  />
                </section>
              ))}
          </div>
        </ContentDialog>
      )}
    </div>
  );
}
