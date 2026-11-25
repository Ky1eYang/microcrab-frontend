import { referenceLabels } from "../referenceLabels";
import { useEffect, useRef, useState } from "react";
import { trapFocus } from "../../client/viewport";
import { useApp } from "../../state";
import { selectedModel } from "../../state/model";
import { applySnapshot } from "../../client";
import { Icon } from "../shared";
import { diagnosticMessage, reportDiagnostic } from "../../client/diagnostics";
import { t } from "../../i18n";
import { Markdown } from "../views";

export function SearchDialog() {
  const { state, dispatch } = useApp(),
    p = state.popup;
  const sessionLabel = referenceLabels("session", state.sessions.map((row) => row.id));
  const sessions = state.sessions.filter(
    (s) =>
      !s.parentID &&
      `${s.title} ${s.id} ${sessionLabel(s.id)}`.toLowerCase().includes(p.query.toLowerCase()),
  );
  const selected = state.sessions.find(
    (s) => s.id === (p.selectedId ?? sessions[0]?.id),
  );
  const [meta, setMeta] = useState(false),
    [preview, setPreview] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setPreview(null);
    setPreviewError(null);
    if (!selected) {
      setLoading(false);
      return;
    }
    const sid = selected.id;
    const memory =
      sid === state.sessionId
        ? [...state.transcript.blocks]
            .reverse()
            .find((b) => b.role === "assistant" && b.payload.text.trim())
            ?.payload.text
        : null;
    if (memory) {
      setPreview(memory);
      setLoading(false);
      return;
    }
    setLoading(true);
    void dispatch({ type: "GetSessionSnapshot", value: sid })
      .then((snapshot) => {
        if (live && snapshot)
          setPreview(
            [...applySnapshot(snapshot).blocks]
              .reverse()
              .find((b) => b.role === "assistant" && b.payload.text.trim())
              ?.payload.text ?? null,
          );
      })
      .catch((error: unknown) => {
        if (!live) return;
        reportDiagnostic("search", "preview", error);
        setPreviewError(
          `${t("search.session.previewFailed")} ${diagnosticMessage(error)}`,
        );
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [selected?.id, state.connection, state.sessionId]);
  const emit = (type: string, value?: unknown) => dispatch({ type, value });
  const dialog = useRef<HTMLDivElement>(null);
  // Modal keyboard contract (same as SessionPermissionsDialog): Tab and
  // Shift+Tab cycle inside the dialog, Escape closes, and focus returns to the opener.
  // Captured during the first render, before autoFocus moves focus into the input.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Tab") trapFocus(dialog.current, event);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void dispatch({ type: "DismissPopup", value: undefined });
      }
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      // Restore only when focus would otherwise fall to <body>. Opening a
      // session deliberately moves focus to the new view.
      requestAnimationFrame(() => {
        if (
          opener?.isConnected &&
          (!document.activeElement || document.activeElement === document.body)
        )
          opener.focus();
      });
    };
  }, []);
  const open = (id: string) => {
    emit("Attach", id);
    emit("DismissPopup");
  };
  return (
    <div className="overlay">
      <div
        ref={dialog}
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("search.session.dialog")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="search-dialog-header">
          <Icon name="search" size={18} className="search-dialog-icon" />
          <input
            className="search-dialog-input"
            type="text"
            autoFocus
            placeholder={t("search.session.placeholder")}
            value={p.query}
            onChange={(e) => emit("SetSearchQuery", e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && selected) open(selected.id);
            }}
          />
          <button
            type="button"
            className="search-dialog-close-btn"
            data-testid="search-close"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={() => emit("DismissPopup")}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="search-dialog-body">
          <aside className="search-dialog-list">
            <div className="search-list-section-header">
              <span>{t("search.session.list")}</span>
              <span className="search-list-count">{sessions.length}</span>
            </div>
            {!sessions.length ? (
              <div className="search-empty-state">
                {t("search.session.empty")}
              </div>
            ) : (
              <div className="search-items-scroll">
                {sessions.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    className="search-result-item"
                    data-testid="search-result"
                    data-selected={selected?.id === s.id}
                    aria-pressed={selected?.id === s.id}
                    onClick={() => emit("SelectSearchSession", s.id)}
                    onDoubleClick={() => open(s.id)}
                  >
                    <svg
                      className="search-result-icon"
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <div className="search-result-text">
                      <div className="search-result-title">{s.title || sessionLabel(s.id)}</div>
                      <div className="search-result-sub">
                        <span className="search-result-id">
                          #{sessionLabel(s.id)}
                        </span>
                        {s.agent && (
                          <span className="search-result-agent">
                            {" "}
                            • {s.agent}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </aside>
          <section className="search-dialog-preview">
            {selected ? (
              <div className="search-preview-card">
                <div className="search-preview-top">
                  <div className="search-preview-badge">
                    {t("search.session.preview")}
                  </div>
                  <button
                    type="button"
                    className="primary-btn search-open-btn"
                    data-testid="search-open-session"
                    onClick={() => open(selected.id)}
                  >
                    {t("search.session.open")}
                  </button>
                </div>
                <h3 className="search-preview-title">{selected.title}</h3>
                <div className="preview-info-accordion">
                  <button
                    className="preview-info-toggle-btn"
                    type="button"
                    onClick={() => setMeta(!meta)}
                  >
                    <span>{t("search.session.details")}</span>
                    <span className="toggle-chevron">
                      {meta
                        ? t("search.session.collapse")
                        : t("search.session.expand")}
                    </span>
                  </button>
                  {meta && (
                    <div className="search-preview-meta-grid">
                      {[
                        [t("search.session.id"), sessionLabel(selected.id), "mono"],
                        [
                          t("search.session.workspace"),
                          state.currentWorkspace,
                          "",
                        ],
                        [t("search.session.status"), selected.status, ""],
                        [
                          t("search.session.agent"),
                          selected.agent ?? t("search.session.defaultAgent"),
                          "",
                        ],
                        ...(selected.model
                          ? [
                              [
                                t("search.session.model"),
                                `${selected.model.providerId}/${selected.model.id}`,
                                "mono",
                              ],
                            ]
                          : []),
                      ].map(([label, value, cls]) => (
                        <div className="preview-meta-item" key={label}>
                          <div className="preview-meta-label">{label}</div>
                          <div className={`preview-meta-value ${cls}`}>
                            {value}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="preview-response-section">
                  <div className="preview-section-header">
                    <span className="preview-section-title">
                      {t("search.session.latest")}
                    </span>
                  </div>
                  {loading ? (
                    <div className="preview-loading-hint">
                      {t("search.session.loading")}
                    </div>
                  ) : previewError ? (
                    <p role="alert">{previewError}</p>
                  ) : preview ? (
                    <div className="preview-response-content preview-response-markdown">
                      <Markdown text={preview} />
                    </div>
                  ) : (
                    <div className="preview-response-empty">
                      {t("search.session.noResponse")}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="search-preview-empty">
                {t("search.session.pick")}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
export function ModelDialog() {
  const { state, dispatch } = useApp(),
    query = state.popup.query ?? "";
  useEffect(() => {
    void dispatch({ type: "LoadModelMetadata" });
  }, []);
  const metadataTime = state.modelMetadataStatus?.fetched_at_ms;
  const currentModel = selectedModel(state);
  const selectionDisabled =
    state.connection !== "ws" ||
    !state.authSession?.authenticated ||
    (!!state.sessionId &&
      !state.capabilities?.methods.includes("session.set_model")) ||
    state.modeSelectionPending ||
    state.modelSelectionPending ||
    state.isCreatingSession ||
    !!state.sessions.find((s) => s.id === state.sessionId)?.parentID;
  const filtered = state.availableModels.filter((m) =>
    `${m.name} ${m.id} ${m.providerId}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const providers = [...new Set(filtered.map((m) => m.providerId))].sort();
  return (
    <div className="overlay">
      <div
        className="dialog model-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("search.model.dialog")}
      >
        <div className="model-dialog-header">
          <Icon name="search" size={18} className="model-search-icon" />
          <input
            className="model-search-input"
            type="text"
            autoFocus
            placeholder={t("search.model.placeholder")}
            value={query}
            onChange={(e) =>
              dispatch({ type: "SetModelSearchQuery", value: e.target.value })
            }
            onKeyDown={(e) =>
              e.key === "Escape" && dispatch({ type: "DismissPopup" })
            }
          />
          <button
            className="search-dialog-close-btn"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={() => dispatch({ type: "DismissPopup" })}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="model-dialog-body">
          {!state.availableModels.length ? (
            <div className="search-empty-state">
              <Icon
                name="clock"
                size={28}
                className="empty-icon"
                aria-hidden="true"
              />
              <p className="empty-title">{t("search.model.none")}</p>
              <p className="empty-hint">{t("search.model.noneHint")}</p>
            </div>
          ) : !providers.length ? (
            <div className="search-empty-state">
              <Icon
                name="search"
                size={28}
                className="empty-icon"
                aria-hidden="true"
              />
              <p className="empty-title">{t("search.model.empty")}</p>
              <p className="empty-hint">
                {t("search.model.emptyHint", { query })}
              </p>
            </div>
          ) : (
            providers.map((provider) => (
              <div className="model-provider-group" key={provider}>
                <div className="model-provider-title">
                  <span>{provider.toUpperCase()}</span>
                  <span className="search-list-count">
                    {filtered.filter((m) => m.providerId === provider).length}
                  </span>
                </div>
                {filtered
                  .filter((m) => m.providerId === provider)
                  .map((m) => {
                    const selected =
                      currentModel?.id === m.id &&
                      currentModel?.providerId === provider;
                    return (
                      <button
                        className="model-item-row"
                        data-testid="model-item"
                        data-selected={selected}
                        key={`${m.providerId}:${m.id}`}
                        disabled={selectionDisabled}
                        title={
                          selectionDisabled
                            ? t("search.model.locked")
                            : undefined
                        }
                        onClick={() =>
                          dispatch({ type: "SelectDraftModel", value: m })
                        }
                      >
                        <div className="model-item-left">
                          <span className="model-item-icon" aria-hidden="true">
                            <Icon name="model" size={16} />
                          </span>
                          <div className="model-item-info">
                            <span className="model-item-name">{m.name}</span>
                            <span className="model-item-id">
                              {provider}/{m.id}
                            </span>
                          </div>
                        </div>
                        {selected && (
                          <span className="model-selected-badge">
                            <Icon name="check" size={14} aria-hidden="true" />{" "}
                            {t("search.model.selected")}
                          </span>
                        )}
                      </button>
                    );
                  })}
              </div>
            ))
          )}
        </div>
        <div className="model-dialog-footer">
          <span role="status" data-testid="model-metadata-status">
            {state.modelMetadataError ??
              (state.modelMetadataStatus?.last_error
                ? t("models.metadata.failed")
                : metadataTime
                  ? t("models.metadata.updated", {
                      time: new Date(metadataTime).toLocaleString(),
                    })
                  : t("models.metadata.missing"))}
          </span>
          <button
            type="button"
            className="ghost-btn"
            data-testid="model-metadata-refresh"
            disabled={state.modelMetadataPending === true}
            onClick={() => dispatch({ type: "RefreshModelMetadata" })}
          >
            {t(
              state.modelMetadataPending
                ? "models.metadata.refreshing"
                : "models.metadata.refresh",
            )}
          </button>
          <span className="model-footer-stats">
            {t("search.model.count", {
              total: state.availableModels.length,
              shown: filtered.length,
            })}
          </span>
          <button
            className="ghost-btn"
            onClick={() => dispatch({ type: "DismissPopup" })}
          >
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
