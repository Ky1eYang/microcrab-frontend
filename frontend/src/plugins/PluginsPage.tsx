import { referenceLabels } from "../features/referenceLabels";
import { ExpandableNotice } from "../features/ExpandableNotice";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useAppFields, useAppStore, useClientPlugins } from "../state";
import { t } from "../i18n";
import { Icon } from "../shell/Icon";
import { formatPluginImportError } from "./import-errors";
import { PluginSurface } from "./PluginSidebar";
import { PluginHttpSettings } from "./PluginHttpSettings";
import type { InstalledPlugin } from "./types";
import { requestDocumentLeave } from "../client/document-leave";

/** A real button keeps file selection keyboard-accessible without an invisible click layer. */
function PluginUpload({
  label,
  testid,
  disabled,
  className = "ghost-btn",
  onChange,
}: {
  label: string;
  testid?: string;
  disabled: boolean;
  className?: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {label}
      </button>
      <input
        ref={input}
        hidden
        data-testid={testid}
        type="file"
        accept=".wasm,application/wasm"
        disabled={disabled}
        aria-label={label}
        onChange={onChange}
      />
    </>
  );
}

export function PluginsPage({ embedded = false }: { embedded?: boolean }) {
  const store = useAppStore();
  const plugins = useClientPlugins();
  const registry = plugins.registry;
  const { state, dispatch } = useAppFields([
    "sessionId",
    "sessions",
    "resolvedLocale",
    "pluginWorkspace",
  ]);
  const sessionId = embedded ? null : state.sessionId;
  const [working, setBusy] = useState(false);
  const busy = working || !plugins.isReadyFor(sessionId);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  // Render precedes removal of the invoking sidebar, so retain its exact trigger.
  const opener = useRef(document.activeElement);
  useEffect(() => {
    if (!embedded) searchInput.current?.focus({ preventScroll: true });
    return () => {
      if (embedded) return;
      requestAnimationFrame(() => {
        const visible = (node: Element | null): node is HTMLElement =>
          node instanceof HTMLElement &&
          node.isConnected &&
          !node.closest("[inert]") &&
          node.getClientRects().length > 0 &&
          getComputedStyle(node).visibility !== "hidden";
        const candidates = [
          opener.current,
          ...document.querySelectorAll(
            '[data-testid="rail-plugins-btn"], [data-testid="composer"] textarea',
          ),
        ];
        candidates.find(visible)?.focus({ preventScroll: true });
      });
    };
  }, [embedded]);

  const installed = registry?.getSnapshot() ?? [];

  const artifactLabel = useMemo(() => referenceLabels("digest", installed.map((plugin) => plugin.artifact)), [installed]);
  const sessionLabel = referenceLabels("session", state.sessions.map((row) => row.id));

  const isPluginActiveInScope = (plugin: InstalledPlugin) =>
    registry
      ? sessionId
        ? registry.isEnabled(plugin.manifest.id, sessionId)
        : plugin.enabledByDefault
      : false;

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return installed.filter((plugin) => {
      if (!q) return true;
      return (
        plugin.manifest.name.toLowerCase().includes(q) ||
        plugin.manifest.id.toLowerCase().includes(q) ||
        (plugin.manifest.description ?? "").toLowerCase().includes(q) ||
        Boolean(plugin.artifact && (plugin.artifact.toLowerCase() === q || artifactLabel(plugin.artifact).includes(q)))
      );
    });
  }, [artifactLabel, installed, searchQuery]);

  useEffect(() => {
    if (
      selectedId &&
      installed.some((plugin) => plugin.manifest.id === selectedId)
    )
      return;
    setSelectedId(installed[0]?.manifest.id ?? null);
  }, [installed, selectedId]);

  const activePlugin =
    installed.find((plugin) => plugin.manifest.id === selectedId) ??
    filtered[0] ??
    installed[0] ??
    null;

  const selectedOutsideFilter =
    !!activePlugin && !filtered.includes(activePlugin);
  const visiblePlugins = selectedOutsideFilter
    ? [activePlugin!, ...filtered]
    : filtered;

  const selectPlugin = (id: string) => {
    if (id !== activePlugin?.manifest.id)
      requestDocumentLeave(() => setSelectedId(id), ".client-plugins-page");
  };

  const run = (work: () => Promise<unknown>) =>
    requestDocumentLeave(() => {
      void perform(work);
    }, ".client-plugins-page");
  const perform = async (work: () => Promise<unknown>) => {
    if (!plugins.isReadyFor(state.sessionId)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (reason) {
      setError(formatPluginImportError(reason));
    } finally {
      setBusy(false);
    }
  };

  const upload = (
    event: ChangeEvent<HTMLInputElement>,
    expectedId?: string,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file && registry)
      void run(async () => {
        if (file.size > 16 * 1024 * 1024)
          throw Error(t("plugins.fileTooLarge"));
        const result = await registry.importPlugin(
          new Uint8Array(await file.arrayBuffer()),
          {
            replace: Boolean(expectedId),
            expectedId,
          },
        );
        setSelectedId(result.manifest.id);
        setNotice(
          t(
            result.importFormat === "core"
              ? "plugins.importedCore"
              : "plugins.imported",
          ),
        );
      });
  };

  const toggleScopeEnablement = (plugin: InstalledPlugin, next: boolean) => {
    if (!registry) return;
    if (state.sessionId) {
      void run(() =>
        registry.setEnabled(plugin.manifest.id, state.sessionId!, next),
      );
    } else {
      void run(() => registry.setDefaultEnabled(plugin.manifest.id, next));
    }
  };

  return (
    <section
      className="client-plugins-page"
      data-embedded={embedded}
      data-testid="client-plugins-manager"
      aria-busy={busy}
    >
      {/* Middle Column (in 3-column layout): Plugin List Sidebar */}
      <aside
        className="client-plugins-rail"
        aria-label={t("plugins.title")}
        data-testid="client-plugins-rail"
      >
        <div className="client-plugins-rail-header">
          <div className="client-plugins-rail-title-row">
            <div className="client-plugins-rail-heading">
              <h2>{t("plugins.title")}</h2>
              <span className="client-plugins-count-badge">
                {installed.length}
              </span>
            </div>
            {!embedded && (
              <button
                type="button"
                className="ghost-btn btn-sm"
                onClick={() => void dispatch({ type: "ClosePluginPage" })}
              >
                {t("plugins.back")}
              </button>
            )}
          </div>
          <div className="client-plugins-rail-actions">
            <PluginUpload
              label={t("plugins.import")}
              testid="plugin-upload"
              className="primary-btn btn-sm client-plugins-action-btn"
              disabled={busy || !registry}
              onChange={(event) => upload(event)}
            />
          </div>
          <div className="client-plugins-search-box">
            <Icon
              name="search"
              size={14}
              className="client-plugins-search-icon"
              aria-hidden="true"
            />
            <input
              ref={searchInput}
              type="search"
              className="client-plugins-search-input"
              placeholder={t("plugins.searchPlaceholder")}
              aria-label={t("plugins.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="client-plugins-search-clear"
                aria-label={t("plugins.clearSearch")}
                onClick={() => setSearchQuery("")}
              >
                <Icon name="close" size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        <div className="client-plugins-nav-list stable-scrollbar">
          {plugins.initializing && (
            <p role="status" className="client-plugin-empty">
              {t("plugins.loading")}
            </p>
          )}
          {!plugins.initializing && registry && installed.length === 0 && (
            <p role="status" className="client-plugin-empty">
              {t("plugins.empty")}
            </p>
          )}
          {!plugins.initializing &&
            installed.length > 0 &&
            filtered.length === 0 && (
              <p role="status" className="client-plugin-empty">
                {t("plugins.noMatching")}
              </p>
            )}
          {selectedOutsideFilter && (
            <p role="status" className="client-plugin-empty">
              {t("plugins.selectedOutsideFilter")}
            </p>
          )}
          {visiblePlugins.map((plugin) => {
            const selected = activePlugin?.manifest.id === plugin.manifest.id;
            return (
              <button
                type="button"
                key={plugin.manifest.id}
                aria-pressed={selected}
                className="client-plugin-nav-card"
                data-testid="plugin-nav-item"
                data-plugin-nav-id={plugin.manifest.id}
                data-active={selected}
                data-status={plugin.status}
                onClick={() => selectPlugin(plugin.manifest.id)}
              >
                <div className="client-plugin-nav-info">
                  <div
                    className="client-plugin-nav-name"
                    title={plugin.manifest.name}
                  >
                    {plugin.manifest.name}
                  </div>
                  <div
                    className="client-plugin-nav-hash"
                    title={plugin.artifact ? artifactLabel(plugin.artifact) : plugin.manifest.id}
                  >
                    {plugin.artifact ? artifactLabel(plugin.artifact) : plugin.manifest.id}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="client-plugins-rail-footer">
          <p>{t("plugins.importHelp")}</p>
        </div>
      </aside>

      {/* Right Column (in 3-column layout): Selected Plugin Settings & Parameter Surface */}
      <div
        className="client-plugins-detail stable-scrollbar"
        data-testid="client-plugins-detail"
      >
        {(error || plugins.error) && (
          <ExpandableNotice
            role="alert"
            className="client-plugin-notice"
            tone="danger"
            marker="none"
            text={String(error || plugins.error)}
            action={
              plugins.error &&
              !plugins.initializing &&
              !plugins.isReadyFor(state.sessionId) && (
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() =>
                    plugins.retrySynchronization(store.getSnapshot())
                  }
                >
                  {t("plugins.retry")}
                </button>
              )
            }
          />
        )}
        {notice && (
          <ExpandableNotice
            role="status"
            className="client-plugin-feedback-banner"
            tone="info"
            marker="none"
            text={notice}
          />
        )}
        {!registry && (
          <div className="client-plugins-empty-stage" role="status">
            <p>{t("plugins.unavailable")}</p>
          </div>
        )}
        {registry && !activePlugin && !plugins.initializing && (
          <div className="client-plugins-empty-stage" role="status">
            <p>{t("plugins.selectHint")}</p>
          </div>
        )}
        {registry && activePlugin && (
          <article
            className="client-plugin-entry client-plugin-detail-article"
            key={activePlugin.manifest.id}
            data-testid="plugin-entry"
            data-plugin-id={activePlugin.manifest.id}
            data-status={activePlugin.status}
          >
            {/* Card 1: 4-Row Control Header (1: Name+Version+Status, 2: SHA-256, 3: Description, 4: Reset/Remove Actions) */}
            <div className="settings-card client-plugin-header-card">
              {/* Row 1: Name + Version + Status */}
              <div className="client-plugin-header-row client-plugin-identity">
                <h3>{activePlugin.manifest.name}</h3>
                <span className="client-plugin-version">
                  v{activePlugin.manifest.version}
                </span>
                <span
                  className="client-plugin-status-pill"
                  role="status"
                  data-status={activePlugin.status}
                >
                  <span
                    className="client-plugin-status-dot"
                    data-status={activePlugin.status}
                    aria-hidden="true"
                  />
                  {t(`plugins.status.${activePlugin.status}`)}
                </span>
              </div>

              {/* Row 2: WASM SHA-256 Hash */}
              <div
                className="client-plugin-header-row client-plugin-sha256"
                title={activePlugin.artifact ? artifactLabel(activePlugin.artifact) : activePlugin.manifest.id}
              >
                <span className="client-plugin-hash-label">SHA-256</span>
                <code className="client-plugin-hash-value">
                  {activePlugin.artifact ? artifactLabel(activePlugin.artifact) : "—"}
                </code>
                {activePlugin.artifact && <button type="button" className="ghost-btn" onClick={() => dispatch({ type: "CopyText", value: activePlugin.artifact })}>{t("references.copyChecksum")}</button>}
              </div>

              {/* Row 3: Description + Contract Metadata (ID / Targets / Imports / Origins) */}
              <p className="client-plugin-header-row client-plugin-description">
                {activePlugin.manifest.description || "—"}
              </p>
              <dl className="client-plugin-info client-plugin-header-contract">
                <dt>{t("plugins.id")}</dt>
                <dd>{activePlugin.manifest.id}</dd>
                <dt>{t("plugins.targets")}</dt>
                <dd className="client-plugin-tag-list">
                  {activePlugin.manifest.targets.length
                    ? activePlugin.manifest.targets.map((target) => (
                        <span
                          key={target}
                          className="client-plugin-target-pill monospace-text"
                        >
                          {target}
                        </span>
                      ))
                    : "—"}
                </dd>
                <dt>{t("plugins.imports")}</dt>
                <dd>
                  {activePlugin.imports.length ? (
                    <ul className="client-plugin-import-list">
                      {activePlugin.imports.map((capability) => (
                        <li key={capability}>{capability}</li>
                      ))}
                    </ul>
                  ) : (
                    t("plugins.noImports")
                  )}
                </dd>
                <dt>{t("plugins.providesTools")}</dt>
                <dd data-testid="plugin-provides-tools">
                  {t(
                    activePlugin.providesTools
                      ? "plugins.booleanYes"
                      : "plugins.booleanNo",
                  )}
                </dd>
                {Boolean(activePlugin.manifest.network_origins?.length) && (
                  <>
                    <dt>{t("plugins.origins")}</dt>
                    <dd>{activePlugin.manifest.network_origins?.join(", ")}</dd>
                  </>
                )}
              </dl>

              {/* Row 4: Reset Data / Remove Plugin & Maintenance Controls */}
              <div className="client-plugin-header-row client-plugin-header-actions">
                <div className="client-plugin-maintenance-actions">
                  <button
                    type="button"
                    className="ghost-btn btn-sm"
                    disabled={busy}
                    onClick={() =>
                      void run(() => registry.reset(activePlugin.manifest.id))
                    }
                  >
                    {t("plugins.reset")}
                  </button>
                  <button
                    type="button"
                    className="ghost-btn btn-sm client-plugin-remove"
                    disabled={busy}
                    onClick={() =>
                      void run(() => registry.remove(activePlugin.manifest.id))
                    }
                  >
                    {t("plugins.remove")}
                  </button>
                </div>
                <div className="client-plugin-toolbar-actions">
                  <PluginUpload
                    label={t("plugins.update")}
                    className="ghost-btn btn-sm"
                    disabled={busy}
                    onChange={(event) =>
                      upload(event, activePlugin.manifest.id)
                    }
                  />
                </div>
              </div>

              {activePlugin.error && (
                <ExpandableNotice
                  role="alert"
                  className="client-plugin-notice"
                  tone="danger"
                  marker="none"
                  text={String(activePlugin.error)}
                  action={
                    isPluginActiveInScope(activePlugin) && (
                      <button
                        type="button"
                        className="ghost-btn btn-sm"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            registry.restart(activePlugin.manifest.id),
                          )
                        }
                      >
                        {t("plugins.retry")}
                      </button>
                    )
                  }
                />
              )}
            </div>

            {/* Card 2: Enablement Switches & Priority */}
            <div className="settings-card client-plugin-controls-card">
              <div className="settings-card-title">
                {t("plugins.enablementSection")}
              </div>
              {state.sessionId ? (
                <div className="settings-row">
                  <div className="settings-row-info">
                    <div className="settings-row-label">
                      {t("plugins.sessionEnabled")}
                    </div>
                    <div className="settings-row-sub">
                      {t("plugins.sessionEnabledHint")} (
                      {sessionLabel(state.sessionId)})
                    </div>
                  </div>
                  <div className="settings-row-action">
                    <label className="client-plugin-switch">
                      <input
                        type="checkbox"
                        checked={registry.isEnabled(
                          activePlugin.manifest.id,
                          state.sessionId,
                        )}
                        disabled={busy}
                        aria-label={t("plugins.sessionEnabled")}
                        onChange={(event) => {
                          const enabled = event.target.checked;
                          void run(() =>
                            registry.setEnabled(
                              activePlugin.manifest.id,
                              state.sessionId!,
                              enabled,
                            ),
                          );
                        }}
                      />
                      <span className="client-plugin-switch-slider" />
                      <span className="sr-only">
                        {t("plugins.sessionEnabled")}
                      </span>
                    </label>
                  </div>
                </div>
              ) : (
                <div className="settings-row">
                  <div className="settings-row-info">
                    <div className="settings-row-label">
                      {t("plugins.sessionEnabled")}
                    </div>
                    <div className="settings-row-sub">
                      {t("plugins.sessionDisabledNoSession")}
                    </div>
                  </div>
                </div>
              )}

              <div className="settings-row">
                <div className="settings-row-info">
                  <div className="settings-row-label">
                    {t("plugins.defaultEnabled")}
                  </div>
                  <div className="settings-row-sub">
                    {t("plugins.defaultEnabledHint")}
                  </div>
                </div>
                <div className="settings-row-action">
                  <label className="client-plugin-switch">
                    <input
                      type="checkbox"
                      checked={activePlugin.enabledByDefault}
                      disabled={busy}
                      aria-label={t("plugins.defaultEnabled")}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        void run(() =>
                          registry.setDefaultEnabled(
                            activePlugin.manifest.id,
                            enabled,
                          ),
                        );
                      }}
                    />
                    <span className="client-plugin-switch-slider" />
                    <span className="sr-only">
                      {t("plugins.defaultEnabled")}
                    </span>
                  </label>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-info">
                  <div className="settings-row-label">
                    {t("plugins.priority")}
                  </div>
                  <div className="settings-row-sub">
                    {t("plugins.priorityHint")}
                  </div>
                </div>
                <div className="settings-row-action">
                  <label className="client-plugin-priority">
                    <span className="sr-only">{t("plugins.priority")}</span>
                    <input
                      type="number"
                      className="settings-input client-plugin-priority-input"
                      aria-label={t("plugins.priority")}
                      value={activePlugin.priority}
                      disabled={busy}
                      onChange={(event) => {
                        const value = event.target.valueAsNumber;
                        if (Number.isFinite(value))
                          void run(() =>
                            registry.setPriority(
                              activePlugin.manifest.id,
                              value,
                            ),
                          );
                      }}
                    />
                  </label>
                </div>
              </div>
            </div>

            <div className="settings-card client-plugin-controls-card">
              <PluginHttpSettings
                key={activePlugin.manifest.id}
                registry={registry}
                pluginId={activePlugin.manifest.id}
                disabled={busy}
              />
            </div>

            {/* Card 3: Parameter Settings Surface (view-target: setting-page); omitted when plugin exposes no view */}
            {(() => {
              if (!activePlugin.manifest.targets.includes("setting-page"))
                return null;
              const target = "setting-page" as const;
              return (
                <div
                  className="settings-card client-plugin-settings-card"
                  data-testid="plugin-setting-page-card"
                >
                  <div className="client-plugin-card-head">
                    <div>
                      <div className="settings-card-title">
                        {t("plugins.settingsSection")}
                      </div>
                      <p className="client-plugin-card-sub">
                        {t("plugins.settingsIntro")}
                      </p>
                    </div>
                    <span className="client-plugin-target-pill monospace-text">
                      {target}
                    </span>
                  </div>
                  {!isPluginActiveInScope(activePlugin) ? (
                    <div className="client-plugin-setting-empty" role="status">
                      <p>{t("plugins.enableToConfigure")}</p>
                      <button
                        type="button"
                        className="primary-btn btn-sm"
                        disabled={busy}
                        onClick={() =>
                          toggleScopeEnablement(activePlugin, true)
                        }
                      >
                        {t("plugins.enableNow")}
                      </button>
                    </div>
                  ) : (
                    <div
                      className="client-plugin-panel client-plugin-setting-surface"
                      data-testid="plugin-setting-surface"
                    >
                      <PluginSurface
                        key={`${state.sessionId ?? "global"}:${activePlugin.manifest.id}:${target}`}
                        pluginId={activePlugin.manifest.id}
                        target={target}
                        surface={{
                          surface_id: `setting-page:${activePlugin.manifest.id}`,
                          target,
                        }}
                        visible={!state.pluginWorkspace}
                      />
                    </div>
                  )}
                </div>
              );
            })()}
          </article>
        )}
      </div>
    </section>
  );
}
