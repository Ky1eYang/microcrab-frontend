import "../../styles/owner-settings.css";
import { PredicateEditor } from "./SessionPermissionsDialog/PredicateEditor";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../state";
import { t } from "../../i18n";
import {
  LIMIT_FIELDS,
  validateSettingsOverrides,
  validateProviderConfig,
  type SettingsSnapshot,
  type SettingsOverrides,
  type ProviderConfig,
  type PublicProvider,
  type ModelOverlay,
} from "../../client/settings";
import { ModelCombobox } from "../ModelCombobox";
import { Payload } from "../Payload";

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
            className="settings-model-default"
            data-testid="settings-model-default"
          >
            <h4>
              {t(
                scope.kind === "session"
                  ? "ownerSettings.model_selection"
                  : "settingsUX.newSessionModel",
              )}
            </h4>
            <p className="settings-description">
              {t(
                scope.kind === "session"
                  ? "ownerSettings.liveHint"
                  : "settingsUX.newSessionHint",
              )}
            </p>
            {modelSelect("model_selection")}
            {source("model_selection")}
          </section>
          <p className="settings-row-sub" data-testid="settings-revisions">
            {t("ownerSettings.revisions", {
              desired: snapshot.revision,
              applied: snapshot.applied_revision ?? snapshot.revision,
            })}
          </p>
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

          <h4>{t("ownerSettings.agentMode")}</h4>
          <select
            className="settings-input"
            aria-label={t("ownerSettings.agent")}
            value={draft.agent ?? ""}
            onChange={(e) => {
              change("agent", e.target.value || undefined);
              change("mode", undefined);
            }}
          >
            <option value="">{t("ownerSettings.inherit")}</option>
            {state.agents.map((agent) => (
              <option key={agent.name} value={agent.name}>
                {agent.name}
              </option>
            ))}
          </select>
          <select
            className="settings-input"
            aria-label={t("ownerSettings.mode")}
            value={draft.mode ?? ""}
            onChange={(e) => change("mode", e.target.value || undefined)}
          >
            <option value="">{t("ownerSettings.inherit")}</option>
            {state.agents
              .find(
                (agent) =>
                  agent.name === (draft.agent ?? snapshot.effective.agent),
              )
              ?.modes.map((mode) => (
                <option key={mode.name} value={mode.name}>
                  {mode.name}
                </option>
              ))}
          </select>
          {source("agent")}
          {source("mode")}
          {scope.kind === "session" &&
            state.publicState?.mode_prompt !== undefined && (
              <>
                <h4>{t("ownerSettings.modeState")}</h4>
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
              </>
            )}
          <h4>{t("ownerSettings.limits")}</h4>
          {LIMIT_FIELDS.map((field) => (
            <div className="settings-row" key={field}>
              <label className="settings-row-info">
                <span className="settings-row-label">
                  {t(`ownerSettings.limit.${field}`)}
                </span>
                <span className="settings-row-sub">
                  {t("ownerSettings.limitEffective", {
                    value: snapshot.effective.limits[field],
                    source: t(
                      `ownerSettings.source.${snapshot.sources[`limits.${field}`] ?? "admin"}`,
                    ),
                    maximum: snapshot.constraints.limits[field],
                  })}
                </span>
                <input
                  className="settings-input"
                  data-testid={`limit-${field}`}
                  data-validation-path={`settings.limits.${field}`}
                  type="number"
                  min={field === "max_retained_processes" ? 0 : 1}
                  step="1"
                  max={snapshot.constraints.limits[field]}
                  placeholder={t("ownerSettings.inherit")}
                  value={draft.limits?.[field] ?? ""}
                  onChange={(e) => {
                    const limits = { ...draft.limits };
                    if (e.target.value === "") delete limits[field];
                    else limits[field] = Number(e.target.value);
                    change(
                      "limits",
                      Object.keys(limits).length ? limits : undefined,
                    );
                  }}
                />
                {field.endsWith("_bytes") && (
                  <span className="settings-row-sub">
                    {byteHint(
                      draft.limits?.[field] ?? snapshot.effective.limits[field],
                    )}
                  </span>
                )}
              </label>
            </div>
          ))}
          <h4>{t("ownerSettings.permissions")}</h4>
          <label className="settings-form-group">
            {t("ownerSettings.initialization")}
            <select
              className="settings-input"
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
          </label>
          {source("initialization")}
          <label className="settings-form-group">
            {t("ownerSettings.review")}
            {booleanSelect("review")}
          </label>
          {source("review")}
          <label className="settings-form-group">
            {t("ownerSettings.review_model")}
            {modelSelect("review_model")}
          </label>
          {source("review_model")}
          <label className="settings-form-group">
            <input
              type="checkbox"
              checked={draft.permissions !== undefined}
              onChange={(e) =>
                change("permissions", e.target.checked ? [] : undefined)
              }
            />
            {t("ownerSettings.overridePermissions")}
          </label>
          {draft.permissions !== undefined && (
            <PredicateEditor
              rules={draft.permissions}
              disabled={busy}
              onChange={(permissions) => {
                change("permissions", permissions);
                setRules(JSON.stringify(permissions, null, 2));
              }}
            />
          )}
          {draft.permissions !== undefined && (
            <label className="settings-form-group">
              {t("ownerSettings.permissionRules")}
              <textarea
                className="settings-input monospace-text"
                rows={8}
                value={rules}
                onChange={(e) => setRules(e.target.value)}
                data-testid="settings-permission-rules"
                data-validation-path="settings.permissions"
              />
            </label>
          )}
          <h4>{t("ownerSettings.behavior")}</h4>
          <label className="settings-form-group">
            {t("ownerSettings.auto_naming")}
            {booleanSelect("auto_naming")}
          </label>
          {source("auto_naming")}
          <label className="settings-form-group">
            <input
              type="checkbox"
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
            {t("ownerSettings.overrideCompaction")}
          </label>
          {draft.auto_compaction && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={draft.auto_compaction.enabled}
                  onChange={(e) =>
                    change("auto_compaction", {
                      ...draft.auto_compaction,
                      enabled: e.target.checked,
                    })
                  }
                />
                {t("ownerSettings.enabled")}
              </label>
              {(
                [
                  "turn_threshold",
                  "round_threshold",
                  "headroom_tokens",
                ] as const
              ).map((field) => (
                <label className="settings-form-group" key={field}>
                  {t(`ownerSettings.${field}`)}
                  <input
                    className="settings-input"
                    type="number"
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
            </>
          )}
          {source("auto_compaction")}
        </>
      )}
      <div className="settings-actions-row">
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
  const owner = state.authSession?.principal?.owner;
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [selected, setSelected] = useState<PublicProvider | null>(null);
  const [id, setId] = useState("");
  const [draft, setDraft] = useState<ProviderConfig>(emptyProvider);
  const [keyAction, setKeyAction] = useState("retain");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const generation = useRef(0);
  const form = useRef<HTMLElement>(null);
  const readonly = selected?.read_only || selected?.scope === "admin";
  const request = (method: string, params = {}) =>
    dispatch({ type: "SettingsRequest", method, params });
  const edit = (provider: PublicProvider | null) => {
    setSelected(provider);
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
  };
  const load = async () => {
    const ticket = generation.current;
    try {
      const next = await request("provider.list");
      if (ticket === generation.current) setProviders(next.items);
    } catch (failure) {
      if (ticket === generation.current) setError(errorText(failure));
    }
  };
  useEffect(() => {
    generation.current++;
    setProviders([]);
    edit(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [owner]);
  const mutate = async (method: string) => {
    if (readonly || busy) return;
    const ticket = generation.current;
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
      if (ticket !== generation.current) return;
      edit(method === "provider.delete" ? null : result);
      setStatus(t("ownerSettings.saved"));
      await load();
    } catch (failure) {
      if (ticket === generation.current) {
        setError(errorText(failure));
        focusFailure(form.current, failurePath(failure), errorText(failure));
      }
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  };
  const updateModel = (index: number, patch: Partial<ModelOverlay>) =>
    setDraft((current) => ({
      ...current,
      models: current.models.map((model, at) =>
        at === index ? { ...model, ...patch } : model,
      ),
    }));
  return (
    <section
      ref={form}
      onChangeCapture={() => clearFailure(form.current)}
      className="settings-ergonomics"
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
      <div className="settings-actions-row">
        <select
          className="settings-input"
          aria-label={t("ownerSettings.provider")}
          disabled={busy}
          value={selected?.id ?? ""}
          onChange={(e) =>
            edit(
              providers.find((provider) => provider.id === e.target.value) ??
                null,
            )
          }
        >
          <option value="">{t("ownerSettings.newProvider")}</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name} · {t(`ownerSettings.source.${provider.scope}`)}
            </option>
          ))}
        </select>
        <button
          className="ghost-btn"
          disabled={busy}
          onClick={() => void load()}
        >
          {t("ownerSettings.reload")}
        </button>
      </div>
      {readonly && (
        <p className="inline-notice">{t("ownerSettings.adminReadonly")}</p>
      )}
      <fieldset disabled={busy || readonly} className="settings-flat-fieldset">
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
        <h4>{t("ownerSettings.manualModels")}</h4>
        {draft.models.map((model, index) => (
          <div
            className="settings-section"
            key={index}
            data-testid="provider-model-row"
          >
            {(["id", "name", "endpoint"] as const).map((field) => (
              <label className="settings-form-group" key={field}>
                {t(`ownerSettings.model.${field}`)}
                <input
                  className="settings-input"
                  value={model[field] ?? ""}
                  data-validation-path={`provider.models[${index}].${field}`}
                  onChange={(e) =>
                    updateModel(index, { [field]: e.target.value || undefined })
                  }
                />
              </label>
            ))}
            <label className="settings-form-group">
              {t("ownerSettings.model.variants")}
              <input
                className="settings-input"
                value={model.variants?.join(", ") ?? ""}
                onChange={(e) =>
                  updateModel(index, {
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
                value={model.context_window_tokens ?? ""}
                data-validation-path={`provider.models[${index}].context_window_tokens`}
                onChange={(e) =>
                  updateModel(index, {
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
                value={model.protocol ?? ""}
                onChange={(e) =>
                  updateModel(index, {
                    protocol: e.target.value
                      ? (e.target.value as ModelOverlay["protocol"])
                      : undefined,
                  })
                }
              >
                <option value="">{t("ownerSettings.inherit")}</option>
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
                value={model.auth ?? ""}
                onChange={(e) =>
                  updateModel(index, {
                    auth: e.target.value
                      ? (e.target.value as ModelOverlay["auth"])
                      : undefined,
                  })
                }
              >
                <option value="">{t("ownerSettings.inherit")}</option>
                <option value="native">native</option>
                <option value="bearer">bearer</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={model.disabled ?? false}
                onChange={(e) =>
                  updateModel(index, { disabled: e.target.checked })
                }
              />
              {t("ownerSettings.disabled")}
            </label>
            <button
              className="ghost-btn"
              onClick={() =>
                setDraft({
                  ...draft,
                  models: draft.models.filter((_, at) => at !== index),
                })
              }
            >
              {t("ownerSettings.remove")}
            </button>
          </div>
        ))}
        <button
          className="ghost-btn"
          onClick={() =>
            setDraft({ ...draft, models: [...draft.models, { id: "" }] })
          }
        >
          {t("ownerSettings.addModel")}
        </button>
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
      {!!selected?.discovered.length && (
        <>
          <h4>{t("ownerSettings.discoveredModels")}</h4>
          <Payload value={selected.discovered} testid="provider-discovered" />
        </>
      )}
      <p className="settings-description">{t("ownerSettings.discoveryHint")}</p>
      <button
        className="ghost-btn"
        disabled={busy}
        onClick={() => void dispatch({ type: "RefreshModelMetadata" })}
      >
        {t("ownerSettings.metadataRefresh")}
      </button>
    </section>
  );
}
