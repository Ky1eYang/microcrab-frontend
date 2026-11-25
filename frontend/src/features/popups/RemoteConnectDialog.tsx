import { referenceLabels } from "../referenceLabels";
import { useEffect, useRef, useState } from "react";
import { useApp, useAppStore } from "../../state";
import { hostReadiness } from "../../state/host-readiness";
import { t } from "../../i18n";
import { hostTerminalCode } from "../../client/host-quarantine";
import { CommandError } from "../../client/errors";
import {
  hostCarrier,
  hostLocator,
  hostPreferenceScope,
} from "../../client/host-locators";
import { Icon } from "../shared";
import "../../styles/host-connection.css";

const hostStatusKeys = new Set<string>([
  "detached",
  "connecting",
  "pairing",
  "reconciling",
  "unready",
  "ready",
  "suspended",
  "binding_mismatch",
  "host_preflight_unsupported",
]);
/** Localized lazily so a live locale switch re-renders with the active dictionary. */
export const hostStatus: Record<string, string> = new Proxy(
  {} as Record<string, string>,
  {
    get: (_, k) =>
      typeof k === "string" && hostStatusKeys.has(k)
        ? t("host.status." + k)
        : undefined,
    has: (_, k) => typeof k === "string" && hostStatusKeys.has(k),
  },
);
/** Labels include catalog readiness while the underlying Host transport remains connected. */
export function hostStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    loading_catalog: t("host.readiness.loading"),
    catalog_error: t("host.readiness.catalogError"),
    project_mismatch: t("host.readiness.projectMismatch"),
  };
  return labels[status] ?? hostStatus[status] ?? hostStatus.detached;
}
const hostReasonKeys = new Set<string>([
  "loading_catalog",
  "pairing_expired",
  "host_pairing_expired",
  "pairing_rejected",
  "resume_rejected",
  "bridge_upgrade_required",
  "pairing_required",
  "handshake_timeout",
  "workspace_conflict",
  "workspace_mismatch",
  "directory_not_allowed",
  "host_reconciliation_required",
  "binding_mismatch",
  "host_preflight_unsupported",
  "disconnected",
  "connection_failed",
  "connection_timeout",
  "timed_out",
]);
/** Localized lazily so a live locale switch re-renders with the active dictionary. */
export const hostReason: Record<string, string> = new Proxy(
  {} as Record<string, string>,
  {
    get: (_, k) =>
      typeof k === "string" && hostReasonKeys.has(k)
        ? t("host.reason." + (k === "host_pairing_expired" ? "pairing_expired" : k))
        : undefined,
    has: (_, k) => typeof k === "string" && hostReasonKeys.has(k),
  },
);
// Current bridges report pairing_denied; older records use pairing_rejected.
// Both identify the same rejected one-use code and share its existing copy.
hostReasonKeys.add("pairing_denied");
export function RemoteConnectDialog() {
  const { state, dispatch } = useApp();
  const store = useAppStore();
  const [mode, setMode] = useState("relay");
  const creating = state.popup.type === "createProject";
  const projectId = state.popup.projectId ?? "";
  const readiness = hostReadiness(state, projectId);
  const terminal = hostTerminalCode(readiness.status);
  const [endpoint, setEndpoint] = useState(state.popup.endpoint ?? "");
  const [recover, setRecover] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState(state.popup.error ?? "");
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState(".");
  const project = state.projects.find((p) => p.id === projectId);
  const locator = hostLocator(
    hostPreferenceScope(state.apiBase, state.authSession),
    project,
  );
  const connection =
    state.hostConnection?.projectId === projectId
      ? state.hostConnection
      : undefined;
  const locatorCarrier = locator ? hostCarrier(locator) : null;
  const showAddress =
    creating ||
    recover ||
    !locator ||
    connection?.recoverAddress ||
    (mode === "grpc" && locatorCarrier !== "grpc") ||
    (mode === "relay" && locatorCarrier === "grpc");
  const connected = connection?.connected === true;
  const canControl = connection?.localControl !== false;
  useEffect(() => {
    setEndpoint(locator ?? state.popup.endpoint ?? "");
    setRecover(false);
    setError(state.popup.error ?? "");
    setCode("");
    if (
      (locator && hostCarrier(locator) === "grpc") ||
      (!locator && state.popup.transport === "grpc")
    )
      setMode("grpc");
    else setMode((current) => (current === "ssh" ? "ssh" : "relay"));
  }, [projectId, locator]);

  const connect = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const popup = state.popup;
    const owner = state.authSession?.principal?.owner;
    const current = () =>
      store.getSnapshot().popup === popup &&
      store.getSnapshot().authSession?.principal?.owner === owner;
    const freshCode = code.trim() || undefined;
    // Clear the one-use input before awaiting an uncertain network response.
    setCode("");
    try {
      const result = await dispatch(
        creating
          ? {
              type: "CreateConnectedProject",
              name: name.trim(),
              root: directory.trim() || ".",
              endpoint: endpoint.trim(),
              pairingToken: freshCode,
              transport: mode === "grpc" ? "grpc" : "relay",
            }
          : {
              type: "ConnectHost",
              projectId,
              endpoint: showAddress ? endpoint.trim() : undefined,
              pairingToken: freshCode,
              transport: mode === "grpc" ? "grpc" : "relay",
            },
      );
      if (!current()) return;
      if (result) {
        dispatch({ type: "CloseRemoteConnectDialog" });
      } else setError(t("hostDlg.incomplete"));
    } catch (e) {
      if (!current()) return;
      const provisionalId = (e as { provisionalProjectId?: string })
        ?.provisionalProjectId;
      if (provisionalId) {
        await dispatch({
          type: "OpenRemoteConnectDialog",
          projectId: provisionalId,
          error: e instanceof Error ? e.message : String(e),
          endpoint: endpoint.trim(),
          transport: mode === "grpc" ? "grpc" : "relay",
        });
      }
      const errorCode = e instanceof CommandError ? e.code : undefined;
      if (errorCode === "resume_rejected" || errorCode === "pairing_required") {
        setError(hostReason[errorCode]);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="overlay host-connect-overlay">
      <div
        className="dialog remote-connect-dialog host-connect-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-connect-title"
        aria-busy={busy}
      >
        <div className="dialog-header">
          <h2 id="host-connect-title">
            {t(creating ? "hostDlg.newProjectTitle" : "hostDlg.title")}
          </h2>
          <button
            className="settings-close-btn"
            type="button"
            title={t("hostDlg.close")}
            aria-label={t("hostDlg.closeDialog")}
            onClick={() => dispatch({ type: "CloseRemoteConnectDialog" })}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="host-connect-body">
          <div
            className="auth-type-tabs"
            role="group"
            aria-label={t("hostDlg.method")}
          >
            {[
              ["relay", t("hostDlg.relay")],
              ["grpc", t("hostDlg.grpc")],
              ["ssh", t("hostDlg.ssh")],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="auth-tab-btn"
                disabled={busy}
                data-active={mode === value}
                aria-pressed={mode === value}
                onClick={() => {
                  setMode(value);
                  if (value === "ssh") return;
                  const current = hostCarrier(endpoint || locator || "");
                  if (
                    (value === "grpc" && current !== "grpc") ||
                    (value === "relay" && current === "grpc")
                  )
                    setEndpoint("");
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {mode === "ssh" ? (
            <div className="host-connect-note" role="status">
              {t("hostDlg.sshNote")}
            </div>
          ) : (
            <>
              <div className="host-connect-note">{t("hostDlg.note")}</div>
              {!creating && !connected && (
                <div className="host-connect-hint" role="status">
                  {t("hostDlg.scopedControls")}
                </div>
              )}
              {mode === "grpc" && (
                <div className="host-connect-note">{t("hostDlg.grpcNote")}</div>
              )}
              <div className="host-connect-fields">
                <div className="host-connect-field">
                  {creating ? (
                    <div className="host-connect-create">
                      <label htmlFor="host-project-name">
                        {t("hostDlg.projectName")}
                      </label>
                      <input
                        id="host-project-name"
                        className="settings-input"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        disabled={busy}
                        autoFocus
                      />
                      <label htmlFor="host-project-root">
                        {t("hostDlg.workspace")}
                      </label>
                      <input
                        id="host-project-root"
                        className="settings-input"
                        value={directory}
                        onChange={(e) => setDirectory(e.target.value)}
                        disabled={busy}
                        placeholder={t("hostDlg.dirPlaceholder")}
                      />
                      <small className="host-connect-hint">
                        {t("hostDlg.dirHint")}
                      </small>
                    </div>
                  ) : (
                    <>
                      <span className="host-connect-label">
                        {t("hostDlg.project")}
                      </span>
                      <strong data-testid="host-fixed-project">
                        {project?.name ?? t("hostDlg.projectUnavailable")}
                      </strong>
                    </>
                  )}
                </div>
                {!creating && project && (
                  <div className="host-connect-field">
                    <span className="host-connect-label">
                      {t("hostDlg.workspace")}
                    </span>
                    <code>{project.root || "."}</code>
                    {project.host_id && (
                      <code data-testid="host-fixed-identity">
                        {referenceLabels("host", state.projects.map((row) => row.host_id))(project.host_id)}
                      </code>
                    )}
                    {project.workspace_id && (
                      <code>{project.workspace_id}</code>
                    )}
                    <small className="host-connect-hint">
                      {t("hostDlg.pinnedHint")}
                    </small>
                    {locatorCarrier && (
                      <small className="host-connect-hint" data-testid="host-saved-transport">
                        {t("hostDlg.savedTransport", {
                          transport: t(`hostDlg.${locatorCarrier}`),
                        })}
                      </small>
                    )}
                  </div>
                )}
                {showAddress ? (
                  <div className="host-connect-field">
                    <label htmlFor="host-url">
                      {mode === "grpc"
                        ? t("hostDlg.grpcUrl")
                        : t("hostDlg.url")}
                    </label>
                    <input
                      id="host-url"
                      className="settings-input"
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                      disabled={busy}
                      placeholder={
                        mode === "grpc"
                          ? t("hostDlg.grpcPlaceholder")
                          : t("hostDlg.relayPlaceholder")
                      }
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {!creating && (
                      <small className="host-connect-hint">
                        {locator
                          ? t("hostDlg.urlUpdateHint")
                          : t("hostDlg.urlMissing")}
                      </small>
                    )}
                  </div>
                ) : (
                  <button
                    className="ghost-btn"
                    disabled={busy}
                    onClick={() => setRecover(true)}
                  >
                    {t("hostDlg.recover")}
                  </button>
                )}
                <div className="host-connect-field">
                  <label htmlFor="host-code">{t("hostDlg.code")}</label>
                  <input
                    id="host-code"
                    className="settings-input"
                    type="password"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    disabled={busy}
                    autoComplete="off"
                    placeholder={t("hostDlg.codePlaceholder")}
                  />
                  <small className="host-connect-hint">
                    {t("hostDlg.codeHint")}
                  </small>
                </div>
              </div>
              <div
                className="host-connect-note"
                role="status"
                data-testid="host-status"
                data-ready={readiness.ready}
              >
                <strong>
                  {t("hostDlg.status", {
                    status: hostStatusLabel(readiness.status),
                  })}
                </strong>
                {connection?.connected && connection.carrierMode && (
                  <div data-testid="host-carrier-mode">
                    {t(`host.carrier.${connection.carrierMode}`)}
                  </div>
                )}
                {connection?.connected && !connection.carrierMode && connection.effectiveTransport && (
                  <div data-testid="host-effective-transport">
                    {t(`hostDlg.effective.${connection.effectiveTransport}`)}
                  </div>
                )}
                {connection?.workspace && (
                  <div>
                    {t("hostDlg.bridgeWorkspace")}
                    <code>{connection.workspace}</code>
                  </div>
                )}
                {connection?.readiness && (
                  <div data-testid="host-readiness-phase">
                    {t("hostDlg.phase", { phase: connection.readiness.phase })}
                  </div>
                )}
                {connection?.readiness?.transport_warning && (
                  <div
                    className="host-connect-hint"
                    data-testid="host-transport-warning"
                  >
                    <code>{connection.readiness.transport_warning.code}</code>
                    {": "}
                    {connection.readiness.transport_warning.message}
                  </div>
                )}
                {connection?.cause &&
                  connection.reason &&
                  hostReason[connection.reason] &&
                  hostReason[connection.reason] !==
                    connection.cause.message && (
                    <div
                      className="host-connect-hint"
                      data-testid="host-recovery-guidance"
                    >
                      {hostReason[connection.reason]}
                    </div>
                  )}
                {(connection?.cause || connection?.reason) && (
                  <div
                    className="host-connect-error"
                    data-testid="host-public-cause"
                  >
                    {connection.cause ? (
                      <>
                        <code>{connection.cause.code}</code>
                        {": "}
                        {connection.cause.message}
                      </>
                    ) : (
                      (hostReason[connection.reason!] ??
                      t("hostDlg.reasonFallback", {
                        reason: connection.reason!,
                      }))
                    )}
                  </div>
                )}
              </div>
              {terminal && (
                <div className="host-connect-note" data-testid="host-terminal-guidance">
                  <p>{t(readiness.status === "binding_mismatch" ? "host.readiness.bindingMismatchNotice" : "host.readiness.preflightUnsupportedNotice")}</p>
                  <p>{t("hostDlg.terminalRecovery")}</p>
                  <div className="host-connect-create-actions">
                    <label htmlFor="host-compatible-project">{t("hostDlg.switchProject")}</label>
                    <select id="host-compatible-project" className="settings-input" value="" disabled={busy}
                      onChange={(event) => {
                        const id = event.target.value;
                        if (id) void dispatch({ type: "CreateSessionInProject", value: id });
                      }}>
                      <option value="">{t("hostDlg.selectProject")}</option>
                      {state.projects.filter((item) => item.id !== projectId).map((item) => (
                        <option key={item.id} value={item.id}>{item.name}</option>
                      ))}
                    </select>
                    <button className="ghost-btn" disabled={busy} onClick={() => setRecover(true)}>
                      {t("hostDlg.configureHost")}
                    </button>
                    <button className="ghost-btn" disabled={busy}
                      onClick={() => void dispatch({ type: "OpenCreateProjectDialog" })}>
                      {t("hostDlg.differentWorkspace")}
                    </button>
                  </div>
                </div>
              )}
              {connection && (connected || connection.observeRoute) && (
                <div className="host-connect-create-actions">
                  <button
                    className="ghost-btn"
                    disabled={busy}
                    onClick={() =>
                      void dispatch({
                        type: "RefreshHostState",
                        projectId,
                        reconcile: true,
                      })
                    }
                  >
                    {t(connected && canControl ? "hostDlg.refresh" : "hostDlg.observe")}
                  </button>
                  <button
                    className="ghost-btn"
                    disabled={busy || !connected}
                    onClick={() =>
                      void dispatch({ type: "RetryHostCatalog", projectId })
                    }
                  >
                    {t("hostDlg.retryCatalog")}
                  </button>
                </div>
              )}
              {connection?.catalogError && (
                <div role="alert" className="host-connect-error">
                  {t("hostDlg.catalogError", {
                    error: connection.catalogError,
                  })}
                </div>
              )}
              {connection?.debugError && (
                <div role="alert" className="host-connect-error">
                  {t("hostDlg.debugError", { error: connection.debugError })}
                </div>
              )}
              {connection?.operations && (
                <div data-testid="host-operations">
                  <h3>{t("hostDlg.ops")}</h3>
                  <p>{t("hostDlg.opsNote")}</p>
                  {connection.operations.length === 0 ? (
                    <p>{t("hostDlg.opsEmpty")}</p>
                  ) : (
                    connection.operations.map((op) => (
                      <div key={op.operation_id}>
                        <code>{op.operation_id}</code>：
                        {typeof op.state === "string"
                          ? op.state
                          : JSON.stringify(op.state)}
                        {op.reason && (
                          <span>
                            {" "}
                            — {op.reason.code}: {op.reason.message}
                          </span>
                        )}
                        {op.effects_may_have_occurred && (
                          <strong> {t("hostDlg.effects")}</strong>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
              {error && (
                <div role="alert" className="host-connect-error">
                  {error}
                </div>
              )}
            </>
          )}
        </div>
        <div className="dialog-actions host-connect-actions">
          <button
            className="ghost-btn"
            onClick={() => dispatch({ type: "CloseRemoteConnectDialog" })}
          >
            {t("hostDlg.close")}
          </button>
          {mode !== "ssh" && (
            <>
              <button
                className="ghost-btn"
                disabled={busy || !connection || !project || !canControl}
                onClick={() =>
                  void dispatch({ type: "DisconnectHost", projectId })
                }
              >
                {t("hostDlg.disconnect")}
              </button>
              <button
                className="primary-btn"
                disabled={
                  busy ||
                  state.connection !== "ws" ||
                  (creating ? !name.trim() : !project) ||
                  (!!showAddress && !endpoint.trim())
                }
                onClick={() => void connect()}
              >
                {busy
                  ? t("hostDlg.connecting")
                  : creating
                    ? t("hostDlg.createConnect")
                    : code
                      ? t("hostDlg.pairConnect")
                      : connected
                        ? t("hostDlg.reconnect")
                        : t("hostDlg.connect")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
