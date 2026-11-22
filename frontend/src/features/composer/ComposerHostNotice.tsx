import { t } from "../../i18n";
import { useAppDispatch, useAppSelector } from "../../state";
import { hostReadiness } from "../../state/host-readiness";
import { Icon } from "../shared";
import { ComposerNoticeText } from "./ComposerNoticeText";
import "../../styles/composer-notification-dock.css";

type Host = ReturnType<typeof hostReadiness>;

export function composerHostMessage(host: Host, catalogError?: string) {
  if (!host.projectId) {
    if (host.matched && catalogError)
      return t(
        host.hostFlavor === "chat_only"
          ? "chatOnly.unavailableNotice"
          : "browserHost.unavailableNotice",
        { error: catalogError },
      );
    return t(
      host.hostFlavor === "chat_only"
        ? "chatOnly.loadingNotice"
        : "browserHost.loadingNotice",
    );
  }
  switch (host.status) {
    case "binding_mismatch":
      return t("host.readiness.bindingMismatchNotice");
    case "host_preflight_unsupported":
      return t("host.readiness.preflightUnsupportedNotice");
    case "loading_catalog":
      return t("host.readiness.loadingNotice");
    case "catalog_error":
      return t("host.readiness.catalogErrorNotice", {
        error: catalogError ?? "",
      });
    case "project_mismatch":
      return t("host.readiness.projectMismatchNotice");
    case "connecting":
    case "pairing":
    case "reconciling":
      return t("host.readiness.pendingNotice");
    default:
      return t("host.readiness.offlineNotice");
  }
}

export function ComposerHostNotice({ inDock = false }: { inDock?: boolean }) {
  const dispatch = useAppDispatch();
  const { host, catalogError } = useAppSelector(
    (state) => ({
      host: hostReadiness(state),
      catalogError: state.hostConnection?.catalogError,
      locale: state.resolvedLocale,
    }),
    (a, b) =>
      a.locale === b.locale &&
      a.catalogError === b.catalogError &&
      a.host.projectId === b.host.projectId &&
      a.host.hostFlavor === b.host.hostFlavor &&
      a.host.matched === b.host.matched &&
      a.host.status === b.host.status,
  );
  if (host.ready) return null;
  const browserHost = !host.projectId;
  const browserError = browserHost && host.matched && !!catalogError;
  return (
    <div
      className={`composer-offline-banner composer-host-notice${inDock ? " composer-notification-row" : ""}`}
      role="alert"
      data-tone="warn"
      data-host-state={host.status}
    >
      <div className="composer-offline-left">
        <Icon
          name="warning"
          size={16}
          className="offline-icon"
          aria-hidden="true"
        />
        <ComposerNoticeText text={composerHostMessage(host, catalogError)} />
      </div>
      {(!browserHost || browserError) && (
        <button
          type="button"
          className="composer-offline-reconnect-btn"
          disabled={host.status === "loading_catalog"}
          onClick={() =>
            dispatch({
              type: browserHost
                ? "ReconnectBrowserHost"
                : host.status === "catalog_error"
                  ? "RetryHostCatalog"
                  : "OpenRemoteConnectDialog",
              projectId: host.projectId,
            })
          }
        >
          {browserHost
            ? t(
                host.hostFlavor === "chat_only"
                  ? "chatOnly.retry"
                  : "browserHost.retry",
              )
            : host.status === "catalog_error"
              ? t("host.readiness.retryCatalog")
              : host.status === "loading_catalog"
                ? t("host.readiness.loadingAction")
                : t("host.readiness.connect")}
        </button>
      )}
    </div>
  );
}
