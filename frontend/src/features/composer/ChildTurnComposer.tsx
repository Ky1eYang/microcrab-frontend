import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useApp, useAppStore } from "../../state";
import { t } from "../../i18n";
import type { ChildInputDocument } from "../../client/child-input-documents";
import { CommandError } from "../../client/errors";
import { registerDocumentLeave } from "../../client/document-leave";
import {
  childInputAllowed,
  type ChildTurnOperation,
  type ChildTurnRequest,
  type ChildTurnScope,
} from "../../client/child-turns";
import type { NativeChildDetail } from "../../client/types";
import { childText } from "../childPresentation";
import { Icon } from "../shared";
import { ComposerSurface } from "./ComposerSurface";

export function ChildTurnComposer(props: {
  detail?: NativeChildDetail;
  childId: string;
  loading: boolean;
  onRefresh: () => void;
  onEarlier: () => void;
}) {
  const { state } = useApp();
  const store = useAppStore();
  const auth = state.authSession;
  const api = store.api;
  const owner = auth?.principal?.owner ?? "";
  const parentId = state.popup.parentId ?? "";
  const lifecycle = useRef({ auth, api, generation: 0 });
  if (lifecycle.current.auth !== auth || lifecycle.current.api !== api)
    lifecycle.current = {
      auth,
      api,
      generation: lifecycle.current.generation + 1,
    };
  const scope = { parentId, childId: props.childId };
  let retained: ChildInputDocument;
  try {
    retained = store.childInputs.open(api, owner, scope);
  } catch (failure) {
    return (
      <p role="alert" className="child-content-notice">
        {failure instanceof Error ? failure.message : String(failure)}
      </p>
    );
  }
  return (
    <ChildTurnDocument
      key={JSON.stringify([
        state.apiBase,
        owner,
        lifecycle.current.generation,
        parentId,
        props.childId,
      ])}
      {...props}
      scope={scope}
      retained={retained}
      owner={owner}
      fresh={!state.popup.error && !state.popup.loading}
      connected={
        state.connection === "ws" &&
        auth?.authenticated === true &&
        !state.authRequired
      }
      isCurrent={() => {
        const current = store.getSnapshot();
        return (
          store.api === api &&
          current.authSession === auth &&
          !current.authRequired &&
          current.sessionId === parentId &&
          current.popup.type === "subagentDetail" &&
          current.popup.parentId === parentId &&
          current.popup.childId === scope.childId
        );
      }}
    />
  );
}

function ChildTurnDocument({
  detail,
  childId,
  loading,
  onRefresh,
  onEarlier,
  scope,
  retained,
  owner,
  connected,
  fresh,
  isCurrent,
}: {
  detail?: NativeChildDetail;
  childId: string;
  loading: boolean;
  onRefresh: () => void;
  onEarlier: () => void;
  scope: ChildTurnScope;
  retained: ChildInputDocument;
  owner: string;
  connected: boolean;
  fresh: boolean;
  isCurrent: () => boolean;
}) {
  const store = useAppStore();
  const { dispatch } = useApp();
  const [text, setText] = useState(retained.text);
  const [error, setError] = useState(retained.error);
  const [receipt, setReceipt] = useState<ChildTurnOperation | null>(
    retained.receipt,
  );
  const [unknown, setUnknown] = useState(retained.unknown);
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [status, setStatus] = useState(retained.status);
  const root = useRef<HTMLDivElement>(null);
  const controller = useRef(new AbortController());
  const epoch = useRef(0);
  const generation = useRef(retained.generation);
  const pending = useRef(false);
  const operation = useRef(retained.operation);
  const continuation = useRef<(() => void) | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const polls = useRef(0);
  const latest = useRef({ text, busy, unresolved: !!operation.current });
  latest.current = { text, busy, unresolved: !!operation.current };
  const current = (ticket: number) =>
    epoch.current === ticket &&
    !controller.current.signal.aborted &&
    isCurrent();
  const allowed =
    connected && fresh && !loading && childInputAllowed(detail, scope);
  const report = (failure: unknown) => {
    const reason =
      failure instanceof CommandError
        ? `${failure.code}: ${failure.message}`
        : failure instanceof Error
          ? failure.message
          : String(failure);
    setError(reason);
    void dispatch({ type: "ShowToast", text: reason, kind: "warn" });
  };
  const install = (next: ChildTurnOperation, ticket: number) => {
    if (!current(ticket) || !operation.current) return;
    setReceipt(next);
    setUnknown(false);
    if (next.status === "accepted") {
      setStatus(t("childInput.accepted"));
      return;
    }
    const saved = operation.current;
    operation.current = null;
    if (next.status === "completed") {
      if (
        saved.generation === generation.current &&
        saved.text === latest.current.text
      ) {
        setText("");
        generation.current++;
      }
      setStatus(t("childInput.completed"));
    } else {
      const failure = next.result.error;
      setError(failure ? `${failure.code}: ${failure.message}` : next.status);
      setStatus(t("childInput.failedMayApply"));
    }
    // Every terminal receipt can follow admission. Read the currently inspected child only.
    onRefresh();
  };
  const observe = async (automatic = false) => {
    if (!operation.current || pending.current || !isCurrent()) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const ticket = epoch.current;
    const saved = operation.current;
    try {
      const next = await store.api.getChildTurnOperation(
        scope,
        saved.request.operation_id,
        owner,
        controller.current.signal,
      );
      if (current(ticket) && operation.current === saved) {
        install(next, ticket);
        if (next.status === "accepted") schedule();
      }
    } catch (failure) {
      if (current(ticket)) {
        setUnknown(true);
        if (!automatic) report(failure);
        else
          setError(
            failure instanceof CommandError
              ? `${failure.code}: ${failure.message}`
              : failure instanceof Error
                ? failure.message
                : String(failure),
          );
      }
    } finally {
      if (current(ticket)) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const schedule = () => {
    clearTimeout(timer.current);
    if (!operation.current || !isCurrent()) return;
    if (polls.current >= 12) {
      setStatus(t("childInput.pollPaused"));
      return;
    }
    const delay = Math.min(1000 * 2 ** Math.floor(polls.current / 3), 5000);
    polls.current++;
    timer.current = setTimeout(() => {
      void observe(true);
    }, delay);
  };
  const send = async () => {
    if (
      !allowed ||
      !text.trim() ||
      operation.current ||
      pending.current ||
      !isCurrent()
    )
      return;
    const ticket = epoch.current;
    const authored = text;
    const draftGeneration = generation.current;
    pending.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    setReceipt(null);
    try {
      // Refresh authority immediately before admission; this read never unlocks any other child or root composer.
      const fresh = await store.api.request<NativeChildDetail>(
        "session.child",
        { child_id: scope.childId, limit: 100 },
        scope.parentId,
        undefined,
        undefined,
        controller.current.signal,
      );
      if (!current(ticket)) return;
      if (
        !childInputAllowed(fresh, scope) ||
        store.getSnapshot().connection !== "ws"
      ) {
        onRefresh();
        throw new CommandError(
          "child_input_unavailable",
          t("childInput.authorityChanged"),
        );
      }
      if (
        draftGeneration !== generation.current ||
        authored !== latest.current.text
      )
        return;
      const request: ChildTurnRequest = {
        operation_id: crypto.randomUUID(),
        input: { parts: [{ type: "text", text: authored }] },
      };
      const saved = { request, text: authored, generation: draftGeneration };
      operation.current = saved;
      polls.current = 0;
      const next = await store.api.submitChildTurn(
        scope,
        request,
        owner,
        controller.current.signal,
      );
      if (current(ticket) && operation.current === saved) {
        install(next, ticket);
        if (next.status === "accepted") schedule();
      }
    } catch (failure) {
      if (current(ticket)) {
        if (
          operation.current &&
          failure instanceof CommandError &&
          (failure.outcomeUnknown ||
            ["receipt_pending", "outcome_unknown"].includes(failure.code))
        )
          setUnknown(true);
        else operation.current = null;
        report(failure);
      }
    } finally {
      if (current(ticket)) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  useLayoutEffect(() => {
    Object.assign(retained, {
      text,
      error,
      receipt,
      unknown,
      status,
      generation: generation.current,
      operation: operation.current,
    });
  });
  useLayoutEffect(() => {
    controller.current = new AbortController();
    return () => {
      retained.operation = operation.current;
      if (operation.current) retained.unknown = true;
      epoch.current++;
      controller.current.abort();
      clearTimeout(timer.current);
      continuation.current = undefined;
    };
  }, []);
  useEffect(
    () =>
      registerDocumentLeave(
        () => root.current,
        (proceed) => {
          if (latest.current.busy) return false;
          if (latest.current.text || latest.current.unresolved) {
            continuation.current = proceed;
            setDiscard(true);
            return false;
          }
          return true;
        },
        () =>
          latest.current.text
            ? {
                label: t("childInput.draftLabel", { child: childId }),
                text: latest.current.text,
              }
            : null,
      ),
    [],
  );
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (
        latest.current.text ||
        latest.current.unresolved ||
        latest.current.busy
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);
  const readonlyReason = !connected
    ? t("childInput.disconnected")
    : loading
      ? t("child.loading")
      : detail?.interaction === "return"
        ? t("childInput.returnReadonly")
        : detail?.current_role === "sub_agent"
          ? t("childInput.subReadonly")
          : t("childInput.metadataReadonly");
  const childStatus =
    !childText(detail?.status) || detail?.status === "unknown"
      ? t("child.unknown")
      : childText(detail?.status);
  return (
    <div ref={root} data-testid="child-turn-composer">
      <ComposerSurface>
        {!allowed && (
          <p
            className="child-content-notice"
            role="status"
            data-testid="child-input-readonly"
          >
            {readonlyReason}
          </p>
        )}
        {error && (
          <p className="child-content-notice" role="alert">
            {error}
          </p>
        )}
        {status && (
          <p className="child-content-notice" role="status">
            {status}
          </p>
        )}
        {unknown && (
          <p className="child-content-notice" role="status">
            {t("childInput.unknown")}
          </p>
        )}
        <textarea
          className="home-composer-textarea"
          data-testid="child-input"
          aria-label={t("composer.message")}
          placeholder={
            allowed ? t("childInput.placeholder") : t("child.inputHint")
          }
          value={text}
          disabled={!allowed || busy || !!operation.current}
          rows={2}
          onChange={(event) => {
            if (
              event.target.value.length >
              store.childInputs.maximumDraftCharacters
            ) {
              setError(
                t("childInput.draftLimit", {
                  limit: store.childInputs.maximumDraftCharacters,
                }),
              );
              return;
            }
            generation.current++;
            setText(event.target.value);
          }}
        />
        <div className="composer-bottom-bar home-composer-bottom-bar">
          <span
            className="composer-bar-left child-input-owner"
            data-testid="child-detail-status"
          >
            {childText(detail?.name)} · {childStatus}
            {detail ? ` · ${t(`child.${detail.availability}`)}` : ""}
          </span>
          <div className="child-content-actions">
            {detail?.next_cursor != null && (
              <button
                type="button"
                className="ghost-btn"
                disabled={loading}
                onClick={onEarlier}
              >
                {t("child.earlier")}
              </button>
            )}
            <button
              type="button"
              className="ghost-btn"
              disabled={loading}
              onClick={onRefresh}
            >
              {t("child.refresh")}
            </button>
            {operation.current && (
              <button
                type="button"
                className="ghost-btn"
                data-testid="child-observe-operation"
                disabled={busy || !connected}
                onClick={() => {
                  polls.current = 0;
                  clearTimeout(timer.current);
                  void observe();
                }}
              >
                {t("childInput.observe")}
              </button>
            )}
            <button
              type="button"
              className="composer-send-arrow-btn"
              data-testid="child-send"
              disabled={!allowed || !text.trim() || busy || !!operation.current}
              title={allowed ? t("childInput.send") : readonlyReason}
              aria-label={t("childInput.send")}
              onClick={() => void send()}
            >
              <Icon name="send" size={16} />
            </button>
          </div>
        </div>
      </ComposerSurface>
      {receipt && (
        <p className="settings-row-sub" data-testid="child-operation-status">
          {t(`childInput.operation.${receipt.status}`)}
        </p>
      )}
      {discard && (
        <div role="alertdialog" aria-label={t("childInput.discardTitle")}>
          <p>{t("childInput.discardHint")}</p>
          <button
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
              clearTimeout(timer.current);
              generation.current++;
              retained.text = "";
              retained.generation = generation.current;
              retained.operation = operation.current;
              retained.unknown = !!operation.current;
              setText("");
              setDiscard(false);
              latest.current = { text: "", busy: false, unresolved: false };
              proceed?.();
            }}
          >
            {t("speakers.discardLeave")}
          </button>
        </div>
      )}
    </div>
  );
}
