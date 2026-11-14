import { useAppFields } from "../state";
import { t } from "../i18n";
import { Icon } from "./shared";
import { SettingsDialog } from "./popups/SettingsDialog";
import { RemoteConnectDialog } from "./popups/RemoteConnectDialog";
import { SearchDialog, ModelDialog } from "./popups/SearchDialog";
import { SessionPermissionsDialog } from "./popups/SessionPermissionsDialog";
import { ProjectSettingsDialog } from "./popups/ProjectSettingsDialog";
export function PopupView() {
  const { state, dispatch } = useAppFields([
    "popup",
    "compactInflight",
    "resolvedLocale",
  ]);
  const p = state.popup;
  if (p.type === "none") return null;
  if (p.type === "settings") return <SettingsDialog />;
  if (p.type === "sessionPermissions")
    return <SessionPermissionsDialog key={`${p.sessionId}:${p.requestId}`} />;
  if (p.type === "projectSettings") return <ProjectSettingsDialog />;
  if (p.type === "remoteConnect" || p.type === "createProject")
    return <RemoteConnectDialog key={`${p.type}:${p.projectId ?? ""}`} />;
  if (p.type === "search") return <SearchDialog />;
  if (p.type === "modelSelect") return <ModelDialog />;
  if (p.type === "subagentDetail") return null;
  const projectDelete = p.type === "deleteProject",
    projectRename = p.type === "renameProject",
    deleting = p.type === "delete",
    archiving = p.type === "archive",
    archive = deleting || archiving || projectDelete,
    compact = p.type === "compact";
  const heading = projectDelete
    ? t("popup.deleteProject.title")
    : projectRename
      ? t("popup.renameProject.title")
      : archiving
        ? t("popup.archiveSession.title")
        : deleting
          ? t("popup.deleteSession.title")
          : archive
            ? t("popup.deleteSession.title")
            : compact
              ? t("composer.compact.title")
              : t("popup.renameSession.title");
  return (
    <div className="overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        aria-busy={p.pending === true}
      >
        <div className="dialog-header">
          <h2>{heading}</h2>
          <button
            className="settings-close-btn"
            aria-label={t("popup.close")}
            disabled={p.pending === true}
            onClick={() => dispatch({ type: "DismissPopup" })}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        {projectDelete ? (
          <p>{t("popup.deleteProject.warning", { title: p.title ?? "" })}</p>
        ) : archiving ? (
          <p>{t("popup.archiveSession.warning", { title: p.title ?? "" })}</p>
        ) : deleting ? (
          <p>{t("popup.deleteSession.warning", { title: p.title ?? "" })}</p>
        ) : compact ? (
          <textarea
            aria-label={t("composer.compact.instruction")}
            value={p.instruction ?? ""}
            disabled={p.pending === true || state.compactInflight}
            placeholder={t("composer.compact.placeholder")}
            onChange={(event) =>
              dispatch({
                type: "SetCompactInstruction",
                value: event.target.value,
              })
            }
          />
        ) : (
          <input
            className="text-input"
            aria-label={t(
              projectRename ? "popup.projectName" : "popup.sessionTitle",
            )}
            value={p.title}
            disabled={p.pending === true}
            onChange={(event) =>
              dispatch({ type: "SetPopupTitle", value: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") dispatch({ type: "ConfirmPopup" });
              else if (event.key === "Escape")
                dispatch({ type: "DismissPopup" });
            }}
          />
        )}
        <div className="dialog-actions">
          <button
            className="ghost-btn"
            disabled={p.pending === true}
            onClick={() => dispatch({ type: "DismissPopup" })}
          >
            {t("popup.cancel")}
          </button>
          <button
            className={deleting || projectDelete ? "danger-btn" : "primary-btn"}
            disabled={p.pending === true}
            onClick={() => dispatch({ type: "ConfirmPopup" })}
          >
            {deleting || projectDelete
              ? t(p.pending ? "popup.deleting" : "popup.delete")
              : archiving
                ? t(p.pending ? "popup.archiving" : "popup.archive")
                : compact
                  ? t("composer.compact.confirm")
                  : t("popup.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
