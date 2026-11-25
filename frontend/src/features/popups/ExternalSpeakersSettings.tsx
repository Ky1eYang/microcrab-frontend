import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useApp, useAppStore } from "../../state";
import { t } from "../../i18n";
import type { ApiClient } from "../../client/api";
import { CommandError } from "../../client/errors";
import { registerDocumentLeave } from "../../client/document-leave";
import {
  speakerOutcomeUnknown,
  validSpeakerIdentity,
  validSpeakerCustomKey,
  type SpeakerScope,
  type SpeakerSnapshot,
  type SpeakerLayer,
  type SpeakerBinding,
  type SpeakerUpdate,
} from "../../client/external-speakers";

export function ExternalSpeakersSettings({ scope }: { scope: SpeakerScope }) {
  const { state, dispatch } = useApp();
  const store = useAppStore();
  const api = store.api;
  const auth = state.authSession;
  const owner = auth?.principal?.owner;
  const lifecycle = useRef({ auth, api, generation: 0 });
  if (lifecycle.current.auth !== auth || lifecycle.current.api !== api)
    lifecycle.current = {
      auth,
      api,
      generation: lifecycle.current.generation + 1,
    };
  const identity = JSON.stringify([
    state.apiBase,
    owner,
    lifecycle.current.generation,
    scope.kind,
    scope.id,
  ]);
  if (!auth?.authenticated || !owner || state.authRequired) return null;
  return (
    <SpeakerSettingsDocument
      key={identity}
      api={api}
      scope={scope}
      isCurrent={() =>
        store.api === api &&
        store.getSnapshot().authSession === auth &&
        store.getSnapshot().popup === state.popup &&
        (scope.kind !== "session" ||
          store.getSnapshot().sessionId === scope.id) &&
        !store.getSnapshot().authRequired
      }
      notify={(text) => {
        void dispatch({ type: "ShowToast", text, kind: "warn" });
      }}
    />
  );
}

/** All credentials live only in this owner-fenced mounted settings document. */
export function SpeakerSettingsDocument({
  api,
  scope,
  isCurrent,
  notify,
}: {
  api: Pick<
    ApiClient,
    | "getExternalSpeakers"
    | "putExternalSpeakers"
    | "revealExternalSpeakerKey"
    | "getExternalSpeakerOperation"
  >;
  scope: SpeakerScope;
  isCurrent: () => boolean;
  notify: (message: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<SpeakerSnapshot | null>(null);
  const [draft, setDraft] = useState<SpeakerLayer>({});
  const [draftEnabled, setDraftEnabled] = useState(false);
  const enablementHelpId = useId();
  const [identity, setIdentity] = useState("");
  const [keyMode, setKeyMode] = useState<"generated" | "custom">("generated");
  const [customKey, setCustomKey] = useState("");
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [observed, setObserved] = useState<SpeakerSnapshot | null>(null);
  const [discard, setDiscard] = useState(false);
  const root = useRef<HTMLElement>(null);
  const pending = useRef(false);
  const epoch = useRef(0);
  const controller = useRef(new AbortController());
  const continuation = useRef<(() => void) | undefined>(undefined);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const operation = useRef<SpeakerUpdate | null>(null);
  const dirty =
    !!snapshot &&
    ((scope.kind === "project" && draftEnabled !== snapshot.enabled) ||
      JSON.stringify(draft) !== JSON.stringify(snapshot.overrides) ||
      !!identity ||
      !!customKey);
  const latest = useRef({ dirty, busy, uncertain });
  latest.current = { dirty, busy, uncertain };
  const current = (ticket: number) =>
    ticket === epoch.current &&
    !controller.current.signal.aborted &&
    isCurrent();
  const install = (next: SpeakerSnapshot) => {
    operation.current = null;
    setSnapshot(next);
    setDraft(structuredClone(next.overrides));
    setDraftEnabled(next.enabled);
    setIdentity("");
    setCustomKey("");
    setRevealed({});
    setObserved(null);
    setNeedsRefresh(false);
  };
  const fail = (failure: unknown) => {
    const text =
      failure instanceof CommandError
        ? failure.code === "project_external_messaging_busy"
          ? t("speakers.projectBusy")
          : failure.code === "revision_conflict"
            ? t("speakers.revisionConflict")
            : `${failure.code}: ${failure.message}`
        : failure instanceof Error
          ? failure.message
          : String(failure);
    setError(text);
    notify(text);
    if (operation.current && speakerOutcomeUnknown(failure)) setUncertain(true);
    else if (!uncertain) operation.current = null;
  };
  const run = async (
    effect: (signal: AbortSignal, ticket: number) => Promise<void>,
  ) => {
    if (pending.current || !isCurrent()) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    const ticket = epoch.current;
    try {
      await effect(controller.current.signal, ticket);
    } catch (failure) {
      if (current(ticket)) fail(failure);
    } finally {
      if (current(ticket)) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  useLayoutEffect(() => {
    controller.current = new AbortController();
    pending.current = false;
    return () => {
      epoch.current++;
      controller.current.abort();
      operation.current = null;
      continuation.current = undefined;
    };
  }, []);
  useEffect(() => {
    void run(async (signal, ticket) => {
      const next = await api.getExternalSpeakers(scope, signal);
      if (current(ticket)) install(next);
    });
  }, []);
  useEffect(
    () =>
      registerDocumentLeave(
        () => root.current,
        (proceed, intent) => {
          // Switching Project tabs must not throw away an unsettled receipt.
          // Actual document exit still uses explicit abandonment confirmation.
          if (
            pending.current ||
            latest.current.busy ||
            (intent === "tab" && latest.current.uncertain)
          )
            return false;
          if (latest.current.dirty || latest.current.uncertain) {
            continuation.current = proceed;
            setDiscard(true);
            return false;
          }
          return true;
        },
      ),
    [],
  );
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (
        latest.current.dirty ||
        latest.current.busy ||
        latest.current.uncertain
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);
  useLayoutEffect(() => {
    if (!discard) return;
    const opener = document.activeElement;
    keepEditing.current?.focus();
    keepEditing.current?.scrollIntoView({ block: "nearest" });
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [discard]);
  const change = (name: string, binding?: SpeakerBinding) => {
    setDraft((value) => {
      const next = { ...value };
      if (binding)
        Object.defineProperty(next, name, {
          value: binding,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      else delete next[name];
      return next;
    });
    setRevealed({});
    setStatus("");
    setError("");
  };
  const add = () => {
    if (!validSpeakerIdentity(identity)) {
      setError(t("speakers.identityHint"));
      return;
    }
    if (keyMode === "custom" && !validSpeakerCustomKey(customKey)) {
      setError(t("speakers.keyHint"));
      return;
    }
    change(identity, {
      action: "set",
      key:
        keyMode === "generated"
          ? { kind: "generated" }
          : { kind: "custom", value: customKey },
    });
    setIdentity("");
    setCustomKey("");
  };
  const save = () => {
    if (
      pending.current ||
      !isCurrent() ||
      !snapshot ||
      uncertain ||
      !dirty ||
      identity ||
      customKey
    )
      return;
    const update: SpeakerUpdate = {
      operation_id: crypto.randomUUID(),
      expected_revision: snapshot.revision,
      speakers: structuredClone(draft),
      ...(scope.kind === "project" ? { enabled: draftEnabled } : {}),
    };
    operation.current = update;
    void run(async (signal, ticket) => {
      const next = await api.putExternalSpeakers(scope, update, signal);
      if (current(ticket)) {
        operation.current = null;
        install(next);
        setStatus(
          t(
            scope.kind === "project" && update.enabled !== snapshot.enabled
              ? "speakers.projectSaved"
              : "speakers.saved",
          ),
        );
      }
    });
  };
  const refresh = () =>
    void run(async (signal, ticket) => {
      setRevealed({});
      const next = await api.getExternalSpeakers(scope, signal);
      if (!current(ticket)) return;
      if (dirty || uncertain) setObserved(next);
      else install(next);
    });
  const observe = () => {
    const update = operation.current;
    if (!update) return;
    void run(async (signal, ticket) => {
      const saved = await api.getExternalSpeakerOperation(
        scope,
        update.operation_id,
        signal,
      );
      if (!current(ticket) || operation.current !== update) return;
      // A retained receipt is evidence about one operation, never current status.
      if (
        typeof saved.enabled !== "boolean" ||
        (update.enabled !== undefined && update.enabled !== saved.enabled)
      )
        throw new CommandError(
          "invalid_result",
          t("speakers.receiptNotAcknowledged"),
        );
      operation.current = null;
      setUncertain(false);
      setNeedsRefresh(true);
      setSnapshot(null);
      setDraft({});
      setRevealed({});
      setObserved(null);
      setStatus(t("speakers.receiptApplied"));
    });
  };
  const reveal = (name: string, copy: boolean) =>
    void run(async (signal, ticket) => {
      setRevealed({});
      const next = await api.revealExternalSpeakerKey(scope, name, signal);
      if (!current(ticket)) return;
      const row = snapshot?.speakers.find((item) => item.identity === name);
      if (next.fingerprint !== row?.fingerprint)
        throw new CommandError("revision_conflict", t("speakers.keyChanged"));
      if (copy) {
        await navigator.clipboard.writeText(next.key);
        if (current(ticket)) setStatus(t("speakers.copied"));
      } else setRevealed((value) => ({ ...value, [name]: next.key }));
    });
  const rows = [
    ...new Set([
      ...(snapshot?.speakers.map((row) => row.identity) ?? []),
      ...Object.keys(draft),
    ]),
  ].sort();
  const locked = busy || uncertain || needsRefresh || !snapshot;
  const canReveal =
    snapshot?.enabled &&
    !observed &&
    (scope.kind === "session" || draftEnabled) &&
    !dirty &&
    !locked;
  const effectiveStatus = (value: SpeakerSnapshot) =>
    t(
      value.enabled
        ? "speakers.enabledStatus"
        : `speakers.disabledStatus.${value.disabled_reason}`,
    );
  return (
    <section
      ref={root}
      className="settings-section-card"
      data-testid="external-speakers"
      aria-label={t("speakers.title")}
    >
      <div className="settings-section-head">
        <h4 className="settings-section-title">{t("speakers.title")}</h4>
      </div>
      <p className="settings-description">
        {t(
          scope.kind === "project"
            ? "speakers.projectHint"
            : "speakers.sessionHint",
        )}
      </p>
      {scope.kind === "project" && (
        <div className="settings-row-info">
          <label className="settings-row-label">
            <input
              type="checkbox"
              role="switch"
              checked={draftEnabled}
              disabled={locked}
              aria-describedby={enablementHelpId}
              onChange={(event) => {
                setDraftEnabled(event.target.checked);
                setRevealed({});
                setError("");
                setStatus("");
              }}
            />{" "}
            {t("speakers.allow")}
          </label>
          <p className="settings-row-sub" id={enablementHelpId}>
            {t("speakers.allowHint")}
          </p>
        </div>
      )}
      {(needsRefresh || snapshot) && (
        <p
          className="settings-row-sub"
          role="status"
          data-testid="external-messaging-status"
        >
          {needsRefresh && t("speakers.statusNeedsRefresh")}
          {!needsRefresh && snapshot && effectiveStatus(observed ?? snapshot)}
        </p>
      )}
      <p className="settings-row-sub">{t("speakers.secretsHint")}</p>
      {error && (
        <p role="alert" className="settings-field-error">
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="inline-notice">
          {status}
        </p>
      )}
      {uncertain && (
        <>
          <p role="status" className="inline-notice">
            {t("speakers.uncertain")}
            {scope.kind === "project" &&
              ` ${t("speakers.projectTabUncertain")}`}
          </p>
          {operation.current && (
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={observe}
            >
              {t("speakers.observe")}
            </button>
          )}
        </>
      )}
      {busy && <p role="status">{t("speakers.pending")}</p>}
      {observed && (
        <div className="settings-row-info" data-testid="speakers-observed">
          <p>{t("speakers.observed", { revision: observed.revision })}</p>
          {observed.speakers.map((row) => (
            <p key={row.identity}>
              {row.identity} ·{" "}
              {t(
                row.disabled
                  ? "speakers.disabled"
                  : `speakers.source.${row.source}`,
              )}{" "}
              · {row.fingerprint?.slice(0, 16) ?? "—"}
            </p>
          ))}
          <button
            type="button"
            className="ghost-btn"
            disabled={busy || (uncertain && !!operation.current)}
            onClick={() => {
              operation.current = null;
              install(observed);
              setUncertain(false);
              setError("");
              setStatus(t("speakers.rebased"));
            }}
          >
            {t("speakers.rebase")}
          </button>
        </div>
      )}
      {!rows.length && snapshot && (
        <p className="settings-row-sub">{t("speakers.empty")}</p>
      )}
      {rows.map((name) => {
        const row = snapshot?.speakers.find((item) => item.identity === name);
        const local = Object.hasOwn(draft, name) ? draft[name] : undefined;
        const original =
          snapshot && Object.hasOwn(snapshot.overrides, name)
            ? snapshot.overrides[name]
            : undefined;
        const changed = JSON.stringify(local) !== JSON.stringify(original);
        const disabled = local?.action === "disable";
        return (
          <div className="settings-row" key={name} data-testid="speaker-row">
            <div
              className="settings-row-info"
              style={{ minWidth: 0, overflowWrap: "anywhere" }}
            >
              <div className="settings-row-label">{name}</div>
              <div className="settings-row-sub">
                {t(
                  disabled
                    ? "speakers.disabled"
                    : local
                      ? "speakers.local"
                      : scope.kind === "project"
                        ? "speakers.removed"
                        : "speakers.inherited",
                )}{" "}
                · {row?.fingerprint?.slice(0, 16) ?? "—"}
                {changed ? ` · ${t("speakers.draft")}` : ""}
              </div>
              {local?.action === "set" && local.key.kind !== "keep" && (
                <div className="settings-row-sub">
                  {t(`speakers.${local.key.kind}`)}
                </div>
              )}
              {Object.hasOwn(revealed, name) && (
                <div>
                  <input
                    className="settings-input monospace-text"
                    aria-label={t("speakers.revealedKey", { identity: name })}
                    readOnly
                    value={revealed[name]}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => setRevealed({})}
                  >
                    {t("speakers.hide")}
                  </button>
                </div>
              )}
              <div
                className="settings-actions-row"
                style={{ flexWrap: "wrap" }}
              >
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={locked}
                  onClick={() => {
                    setIdentity(name);
                    setKeyMode("generated");
                    setCustomKey("");
                  }}
                >
                  {t(local ? "speakers.replace" : "speakers.override")}
                </button>
                {scope.kind === "session" && (
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={locked || disabled}
                    onClick={() => change(name, { action: "disable" })}
                  >
                    {t("speakers.revoke")}
                  </button>
                )}
                {local && (
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={locked}
                    onClick={() => change(name)}
                  >
                    {t(
                      scope.kind === "session"
                        ? "speakers.reset"
                        : "speakers.remove",
                    )}
                  </button>
                )}
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={!canReveal || !row || row.disabled}
                  onClick={() => reveal(name, false)}
                >
                  {t("speakers.reveal")}
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={!canReveal || !row || row.disabled}
                  onClick={() => reveal(name, true)}
                >
                  {t("speakers.copy")}
                </button>
              </div>
            </div>
          </div>
        );
      })}
      <fieldset
        disabled={locked}
        style={{ border: 0, padding: 0, minWidth: 0 }}
      >
        <legend className="settings-row-label">{t("speakers.add")}</legend>
        <label className="settings-row-sub">
          {t("speakers.identity")}
          <input
            className="settings-input"
            data-testid="speaker-identity"
            value={identity}
            maxLength={64}
            onChange={(event) => setIdentity(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p className="settings-row-sub">{t("speakers.identityHint")}</p>
        <label className="settings-row-sub">
          {t("speakers.keyMode")}
          <select
            aria-label={t("speakers.keyMode")}
            className="settings-input"
            value={keyMode}
            onChange={(event) => {
              setKeyMode(event.target.value as "generated" | "custom");
              setCustomKey("");
            }}
          >
            <option value="generated">{t("speakers.generated")}</option>
            <option value="custom">{t("speakers.custom")}</option>
          </select>
        </label>
        {keyMode === "custom" && (
          <label className="settings-row-sub">
            {t("speakers.custom")}
            <input
              type="password"
              aria-label={t("speakers.custom")}
              className="settings-input"
              value={customKey}
              maxLength={128}
              onChange={(event) => setCustomKey(event.target.value)}
              autoComplete="new-password"
              spellCheck={false}
            />
            <span>{t("speakers.keyHint")}</span>
          </label>
        )}
        <div className="settings-actions-row">
          <button
            type="button"
            className="ghost-btn"
            disabled={!identity}
            onClick={add}
          >
            {t("speakers.stage")}
          </button>
          <button
            type="button"
            className="ghost-btn"
            disabled={!identity && !customKey}
            onClick={() => {
              setIdentity("");
              setCustomKey("");
            }}
          >
            {t("speakers.cancelAdd")}
          </button>
        </div>
      </fieldset>
      <div className="settings-actions-row" style={{ flexWrap: "wrap" }}>
        <button
          type="button"
          className="primary-btn"
          data-testid="speakers-save"
          disabled={locked || !dirty || !!identity || !!customKey}
          onClick={save}
        >
          {t("speakers.save")}
        </button>
        <button
          type="button"
          className="ghost-btn"
          disabled={busy}
          onClick={refresh}
        >
          {t("speakers.refresh")}
        </button>
        <button
          type="button"
          className="ghost-btn"
          disabled={busy || uncertain || !dirty}
          onClick={() => {
            if (snapshot) install(snapshot);
            setError("");
          }}
        >
          {t("speakers.discard")}
        </button>
      </div>
      {discard && (
        <div role="alertdialog" aria-label={t("speakers.discardTitle")}>
          <p>{t("speakers.discardHint")}</p>
          <button
            ref={keepEditing}
            type="button"
            className="ghost-btn"
            onClick={() => {
              continuation.current = undefined;
              setDiscard(false);
            }}
          >
            {t("speakers.keepEditing")}
          </button>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              if (pending.current || !isCurrent()) return;
              const proceed = continuation.current;
              continuation.current = undefined;
              latest.current = { dirty: false, busy: false, uncertain: false };
              if (snapshot) install(snapshot);
              setUncertain(false);
              setDiscard(false);
              proceed?.();
            }}
          >
            {t("speakers.discardLeave")}
          </button>
        </div>
      )}
    </section>
  );
}
