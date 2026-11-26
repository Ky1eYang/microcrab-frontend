import React, { useEffect, useMemo, useRef, useState } from "react";
import { relaySelectionKey } from "../../../client/account-preferences";
import type { RelayKey } from "../../../client/relay-keys";
import type { NativeModelSelection } from "../../../client/types";
import { t } from "../../../i18n";
import { useAppFields, useAppStore } from "../../../state";
import { ModalContainer } from "../components/ModalContainer";

type KeyFilterStatus = "all" | "active" | "disabled";

export const ApiKeysView: React.FC<{
  owner: string;
  refreshSignal?: number;
}> = ({ owner, refreshSignal = 0 }) => {
  const { state, dispatch } = useAppFields(["apiBase", "resolvedLocale"]);
  const store = useAppStore();
  const api = store.api;

  const [keys, setKeys] = useState<RelayKey[]>([]);
  const [relayModels, setRelayModels] = useState<NativeModelSelection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const mutationInFlight = useRef(false);
  const [localRefresh, setLocalRefresh] = useState(0);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<KeyFilterStatus>("all");

  const [quickKeyName, setQuickKeyName] = useState("");
  const quickInputRef = useRef<HTMLInputElement>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<RelayKey | null>(null);
  const [formName, setFormName] = useState("");
  const [formProviders, setFormProviders] = useState("");
  const [formModel, setFormModel] = useState("");
  const [formEnabled, setFormEnabled] = useState(true);

  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<RelayKey | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    Promise.all([
      api.listRelayKeys(owner, abort.signal),
      api.readAccountPreferences(owner, abort.signal).catch(() => null),
    ])
      .then(
        ([keyRes, prefs]) => {
          if (!abort.signal.aborted) {
            setKeys(keyRes.keys);
            if (prefs) setRelayModels(prefs.relay_models);
          }
        },
        (cause: unknown) => {
          if (!abort.signal.aborted) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        },
      )
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [api, owner, refreshSignal, localRefresh]);

  const mutate = async (work: () => Promise<void>) => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setPending(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      mutationInFlight.current = false;
      setPending(false);
      setLocalRefresh((n) => n + 1);
    }
  };

  const handleCopy = (text: string, id: string) => {
    void dispatch({ type: "CopyText", value: text });
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(null), 2000);
  };

  const openCreateModal = () => {
    setEditing(null);
    setFormName("");
    setFormProviders("");
    setFormModel("");
    setFormEnabled(true);
    setIsModalOpen(true);
  };

  const openEditModal = (key: RelayKey) => {
    setEditing(key);
    setFormName(key.name);
    setFormProviders(key.allowed_providers?.join(", ") ?? "");
    setFormModel(relaySelectionKey(key.default_model_selection));
    setFormEnabled(key.enabled);
    setIsModalOpen(true);
  };

  const handleQuickCreate = () => {
    if (!quickKeyName.trim()) return;
    const name = quickKeyName.trim();
    setQuickKeyName("");
    void mutate(async () => {
      const created = await api.createRelayKey(owner, { name, enabled: true });
      setRevealedSecret(created.secret);
    });
  };

  const handleSubmitModal = () => {
    if (!formName.trim()) return;
    const trimmedModel = formModel.trim();
    const slash = trimmedModel.indexOf("/");
    if (trimmedModel && (slash <= 0 || !trimmedModel.slice(slash + 1).trim())) {
      setError(t("relayKeys.modelFormat"));
      return;
    }
    const parsedProviders = formProviders.trim()
      ? [
          ...new Set(
            formProviders
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        ]
      : null;

    const payload = {
      name: formName.trim(),
      enabled: formEnabled,
      allowed_providers: parsedProviders,
      default_model_selection: trimmedModel
        ? {
            provider_id: trimmedModel.slice(0, slash).trim(),
            model: trimmedModel.slice(slash + 1).trim(),
          }
        : null,
    };

    const currentEdit = editing;
    setIsModalOpen(false);
    void mutate(async () => {
      if (currentEdit) {
        await api.editRelayKey(owner, currentEdit.id, {
          ...payload,
          expected_revision: currentEdit.revision,
        });
      } else {
        const created = await api.createRelayKey(owner, payload);
        setRevealedSecret(created.secret);
      }
    });
  };

  const relayBaseUrl = new URL("/v1", state.apiBase || window.location.origin).toString();
  const distinctProviders = [...new Set(relayModels.map((m) => m.provider_id))];

  const counts = useMemo(() => {
    let active = 0;
    let disabled = 0;
    for (const k of keys) {
      if (k.enabled) active++;
      else disabled++;
    }
    return { all: keys.length, active, disabled };
  }, [keys]);

  const filteredKeys = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return keys.filter((key) => {
      if (statusFilter === "active" && !key.enabled) return false;
      if (statusFilter === "disabled" && key.enabled) return false;
      if (!q) return true;
      const defaultModel = relaySelectionKey(key.default_model_selection).toLowerCase();
      const providersText = (key.allowed_providers ?? []).join(" ").toLowerCase();
      return (
        key.name.toLowerCase().includes(q) ||
        key.key_prefix.toLowerCase().includes(q) ||
        providersText.includes(q) ||
        defaultModel.includes(q)
      );
    });
  }, [keys, searchQuery, statusFilter]);

  const hasFilters = searchQuery.trim() !== "" || statusFilter !== "all";

  return (
    <div className="sb-view-container space-y-4">
      {/* Top Header, Endpoint Strip & Quick Create Card */}
      <div className="sb-card p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <h2 className="text-base font-semibold text-white">
              {t("relayKeys.title")}
            </h2>
            <p className="text-xs text-neutral-400">
              {t("relayKeys.description")}
            </p>
          </div>
          <button
            type="button"
            className="sb-btn sb-btn-primary shrink-0"
            data-testid="relay-key-open-modal"
            disabled={pending}
            onClick={openCreateModal}
          >
            <span>+ {t("relayKeys.modalCreate")}</span>
          </button>
        </div>

        {/* Relay Endpoint Command Card */}
        <div className="sb-terminal-box p-3.5 space-y-2 text-xs font-mono">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <span className="font-sans text-neutral-400">
                {t("relayKeys.endpoint")}:
              </span>
              <code className="sb-tag-pill text-neutral-200 font-mono">
                {relayBaseUrl}
              </code>
            </div>
            <button
              type="button"
              className="sb-btn sb-btn-ghost sb-btn-sm font-sans"
              onClick={() => handleCopy(relayBaseUrl, "endpoint")}
            >
              {copiedId === "endpoint" ? t("common.copied") : t("common.copy")}
            </button>
          </div>
          <pre className="text-[11px] text-neutral-400 overflow-x-auto m-0">
            <code>{`curl '${relayBaseUrl}/models' -H "Authorization: Bearer $MICROCRAB_KEY"`}</code>
          </pre>
        </div>

        {/* Quick Create Input Strip */}
        <div className="flex flex-wrap items-center gap-2.5 pt-1">
          <input
            ref={quickInputRef}
            type="text"
            className="sb-input flex-1 min-w-[220px]"
            data-testid="relay-key-quick-name"
            placeholder={t("relayKeys.namePlaceholder")}
            maxLength={100}
            value={quickKeyName}
            onChange={(e) => setQuickKeyName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) handleQuickCreate();
            }}
          />
          <button
            type="button"
            className="sb-btn sb-btn-secondary shrink-0"
            data-testid="relay-key-quick-create"
            disabled={pending || !quickKeyName.trim()}
            onClick={handleQuickCreate}
          >
            {t("relayKeys.createButton")}
          </button>
        </div>
      </div>

      {error && (
        <div
          className="sb-card p-3.5 border-rose-500/20 bg-rose-500/10 text-xs text-rose-400"
          role="alert"
        >
          {error}
        </div>
      )}

      {/* Secret Banner for Newly Created Key */}
      {revealedSecret && (
        <div
          className="sb-card p-4 border-amber-500/40 bg-amber-500/5 space-y-3"
          data-testid="relay-key-secret-banner"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-400">
              <svg
                className="w-4 h-4 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>{t("relayKeys.onceNotice")}</span>
            </div>
            <button
              type="button"
              className="sb-btn sb-btn-ghost sb-btn-sm"
              onClick={() => setRevealedSecret(null)}
            >
              ✕ {t("relayKeys.dismissSecret")}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="sb-terminal-box p-3 flex-1 min-w-[200px] font-mono text-xs text-emerald-400 break-all select-all board-secret">
              {revealedSecret}
            </code>
            <button
              type="button"
              className="sb-btn sb-btn-primary shrink-0"
              onClick={() => handleCopy(revealedSecret, "revealed")}
            >
              {copiedId === "revealed" ? t("common.copied") : t("relayKeys.copySecret")}
            </button>
          </div>
        </div>
      )}

      {/* Search & Status Filter Toolbar */}
      <search aria-label={t("relayKeys.title")}>
        <div className="sb-toolbar">
          <div className="sb-search-wrap">
            <svg
              className="sb-search-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="search"
              className="sb-input"
              aria-label={t("relayKeys.searchPlaceholder")}
              placeholder={t("relayKeys.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="sb-search-clear"
                aria-label={t("relayKeys.clearSearch")}
                onClick={() => setSearchQuery("")}
              >
                ×
              </button>
            )}
          </div>

          <div className="sb-filter-pills" role="group" aria-label={t("relayKeys.col.status")}>
            <button
              type="button"
              className="sb-filter-pill"
              aria-pressed={statusFilter === "all"}
              onClick={() => setStatusFilter("all")}
            >
              <span>{t("relayKeys.filter.all")}</span>
              <span className="sb-pill-count">{counts.all}</span>
            </button>
            <button
              type="button"
              className="sb-filter-pill"
              aria-pressed={statusFilter === "active"}
              onClick={() => setStatusFilter("active")}
            >
              <span>{t("relayKeys.filter.active")}</span>
              <span className="sb-pill-count">{counts.active}</span>
            </button>
            <button
              type="button"
              className="sb-filter-pill"
              aria-pressed={statusFilter === "disabled"}
              onClick={() => setStatusFilter("disabled")}
            >
              <span>{t("relayKeys.filter.disabled")}</span>
              <span className="sb-pill-count">{counts.disabled}</span>
            </button>
          </div>
        </div>
      </search>

      {/* Keys Table or Modern Empty State */}
      {loading && keys.length === 0 ? (
        <div className="sb-card p-6 text-xs text-neutral-400" role="status">
          {t("console.loading")}
        </div>
      ) : filteredKeys.length === 0 ? (
        <div className="sb-empty-state" role="status">
          <div className="sb-empty-icon" aria-hidden="true">
            {hasFilters ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
                <path d="m21 2-9.6 9.6" />
                <circle cx="7.5" cy="15.5" r="5.5" />
              </svg>
            )}
          </div>
          <h3 className="sb-empty-title">
            {hasFilters ? t("relayKeys.emptyFilterTitle") : t("relayKeys.emptyTitle")}
          </h3>
          <p className="sb-empty-desc">
            {hasFilters
              ? searchQuery.trim()
                ? t("relayKeys.emptyFilterDesc", { query: searchQuery.trim() })
                : t("relayKeys.emptyFilterDescNoQuery")
              : t("relayKeys.description")}
          </p>
          <div className="sb-empty-actions">
            {hasFilters ? (
              <button
                type="button"
                className="sb-btn sb-btn-secondary"
                onClick={() => {
                  setSearchQuery("");
                  setStatusFilter("all");
                }}
              >
                {t("relayKeys.clearFilters")}
              </button>
            ) : (
              <button
                type="button"
                className="sb-btn sb-btn-primary"
                onClick={openCreateModal}
              >
                + {t("relayKeys.modalCreate")}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="sb-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-dash-line bg-dash-terminal text-[11px] text-neutral-400 font-medium">
                  <th className="py-3 px-4">{t("relayKeys.col.name")}</th>
                  <th className="py-3 px-4">{t("relayKeys.col.prefix")}</th>
                  <th className="py-3 px-4">{t("relayKeys.col.scope")}</th>
                  <th className="py-3 px-4">{t("relayKeys.col.usage")}</th>
                  <th className="py-3 px-4">{t("relayKeys.col.status")}</th>
                  <th className="py-3 px-4 text-right">{t("relayKeys.col.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dash-line">
                {filteredKeys.map((key) => {
                  const defaultModel = relaySelectionKey(key.default_model_selection);
                  return (
                    <tr
                      key={key.id}
                      data-testid={`relay-key-row-${key.id}`}
                      className="hover:bg-dash-soft transition-colors"
                    >
                      <td className="py-3.5 px-4 font-sans text-neutral-200 font-medium">
                        {key.name}
                      </td>
                      <td className="py-3.5 px-4 font-mono">
                        <button
                          type="button"
                          className="sb-tag-pill font-mono hover:opacity-80 cursor-pointer"
                          title={t("relayKeys.copyPrefix")}
                          onClick={() => handleCopy(key.key_prefix, `prefix-${key.id}`)}
                        >
                          <span>{key.key_prefix}••••</span>
                          <span className="text-[10px] text-neutral-400 font-sans">
                            {copiedId === `prefix-${key.id}` ? t("common.copied") : t("common.copy")}
                          </span>
                        </button>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {key.allowed_providers?.length ? (
                            key.allowed_providers.map((pid) => (
                              <span key={pid} className="sb-tag-pill font-mono">
                                {pid}
                              </span>
                            ))
                          ) : (
                            <span className="sb-tag-pill">
                              {t("relayKeys.allProviders")}
                            </span>
                          )}
                          {defaultModel && (
                            <span className="sb-tag-pill font-mono text-neutral-400">
                              {t("relayKeys.defaultTag")}: {defaultModel}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-[11px] text-neutral-400 font-mono">
                        <div>
                          {t("relayKeys.callsUnit", {
                            count: key.request_count.toLocaleString(),
                          })}
                        </div>
                        <div className="text-[10px] text-neutral-500">
                          {key.last_used_at_ms
                            ? new Date(key.last_used_at_ms).toLocaleString(state.resolvedLocale)
                            : t("relayKeys.neverUsed")}
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        {key.enabled ? (
                          <span className="sb-status-pill sb-status-pill-active">
                            <span className="sb-status-dot" aria-hidden="true" />
                            <span>{t("relayKeys.status.active")}</span>
                          </span>
                        ) : (
                          <span className="sb-status-pill sb-status-pill-disabled">
                            <span className="sb-status-dot" aria-hidden="true" />
                            <span>{t("relayKeys.status.disabled")}</span>
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            className="sb-btn sb-btn-ghost sb-btn-sm"
                            disabled={pending}
                            onClick={() =>
                              void mutate(async () => {
                                await api.editRelayKey(owner, key.id, {
                                  enabled: !key.enabled,
                                  expected_revision: key.revision,
                                });
                              })
                            }
                          >
                            {key.enabled
                              ? t("relayKeys.action.disable")
                              : t("relayKeys.action.enable")}
                          </button>
                          <button
                            type="button"
                            className="sb-btn sb-btn-ghost sb-btn-sm"
                            disabled={pending}
                            onClick={() => openEditModal(key)}
                          >
                            {t("common.edit")}
                          </button>
                          <button
                            type="button"
                            className="sb-btn sb-btn-danger sb-btn-sm"
                            data-testid={`relay-key-delete-${key.id}`}
                            disabled={pending}
                            onClick={() => setRevokeTarget(key)}
                          >
                            {t("relayKeys.action.revoke")}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create / Edit Key Modal (Native Top-Layer Dialog via ModalContainer) */}
      <ModalContainer
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editing ? t("relayKeys.modalEditTitle") : t("relayKeys.modalCreate")}
        confirmText={editing ? t("settingsDlg.save") : t("relayKeys.createButton")}
        onConfirm={handleSubmitModal}
        confirmDisabled={!formName.trim() || pending}
      >
        <div className="space-y-3.5 text-xs">
          <div>
            <label htmlFor="relay-key-form-name" className="block text-neutral-400 mb-1 font-medium">
              {t("relayKeys.name")}
            </label>
            <input
              id="relay-key-form-name"
              type="text"
              className="sb-input w-full"
              placeholder={t("relayKeys.namePlaceholder")}
              maxLength={100}
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
            />
          </div>

          <div>
            <label htmlFor="relay-key-form-providers" className="block text-neutral-400 mb-1 font-medium">
              {t("relayKeys.providers")}
            </label>
            <input
              id="relay-key-form-providers"
              type="text"
              className="sb-input w-full"
              placeholder={
                distinctProviders.length
                  ? distinctProviders.join(", ")
                  : "configured, user:myproxy"
              }
              value={formProviders}
              onChange={(e) => setFormProviders(e.target.value)}
            />
            <p className="text-[11px] text-neutral-500 mt-1">
              {t("relayKeys.providersHint")}
            </p>
          </div>

          <div>
            <label htmlFor="relay-key-form-model" className="block text-neutral-400 mb-1 font-medium">
              {t("relayKeys.model")}
            </label>
            <input
              id="relay-key-form-model"
              type="text"
              list="relay-key-model-suggestions"
              className="sb-input w-full"
              placeholder="provider_id/model"
              value={formModel}
              onChange={(e) => setFormModel(e.target.value)}
            />
            <datalist id="relay-key-model-suggestions">
              {relayModels.map((item) => {
                const key = relaySelectionKey(item);
                return <option key={key} value={key} />;
              })}
            </datalist>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="accent-ink"
              checked={formEnabled}
              onChange={(e) => setFormEnabled(e.target.checked)}
            />
            <span className="text-neutral-300">{t("relayKeys.enabledLabel")}</span>
          </label>

          {!editing && (
            <div className="sb-terminal-box p-3 text-neutral-500 text-[11px] leading-relaxed">
              {t("relayKeys.onceNotice")}
            </div>
          )}
        </div>
      </ModalContainer>

      <ModalContainer
        isOpen={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        title={t("relayKeys.revokeTitle")}
        maxWidth="max-w-sm"
        footer={
          <>
            <button
              type="button"
              className="sb-btn sb-btn-secondary"
              onClick={() => setRevokeTarget(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="sb-btn sb-btn-danger"
              data-testid="relay-key-confirm-revoke"
              onClick={() => {
                if (!revokeTarget) return;
                const target = revokeTarget;
                setRevokeTarget(null);
                void mutate(async () => {
                  await api.revokeRelayKey(owner, target.id, target.revision);
                });
              }}
            >
              {t("relayKeys.action.revoke")}
            </button>
          </>
        }
      >
        <p className="text-xs text-neutral-300 leading-relaxed">
          {revokeTarget
            ? t("relayKeys.revokeConfirm", { name: revokeTarget.name })
            : ""}
        </p>
      </ModalContainer>
    </div>
  );
};
