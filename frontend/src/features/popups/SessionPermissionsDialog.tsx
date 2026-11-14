import { PredicateEditor } from "./SessionPermissionsDialog/PredicateEditor";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useApp } from "../../state";
import { t } from "../../i18n";
import { trapFocus } from "../../client/viewport";
import type {
  PolicySnapshot,
  SessionPermissionConfig,
  NativeModelSelection,
} from "../../client/types";
import { Icon } from "../shared";
import { Payload } from "../Payload";
import {
  isRecord,
  modelKey,
  parsePermissionDraft,
  resetSimpleRules,
  setSimpleToolRule,
  simpleAction,
} from "./SessionPermissionsDialog/rules";
import { rovingTabKey } from "./SessionPermissionsDialog/tabs";

const TABS = ["tools", "review"] as const;
type Tab = (typeof TABS)[number];
type ErrorKind = "load" | "save" | "conflict" | "invalidJson";

/** Display status for the dialog shell. Loading (initial or reload) and saving
 * are distinct so the Save button is never labelled "Saving" while reading. */
function dialogStatus(
  pending: "load" | "save" | null,
  error: ErrorKind | null,
  saved: boolean,
) {
  if (pending === "load") return "loading";
  if (pending === "save") return "saving";
  if (error === "conflict") return "conflict";
  if (error) return "error";
  if (saved) return "saved";
  return "ready";
}

export function SessionPermissionsDialog() {
  const { state, dispatch } = useApp();
  const popup = state.popup;
  const sessionId = popup.sessionId as string;
  const requestId = popup.requestId as string;
  const [policy, setPolicy] = useState<PolicySnapshot | null>(null);
  const [draft, setDraft] = useState<SessionPermissionConfig | null>(null);
  const [mode, setMode] = useState("");
  const [tab, setTab] = useState<Tab>("tools");
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState("");
  const [pending, setPending] = useState<"load" | "save" | null>(null);
  const [errorKind, setErrorKind] = useState<ErrorKind | null>(null);
  const [errorDetail, setErrorDetail] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const dirty = useRef(false);
  const alive = useRef(true);
  const ticket = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const jsonRef = useRef<HTMLTextAreaElement>(null);
  const uid = useId();
  const headingId = `${uid}-title`;
  const errorId = `${uid}-error`;
  const advancedId = `${uid}-advanced`;
  const busy = pending !== null;
  const conflict = errorKind === "conflict";
  const selected = state.sessions.find((item) => item.id === sessionId);
  const stale = state.sessionId !== sessionId;
  const readonly =
    stale || !selected || !!selected.parentID || !!selected.archived;
  const canSave =
    state.capabilities?.methods.includes("permission.set") === true;
  const fail = (kind: ErrorKind | null, detail = "") => {
    setErrorKind(kind);
    setErrorDetail(detail);
  };
  const sync = (next: PolicySnapshot) => {
    setPolicy(next);
    const config = {
      ...next.config,
      initialization: next.config.initialization ?? "allow",
      review_model: next.config.review_model ?? null,
    };
    setDraft(config);
    setJson(JSON.stringify(config, null, 2));
    setMode(
      next.tool_inventory?.modes.find((item) => item.current)?.name ??
        next.tool_inventory?.modes[0]?.name ??
        "",
    );
    setConfirmReload(false);
    dirty.current = false;
  };
  const load = async () => {
    const current = ++ticket.current;
    setPending("load");
    setSaved(false);
    fail(null);
    try {
      const next = (await dispatch({
        type: "LoadSessionPermissions",
        sessionId,
        requestId,
      })) as PolicySnapshot;
      if (alive.current && current === ticket.current && next) sync(next);
    } catch (failure) {
      if (alive.current && current === ticket.current)
        fail(
          "load",
          failure instanceof Error ? failure.message : String(failure),
        );
    } finally {
      if (alive.current && current === ticket.current) setPending(null);
    }
  };
  useEffect(() => {
    alive.current = true;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Tab") trapFocus(dialog.current, event);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dispatch({ type: "DismissPopup" });
      }
    };
    window.addEventListener("keydown", key, true);
    void load();
    // Safe initial focus: the close button, never Save.
    dialog.current
      ?.querySelector<HTMLButtonElement>(
        '[data-testid="session-permission-close"]',
      )
      ?.focus();
    return () => {
      alive.current = false;
      ticket.current++;
      window.removeEventListener("keydown", key, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [sessionId, requestId]);
  const change = (config: SessionPermissionConfig) => {
    dirty.current = true;
    setSaved(false);
    setDraft(config);
    setJson(JSON.stringify(config, null, 2));
  };
  const invalidJson = (failure: unknown) => {
    fail(
      "invalidJson",
      failure instanceof Error ? failure.message : String(failure),
    );
    requestAnimationFrame(() => jsonRef.current?.focus());
  };
  /** Leaving the Advanced editor commits a parsable JSON draft; an invalid
   * draft keeps the editor open, untouched, with the error focused. */
  const commitAdvanced = () => {
    if (!advanced) return true;
    try {
      change(parsePermissionDraft(json));
    } catch (failure) {
      invalidJson(failure);
      return false;
    }
    if (errorKind === "invalidJson") fail(null);
    return true;
  };
  const selectTab = (value: Tab) => {
    if (value === tab) return true;
    if (!commitAdvanced()) return false;
    setAdvanced(false);
    setTab(value);
    return true;
  };
  const save = async () => {
    if (!policy || !draft || readonly || busy || !canSave || conflict) return;
    let config = draft;
    try {
      if (advanced) config = parsePermissionDraft(json);
    } catch (failure) {
      invalidJson(failure);
      return;
    }
    const current = ++ticket.current;
    setPending("save");
    fail(null);
    setSaved(false);
    try {
      const next = (await dispatch({
        type: "SaveSessionPermissions",
        sessionId,
        requestId,
        expectedRevision: policy.revision,
        config,
      })) as PolicySnapshot;
      if (alive.current && current === ticket.current && next) {
        sync(next);
        setSaved(true);
      }
    } catch (failure) {
      if (alive.current && current === ticket.current) {
        const code = isRecord(failure) ? failure.code : undefined;
        fail(
          code === "revision_conflict" || code === "conflict"
            ? "conflict"
            : "save",
          failure instanceof Error ? failure.message : String(failure),
        );
      }
    } finally {
      if (alive.current && current === ticket.current) setPending(null);
    }
  };
  const inventory = policy?.tool_inventory;
  const modeNames = inventory?.modes.map((item) => item.name) ?? [];
  const currentMode = inventory?.modes.find((item) => item.name === mode);
  // API admission validates selector uniqueness and compiled facts. Keep the
  // exact Server rows independent of the editable draft.
  const policyFacts = useMemo(
    () =>
      new Map(
        currentMode?.compiled.map((row) => [row.tool.value, row] as const),
      ),
    [currentMode?.compiled],
  );
  const modeIndex = modeNames.indexOf(mode);
  const choices: { key: string; label: string; value: NativeModelSelection }[] =
    [];
  const seenChoices = new Set<string>();
  for (const model of state.availableModels)
    for (const variant of [null, ...model.variants]) {
      const value = {
        provider_id: model.providerId,
        model: model.id,
        ...(variant ? { variant } : {}),
      };
      const key = modelKey(value);
      if (seenChoices.has(key)) continue;
      seenChoices.add(key);
      choices.push({
        key,
        label: `${model.name} · ${model.providerId}${variant ? ` · ${variant}` : ""}`,
        value,
      });
    }
  const selectedModel = modelKey(draft?.review_model);
  const unmatchedModel = !!selectedModel && !seenChoices.has(selectedModel);
  const status = dialogStatus(pending, errorKind, saved);
  const errorSummary =
    errorKind === "conflict"
      ? t("sessionPermissions.conflict")
      : errorKind === "invalidJson"
        ? t("sessionPermissions.invalidJson")
        : errorKind === "load"
          ? t("sessionPermissions.loadFailed")
          : errorKind === "save"
            ? t("sessionPermissions.saveFailed")
            : "";
  const close = () => dispatch({ type: "DismissPopup" });
  return (
    <div className="overlay" onClick={close}>
      <div
        ref={dialog}
        className="perm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-busy={busy}
        data-testid="session-permissions"
        data-status={status}
        data-session-id={sessionId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="perm-dialog-header">
          <div className="perm-dialog-title-row">
            <h2 id={headingId}>{t("sessionPermissions.title")}</h2>
            <button
              type="button"
              className="settings-close-btn"
              aria-label={t("popup.close")}
              data-testid="session-permission-close"
              onClick={close}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <p className="perm-dialog-scope">
            {t("sessionPermissions.scope", {
              session: selected?.title ?? sessionId,
            })}
          </p>
          <div
            role="tablist"
            aria-label={t("sessionPermissions.sections")}
            className="perm-tabs"
            onKeyDown={(event) => rovingTabKey(event, TABS, tab, selectTab)}
          >
            {TABS.map((value) => (
              <button
                type="button"
                role="tab"
                key={value}
                aria-selected={tab === value}
                aria-controls={`session-permission-${value}`}
                id={`session-permission-tab-${value}`}
                tabIndex={tab === value ? 0 : -1}
                data-testid={`session-permission-tab-${value}`}
                className="perm-tab"
                onClick={() => selectTab(value)}
              >
                {t(`sessionPermissions.${value}`)}
              </button>
            ))}
          </div>
        </header>
        <div className="perm-dialog-body" data-testid="session-permission-body">
          {pending === "load" && !policy && (
            <p className="perm-dialog-loading" role="status">
              <Icon
                name="spinner"
                size={14}
                className="perm-spinner"
                aria-hidden="true"
              />
              {t("sessionPermissions.loading")}
            </p>
          )}
          {readonly && (
            <p className="perm-notice" role="status">
              {t(
                stale
                  ? "sessionPermissions.stale"
                  : "sessionPermissions.readOnly",
              )}
            </p>
          )}
          {policy && draft && (
            <fieldset disabled={busy || readonly} className="perm-fieldset">
              {tab === "tools" ? (
                <section
                  role="tabpanel"
                  id="session-permission-tools"
                  aria-labelledby="session-permission-tab-tools"
                  className="perm-panel"
                >
                  {!inventory ? (
                    <p className="perm-notice" role="status">
                      {t("sessionPermissions.inventoryUnavailable")}
                    </p>
                  ) : (
                    <>
                      <div
                        role="tablist"
                        aria-label={t("sessionPermissions.modes")}
                        className="perm-modes"
                        onKeyDown={(event) =>
                          rovingTabKey(event, modeNames, mode, (value) => {
                            setMode(value);
                          })
                        }
                      >
                        {inventory.modes.map((item, index) => (
                          <button
                            type="button"
                            role="tab"
                            key={item.name}
                            id={`session-permission-mode-${index}`}
                            className="perm-mode"
                            data-testid="session-permission-mode"
                            data-mode={item.name}
                            aria-selected={mode === item.name}
                            aria-controls="session-permission-tool-list"
                            tabIndex={
                              mode === item.name ||
                              (modeIndex < 0 && index === 0)
                                ? 0
                                : -1
                            }
                            onClick={() => setMode(item.name)}
                          >
                            {inventory.agent} · {item.name}
                            {item.current && (
                              <span className="perm-mode-current">
                                {` · ${t("sessionPermissions.current")}`}
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                      <p className="perm-help">
                        {t("sessionPermissions.policyHelp")}
                      </p>
                      {currentMode?.owners && (
                        <p
                          className="perm-help"
                          data-testid="session-permission-owners"
                        >
                          {t("sessionPermissions.owners")}
                          {t("common.fieldSep")}
                          {currentMode.owners
                            .map(
                              (owner) =>
                                `${owner.controller}@${owner.revision} · ${owner.agent}/${owner.mode}`,
                            )
                            .join("; ")}
                        </p>
                      )}
                      <p
                        className="perm-help"
                        data-testid="session-permission-draft-label"
                      >
                        {t(
                          dirty.current
                            ? "sessionPermissions.unsavedDraft"
                            : "sessionPermissions.savedConfig",
                        )}
                      </p>
                      <div
                        id="session-permission-tool-list"
                        role="tabpanel"
                        aria-labelledby={
                          modeIndex >= 0
                            ? `session-permission-mode-${modeIndex}`
                            : undefined
                        }
                        className="perm-tool-list"
                      >
                        {!currentMode?.tools.length && (
                          <p className="perm-help">
                            {t("sessionPermissions.noTools")}
                          </p>
                        )}
                        {currentMode?.tools.map((tool) => {
                          const action = simpleAction(
                            draft,
                            inventory.agent,
                            mode,
                            tool.name,
                          );
                          const fact = policyFacts.get(tool.name);
                          const selectId = `${uid}-tool-${tool.name}`;
                          return (
                            <div
                              className="perm-tool-row"
                              data-testid="session-permission-tool"
                              data-tool={tool.name}
                              key={tool.name}
                            >
                              <div className="perm-tool-info">
                                <label
                                  className="perm-tool-name"
                                  htmlFor={selectId}
                                >
                                  {tool.name}
                                </label>
                                {tool.description && (
                                  <p className="perm-tool-desc">
                                    {tool.description}
                                  </p>
                                )}
                                <ul className="perm-facts">
                                  {!fact && (
                                    <li>
                                      {t("sessionPermissions.noConfigured")}
                                    </li>
                                  )}
                                  {fact && (
                                    <li data-testid="session-permission-policy-fact">
                                      {t(
                                        currentMode.current
                                          ? "sessionPermissions.compiledCurrent"
                                          : "sessionPermissions.compiledPreview",
                                      )}
                                      {t("common.fieldSep")}
                                      {t(
                                        `sessionPermissions.${fact.kind === "static" ? fact.action : fact.kind}`,
                                      )}
                                      {fact.kind !== "static" && (
                                        <Payload
                                          value={fact}
                                          testid="session-permission-compiled"
                                        />
                                      )}
                                    </li>
                                  )}
                                </ul>
                              </div>
                              <select
                                id={selectId}
                                disabled={advanced}
                                className="settings-input perm-select"
                                aria-label={t("sessionPermissions.toolAction", {
                                  tool: tool.name,
                                })}
                                value={action}
                                onChange={(event) =>
                                  change(
                                    setSimpleToolRule(
                                      draft,
                                      inventory.agent,
                                      mode,
                                      tool.name,
                                      event.target.value as
                                        "" | "allow" | "ask" | "deny",
                                    ),
                                  )
                                }
                              >
                                <option value="">
                                  {t("sessionPermissions.inherit")}
                                </option>
                                {(["allow", "ask", "deny"] as const).map(
                                  (value) => (
                                    <option key={value} value={value}>
                                      {t(`sessionPermissions.${value}`)}
                                    </option>
                                  ),
                                )}
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                  <div className="perm-field">
                    <label
                      className="perm-field-label"
                      htmlFor={`${uid}-initialization`}
                    >
                      {t("sessionPermissions.initialization")}
                    </label>
                    <select
                      id={`${uid}-initialization`}
                      className="settings-input"
                      data-testid="session-permission-initialization"
                      disabled={advanced}
                      value={draft.initialization}
                      onChange={(event) =>
                        change({
                          ...draft,
                          initialization: event.target.value as
                            "allow" | "ask" | "deny",
                        })
                      }
                    >
                      {(["allow", "ask", "deny"] as const).map((value) => (
                        <option key={value} value={value}>
                          {t(`sessionPermissions.${value}`)}
                        </option>
                      ))}
                    </select>
                    <p className="perm-help">
                      {t("sessionPermissions.initializationHelp")}
                    </p>
                  </div>
                  {!advanced && (
                    <PredicateEditor
                      rules={draft.overrides}
                      disabled={readonly || busy}
                      onChange={(overrides) => change({ ...draft, overrides })}
                    />
                  )}
                  <div className="perm-advanced-row">
                    <button
                      type="button"
                      className="ghost-btn"
                      data-testid="session-permission-reset"
                      aria-describedby={`${uid}-reset-scope`}
                      disabled={!inventory || advanced}
                      onClick={() => change(resetSimpleRules(draft, inventory))}
                    >
                      {t("sessionPermissions.reset")}
                    </button>
                    <button
                      type="button"
                      className="ghost-btn"
                      data-testid="session-permission-advanced"
                      aria-expanded={advanced}
                      aria-controls={advancedId}
                      onClick={() => {
                        if (advanced && !commitAdvanced()) return;
                        setAdvanced(!advanced);
                      }}
                    >
                      {t("sessionPermissions.advanced")}
                      <Icon
                        name="chevron"
                        size={12}
                        className={`perm-disclosure${advanced ? " open" : ""}`}
                        aria-hidden="true"
                      />
                    </button>
                  </div>
                  {/* Part B D4: the scope sits next to the normal Reset, not only inside Advanced. */}
                  <p
                    className="perm-help perm-reset-scope"
                    id={`${uid}-reset-scope`}
                    data-testid="session-permission-reset-scope"
                  >
                    {t("sessionPermissions.resetScope")}
                  </p>
                  <div
                    id={advancedId}
                    hidden={!advanced}
                    className="perm-advanced"
                  >
                    {advanced && (
                      <>
                        <p className="perm-help">
                          {t("sessionPermissions.advancedHelp")}
                        </p>
                        <textarea
                          ref={jsonRef}
                          className="settings-textarea monospace-text perm-json"
                          rows={12}
                          spellCheck={false}
                          aria-label={t("sessionPermissions.advanced")}
                          aria-invalid={errorKind === "invalidJson"}
                          aria-describedby={
                            errorKind === "invalidJson" ? errorId : undefined
                          }
                          value={json}
                          onChange={(event) => {
                            dirty.current = true;
                            setSaved(false);
                            setJson(event.target.value);
                          }}
                        />
                      </>
                    )}
                  </div>
                </section>
              ) : (
                <section
                  role="tabpanel"
                  id="session-permission-review"
                  aria-labelledby="session-permission-tab-review"
                  className="perm-panel"
                >
                  <div className="perm-check-row">
                    <input
                      id="session-permission-review-enabled"
                      type="checkbox"
                      checked={draft.review}
                      onChange={(event) =>
                        change({ ...draft, review: event.target.checked })
                      }
                    />
                    <label htmlFor="session-permission-review-enabled">
                      {t("sessionPermissions.reviewEnabled")}
                    </label>
                  </div>
                  <p className="perm-help">
                    {t("sessionPermissions.reviewHelp")}
                  </p>
                  <div className="perm-field">
                    <label
                      className="perm-field-label"
                      htmlFor="session-permission-review-model"
                    >
                      {t("sessionPermissions.reviewModel")}
                    </label>
                    <select
                      id="session-permission-review-model"
                      className="settings-input"
                      value={selectedModel}
                      aria-describedby="session-permission-model-help"
                      onChange={(event) =>
                        change({
                          ...draft,
                          review_model:
                            choices.find(
                              (item) => item.key === event.target.value,
                            )?.value ?? null,
                        })
                      }
                    >
                      <option value="">
                        {t("sessionPermissions.followMain")}
                      </option>
                      {unmatchedModel && (
                        <option value={selectedModel}>
                          {t("sessionPermissions.unavailableModel", {
                            model: `${draft.review_model?.provider_id} / ${draft.review_model?.model}${draft.review_model?.variant ? ` / ${draft.review_model.variant}` : ""}`,
                          })}
                        </option>
                      )}
                      {choices.map((item) => (
                        <option key={item.key} value={item.key}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                    <p
                      className="perm-help"
                      id="session-permission-model-help"
                      data-unavailable={unmatchedModel || undefined}
                    >
                      {t(
                        unmatchedModel
                          ? "sessionPermissions.modelUnavailableHelp"
                          : "sessionPermissions.modelHelp",
                      )}
                    </p>
                  </div>
                </section>
              )}
            </fieldset>
          )}
        </div>
        <footer className="perm-dialog-footer">
          <div className="perm-status" data-testid="session-permission-status">
            {errorKind && (
              <div
                className="perm-notice perm-notice-danger"
                role="alert"
                id={errorId}
              >
                <p>{errorSummary}</p>
                {errorDetail && (
                  <p
                    className="perm-error-detail"
                    data-testid="session-permission-error-detail"
                  >
                    {errorDetail}
                  </p>
                )}
              </div>
            )}
            {pending === "load" && policy && (
              <p className="perm-notice" role="status">
                {t("sessionPermissions.loading")}
              </p>
            )}
            {pending === "save" && (
              <p className="perm-notice" role="status">
                {t("sessionPermissions.saving")}
              </p>
            )}
            {saved && !busy && (
              <p className="perm-notice perm-notice-success" role="status">
                {t("sessionPermissions.saved")}
              </p>
            )}
          </div>
          <div className="perm-actions">
            <div className="perm-reload">
              <button
                type="button"
                className="ghost-btn"
                data-testid="session-permission-reload"
                data-confirming={confirmReload || undefined}
                aria-describedby={
                  confirmReload ? `${uid}-reload-warning` : undefined
                }
                disabled={busy || stale}
                onClick={() => {
                  if (dirty.current && !confirmReload) {
                    setConfirmReload(true);
                    return;
                  }
                  void load();
                }}
              >
                {t(
                  confirmReload
                    ? "sessionPermissions.reloadConfirm"
                    : "sessionPermissions.reload",
                )}
              </button>
              {confirmReload && (
                <p
                  className="perm-reload-warning"
                  role="status"
                  id={`${uid}-reload-warning`}
                >
                  {t("sessionPermissions.reloadWarning")}
                </p>
              )}
            </div>
            {policy && !canSave && !readonly && (
              <p
                className="perm-notice perm-save-unsupported"
                id={`${uid}-save-unsupported`}
                data-testid="session-permission-save-unsupported"
              >
                {t("sessionPermissions.saveUnsupported")}
              </p>
            )}
            <div className="perm-commit">
              <button type="button" className="ghost-btn" onClick={close}>
                {t("popup.cancel")}
              </button>
              <button
                type="button"
                className="primary-btn"
                data-testid="session-permission-save"
                disabled={busy || readonly || !policy || !canSave || conflict}
                title={
                  !canSave ? t("sessionPermissions.saveUnsupported") : undefined
                }
                aria-describedby={
                  !canSave && policy && !readonly
                    ? `${uid}-save-unsupported`
                    : undefined
                }
                onClick={() => void save()}
              >
                {t(
                  pending === "save"
                    ? "sessionPermissions.saving"
                    : "sessionPermissions.save",
                )}
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
