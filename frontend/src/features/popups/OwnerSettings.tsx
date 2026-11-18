import "../../styles/owner-settings.css";
import { PredicateEditor } from "./SessionPermissionsDialog/PredicateEditor";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useApp } from "../../state";
import { t } from "../../i18n";
import {
  LIMIT_FIELDS,
  PROMPT_FIELDS,
  validateSettingsOverrides,
  validateProviderConfig,
  type SettingsSnapshot,
  type SettingsOverrides,
  type ProviderConfig,
  type PublicProvider,
  type ModelOverlay,
} from "../../client/settings";
import { ModelCombobox } from "../ModelCombobox";
import { SearchableSelect } from "../SearchableSelect";
import { Payload } from "../Payload";
import { PromptSettings } from "./PromptSettings";

type Scope =
  | { kind: "user" }
  | { kind: "project"; id: string }
  | { kind: "session"; id: string };
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const byteHint = (bytes: number) => {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return t("settingsUX.byteHint", {
    value: `${Number(value.toFixed(2))} ${units[unit]}`,
  });
};

/** Local validation routes concrete protocol paths to the actual editable control. */
function clearFailure(root: HTMLElement | null) {
  root?.querySelectorAll("[aria-invalid]").forEach((node) => {
    node.removeAttribute("aria-invalid");
    node.removeAttribute("aria-errormessage");
  });
  root
    ?.querySelectorAll(".settings-field-error")
    .forEach((node) => node.remove());
}
function focusFailure(root: HTMLElement | null, path: string, message: string) {
  if (!root) return;
  clearFailure(root);
  const controls = [
    ...root.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >("[data-validation-path]"),
  ];
  const control =
    controls.find((node) => node.dataset.validationPath === path) ??
    controls.find(
      (node) =>
        path.startsWith(node.dataset.validationPath + ".") ||
        path.startsWith(node.dataset.validationPath + "["),
    );
  if (!control) return;
  const detail = document.createElement("p");
  detail.className = "settings-field-error";
  detail.id = `${root.dataset.testid}-field-error`;
  detail.textContent = message;
  detail.setAttribute("role", "alert");
  control.setAttribute("aria-invalid", "true");
  control.setAttribute("aria-errormessage", detail.id);
  control.insertAdjacentElement("afterend", detail);
  control.focus({ preventScroll: true });
  control.scrollIntoView({ block: "center", behavior: "instant" });
}
const failurePath = (failure: unknown) => {
  const path = errorText(failure).split(":")[0];
  return path === "settings.auto_compaction"
    ? "settings.auto_compaction.turn_threshold"
    : path;
};

/** Each scope has its own CAS record. Saving defaults never applies to live Sessions. */
export function OwnerSettings({ scope = { kind: "user" } }: { scope?: Scope }) {
  const { state, dispatch } = useApp();
  const identity = JSON.stringify([
    state.authSession?.principal?.owner,
    scope.kind,
    "id" in scope ? scope.id : "",
  ]);
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<SettingsOverrides>({});
  const [rules, setRules] = useState("[]");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const form = useRef<HTMLElement>(null);
  const scopeParams = scope.kind === "project" ? { project_id: scope.id } : {};
  const method = scope.kind === "user" ? "settings" : `${scope.kind}.settings`;
  const request = (operation: "get" | "set", params = {}) =>
    dispatch({
      type: "SettingsRequest",
      method: `${method}.${operation}`,
      params: { ...scopeParams, ...params },
      sessionId: scope.kind === "session" ? scope.id : undefined,
    });
  const install = (next: SettingsSnapshot) => {
    setSnapshot(next);
    setDraft(structuredClone(next.overrides));
    setRules(JSON.stringify(next.overrides.permissions ?? [], null, 2));
  };
  const load = async () => {
    const ticket = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const next = await request("get");
      if (ticket === generation.current) install(next);
    } catch (failure) {
      if (ticket === generation.current) setError(errorText(failure));
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  };
  useEffect(() => {
    setSnapshot(null);
    setDraft({});
    setStatus("");
    void load();
    return () => {
      generation.current++;
    };
  }, [identity]);
  const change = (key: keyof SettingsOverrides, value: unknown) => {
    setStatus("");
    setDraft((current) => {
      const next = { ...current };
      if (value === undefined) delete next[key];
      else (next as Record<string, unknown>)[key] = value;
      return next;
    });
  };
  const save = async () => {
    if (!snapshot || busy) return;
    const ticket = generation.current;
    try {
      const next = { ...draft };
      for (const field of PROMPT_FIELDS)
        if (scope.kind === "session" || next[field] == null) delete next[field];
      if (draft.permissions !== undefined) {
        try {
          next.permissions = JSON.parse(rules);
        } catch {
          throw Error(t("settingsUX.rulesJson"));
        }
      }
      for (const field of LIMIT_FIELDS) {
        const value = next.limits?.[field];
        if (value !== undefined && value > snapshot.constraints.limits[field])
          throw Error(
            `settings.limits.${field}: ${t("settingsUX.maximum", { value: snapshot.constraints.limits[field] })}`,
          );
      }
      validateSettingsOverrides(next);
      setBusy(true);
      setError("");
      const saved = await request("set", {
        expected_revision: snapshot.revision,
        overrides: next,
      });
      if (ticket === generation.current) {
        install(saved);
        setStatus(
          t(
            scope.kind === "session"
              ? `ownerSettings.application.${saved.application}`
              : "ownerSettings.saved",
          ) + (saved.reason ? ` · ${saved.reason}` : ""),
        );
      }
    } catch (failure) {
      if (ticket === generation.current) {
        setError(errorText(failure));
        focusFailure(
          form.current,
          errorText(failure) === t("settingsUX.rulesJson")
            ? "settings.permissions"
            : failurePath(failure),
          errorText(failure),
        );
      }
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  };
  const models = state.availableModels.flatMap((model) =>
    [null, ...model.variants].map((variant) => ({
      label: `${model.name} · ${model.providerId}${variant ? ` · ${variant}` : ""}`,
      value: {
        provider_id: model.providerId,
        model: model.id,
        ...(variant ? { variant } : {}),
      },
    })),
  );
  const modelSelect = (field: "model_selection" | "review_model") => (
    <ModelCombobox
      label={t(`ownerSettings.${field}`)}
      models={models}
      value={draft[field]}
      allowCurrent={field === "review_model"}
      disabled={busy}
      recentScope={
        state.authSession?.principal?.owner
          ? JSON.stringify([state.apiBase, state.authSession.principal.owner])
          : undefined
      }
      onChange={(value) => change(field, value)}
    />
  );
  const booleanSelect = (field: "review" | "auto_naming") => (
    <select
      className="settings-input"
      aria-label={t(`ownerSettings.${field}`)}
      disabled={busy}
      value={draft[field] === undefined ? "" : String(draft[field])}
      onChange={(e) =>
        change(
          field,
          e.target.value === "" ? undefined : e.target.value === "true",
        )
      }
    >
      <option value="">{t("ownerSettings.inherit")}</option>
      <option value="true">{t("ownerSettings.enabled")}</option>
      <option value="false">{t("ownerSettings.disabled")}</option>
    </select>
  );
  const source = (field: string) => (
    <span className="settings-row-sub">
      {t("ownerSettings.effective", {
        value:
          JSON.stringify(
            (snapshot?.effective as unknown as Record<string, unknown>)?.[
              field
            ],
          ) ?? "—",
        source: t(
          `ownerSettings.source.${snapshot?.sources[field] ?? "admin"}`,
        ),
      })}
    </span>
  );
  return (
    <section
      ref={form}
      onChangeCapture={() => clearFailure(form.current)}
      className="settings-ergonomics"
      data-testid={`owner-settings-${scope.kind}`}
      aria-busy={busy}
    >
      <p className="settings-description">
        {t(
          scope.kind === "session"
            ? "ownerSettings.liveHint"
            : "ownerSettings.defaultsHint",
        )}
      </p>
      <p className="settings-description">{t("ownerSettings.precedence")}</p>
      {error && (
        <p role="alert" className="inline-notice" data-tone="danger">
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="inline-notice">
          {status}
        </p>
      )}
      {snapshot && (
        <>
          <section
            className="settings-section-card settings-model-default"
            data-testid="settings-model-default"
          >
            <div className="settings-section-head">
              <h4 className="settings-section-title">
                {t(
                  scope.kind === "session"
                    ? "ownerSettings.model_selection"
                    : "settingsUX.newSessionModel",
                )}
              </h4>
              <div className="settings-section-meta">
                <span
                  className="limit-source-pill"
                  data-testid="settings-revisions"
                >
                  {t("ownerSettings.revisions", {
                    desired: snapshot.revision,
                    applied: snapshot.applied_revision ?? snapshot.revision,
                  })}
                </span>
              </div>
            </div>
            <p className="settings-description">
              {t(
                scope.kind === "session"
                  ? "ownerSettings.liveHint"
                  : "settingsUX.newSessionHint",
              )}
            </p>
            {modelSelect("model_selection")}
            {source("model_selection")}
            <p className="inline-notice" data-testid="settings-application">
              {t(`ownerSettings.application.${snapshot.application}`)}
              {snapshot.reason && ` · ${snapshot.reason}`}
            </p>
            {snapshot.applied_revision !== snapshot.revision && (
              <Payload
                value={snapshot.desired_effective}
                testid="settings-desired-effective"
              />
            )}
          </section>

          <section className="settings-section-card">
            <div className="settings-section-head">
              <h4 className="settings-section-title">
                {t("ownerSettings.agentMode")}
              </h4>
            </div>
            <div className="settings-form-grid">
              <div className="settings-form-group">
                <span className="settings-form-label">
                  {t("ownerSettings.agent")}
                </span>
                <SearchableSelect<string | undefined>
                  label={t("ownerSettings.agent")}
                  disabled={busy}
                  valueKey={draft.agent ?? ""}
                  options={[
                    {
                      key: "",
                      label: t("ownerSettings.inherit"),
                      value: undefined,
                    },
                    ...state.agents.map((agent) => ({
                      key: agent.name,
                      label: agent.name,
                      value: agent.name,
                    })),
                  ]}
                  onChange={(value) => {
                    change("agent", value);
                    change("mode", undefined);
                  }}
                />
                {source("agent")}
              </div>
              <div className="settings-form-group">
                <span className="settings-form-label">
                  {t("ownerSettings.mode")}
                </span>
                <SearchableSelect<string | undefined>
                  label={t("ownerSettings.mode")}
                  disabled={busy}
                  valueKey={draft.mode ?? ""}
                  options={[
                    {
                      key: "",
                      label: t("ownerSettings.inherit"),
                      value: undefined,
                    },
                    ...(state.agents
                      .find(
                        (agent) =>
                          agent.name ===
                          (draft.agent ?? snapshot.effective.agent),
                      )
                      ?.modes.map((mode) => ({
                        key: mode.name,
                        label: mode.description
                          ? `${mode.name} · ${mode.description}`
                          : mode.name,
                        value: mode.name,
                      })) ?? []),
                  ]}
                  onChange={(value) => change("mode", value)}
                />
                {source("mode")}
              </div>
            </div>
            {scope.kind === "session" &&
              state.publicState?.mode_prompt !== undefined && (
                <div className="settings-subpanel">
                  <div className="settings-section-title">
                    {t("ownerSettings.modeState")}
                  </div>
                  <p className="settings-description">
                    {t("ownerSettings.modeBoundary")}
                  </p>
                  <Payload
                    value={{
                      mode: state.publicState.mode,
                      mode_prompt: state.publicState.mode_prompt,
                    }}
                    testid="settings-mode-state"
                  />
                </div>
              )}
          </section>

          <PromptSettings draft={draft} snapshot={snapshot} busy={busy}
            frozen={scope.kind === "session"} onChange={change} />

          <section className="settings-section-card">
            <div className="settings-section-head">
              <h4 className="settings-section-title">
                {t("ownerSettings.limits")}
              </h4>
            </div>
            <div className="limits-groups-stack">
              {(
                [
                  {
                    key: "timeouts",
                    fields: [
                      "interaction_timeout_ms",
                      "lifecycle_timeout_ms",
                      "sleep_max_ms",
                    ],
                  },
                  {
                    key: "bytes",
                    fields: [
                      "max_context_bytes",
                      "max_tool_output_bytes",
                      "max_tool_image_bytes",
                      "output_buffer_bytes",
                      "max_output_tokens",
                    ],
                  },
                  {
                    key: "processes",
                    fields: [
                      "max_processes",
                      "max_retained_processes",
                      "max_pending_executions",
                      "max_retained_executions",
                      "max_execution_buffers",
                    ],
                  },
                  {
                    key: "rounds",
                    fields: ["max_rounds", "max_tool_calls_per_round"],
                  },
                ] as const
              ).map((group) => (
                <div className="limits-group-card" key={group.key}>
                  <h5 className="limits-group-title">
                    {t(`ownerSettings.limitGroup.${group.key}`)}
                  </h5>
                  <div className="limits-grid">
                    {group.fields.map((field) => {
                      const unit = field.endsWith("_ms")
                        ? "ms"
                        : field.endsWith("_bytes")
                          ? "bytes"
                          : field.endsWith("_tokens")
                            ? "tokens"
                            : "";
                      const effectiveVal = snapshot.effective.limits[field];
                      const sourceKey =
                        snapshot.sources[`limits.${field}`] ?? "admin";
                      return (
                        <label className="limit-tile" key={field}>
                          <div className="limit-tile-top">
                            <span className="limit-tile-label">
                              {t(`ownerSettings.limit.${field}`)}
                            </span>
                            <span className="limit-source-pill">
                              {draft.limits?.[field] === undefined
                                ? t("ownerSettings.inherit")
                                : t(`ownerSettings.source.${scope.kind}`)}
                            </span>
                          </div>
                          <div className="limit-input-wrap">
                            <input
                              className="settings-input"
                              disabled={busy}
                              data-testid={`limit-${field}`}
                              data-validation-path={`settings.limits.${field}`}
                              type="number"
                              min={field === "max_retained_processes" ? 0 : 1}
                              step="1"
                              max={snapshot.constraints.limits[field]}
                              placeholder={String(
                                snapshot.effective.limits[field],
                              )}
                              value={draft.limits?.[field] ?? ""}
                              onChange={(e) => {
                                const limits = { ...draft.limits };
                                if (e.target.value === "") delete limits[field];
                                else limits[field] = Number(e.target.value);
                                change(
                                  "limits",
                                  Object.keys(limits).length
                                    ? limits
                                    : undefined,
                                );
                              }}
                            />
                            {unit && <span className="limit-unit">{unit}</span>}
                          </div>
                          <div className="limit-tile-meta">
                            <span>
                              {t("ownerSettings.effective", {
                                value: field.endsWith("_bytes")
                                  ? `${effectiveVal} · ${byteHint(effectiveVal)}`
                                  : effectiveVal,
                                source: t(`ownerSettings.source.${sourceKey}`),
                              })}
                              {field.endsWith("_bytes") &&
                                draft.limits?.[field] !== undefined &&
                                draft.limits[field] !== effectiveVal && (
                                  <span className="limit-draft-hint">
                                    {t("ownerSettings.draftValue", {
                                      value: byteHint(draft.limits[field]),
                                    })}
                                  </span>
                                )}
                            </span>
                            <span>
                              {t("ownerSettings.limitMax", {
                                maximum: snapshot.constraints.limits[field],
                              })}
                            </span>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-section-head">
              <h4 className="settings-section-title">
                {t("ownerSettings.permissions")}
              </h4>
            </div>
            <div className="settings-form-grid">
              <label className="settings-form-group">
                <span className="settings-form-label">
                  {t("ownerSettings.initialization")}
                </span>
                <select
                  className="settings-input"
                  disabled={busy}
                  value={draft.initialization ?? ""}
                  onChange={(e) =>
                    change("initialization", e.target.value || undefined)
                  }
                >
                  <option value="">{t("ownerSettings.inherit")}</option>
                  {["allow", "ask", "deny"].map((action) => (
                    <option key={action} value={action}>
                      {t(`permission.action.${action}`)}
                    </option>
                  ))}
                </select>
                {source("initialization")}
              </label>
              <label className="settings-form-group">
                <span className="settings-form-label">
                  {t("ownerSettings.review")}
                </span>
                {booleanSelect("review")}
                {source("review")}
              </label>
            </div>
            <label className="settings-form-group">
              <span className="settings-form-label">
                {t("ownerSettings.review_model")}
              </span>
              {modelSelect("review_model")}
              {source("review_model")}
            </label>
            <label className="settings-toggle-row">
              <span>{t("ownerSettings.overridePermissions")}</span>
              <input
                type="checkbox"
                disabled={busy}
                checked={draft.permissions !== undefined}
                onChange={(e) =>
                  change("permissions", e.target.checked ? [] : undefined)
                }
              />
            </label>
            {draft.permissions !== undefined && (
              <div className="settings-subpanel">
                <PredicateEditor
                  rules={draft.permissions}
                  disabled={busy}
                  onChange={(permissions) => {
                    change("permissions", permissions);
                    setRules(JSON.stringify(permissions, null, 2));
                  }}
                />
                <label className="settings-form-group">
                  <span className="settings-form-label">
                    {t("ownerSettings.permissionRules")}
                  </span>
                  <textarea
                    className="settings-input monospace-text"
                    rows={8}
                    disabled={busy}
                    value={rules}
                    onChange={(e) => setRules(e.target.value)}
                    data-testid="settings-permission-rules"
                    data-validation-path="settings.permissions"
                  />
                </label>
              </div>
            )}
          </section>

          <section className="settings-section-card">
            <div className="settings-section-head">
              <h4 className="settings-section-title">
                {t("ownerSettings.behavior")}
              </h4>
            </div>
            <label className="settings-form-group">
              <span className="settings-form-label">
                {t("ownerSettings.auto_naming")}
              </span>
              {booleanSelect("auto_naming")}
              {source("auto_naming")}
            </label>
            <label className="settings-toggle-row">
              <span>{t("ownerSettings.overrideCompaction")}</span>
              <input
                type="checkbox"
                disabled={busy}
                checked={draft.auto_compaction !== undefined}
                onChange={(e) =>
                  change(
                    "auto_compaction",
                    e.target.checked
                      ? (snapshot.effective.auto_compaction ?? {
                          enabled: true,
                          turn_threshold: 0.8,
                          round_threshold: 0.95,
                          headroom_tokens: 0,
                        })
                      : undefined,
                  )
                }
              />
            </label>
            {draft.auto_compaction && (
              <div className="settings-subpanel">
                <label className="settings-toggle-row">
                  <span>{t("ownerSettings.enabled")}</span>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={draft.auto_compaction.enabled}
                    onChange={(e) =>
                      change("auto_compaction", {
                        ...draft.auto_compaction,
                        enabled: e.target.checked,
                      })
                    }
                  />
                </label>
                <div className="settings-form-grid-3">
                  {(
                    [
                      "turn_threshold",
                      "round_threshold",
                      "headroom_tokens",
                    ] as const
                  ).map((field) => (
                    <label className="settings-form-group" key={field}>
                      <span className="settings-form-label">
                        {t(`ownerSettings.${field}`)}
                      </span>
                      <input
                        className="settings-input"
                        type="number"
                        disabled={busy}
                        step={field === "headroom_tokens" ? 1 : 0.01}
                        data-validation-path={`settings.auto_compaction.${field}`}
                        value={draft.auto_compaction![field]}
                        onChange={(e) =>
                          change("auto_compaction", {
                            ...draft.auto_compaction,
                            [field]: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}
            {source("auto_compaction")}
          </section>
        </>
      )}
      <div className="settings-actions-row settings-sticky-actions">
        <button
          className="primary-btn"
          disabled={!snapshot || busy}
          onClick={() => void save()}
          data-testid="settings-save"
        >
          {t(
            scope.kind === "session"
              ? "ownerSettings.apply"
              : "ownerSettings.save",
          )}
        </button>
        <button
          className="ghost-btn"
          disabled={busy}
          onClick={() => void load()}
        >
          {t("ownerSettings.reload")}
        </button>
        <button
          className="ghost-btn"
          disabled={!snapshot || busy}
          onClick={() => {
            setDraft({});
            setRules("[]");
            setStatus("");
          }}
        >
          {t("ownerSettings.reset")}
        </button>
      </div>
    </section>
  );
}

const emptyProvider = (): ProviderConfig => ({
  name: "",
  protocol: "openai-compatible",
  endpoint: "",
  auth: "native",
  timeout_ms: 60000,
  max_response_bytes: 1073741824,
  models: [],
});
export function ProvidersSettings() {
  const { state, dispatch } = useApp();
  const owner = JSON.stringify([
    state.apiBase,
    state.authSession?.principal?.owner,
  ]);
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [selected, setSelected] = useState<PublicProvider | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [id, setId] = useState("");
  const [draft, setDraft] = useState<ProviderConfig>(emptyProvider);
  const [keyAction, setKeyAction] = useState("retain");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [modelFilter, setModelFilter] = useState<
    "all" | "enabled" | "overridden"
  >("all");
  const [expandedModelKey, setExpandedModelKey] = useState<string | null>(null);
  const generation = useRef(0);
  const listRequest = useRef(0);
  const editIntent = useRef(0);
  const activeSelection = useRef<{ id: string | null; creating: boolean }>({
    id: null,
    creating: false,
  });
  const busyRef = useRef(false);
  const modelKeys = useRef<string[]>([]);
  const nextModelKey = useRef(0);
  const controlId = useId();
  const [configOpen, setConfigOpen] = useState(true);
  const [pendingFailure, setPendingFailure] = useState<{
    path: string;
    message: string;
  } | null>(null);
  const form = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (pendingFailure) {
      focusFailure(form.current, pendingFailure.path, pendingFailure.message);
      setPendingFailure(null);
    }
  }, [pendingFailure]);
  const readonly = selected?.read_only || selected?.scope === "admin";
  const request = (method: string, params = {}) =>
    dispatch({ type: "SettingsRequest", method, params });
  const edit = (provider: PublicProvider | null, isNew = false) => {
    editIntent.current++;
    activeSelection.current = { id: provider?.id ?? null, creating: isNew };
    modelKeys.current = (provider?.models ?? []).map(
      () => `manual-${++nextModelKey.current}`,
    );
    setConfigOpen(true);
    setPendingFailure(null);
    setModelSearch("");
    setModelFilter("all");
    setSelected(provider);
    setCreatingNew(isNew);
    setId(provider?.id ?? "");
    setDraft(
      provider
        ? {
            name: provider.name,
            protocol: provider.protocol,
            endpoint: provider.endpoint,
            auth: provider.auth,
            timeout_ms: provider.timeout_ms,
            max_response_bytes: provider.max_response_bytes,
            models: structuredClone(provider.models),
          }
        : emptyProvider(),
    );
    setSecret("");
    setKeyAction("retain");
    setError("");
    setStatus("");
    setDeleteConfirm(false);
    setExpandedModelKey(null);
  };
  const load = async (reloadSelected = false) => {
    const ticket = generation.current;
    const requestId = ++listRequest.current;
    const intent = editIntent.current;
    try {
      const next = await request("provider.list");
      if (ticket !== generation.current || requestId !== listRequest.current)
        return;
      setProviders(next.items);
      if (intent !== editIntent.current || busyRef.current) return;
      const active = activeSelection.current;
      if (!active.creating && (!active.id || reloadSelected)) {
        const provider =
          next.items.find((item: PublicProvider) => item.id === active.id) ??
          next.items[0];
        if (provider) edit(provider, false);
        else if (reloadSelected) edit(null, false);
      }
    } catch (failure) {
      if (
        ticket === generation.current &&
        requestId === listRequest.current &&
        intent === editIntent.current
      )
        setError(errorText(failure));
    }
  };
  useEffect(() => {
    generation.current++;
    busyRef.current = false;
    setBusy(false);
    setProviders([]);
    edit(null, false);
    void load();
    return () => {
      generation.current++;
    };
  }, [owner]);
  const mutate = async (method: string) => {
    if (readonly || busyRef.current) return;
    const ticket = generation.current;
    const intent = editIntent.current;
    try {
      if (!id.trim())
        throw Error(`provider.id: ${t("ownerSettings.providerIdRequired")}`);
      if (method === "provider.set") {
        try {
          new URL(draft.endpoint);
        } catch {
          throw Error(`provider.endpoint: ${t("settingsUX.endpoint")}`);
        }
        for (const [index, model] of draft.models.entries()) {
          if (model.endpoint !== undefined) {
            try {
              new URL(model.endpoint);
            } catch {
              throw Error(
                `provider.models[${index}].endpoint: ${t("settingsUX.endpoint")}`,
              );
            }
          }
        }
        validateProviderConfig(draft);
      }
      if (method === "provider.set" && keyAction === "replace" && !secret)
        throw Error(`provider.secret: ${t("ownerSettings.keyRequired")}`);
      busyRef.current = true;
      setBusy(true);
      setError("");
      const params = {
        provider_id: id,
        expected_revision: selected?.revision ?? 0,
        ...(method === "provider.set"
          ? {
              provider: draft,
              ...(keyAction === "replace"
                ? { api_key: secret }
                : keyAction === "clear"
                  ? { api_key: null }
                  : {}),
            }
          : {}),
      };
      const result = await request(method, params);
      if (ticket !== generation.current || intent !== editIntent.current)
        return;
      edit(method === "provider.delete" ? null : result, false);
      setStatus(t("ownerSettings.saved"));
      await load();
    } catch (failure) {
      if (ticket === generation.current) {
        setError(errorText(failure));
        const path = failurePath(failure);
        const index = /^provider\.models\[(\d+)\]/.exec(path)?.[1];
        setConfigOpen(true);
        if (index !== undefined) {
          setModelSearch("");
          setModelFilter("all");
          setExpandedModelKey(modelKeys.current[Number(index)] ?? null);
        }
        setPendingFailure({ path, message: errorText(failure) });
      }
    } finally {
      if (ticket === generation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const updateModel = (index: number, patch: Partial<ModelOverlay>) => {
    if (readonly || busyRef.current) return;
    editIntent.current++;
    setDraft((current) => ({
      ...current,
      models: current.models.map((model, at) =>
        at === index ? { ...model, ...patch } : model,
      ),
    }));
  };

  const upsertManualOverride = (
    model: ModelOverlay,
    patch: Partial<ModelOverlay>,
    rowKey: string,
  ) => {
    if (readonly || busyRef.current) return;
    editIntent.current++;
    if (!draft.models.some((m) => m.id === model.id))
      modelKeys.current.push(rowKey);
    setDraft((current) => {
      const idx = current.models.findIndex((m) => m.id === model.id);
      if (idx >= 0)
        return {
          ...current,
          models: current.models.map((m, i) =>
            i === idx ? { ...m, ...patch } : m,
          ),
        };
      return {
        ...current,
        models: [...current.models, { id: model.id, ...patch }],
      };
    });
  };
  const allModels = [
    ...draft.models.map((overlay, manualIndex) => {
      const discovered = selected?.discovered.find((m) => m.id === overlay.id);
      const model: ModelOverlay = {
        ...discovered,
        id: overlay.id,
        disabled: overlay.disabled ?? false,
      };
      for (const key of [
        "name",
        "variants",
        "context_window_tokens",
        "protocol",
        "endpoint",
        "auth",
      ] as const) {
        const value = overlay[key];
        if (value !== undefined && !(Array.isArray(value) && !value.length))
          Object.assign(model, { [key]: value });
      }
      return {
        model,
        manualIndex: manualIndex as number | null,
        overridden: true,
        rowKey: modelKeys.current[manualIndex],
      };
    }),
    ...(selected?.discovered ?? [])
      .filter((model) => !draft.models.some((m) => m.id === model.id))
      .map((model) => {
        let rowKey = `discovered-${model.id}`;
        while (modelKeys.current.includes(rowKey)) rowKey += "-catalog";
        return {
          model,
          manualIndex: null as number | null,
          overridden: false,
          rowKey,
        };
      }),
  ];
  const mergedModels = allModels.filter(({ model, overridden, rowKey }) => {
    if (expandedModelKey === rowKey) return true;
    if (modelFilter === "enabled" && model.disabled) return false;
    if (modelFilter === "overridden" && !overridden) return false;
    const q = modelSearch.trim().toLowerCase();
    return !q || `${model.id} ${model.name ?? ""}`.toLowerCase().includes(q);
  });

  const renderProviderConfigForm = () => (
    <fieldset disabled={busy || readonly} className="settings-flat-fieldset">
      {readonly && (
        <p className="inline-notice">{t("ownerSettings.adminReadonly")}</p>
      )}
      <div className="limits-grid">
        <label className="settings-form-group">
          {t("ownerSettings.providerId")}
          <input
            className="settings-input"
            placeholder={t("ownerSettings.providerIdHint")}
            value={id}
            disabled={!!selected}
            onChange={(e) => setId(e.target.value)}
            data-testid="provider-id"
            data-validation-path="provider.id"
          />
        </label>
        {(["name", "endpoint"] as const).map((field) => (
          <label className="settings-form-group" key={field}>
            {t(`ownerSettings.${field}`)}
            <input
              className="settings-input"
              value={draft[field]}
              onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
              data-testid={`provider-${field}`}
              data-validation-path={`provider.${field}`}
            />
          </label>
        ))}
        <label className="settings-form-group">
          {t("ownerSettings.protocol")}
          <select
            className="settings-input"
            value={draft.protocol}
            onChange={(e) =>
              setDraft({
                ...draft,
                protocol: e.target.value as ProviderConfig["protocol"],
              })
            }
          >
            {["openai-compatible", "openai", "anthropic", "google"].map(
              (protocol) => (
                <option key={protocol}>{protocol}</option>
              ),
            )}
          </select>
        </label>
        <label className="settings-form-group">
          {t("ownerSettings.auth")}
          <select
            className="settings-input"
            value={draft.auth}
            onChange={(e) =>
              setDraft({
                ...draft,
                auth: e.target.value as ProviderConfig["auth"],
              })
            }
          >
            {["native", "bearer"].map((auth) => (
              <option key={auth}>{auth}</option>
            ))}
          </select>
        </label>
        {(["timeout_ms", "max_response_bytes"] as const).map((field) => (
          <label className="settings-form-group" key={field}>
            {t(`ownerSettings.${field}`)}
            <input
              className="settings-input"
              type="number"
              min="1"
              step="1"
              value={draft[field]}
              data-validation-path={`provider.${field}`}
              onChange={(e) =>
                setDraft({ ...draft, [field]: Number(e.target.value) })
              }
            />
            {field === "max_response_bytes" && (
              <span className="settings-row-sub">{byteHint(draft[field])}</span>
            )}
          </label>
        ))}
        <label className="settings-form-group">
          {t("ownerSettings.credential")}
          <span className="settings-row-sub">
            {t(
              selected?.api_key_configured
                ? "ownerSettings.keyConfigured"
                : "ownerSettings.keyAbsent",
            )}
          </span>
          <select
            className="settings-input"
            value={keyAction}
            onChange={(e) => {
              setKeyAction(e.target.value);
              setSecret("");
            }}
          >
            <option value="retain">{t("ownerSettings.keyRetain")}</option>
            <option value="replace">{t("ownerSettings.keyReplace")}</option>
            <option value="clear">{t("ownerSettings.keyClear")}</option>
          </select>
          {keyAction === "replace" && (
            <input
              className="settings-input"
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              data-testid="provider-secret"
              data-validation-path="provider.secret"
              aria-label={t("ownerSettings.newKey")}
            />
          )}
        </label>
      </div>
      <div className="settings-actions-row">
        <button
          className="primary-btn"
          data-testid="provider-save"
          onClick={() => void mutate("provider.set")}
        >
          {t("ownerSettings.save")}
        </button>
        <button
          className="ghost-btn"
          disabled={!selected}
          onClick={() => void mutate("provider.discover")}
          data-testid="provider-discover"
        >
          {t("ownerSettings.discover")}
        </button>
        {selected && (
          <button
            className="ghost-btn"
            onClick={() =>
              deleteConfirm
                ? void mutate("provider.delete")
                : setDeleteConfirm(true)
            }
          >
            {t(
              deleteConfirm
                ? "ownerSettings.confirmDelete"
                : "ownerSettings.delete",
            )}
          </button>
        )}
      </div>
    </fieldset>
  );

  return (
    <section
      ref={form}
      onChangeCapture={(event) => {
        if (!(
          event.target instanceof HTMLInputElement &&
          event.target.type === "search"
        ))
          editIntent.current++;
        clearFailure(form.current);
      }}
      className="settings-ergonomics providers-stack"
      data-testid="providers-settings"
      aria-busy={busy}
    >
      <p className="settings-description">{t("ownerSettings.providersHint")}</p>
      {error && (
        <p className="inline-notice" data-tone="danger" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="inline-notice" role="status">
          {status}
        </p>
      )}

      {/* Provider configuration accordion with a separate active-provider model list */}
      <div className="providers-header-bar">
        <span className="limits-group-title">
          {t("ownerSettings.provider")}
        </span>
        <div className="settings-actions-row" style={{ margin: 0 }}>
          <button
            type="button"
            className="ghost-btn"
            disabled={busy}
            onClick={() => void load(true)}
          >
            {t("ownerSettings.reload")}
          </button>
          <button
            type="button"
            className="ghost-btn"
            disabled={busy}
            onClick={() => edit(null, true)}
          >
            + {t("ownerSettings.newProvider")}
          </button>
        </div>
      </div>

      {(() => {
        const renderModelsSection = () => (
          <div
            className="provider-models-card"
            data-testid="provider-discovered"
          >
            <div className="providers-header-bar">
              <span className="limits-group-title">
                {t("ownerSettings.modelsCardTitle")}
                {selected ? ` · ${selected.name}` : ""}
              </span>
              <span className="limit-source-pill">{mergedModels.length}</span>
            </div>

            <div className="model-toolbar">
              <input
                type="search"
                className="settings-input model-toolbar-search"
                placeholder={t("ownerSettings.modelsSearchPlaceholder")}
                aria-label={t("ownerSettings.modelsSearchPlaceholder")}
                value={modelSearch}
                onChange={(e) => {
                  setExpandedModelKey(null);
                  setModelSearch(e.target.value);
                }}
              />
              <div className="mc-seg-group" role="group">
                {(["all", "enabled", "overridden"] as const).map(
                  (filterKey) => (
                    <button
                      key={filterKey}
                      type="button"
                      className="mc-seg-btn"
                      aria-pressed={modelFilter === filterKey}
                      onClick={() => {
                        setExpandedModelKey(null);
                        setModelFilter(filterKey);
                      }}
                    >
                      {t(`ownerSettings.modelsFilter.${filterKey}`)}
                    </button>
                  ),
                )}
              </div>
              <button
                type="button"
                className="ghost-btn"
                disabled={busy || readonly}
                onClick={() => {
                  editIntent.current++;
                  const used = new Set(allModels.map(({ model }) => model.id));
                  let suffix = draft.models.length + 1;
                  while (used.has(`custom-model-${suffix}`)) suffix++;
                  const newId = `custom-model-${suffix}`;
                  const rowKey = `manual-${++nextModelKey.current}`;
                  modelKeys.current.push(rowKey);
                  setDraft((current) => ({
                    ...current,
                    models: [...current.models, { id: newId }],
                  }));
                  setExpandedModelKey(rowKey);
                }}
              >
                {t("ownerSettings.addModel")}
              </button>
            </div>

            <div className="model-table-list">
              {mergedModels.length === 0 ? (
                <p className="workspace-flyout-empty">
                  {t("ownerSettings.modelsEmpty")}
                </p>
              ) : (
                mergedModels.map(
                  ({ model, manualIndex, overridden, rowKey }) => {
                    const overlay: ModelOverlay =
                      manualIndex === null
                        ? { id: model.id }
                        : draft.models[manualIndex];
                    const updateRow = (patch: Partial<ModelOverlay>) => {
                      if (readonly || busyRef.current) return;
                      if (manualIndex === null)
                        upsertManualOverride(model, patch, rowKey);
                      else updateModel(manualIndex, patch);
                    };
                    const expanded = expandedModelKey === rowKey;
                    const enabled = !model.disabled;
                    return (
                      <div
                        className="model-row-card"
                        key={rowKey}
                        data-model-id={model.id}
                        data-testid={
                          manualIndex !== null
                            ? "provider-model-row"
                            : undefined
                        }
                      >
                        <div className="model-row-head">
                          <div
                            className="model-id-group"
                            title={`${model.name ?? model.id} (${model.id})`}
                          >
                            <span
                              className="model-status-dot"
                              data-enabled={enabled}
                            />
                            <span className="model-name-text">
                              {model.name || model.id}
                            </span>
                            <span className="model-id-text">{model.id}</span>
                            {model.context_window_tokens && (
                              <span className="limit-source-pill">
                                {Math.round(model.context_window_tokens / 1000)}
                                K
                              </span>
                            )}
                            {overridden && (
                              <span className="limit-source-pill">
                                {t("ownerSettings.modelsFilter.overridden")}
                              </span>
                            )}
                          </div>
                          <div className="model-row-actions">
                            <button
                              type="button"
                              className="mc-state-btn"
                              data-enabled={enabled}
                              disabled={busy || readonly}
                              onClick={() => {
                                if (manualIndex !== null) {
                                  updateModel(manualIndex, {
                                    disabled: enabled,
                                  });
                                } else {
                                  upsertManualOverride(
                                    model,
                                    { disabled: enabled },
                                    rowKey,
                                  );
                                }
                              }}
                            >
                              <span
                                className="model-status-dot"
                                data-enabled={enabled}
                              />
                              <span>
                                {t(
                                  enabled
                                    ? "ownerSettings.modelEnabled"
                                    : "ownerSettings.modelDisabled",
                                )}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="ghost-btn action-fixed-edit"
                              disabled={busy}
                              aria-expanded={expanded}
                              aria-controls={`${controlId}-model-${encodeURIComponent(rowKey)}`}
                              aria-label={`${t(expanded ? "ownerSettings.collapseOverride" : "ownerSettings.editOverride")} · ${model.id}`}
                              onClick={() => {
                                setExpandedModelKey(expanded ? null : rowKey);
                              }}
                            >
                              {t(
                                expanded
                                  ? "ownerSettings.collapseOverride"
                                  : "ownerSettings.editOverride",
                              )}
                            </button>
                          </div>
                        </div>

                        {expanded && (
                          <div
                            className="model-expand-grid"
                            id={`${controlId}-model-${encodeURIComponent(rowKey)}`}
                          >
                            <fieldset
                              disabled={busy || readonly}
                              className="settings-flat-fieldset model-expand-fields"
                            >
                              {(["id", "name", "endpoint"] as const).map(
                                (field) => (
                                  <label
                                    className="settings-form-group"
                                    key={field}
                                  >
                                    {t(`ownerSettings.model.${field}`)}
                                    <input
                                      className="settings-input"
                                      disabled={busy || readonly}
                                      value={overlay[field] ?? ""}
                                      data-validation-path={
                                        manualIndex === null
                                          ? undefined
                                          : `provider.models[${manualIndex}].${field}`
                                      }
                                      onChange={(e) =>
                                        updateRow({
                                          [field]: e.target.value || undefined,
                                        })
                                      }
                                    />
                                  </label>
                                ),
                              )}
                              <label className="settings-form-group">
                                {t("ownerSettings.model.variants")}
                                <input
                                  className="settings-input"
                                  disabled={busy || readonly}
                                  value={overlay.variants?.join(", ") ?? ""}
                                  onChange={(e) =>
                                    updateRow({
                                      variants: e.target.value
                                        .split(",")
                                        .map((v) => v.trim())
                                        .filter(Boolean),
                                    })
                                  }
                                />
                              </label>
                              <label className="settings-form-group">
                                {t("ownerSettings.model.capacity")}
                                <input
                                  className="settings-input"
                                  type="number"
                                  min="1"
                                  disabled={busy || readonly}
                                  value={overlay.context_window_tokens ?? ""}
                                  data-validation-path={
                                    manualIndex === null
                                      ? undefined
                                      : `provider.models[${manualIndex}].context_window_tokens`
                                  }
                                  onChange={(e) =>
                                    updateRow({
                                      context_window_tokens: e.target.value
                                        ? Number(e.target.value)
                                        : undefined,
                                    })
                                  }
                                />
                              </label>
                              <label className="settings-form-group">
                                {t("ownerSettings.protocol")}
                                <select
                                  className="settings-input"
                                  disabled={busy || readonly}
                                  value={overlay.protocol ?? ""}
                                  onChange={(e) =>
                                    updateRow({
                                      protocol: e.target.value
                                        ? (e.target
                                            .value as ModelOverlay["protocol"])
                                        : undefined,
                                    })
                                  }
                                >
                                  <option value="">
                                    {t("ownerSettings.inherit")}
                                  </option>
                                  {[
                                    "openai-compatible",
                                    "openai",
                                    "anthropic",
                                    "google",
                                  ].map((protocol) => (
                                    <option key={protocol}>{protocol}</option>
                                  ))}
                                </select>
                              </label>
                              <label className="settings-form-group">
                                {t("ownerSettings.auth")}
                                <select
                                  className="settings-input"
                                  disabled={busy || readonly}
                                  value={overlay.auth ?? ""}
                                  onChange={(e) =>
                                    updateRow({
                                      auth: e.target.value
                                        ? (e.target
                                            .value as ModelOverlay["auth"])
                                        : undefined,
                                    })
                                  }
                                >
                                  <option value="">
                                    {t("ownerSettings.inherit")}
                                  </option>
                                  <option value="native">native</option>
                                  <option value="bearer">bearer</option>
                                </select>
                              </label>
                              <div className="settings-actions-row">
                                {manualIndex !== null && (
                                  <button
                                    type="button"
                                    className="ghost-btn"
                                    disabled={busy || readonly}
                                    onClick={() => {
                                      editIntent.current++;
                                      modelKeys.current.splice(manualIndex, 1);
                                      setDraft((current) => ({
                                        ...current,
                                        models: current.models.filter(
                                          (_, at) => at !== manualIndex,
                                        ),
                                      }));
                                      setExpandedModelKey(null);
                                    }}
                                  >
                                    {t("ownerSettings.remove")}
                                  </button>
                                )}
                              </div>
                            </fieldset>
                          </div>
                        )}
                      </div>
                    );
                  },
                )
              )}
            </div>
          </div>
        );

        return (
          <>
            <div className="providers-accordion-card">
              {creatingNew && (
                <div
                  className="provider-acc-item"
                  data-open="true"
                  data-selected="true"
                >
                  <div className="provider-acc-head">
                    <div className="model-id-group">
                      <span className="limit-tile-label">
                        {t("ownerSettings.newProvider")}
                      </span>
                    </div>
                  </div>
                  <div className="provider-acc-body">
                    <div className="provider-subcard">
                      {renderProviderConfigForm()}
                    </div>
                  </div>
                </div>
              )}

              {providers.map((provider) => {
                const isSelected = !creatingNew && selected?.id === provider.id;
                const isOpen = isSelected && configOpen;
                const modelCount = new Set(
                  [...provider.discovered, ...provider.models].map(
                    (model) => model.id,
                  ),
                ).size;
                return (
                  <div
                    className="provider-acc-item"
                    data-open={isOpen}
                    data-selected={isSelected}
                    key={provider.id}
                  >
                    <button
                      type="button"
                      className="provider-acc-head"
                      aria-expanded={isOpen}
                      aria-controls={`${controlId}-provider-${encodeURIComponent(provider.id)}`}
                      data-provider-id={provider.id}
                      disabled={busy}
                      onClick={() => {
                        if (busyRef.current) return;
                        if (selected?.id === provider.id && !creatingNew)
                          setConfigOpen((open) => !open);
                        else edit(provider, false);
                      }}
                    >
                      <div className="model-id-group">
                        <span
                          className="model-status-dot"
                          data-enabled={provider.api_key_configured}
                          role="img"
                          aria-label={t(
                            provider.api_key_configured
                              ? "ownerSettings.keyConfigured"
                              : "ownerSettings.keyAbsent",
                          )}
                          title={t(
                            provider.api_key_configured
                              ? "ownerSettings.keyConfigured"
                              : "ownerSettings.keyAbsent",
                          )}
                        />
                        <span className="limit-tile-label">
                          {provider.name}
                        </span>
                        <span className="limit-source-pill">
                          {provider.protocol}
                        </span>
                        <span className="limit-source-pill">
                          {t(`ownerSettings.source.${provider.scope}`)}
                        </span>
                      </div>
                      <div className="model-row-actions">
                        <span className="limit-source-pill">{modelCount}</span>
                        <span className="settings-row-sub">
                          {t(
                            isOpen
                              ? "ownerSettings.collapseConfig"
                              : "ownerSettings.expandConfig",
                          )}
                        </span>
                        <svg
                          className="provider-acc-chevron"
                          data-open={isOpen}
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </div>
                    </button>
                    {isOpen && (
                      <div
                        className="provider-acc-body"
                        id={`${controlId}-provider-${encodeURIComponent(provider.id)}`}
                      >
                        <div className="provider-subcard">
                          {renderProviderConfigForm()}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {(selected || creatingNew) && renderModelsSection()}
          </>
        );
      })()}

      <p className="settings-description">{t("ownerSettings.discoveryHint")}</p>
      <div className="settings-actions-row">
        <button
          className="ghost-btn"
          disabled={busy}
          onClick={() => void dispatch({ type: "RefreshModelMetadata" })}
        >
          {t("ownerSettings.metadataRefresh")}
        </button>
      </div>
    </section>
  );
}
