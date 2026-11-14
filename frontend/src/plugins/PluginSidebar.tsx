import type { FeatureBlock as Block } from "../features/shared";
import { useAppSelector } from "../state";
import { useConversationBlocks } from "../features/conversation/registry-context";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../shell/Icon";
import { useAppFields, useClientPlugins } from "../state";
import { t } from "../i18n";
import { PluginRenderer } from "./renderer";
import {
  savePluginDocument,
  observePluginDocument,
  validatePluginDocument,
} from "./document-edit";
import { PluginWebview } from "./PluginWebview";
import type { BlockSlot, PluginSurfaceDescriptor, ViewTarget } from "./types";
import { useAppStore } from "../state";
import {
  isPluginDrawerViewport,
  usePluginDrawerViewport,
} from "../client/viewport";
import { requestDocumentLeave } from "../client/document-leave";
import { sessionTabPlugins, selectedSessionPlugin } from "./session-tabs";

/** Generic runtime view host; plugin business semantics stay inside the component. */
export function PluginSurface({
  pluginId,
  target,
  surface,
  slot,
  visible = true,
}: {
  pluginId: string;
  target: ViewTarget;
  surface?: PluginSurfaceDescriptor;
  slot?: BlockSlot;
  visible?: boolean;
}) {
  const plugins = useClientPlugins();
  const registry = plugins.registry;
  const store = useAppStore();
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const { state, dispatch } = useAppFields([
    "sessionId",
    "resolvedLocale",
    "authSession",
  ]);
  const ownerId = state.authSession?.principal?.owner ?? "";
  const history = plugins.historyRevision;
  const descriptor = useMemo(
    () =>
      surface ?? {
        surface_id: `default:${target}`,
        target,
      },
    [surface, state.sessionId, history, pluginId, target],
  );
  const ticket = useMemo(
    () => ({}),
    [registry, pluginId, descriptor, history, visible],
  );
  const inlineSlot =
    !!slot && (slot.tree !== undefined || slot.content !== undefined);
  const live = useRef<object | null>(null);
  const output = useRef<{
    mode?: string;
    tree?: unknown;
    content?: string;
    ticket: object;
  }>({ ticket: {} });
  const entry = registry
    ?.getSnapshot()
    .find((entry) => entry.manifest.id === pluginId);
  const status = entry?.status;
  const declared = entry?.manifest.targets.includes(target) ?? false;
  useEffect(() => {
    let current = true;
    live.current = visible && declared ? ticket : null;
    setError(null);
    if (!declared) return;
    try {
      registry?.setSurfaceVisible(pluginId, descriptor, visible);
    } catch (reason) {
      live.current = null;
      setError(String(reason));
      return;
    }
    if (registry && status === "ready" && visible && !inlineSlot)
      void registry
        .render(pluginId, target, false, descriptor)
        .catch((reason) => {
          if (current) setError(String(reason));
        });
    return () => {
      current = false;
      if (live.current === ticket) live.current = null;
      registry?.setSurfaceVisible(pluginId, descriptor, false);
    };
  }, [
    registry,
    pluginId,
    target,
    state.sessionId,
    state.resolvedLocale,
    status,
    declared,
    descriptor,
    visible,
    history,
    inlineSlot,
    ticket,
  ]);
  if (entry && !declared) return null;
  if (!registry) return <p role="status">{t("plugins.unavailable")}</p>;
  const manage = (
    <button
      type="button"
      className="ghost-btn"
      onClick={() => void dispatch({ type: "OpenPlugins" })}
    >
      {t("plugins.manage")}
    </button>
  );
  if (status === undefined)
    return (
      <div className="client-plugin-notice" role="status">
        <p>
          {t(plugins.initializing ? "plugins.loading" : "plugins.notInstalled")}
        </p>
        {!plugins.initializing && manage}
      </div>
    );
  if (!registry.isEnabled(pluginId, state.sessionId))
    return (
      <div className="client-plugin-notice" role="status">
        <p>{t("plugins.disabled")}</p>
        {manage}
      </div>
    );
  if (status === "loading" || retrying)
    return <p role="status">{t("plugins.loading")}</p>;
  const cached = registry.view(pluginId, target, descriptor);
  const view =
    slot && inlineSlot
      ? {
          ...cached,
          mode: slot.mode ?? "native-json",
          tree: slot.tree ?? null,
          content: slot.content,
          viewState: slot.view_state,
        }
      : cached;
  if (
    output.current.mode !== view.mode ||
    output.current.tree !== view.tree ||
    output.current.content !== view.content
  )
    output.current = {
      mode: view.mode,
      tree: view.tree,
      content: view.content,
      ticket: {},
    };
  const outputTicket = output.current.ticket;
  const visibleNow = () => {
    const snapshot = store.getSnapshot();
    const childOpen =
      snapshot.popup.type === "subagentDetail" &&
      snapshot.popup.parentId === snapshot.sessionId;
    if (target === "sidebar")
      return isPluginDrawerViewport()
        ? snapshot.rightOverlayOpen
        : !snapshot.rightRailCollapsed;
    if (target === "expanded-page")
      return (
        (snapshot.page === "plugin" && snapshot.pluginId === pluginId) ||
        (snapshot.pluginWorkspace?.type === "view" &&
          snapshot.pluginWorkspace.pluginId === pluginId)
      );
    const tabs = sessionTabPlugins(registry.getSnapshot(), (id) =>
      registry.isEnabled(id, snapshot.sessionId),
    );
    const selected = selectedSessionPlugin(
      snapshot.sessionPluginTab,
      snapshot.sessionId,
      tabs,
    );
    return (
      !childOpen &&
      (target === "session-tab"
        ? selected === pluginId
        : !selected && snapshot.viewMode === "chat")
    );
  };
  const matchesOutput = () => {
    const actual = registry.view(pluginId, target, descriptor);
    return (
      actual.mode === view.mode &&
      actual.tree === view.tree &&
      actual.content === view.content
    );
  };
  const current = () =>
    live.current === ticket &&
    output.current.ticket === outputTicket &&
    visibleNow() &&
    registry === plugins.registry &&
    store.getSnapshot().sessionId === state.sessionId &&
    store.getSnapshot().authSession?.principal?.owner === ownerId &&
    plugins.historyRevision === history &&
    registry.isEnabled(pluginId, state.sessionId) &&
    registry.view(pluginId, target, descriptor).instanceGeneration ===
      cached.instanceGeneration &&
    (slot
      ? registry
          .getBlockSlots(descriptor.block_id!)
          .some(
            (currentSlot) =>
              currentSlot.pluginId === pluginId &&
              currentSlot.slot_id === descriptor.slot_id &&
              (!inlineSlot ||
                (currentSlot.mode ?? "native-json") === view.mode),
          )
      : matchesOutput());
  const onAction = (action: string, payload?: import("./types").Json) => {
    if (!current()) return;
    void registry
      .action(pluginId, action, payload, descriptor)
      .catch((reason) => {
        if (current()) setError(String(reason));
      });
  };
  const scope = {
    ownerId,
    sessionId: state.sessionId,
    instanceGeneration: view.instanceGeneration!,
    historyGeneration: view.historyGeneration ?? history,
    surfaceId: descriptor.surface_id,
  };
  const failure = error || view.error;
  if (failure)
    return (
      <div className="client-plugin-notice" role="alert">
        <p>{failure}</p>
        <button
          type="button"
          className="ghost-btn"
          data-testid="plugin-retry"
          disabled={retrying}
          onClick={() => {
            setError(null);
            setRetrying(true);
            void registry
              .restart(pluginId)
              .catch((reason) => setError(String(reason)))
              .finally(() => setRetrying(false));
          }}
        >
          {t("plugins.retry")}
        </button>
        {manage}
      </div>
    );
  if (view.status === "loading")
    return <p role="status">{t("plugins.loading")}</p>;
  if (view.status === "disabled")
    return <p role="status">{t("plugins.disabled")}</p>;
  if (
    view.mode === "webview-html" &&
    (view.instanceGeneration === undefined ||
      view.historyGeneration === undefined)
  )
    return <p role="status">{t("plugins.unavailable")}</p>;
  if (view.mode === "webview-html")
    return (
      <PluginWebview
        key="html"
        view={view}
        onAction={onAction}
        scope={scope}
        visible={visible}
      />
    );
  return (
    <PluginRenderer
      key="native"
      view={view}
      onAction={onAction}
      onEditAction={
        target !== "block-slot"
          ? (action, text, context, statePath) =>
              savePluginDocument({
                registry,
                pluginId,
                target,
                surface: descriptor,
                current,
                action,
                text,
                context,
                statePath,
              })
          : undefined
      }
      onValidateAction={
        target !== "block-slot"
          ? (action, text, context, statePath) =>
              validatePluginDocument({
                registry,
                pluginId,
                target,
                surface: descriptor,
                current,
                action,
                text,
                context,
                statePath,
              })
          : undefined
      }
      onObserveAction={(action, statePath) =>
        observePluginDocument({
          registry,
          pluginId,
          target,
          surface: descriptor,
          current,
          action,
          statePath,
        })
      }
      onVariable={(path, value) => {
        if (current()) registry.setVariable(pluginId, path, value, descriptor);
      }}
    />
  );
}

export function PluginBlockSlots({
  blocks,
  readOnly = false,
  placement = "after",
  observeOnly = false,
}: {
  blocks: Block[];
  readOnly?: boolean;
  placement?: "before" | "after";
  observeOnly?: boolean;
}) {
  const plugins = useClientPlugins();
  const current = useConversationBlocks(blocks);
  const { state: selection } = useAppFields([
    "viewMode",
    "sessionPluginTab",
    "sessionId",
    "popup",
  ]);
  const tabs = sessionTabPlugins(
    plugins.registry?.getSnapshot() ?? [],
    (id) => plugins.registry?.isEnabled(id, selection.sessionId) ?? false,
  );
  const visible =
    selection.viewMode === "chat" &&
    !selectedSessionPlugin(
      selection.sessionPluginTab,
      selection.sessionId,
      tabs,
    ) &&
    !(
      selection.popup.type === "subagentDetail" &&
      selection.popup.parentId === selection.sessionId
    );
  const witness = useAppSelector((state) =>
    JSON.stringify([
      state.transcript.historyView?.lineage ?? "",
      state.transcript.historyView?.epoch ?? null,
    ]),
  );
  const history = `${witness}:${plugins.historyRevision}`;
  const registry = plugins.registry;
  const status = registry
    ?.getSnapshot()
    .map((entry) => `${entry.manifest.id}:${entry.status}`)
    .join("|");
  useEffect(() => {
    if (!readOnly) for (const block of current) plugins.settle(block, history);
  }, [plugins, current, history, status, readOnly]);
  if (!registry || readOnly || observeOnly) return null;
  return (
    <>
      {current
        .filter(
          (block) =>
            block.sessionId === selection.sessionId &&
            !block.temporary &&
            block.stream === "complete",
        )
        .map((block) => (
          <div
            className="client-plugin-block-slot"
            key={`${history}:${block.id}`}
            data-plugin-block-id={block.id}
          >
            {registry
              .getBlockSlots(block.id)
              .filter((slot) => (slot.placement ?? "after") === placement)
              .map((slot) => (
                <PluginSlot
                  key={JSON.stringify([
                    history,
                    block.id,
                    slot.pluginId,
                    slot.slot_id,
                    placement,
                  ])}
                  history={history}
                  blockId={block.id}
                  slot={slot}
                  placement={placement}
                  visible={visible}
                />
              ))}
          </div>
        ))}
    </>
  );
}

function PluginSlot({
  history,
  blockId,
  slot,
  placement,
  visible,
}: {
  visible: boolean;
  history: string;
  blockId: string;
  slot: BlockSlot & { pluginId: string };
  placement: "before" | "after";
}) {
  const descriptor = useMemo<PluginSurfaceDescriptor>(
    () => ({
      surface_id: JSON.stringify([
        history,
        blockId,
        slot.pluginId,
        slot.slot_id,
        placement,
      ]),
      target: "block-slot",
      block_id: blockId,
      slot_id: slot.slot_id,
      placement,
    }),
    [history, blockId, slot.pluginId, slot.slot_id, placement],
  );
  return (
    <PluginSurface
      pluginId={slot.pluginId}
      target="block-slot"
      surface={descriptor}
      slot={slot}
      visible={visible}
    />
  );
}

export function PluginSubmitNotice() {
  const plugins = useClientPlugins();
  const { dispatch } = useAppFields(["resolvedLocale"]);
  if (!plugins.error && !plugins.bypass) return null;
  return (
    <div
      className="client-plugin-notice"
      role={plugins.error ? "alert" : "status"}
      data-testid="plugin-submit-notice"
    >
      <span>
        {plugins.bypass
          ? t("plugins.bypassReady")
          : t("plugins.submitFailed", { reason: plugins.error ?? "" })}
      </span>
      {!plugins.bypass && (
        <button
          type="button"
          className="ghost-btn"
          data-testid="plugin-bypass-once"
          onClick={() => void dispatch({ type: "BypassPluginsOnce" })}
        >
          {t("plugins.bypassOnce")}
        </button>
      )}
    </div>
  );
}

export function PluginSidebar({ children }: { children?: ReactNode }) {
  const plugins = useClientPlugins();
  const { state, dispatch } = useAppFields([
    "sessionId",
    "resolvedLocale",
    "rightOverlayOpen",
    "rightRailCollapsed",
  ]);
  const narrow = usePluginDrawerViewport();
  const visible = narrow ? state.rightOverlayOpen : !state.rightRailCollapsed;
  const registry = plugins.registry;
  const installed =
    registry
      ?.getSnapshot()
      .filter(
        (plugin) =>
          plugin.manifest.targets.includes("sidebar") &&
          registry.isEnabled(plugin.manifest.id, state.sessionId),
      ) ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const active =
    installed.find((plugin) => plugin.manifest.id === selected) ?? installed[0];
  return (
    <div className="client-plugin-sidebar" data-testid="client-plugin-sidebar">
      <div className="client-plugin-toolbar">
        <div
          role="tablist"
          aria-label={t("plugins.title")}
          className="client-plugin-tabs"
          onKeyDown={(event) => {
            const index = installed.findIndex(
              (plugin) => plugin.manifest.id === active?.manifest.id,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? installed.length - 1
                  : event.key === "ArrowRight"
                    ? (index + 1) % installed.length
                    : event.key === "ArrowLeft"
                      ? (index - 1 + installed.length) % installed.length
                      : -1;
            const plugin = installed[next];
            if (!plugin) return;
            event.preventDefault();
            if (plugin.manifest.id !== active?.manifest.id)
              requestDocumentLeave(() => {
                setSelected(plugin.manifest.id);
                document
                  .getElementById(`plugin-tab-${plugin.manifest.id}`)
                  ?.focus();
              }, ".right-sidebar-shell");
          }}
        >
          {installed.map((plugin) => (
            <button
              type="button"
              className="ghost-btn"
              role="tab"
              id={`plugin-tab-${plugin.manifest.id}`}
              aria-selected={active?.manifest.id === plugin.manifest.id}
              tabIndex={active?.manifest.id === plugin.manifest.id ? 0 : -1}
              title={plugin.manifest.name}
              aria-controls="client-plugin-sidebar-panel"
              key={plugin.manifest.id}
              onClick={() => {
                if (plugin.manifest.id !== active?.manifest.id)
                  requestDocumentLeave(
                    () => setSelected(plugin.manifest.id),
                    ".right-sidebar-shell",
                  );
              }}
            >
              {plugin.manifest.name}
            </button>
          ))}
        </div>
        <div className="client-plugin-toolbar-actions">
          <button
            type="button"
            className="ghost-btn client-plugin-icon-button"
            data-testid="plugins-manage"
            aria-label={t("plugins.manage")}
            title={t("plugins.manage")}
            onClick={() => void dispatch({ type: "OpenPlugins" })}
          >
            <Icon name="settings" aria-hidden="true" />
          </button>
          {active?.manifest.targets.includes("expanded-page") && (
            <button
              type="button"
              className="ghost-btn client-plugin-icon-button"
              data-testid="plugin-expand"
              aria-label={t("plugins.expand")}
              title={t("plugins.expand")}
              onClick={() =>
                void dispatch({ type: "OpenPlugin", id: active.manifest.id })
              }
            >
              <Icon name="expand" aria-hidden="true" />
            </button>
          )}
          {children}
        </div>
      </div>
      {plugins.error && (
        <p className="client-plugin-notice" role="alert">
          {plugins.error}
        </p>
      )}
      {active ? (
        <section
          role="tabpanel"
          id="client-plugin-sidebar-panel"
          aria-labelledby={`plugin-tab-${active.manifest.id}`}
          className="client-plugin-panel"
        >
          <PluginSurface
            pluginId={active.manifest.id}
            target="sidebar"
            visible={visible}
          />
        </section>
      ) : (
        <p role="status" className="client-plugin-empty">
          {t("plugins.noneEnabled")}
        </p>
      )}
    </div>
  );
}
