import { userTaskInputAllowed } from "../client/session-kind";
import { Icon as PermissionIcon } from "../shell/Icon";
import { QueueDock } from "./composer/QueueDock";
import { ComposerSurface } from "./composer/ComposerSurface";
import { StatisticsDock } from "./composer/StatisticsDock";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ComposerImages } from "./composer/Images";
import { AgentModeMenu } from "./composer/AgentModeMenu";
import {
  ComposerActionMenu,
  matchingComposerActions,
  type ComposerMenuAction,
} from "./composer/ComposerActionMenu";
import "../styles/composer-controls.css";
import { activeSession, useAppDispatch, useAppSelector } from "../state";
import { parseSlash } from "../state/composer-draft";
import { hostReadiness } from "../state/host-readiness";
import { selectedModel } from "../state/model";
import { t } from "../i18n";
const tr = t;
import {
  GlyphIcon,
  Icon,
  isBusy,
  latestUser,
  lower,
  titleCase,
  useMenuEscape,
  useOutside,
} from "./shared";

const SLASH_QUERY = /^\/([^\s]*)$/;

export function Composer({
  onSubmitIntent,
}: { onSubmitIntent?: () => () => void } = {}) {
  const dispatch = useAppDispatch();
  const { state } = useAppSelector(
    (state) => ({
      state,
      facts: JSON.stringify([
        isBusy(state.transcript),
        state.transcript.interrupting,
        state.transcript.inboxActive,
        state.transcript.model?.id,
        state.transcript.model?.providerId,
        state.transcript.model?.variant,
        state.transcript.sessionStatus,
        latestUser(state.transcript)?.messageId,
      ]),
    }),
    (before, after) =>
      before.facts === after.facts &&
      (
        [
          "composer",
          "composerImages",
          "composerFocusRequest",
          "sessionId",
          "sessions",
          "connection",
          "authSession",
          "hostConnection",
          "draftWorkspace",
          "capabilities",
          "isCreatingSession",
          "compactInflight",
          "sessionRecoveryPending",
          "sessionRecoveryUnknown",
          "agentInitRetryRequired",
          "autoCompactionRetryAvailable",
          "inboxPending",
          "historyMutationPending",
          "retryPending",
          "imageIntakePending",
          "modeSelectionPending",
          "modelSelectionPending",
          "historyAvailable",
          "historyTruncated",
          "agents",
          "draftAgent",
          "draftMode",
          "draftModel",
          "availableModels",
          "policy",
          "resolvedLocale",
        ] as const
      ).every((key) => Object.is(before.state[key], after.state[key])),
  );
  const [menu, setMenu] = useState<"plus" | "model" | "agent" | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [slashCursor, setSlashCursor] = useState({
    draft: state.composer,
    index: 0,
  });
  const [dismissedSlash, setDismissedSlash] = useState<string | null>(null);
  useMenuEscape(menu, () => setMenu(null));
  useOutside(
    ".composer-plus-wrap, .composer-model-picker-wrap, .composer-agent-picker-wrap, .composer-action-menu, .composer-agent-mode-menu, .model-variant-picker-dropdown",
    () => setMenu(null),
  );
  const session = activeSession(state);
  const child = !userTaskInputAllowed(session, state.publicState);
  const focusedRequest = useRef(state.composerFocusRequest);
  useEffect(() => {
    const request = state.composerFocusRequest;
    if (request === focusedRequest.current) return;
    focusedRequest.current = request;
    if (!request || request.sessionId !== state.sessionId || child) return;
    const element = input.current;
    if (element && !element.disabled) {
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    }
  }, [state.composerFocusRequest, state.sessionId, child]);
  const ready = state.connection === "ws" && !!state.authSession?.authenticated;
  const host = hostReadiness(state);
  const currentProjectId = host.projectId;
  const isHostReady = host.ready;
  const isProjectOffline = !isHostReady;
  const browserHost = !host.projectId;
  const browserError =
    browserHost && host.matched && !!state.hostConnection?.catalogError;
  const hostNotice = browserHost
    ? browserError
      ? t("browserHost.unavailableNotice", {
          error: state.hostConnection?.catalogError ?? "",
        })
      : t("browserHost.loadingNotice")
    : host.status === "loading_catalog"
      ? t("host.readiness.loadingNotice")
      : host.status === "catalog_error"
        ? t("host.readiness.catalogErrorNotice", {
            error: state.hostConnection?.catalogError ?? "",
          })
        : host.status === "project_mismatch"
          ? t("host.readiness.projectMismatchNotice")
          : ["connecting", "pairing", "reconciling"].includes(host.status)
            ? t("host.readiness.pendingNotice")
            : t("host.readiness.offlineNotice");
  const has = (method: string) =>
    state.capabilities?.methods.includes(method) === true;
  // A requested stop is input-ready at once; the runtime settles behind it.
  const turnActive =
    !state.transcript.interrupting &&
    (isBusy(state.transcript) || state.transcript.inboxActive);
  const busy =
    turnActive ||
    state.isCreatingSession ||
    state.compactInflight ||
    state.sessionRecoveryPending;
  const inboxBlocked =
    child ||
    !ready ||
    isProjectOffline ||
    !state.sessionId ||
    state.isCreatingSession ||
    state.compactInflight ||
    state.inboxPending ||
    state.historyMutationPending ||
    state.retryPending ||
    state.imageIntakePending ||
    state.modeSelectionPending ||
    state.modelSelectionPending;
  const unsupported = (feature: string) => {
    // TODO: Wire these controls only when native APIs provide the requested behavior.
    dispatch({
      type: "ShowToast",
      kind: "error",
      text: t("composer.unsupported", { feature }),
    });
  };
  const draft = state.composer;
  const slashIndex = slashCursor.draft === draft ? slashCursor.index : 0;
  const setSlashIndex = (value: number | ((index: number) => number)) => {
    setSlashCursor((current) => {
      const index = current.draft === draft ? current.index : 0;
      return {
        draft,
        index: typeof value === "function" ? value(index) : value,
      };
    });
  };
  const slashMatch = SLASH_QUERY.exec(draft);
  const slashVisible = !!slashMatch && dismissedSlash !== draft;
  useEffect(() => {
    if (slashVisible && menu === "plus") setMenu(null);
  }, [slashVisible, menu]);
  const compactAvailable =
    !!state.sessionId &&
    !child &&
    ready &&
    !busy &&
    has("session.compact") &&
    !state.modeSelectionPending;
  const chooseCompact = () => {
    if (!compactAvailable) return;
    const parsed = parseSlash(draft);
    const instruction = parsed?.kind === "compact" ? parsed.instruction : "";
    const value = `/compact ${instruction}`;
    dispatch({ type: "SetComposer", value });
    setDismissedSlash(value);
    input.current?.focus();
  };
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    // Collapsing the focused textarea on every keystroke makes the browser
    // scroll its caret into view inside the sticky transcript. Measure a
    // noninteractive copy instead, and apply only the final changed height.
    const measure = element.cloneNode(false) as HTMLTextAreaElement;
    measure.removeAttribute("aria-label");
    measure.removeAttribute("id");
    measure.setAttribute("aria-hidden", "true");
    measure.tabIndex = -1;
    measure.value = element.value;
    Object.assign(measure.style, {
      position: "fixed",
      visibility: "hidden",
      pointerEvents: "none",
      width: `${element.getBoundingClientRect().width}px`,
      height: "0",
      minHeight: "0",
      maxHeight: "none",
      overflow: "hidden",
    });
    element.parentElement?.append(measure);
    const height = `${measure.scrollHeight}px`;
    measure.remove();
    if (element.style.height !== height) element.style.height = height;
  }, [draft, state.sessionId]);
  const submit = (steer = false) => {
    if (isProjectOffline) {
      dispatch({
        type: "ShowToast",
        kind: "error",
        text: hostNotice,
      });
      return;
    }
    if (
      !ready ||
      child ||
      state.isCreatingSession ||
      state.historyMutationPending ||
      state.retryPending ||
      state.inboxPending ||
      state.compactInflight ||
      state.modelSelectionPending ||
      state.modeSelectionPending ||
      state.sessionRecoveryPending ||
      state.agentInitRetryRequired ||
      state.sessionRecoveryUnknown ||
      state.imageIntakePending ||
      (!draft.trim() && !state.composerImages.length)
    )
      return;
    if (turnActive) {
      if (slashMatch) return;
      const method = steer ? "turn.steer" : "turn.queue";
      if (!inboxBlocked && has(method)) {
        const accepted = onSubmitIntent?.();
        void dispatch({ type: steer ? "SteerInput" : "QueueInput" }).then(
          (result) => {
            if (
              result?.status === "completed" &&
              result.sessionId === state.sessionId
            )
              accepted?.();
          },
        );
      }
      return;
    }
    if (
      draft.startsWith("/") ||
      (has("turn.queue") && (state.sessionId || has("session.create")))
    ) {
      const accepted = !parseSlash(draft) ? onSubmitIntent?.() : undefined;
      void dispatch({ type: "Submit" }).then((result) => {
        if (
          result?.status === "completed" &&
          (!state.sessionId || result.sessionId === state.sessionId)
        )
          accepted?.();
      });
    }
  };
  const currentModelId = session?.model?.id ?? state.transcript.model?.id;
  const model = selectedModel(state);
  const variants = model?.variants ?? [];
  const variant = model?.variant;
  const undo = latestUser(state.transcript);
  const pickVariant = (value: string | null) => {
    setMenu(null);
    dispatch({ type: "SelectModelVariant", value });
  };
  const historyLocked = !!state.historyMutationPending || !!state.retryPending;
  const menuActions: ComposerMenuAction[] = [
    {
      id: "add_file",
      section: "add",
      label: t("composer.menu.addFile"),
      description: t("composer.menu.addFileDescription"),
      icon: "attach",
      hint: "@",
      disabled: child || !ready || historyLocked,
      run: () => {
        // TODO: File mention/context resolution requires a native API.
        unsupported(t("composer.menu.addFileUnsupported"));
        setMenu(null);
        input.current?.focus();
      },
    },
    {
      id: "compact",
      section: "command",
      label: t("composer.menu.compact"),
      description: compactAvailable
        ? t("composer.slash.compact")
        : t("composer.compact.unavailable"),
      icon: "compact",
      hint: "/compact",
      optionId: "composer-slash-compact",
      disabled:
        child ||
        !ready ||
        busy ||
        historyLocked ||
        !state.sessionId ||
        !has("session.compact"),
      run: () => {
        setMenu(null);
        if (slashVisible) chooseCompact();
        else dispatch({ type: "OpenCompact", value: state.sessionId });
      },
    },
    {
      id: "undo",
      section: "command",
      label: t("composer.menu.undo"),
      description: t("composer.menu.undoDescription"),
      icon: "undo",
      hint: "Ctrl+Z",
      disabled:
        child ||
        !ready ||
        busy ||
        historyLocked ||
        !undo ||
        state.historyAvailable?.undo === false ||
        !has("history.travel"),
      run: () => {
        setMenu(null);
        dispatch({ type: "RevertTurn", value: undo?.messageId });
      },
    },
    {
      id: "redo",
      section: "command",
      label: t("composer.menu.redo"),
      description: t("composer.menu.redoDescription"),
      icon: "undo",
      disabled:
        child ||
        !ready ||
        busy ||
        historyLocked ||
        !state.sessionId ||
        state.historyAvailable?.redo === false ||
        !has("history.travel"),
      run: () => {
        setMenu(null);
        dispatch({ type: "HistoryRedo" });
      },
    },
    {
      id: "checkpoint",
      section: "command",
      label: t("composer.menu.checkpoint"),
      description: t("composer.menu.checkpointDescription"),
      icon: "clock",
      disabled:
        child ||
        !ready ||
        busy ||
        historyLocked ||
        !state.sessionId ||
        !has("checkpoint.create"),
      run: () => {
        setMenu(null);
        dispatch({ type: "Checkpoint" });
      },
    },
    ...(state.historyTruncated
      ? [
          {
            id: "earlier",
            section: "command" as const,
            label: t("composer.menu.earlier"),
            description: t("composer.menu.earlierDescription"),
            icon: "clock",
            disabled: !ready || historyLocked || !has("session.blocks"),
            run: () => {
              setMenu(null);
              dispatch({ type: "LoadEarlier" });
            },
          },
        ]
      : []),
  ];
  const slashActions = matchingComposerActions(
    menuActions,
    slashMatch?.[1] ?? "",
  );
  const slashAction =
    slashActions[slashIndex % Math.max(1, slashActions.length)];
  const activeSlashId = slashAction
    ? (slashAction.optionId ?? `composer-slash-${slashAction.id}`)
    : undefined;
  const actionMenu =
    menu === "plus" || slashVisible ? (
      <ComposerActionMenu
        actions={
          slashVisible
            ? menuActions.map((action) => ({
                ...action,
                run: () => {
                  if (action.id !== "compact")
                    dispatch({ type: "SetComposer", value: "" });
                  action.run();
                },
              }))
            : menuActions
        }
        mode={slashVisible ? "slash" : "full"}
        query={slashVisible ? slashMatch![1] : ""}
        activeId={slashVisible ? activeSlashId : undefined}
      />
    ) : null;
  return (
    <ComposerSurface
      menu={
        <>
          {actionMenu}
          {menu === "agent" && (
            <AgentModeMenu
              agents={state.agents}
              agent={state.draftAgent}
              mode={state.draftMode}
              pinned={!!state.sessionId}
              pending={
                state.modeSelectionPending ||
                state.modelSelectionPending ||
                state.isCreatingSession ||
                !ready ||
                !isHostReady
              }
              onSelect={(agent, mode) => {
                setMenu(null);
                dispatch({ type: "SetAgentMode", agent, mode });
                input.current?.focus();
              }}
              onManage={() => {
                setMenu(null);
                if (currentProjectId)
                  dispatch({
                    type: "OpenProjectSettings",
                    value: currentProjectId,
                    tab: "agents",
                  });
              }}
            />
          )}
          {menu === "model" && (
            <div
              className="model-variant-picker-dropdown"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                className="model-picker-item"
                type="button"
                disabled={
                  child ||
                  !ready ||
                  state.isCreatingSession ||
                  state.modeSelectionPending ||
                  state.modelSelectionPending ||
                  (!!state.sessionId && !has("session.set_model"))
                }
                onClick={() => {
                  setMenu(null);
                  dispatch({ type: "OpenModelSelect" });
                }}
              >
                <div className="model-picker-item-left">
                  <Icon name="model" />
                  <span>{t("composer.pickModelEllipsis")}</span>
                </div>
                <GlyphIcon name="chevron" className="model-picker-chevron" />
              </button>
              <div className="model-picker-divider" />
              <div className="model-picker-section-title">
                {t("composer.model.section")}
              </div>
              {variants.length ? (
                <>
                  {[null, ...variants].map((v) => {
                    const selected =
                      v === null
                        ? !variant || variant === "default"
                        : variant === v;
                    return (
                      <button
                        key={v ?? "default"}
                        className={`model-picker-item${selected ? " active" : ""}`}
                        type="button"
                        disabled={
                          child ||
                          !ready ||
                          state.isCreatingSession ||
                          state.modeSelectionPending ||
                          state.modelSelectionPending ||
                          (!!state.sessionId && !has("session.set_model"))
                        }
                        onClick={() => pickVariant(v)}
                      >
                        <div className="model-picker-item-left">
                          <span>
                            {v === null
                              ? t("composer.defaultVariant")
                              : titleCase(v)}
                          </span>
                        </div>
                        {selected && (
                          <span className="model-picker-check">
                            <GlyphIcon name="check" size={14} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </>
              ) : (
                <div className="model-picker-item disabled">
                  <span className="model-picker-disabled-hint">
                    {t("composer.noVariants")}
                  </span>
                </div>
              )}
            </div>
          )}
        </>
      }
      clip={isProjectOffline}
    >
      {isProjectOffline && (
        <div
          className="composer-offline-banner"
          role="alert"
          data-host-state={host.status}
        >
          <div className="composer-offline-left">
            <Icon
              name="warning"
              size={16}
              className="offline-icon"
              aria-hidden="true"
            />
            <span className="offline-text">{hostNotice}</span>
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
                ? t("browserHost.retry")
                : host.status === "catalog_error"
                  ? t("host.readiness.retryCatalog")
                  : host.status === "loading_catalog"
                    ? t("host.readiness.loadingAction")
                    : t("host.readiness.connect")}
            </button>
          )}
        </div>
      )}
      {!child &&
        state.sessionId &&
        (state.agentInitRetryRequired ||
          state.autoCompactionRetryAvailable ||
          state.sessionRecoveryUnknown) && (
          <div
            className="composer-offline-banner"
            role="status"
            data-testid="session-recovery-notice"
          >
            <div className="composer-offline-left">
              <Icon
                name="warning"
                size={16}
                className="offline-icon"
                aria-hidden="true"
              />
              <span className="offline-text">
                {t(
                  state.sessionRecoveryUnknown
                    ? "sessionRecovery.unknown"
                    : state.agentInitRetryRequired
                      ? "sessionRecovery.initNotice"
                      : "sessionRecovery.autoNotice",
                )}
              </span>
            </div>
            {state.sessionRecoveryUnknown ? (
              <button
                type="button"
                className="composer-offline-reconnect-btn"
                disabled={
                  !ready || !isHostReady || state.sessionRecoveryPending
                }
                onClick={() => dispatch({ type: "CheckSessionRecovery" })}
              >
                {t("sessionRecovery.checkStatus")}
              </button>
            ) : state.agentInitRetryRequired ? (
              <button
                type="button"
                className="composer-offline-reconnect-btn"
                data-testid="retry-agent-init"
                disabled={!ready || !isHostReady || busy || session?.archived}
                onClick={() => dispatch({ type: "RetryAgentInit" })}
              >
                {t("sessionRecovery.retryInit")}
              </button>
            ) : (
              <button
                type="button"
                className="composer-offline-reconnect-btn"
                data-testid="retry-auto-compaction"
                disabled={
                  !ready ||
                  !isHostReady ||
                  busy ||
                  session?.archived ||
                  state.transcript.sessionStatus !== "idle"
                }
                onClick={() => dispatch({ type: "RetryAutoCompaction" })}
              >
                {t("sessionRecovery.retryAuto")}
              </button>
            )}
          </div>
        )}
      <ComposerImages
        images={state.composerImages}
        onRemove={(id) => dispatch({ type: "RemoveComposerImage", value: id })}
      />
      <textarea
        ref={input}
        className="home-composer-textarea"
        aria-label={t("composer.message")}
        placeholder={
          child
            ? tr("composer.childReadOnly")
            : busy
              ? t("composer.inbox.busyPlaceholder")
              : tr("composer.placeholder")
        }
        value={draft}
        disabled={
          child || !ready || isProjectOffline || state.isCreatingSession
        }
        rows={2}
        aria-controls={slashVisible ? "composer-slash-palette" : undefined}
        aria-expanded={slashVisible || undefined}
        aria-activedescendant={slashVisible ? activeSlashId : undefined}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.items)
            .filter(
              (item) => item.kind === "file" && item.type.startsWith("image/"),
            )
            .map((item) => item.getAsFile())
            .filter((file): file is File => !!file);
          if (!files.length) return;
          event.preventDefault();
          const pasted = event.clipboardData.getData("text/plain");
          if (pasted) {
            const element = event.currentTarget,
              start = element.selectionStart,
              end = element.selectionEnd;
            const value = draft.slice(0, start) + pasted + draft.slice(end);
            dispatch({ type: "SetComposer", value });
            requestAnimationFrame(() => {
              if (element.isConnected && element.value === value)
                element.setSelectionRange(
                  start + pasted.length,
                  start + pasted.length,
                );
            });
          }
          dispatch({ type: "PasteComposerImages", files });
        }}
        onChange={(e) =>
          dispatch({ type: "SetComposer", value: e.target.value })
        }
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
            return;
          if (slashVisible && e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setDismissedSlash(draft);
            return;
          }
          if (slashVisible && ["ArrowUp", "ArrowDown", "Tab"].includes(e.key)) {
            e.preventDefault();
            if (!slashAction) return;
            if (e.key === "Tab") {
              if (slashAction.disabled) return;
              if (slashAction.id === "compact") chooseCompact();
              else
                dispatch({ type: "SetComposer", value: `/${slashAction.id}` });
            } else {
              setSlashIndex(
                (index) =>
                  (index +
                    (e.key === "ArrowDown" ? 1 : -1) +
                    slashActions.length) %
                  slashActions.length,
              );
            }
            return;
          }
          if (slashVisible && e.key === "Enter" && !e.shiftKey && slashAction) {
            // Commands exposed by the shared menu must never become literal user turns.
            // Exact /compact retains the existing instruction-submission contract.
            if (
              slashAction.id !== "compact" ||
              slashMatch![1].toLowerCase() !== "compact"
            ) {
              e.preventDefault();
              if (slashAction.disabled) return;
              if (slashAction.id === "compact") chooseCompact();
              else {
                dispatch({ type: "SetComposer", value: "" });
                slashAction.run();
              }
              return;
            }
          }
          if (!child && e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-bottom-bar home-composer-bottom-bar">
        <div className="composer-left-actions composer-bar-left">
          <div className="composer-plus-wrap">
            <button
              className={`composer-plus-btn${menu === "plus" ? " active" : ""}`}
              title={t("composer.menu.actions")}
              aria-label={t("composer.menu.actions")}
              type="button"
              aria-haspopup="listbox"
              aria-expanded={menu === "plus"}
              aria-controls={
                menu === "plus" ? "composer-slash-palette" : undefined
              }
              disabled={child || !ready}
              onClick={(e) => {
                e.stopPropagation();
                if (menu === "plus") setMenu(null);
                else {
                  if (slashVisible) setDismissedSlash(draft);
                  setMenu("plus");
                }
              }}
            >
              <Icon
                name="plus"
                size={15}
                strokeWidth="2.2"
                aria-hidden="true"
              />
            </button>
          </div>
          <button
            type="button"
            className="composer-permission-btn"
            data-testid="composer-session-permissions"
            aria-label={t("sessionPermissions.title")}
            title={t(
              !state.sessionId
                ? "sessionPermissions.needSession"
                : child || session?.archived
                  ? "sessionPermissions.readOnly"
                  : "sessionPermissions.title",
            )}
            disabled={
              !state.sessionId ||
              child ||
              !!session?.archived ||
              !ready ||
              !has("permission.get")
            }
            onClick={() => {
              setMenu(null);
              dispatch({ type: "OpenSessionPermissionsDialog" });
            }}
          >
            <PermissionIcon name="shield" size={15} aria-hidden="true" />
            {state.policy?.config.review && (
              <span
                aria-label={t("sessionPermissions.reviewOn")}
                title={t("sessionPermissions.reviewOn")}
              >
                ·
              </span>
            )}
          </button>
        </div>
        <div className="composer-right-actions composer-bar-right">
          <div className="composer-agent-picker-wrap">
            <button
              className={`composer-pill composer-agent-pill${menu === "agent" ? " active" : ""}`}
              data-testid="composer-agent-pill"
              title={
                !isHostReady
                  ? t("composer.agent.disabledHost")
                  : state.sessionId
                    ? t("composer.mode.pinned")
                    : t("composer.mode.menu")
              }
              type="button"
              aria-haspopup="menu"
              aria-expanded={menu === "agent"}
              aria-busy={state.modeSelectionPending || undefined}
              disabled={
                child ||
                !ready ||
                state.isCreatingSession ||
                (!!state.sessionId && !has("session.set_mode")) ||
                state.modeSelectionPending ||
                state.modelSelectionPending ||
                !isHostReady
              }
              onClick={(event) => {
                event.stopPropagation();
                setMenu(menu === "agent" ? null : "agent");
              }}
            >
              <span className="model-pill-name">
                {state.draftAgent || t("composer.agent.pick")}
                {state.draftMode ? ` · ${state.draftMode}` : ""}
              </span>
              <GlyphIcon
                name="chevron"
                dir="down"
                className="agent-pill-chevron"
              />
            </button>
          </div>
          <div className="composer-model-picker-wrap">
            <button
              className={`composer-pill composer-model-pill${menu === "model" ? " active" : ""}`}
              data-testid="composer-model-pill"
              title={
                session?.pendingModelChange
                  ? t("composer.model.pending", {
                      configured: model?.name ?? currentModelId ?? "",
                      active: [
                        session.turnModelSelection?.provider_id ??
                          session.appliedModelSelection?.provider_id,
                        session.turnModelSelection?.model ??
                          session.appliedModelSelection?.model,
                      ]
                        .filter(Boolean)
                        .join("/"),
                    })
                  : (model?.name ?? currentModelId ?? t("composer.pickModel"))
              }
              type="button"
              aria-haspopup="menu"
              aria-expanded={menu === "model"}
              aria-busy={state.modelSelectionPending || undefined}
              disabled={
                child ||
                !ready ||
                state.isCreatingSession ||
                state.modeSelectionPending ||
                state.modelSelectionPending ||
                (!!state.sessionId && !has("session.set_model"))
              }
              onClick={(e) => {
                e.stopPropagation();
                setMenu(menu === "model" ? null : "model");
              }}
            >
              <span className="model-pill-icon" aria-hidden="true">
                <Icon name="model" size={14} />
              </span>
              <span
                className="model-pill-name"
                title={
                  session?.pendingModelChange
                    ? t("composer.model.pending", {
                        configured: model?.name ?? currentModelId ?? "",
                        active: [
                          session.turnModelSelection?.provider_id ??
                            session.appliedModelSelection?.provider_id,
                          session.turnModelSelection?.model ??
                            session.appliedModelSelection?.model,
                        ]
                          .filter(Boolean)
                          .join("/"),
                      })
                    : (model?.name ?? currentModelId ?? t("composer.pickModel"))
                }
              >
                {model?.name ?? currentModelId ?? t("composer.pickModel")}
              </span>
              {variant && lower(variant) !== "default" && (
                <span className="model-pill-variant-tag">
                  · {titleCase(variant)}
                </span>
              )}
              <GlyphIcon
                name="chevron"
                dir="down"
                className="model-pill-chevron"
              />
            </button>
          </div>
          {busy ? (
            <div className="composer-busy-actions">
              <button
                className="composer-stop-square-btn"
                data-testid="composer-stop"
                title={t("composer.interruptPending")}
                aria-label={t("composer.interruptPending")}
                disabled={
                  child ||
                  !ready ||
                  !state.sessionId ||
                  !turnActive ||
                  !has("session.interrupt")
                }
                type="button"
                onClick={() => dispatch({ type: "Interrupt" })}
              >
                <Icon name="stop" size={12} />
              </button>
              {(draft.trim() || state.composerImages.length > 0) &&
                turnActive && (
                  <>
                    <button
                      className="composer-insert-btn"
                      data-testid="steer-input"
                      title={t("composer.inbox.steerAction")}
                      aria-label={t("composer.inbox.steerAction")}
                      disabled={
                        inboxBlocked || !has("turn.steer") || !!slashMatch
                      }
                      type="button"
                      onClick={() => submit(true)}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        data-testid="composer-insert-icon"
                      >
                        <path d="M4 5h7a4 4 0 0 1 4 4v10" />
                        <path d="m10 14 5 5 5-5" />
                      </svg>
                      <span>{t("composer.inbox.insertLabel")}</span>
                    </button>
                    <button
                      className="composer-send-arrow-btn queue-btn"
                      data-testid="queue-input"
                      title={t("composer.inbox.queueAction")}
                      aria-label={t("composer.inbox.queueAction")}
                      disabled={
                        inboxBlocked || !has("turn.queue") || !!slashMatch
                      }
                      type="button"
                      onClick={() => submit()}
                    >
                      <Icon name="send" size={16} aria-hidden="true" />
                    </button>
                  </>
                )}
            </div>
          ) : (
            <button
              className="composer-send-arrow-btn"
              title={t("composer.send")}
              type="button"
              disabled={
                child ||
                !ready ||
                isProjectOffline ||
                (!draft.trim() && !state.composerImages.length) ||
                (!slashMatch && !has("turn.queue")) ||
                (!!slashMatch && !compactAvailable) ||
                state.sessionRecoveryPending ||
                state.agentInitRetryRequired ||
                state.sessionRecoveryUnknown ||
                state.imageIntakePending ||
                state.historyMutationPending ||
                state.retryPending ||
                state.inboxPending ||
                state.modeSelectionPending ||
                state.modelSelectionPending ||
                (!state.sessionId && !has("session.create"))
              }
              onClick={() => submit()}
            >
              <Icon name="send" size={16} />
            </button>
          )}
        </div>
      </div>
    </ComposerSurface>
  );
}
export function TodoPanel() {
  const { todos } = useAppSelector(
    (state) => ({
      todos: state.transcript.todos,
      stamp: JSON.stringify(state.transcript.todos),
      locale: state.resolvedLocale,
    }),
    (before, after) =>
      before.stamp === after.stamp && before.locale === after.locale,
  );
  const [collapsed, setCollapsed] = useState(true);
  if (!todos.length) return null;

  const isCompleted = (s: string) =>
    ["completed", "complete", "done"].includes(lower(s).trim());
  const isRunning = (s: string) =>
    ["in_progress", "in-progress", "running"].includes(lower(s).trim());

  const total = todos.length;
  const runningCount = todos.filter((t: any) => isRunning(t.status)).length;
  const completedCount = todos.filter((t: any) => isCompleted(t.status)).length;
  const cancelledCount = todos.filter(
    (t: any) => t.status === "cancelled",
  ).length;
  const pendingCount = Math.max(
    0,
    total - runningCount - completedCount - cancelledCount,
  );

  return (
    <div className="todo-panel-card">
      <button
        type="button"
        className="todo-panel-header"
        onClick={(e) => {
          e.stopPropagation();
          setCollapsed(!collapsed);
        }}
      >
        <div className="todo-panel-header-left">
          <Icon name="todo" className="todo-header-icon" />
          <span className="todo-panel-title">{tr("todo.title")}</span>
          <span className="todo-panel-divider">·</span>
          <span className="todo-panel-summary">
            {completedCount === total && total > 0
              ? tr("todo.allDone", { total })
              : [
                  runningCount > 0
                    ? tr("todo.running", { count: runningCount })
                    : "",
                  tr("todo.summary", {
                    pending: pendingCount,
                    done: completedCount,
                    total,
                  }),
                  cancelledCount
                    ? tr("todo.cancelled", { count: cancelledCount })
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </span>
        </div>
        <div className="todo-panel-header-right">
          <Icon
            name="down"
            className={`todo-chevron${collapsed ? "" : " expanded"}`}
          />
        </div>
      </button>
      {!collapsed && (
        <div className="todo-panel-body">
          <div className="todo-panel-list">
            {todos.map((todo: any, i: number) => {
              const t = todo;
              const completed = isCompleted(t.status);
              const running = isRunning(t.status);
              return (
                <div
                  key={t.id ?? i}
                  className={`todo-item-row${completed ? " completed" : ""}`}
                >
                  <div className="todo-status-icon-wrap">
                    {completed ? (
                      <svg
                        className="todo-status-check"
                        viewBox="0 0 16 16"
                        width="13"
                        height="13"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path
                          d="M3.5 8.5L6.5 11.5L12.5 4.5"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : running ? (
                      <span className="todo-pulse-dot" />
                    ) : (
                      <span className="todo-pending-dot" />
                    )}
                  </div>
                  <span
                    className={`todo-content ${
                      completed
                        ? "completed"
                        : running
                          ? "in-progress"
                          : "pending"
                    }`}
                  >
                    {t.status === "cancelled"
                      ? tr("todo.cancelledItem", { content: t.content })
                      : t.content}
                  </span>
                  {t.priority && (
                    <span
                      className={`todo-priority-badge ${lower(t.priority)}`}
                    >
                      {t.priority}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
export function ComposerDock() {
  return <StatisticsDock />;
}
export function ComposerStack({
  onSubmitIntent,
}: { onSubmitIntent?: () => () => void } = {}) {
  return (
    <div className="composer-stack">
      <QueueDock />
      <TodoPanel />
      <Composer onSubmitIntent={onSubmitIntent} />
      <ComposerDock />
    </div>
  );
}
