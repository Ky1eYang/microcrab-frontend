import { useRef, useState, type ChangeEvent } from "react";
import { useAppFields, useClientPlugins } from "../state";
import { t } from "../i18n";
import { formatPluginImportError } from "./import-errors";

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
  const plugins = useClientPlugins();
  const registry = plugins.registry;
  const { state, dispatch } = useAppFields(["sessionId", "resolvedLocale"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const installed = registry?.getSnapshot() ?? [];
  const run = async (work: () => Promise<unknown>) => {
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
        setNotice(
          t(
            result.importFormat === "core"
              ? "plugins.importedCore"
              : "plugins.imported",
          ),
        );
      });
  };
  return (
    <section
      className="client-plugins-page"
      data-embedded={embedded}
      data-testid="client-plugins-manager"
      aria-busy={busy}
    >
      {!embedded && (
        <header className="client-plugin-toolbar client-plugin-page-heading">
          <h2>{t("plugins.title")}</h2>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void dispatch({ type: "ClosePluginPage" })}
          >
            {t("plugins.back")}
          </button>
        </header>
      )}
      <p className="client-plugin-intro">{t("plugins.intro")}</p>
      <div className="client-plugin-import-strip">
        <PluginUpload
          label={t("plugins.import")}
          testid="plugin-upload"
          className="primary-btn"
          disabled={busy || !registry}
          onChange={(event) => upload(event)}
        />
        <button
          type="button"
          className="ghost-btn"
          data-testid="plugins-restore-bundled"
          disabled={busy || !registry || plugins.initializing}
          onClick={() =>
            void run(async () => {
              const count = await registry!.restoreBundled();
              setNotice(
                t(
                  count
                    ? "plugins.restoredBundled"
                    : "plugins.bundledAlreadyInstalled",
                  { count },
                ),
              );
            })
          }
        >
          {t("plugins.restoreBundled")}
        </button>
        <p>{t("plugins.importHelp")}</p>
      </div>
      {(error || plugins.error) && (
        <p role="alert" className="client-plugin-notice">
          {error || plugins.error}
        </p>
      )}
      {notice && (
        <p role="status" className="client-plugin-feedback">
          {notice}
        </p>
      )}
      {!registry && <p role="status">{t("plugins.unavailable")}</p>}
      {plugins.initializing && <p role="status">{t("plugins.loading")}</p>}
      {!plugins.initializing &&
        !plugins.error &&
        registry &&
        installed.length === 0 && (
          <p role="status" className="client-plugin-empty">
            {t("plugins.empty")}
          </p>
        )}
      {installed.length > 0 && (
        <h3 className="client-plugin-list-heading">
          {t("plugins.installed")} <span>{installed.length}</span>
        </h3>
      )}
      <div className="client-plugin-list">
        {installed.map((plugin) => (
          <article
            className="client-plugin-entry"
            key={plugin.manifest.id}
            data-testid="plugin-entry"
            data-plugin-id={plugin.manifest.id}
            data-status={plugin.status}
          >
            <header className="client-plugin-entry-heading">
              <div className="client-plugin-identity">
                <h3>{plugin.manifest.name}</h3>
                <span className="client-plugin-version">
                  {plugin.manifest.version}
                </span>
              </div>
              <span
                className="client-plugin-status"
                role="status"
                data-status={plugin.status}
              >
                {t(`plugins.status.${plugin.status}`)}
              </span>
            </header>
            {plugin.manifest.description && (
              <p className="client-plugin-description">
                {plugin.manifest.description}
              </p>
            )}
            {plugin.error && (
              <p role="alert" className="client-plugin-notice">
                {plugin.error}
              </p>
            )}
            <div className="client-plugin-controls">
              {state.sessionId && (
                <label>
                  <input
                    type="checkbox"
                    checked={registry!.isEnabled(
                      plugin.manifest.id,
                      state.sessionId,
                    )}
                    disabled={busy}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      void run(() =>
                        registry!.setEnabled(
                          plugin.manifest.id,
                          state.sessionId!,
                          enabled,
                        ),
                      );
                    }}
                  />
                  {t("plugins.sessionEnabled")}
                </label>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={plugin.enabledByDefault}
                  disabled={busy}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    void run(() =>
                      registry!.setDefaultEnabled(plugin.manifest.id, enabled),
                    );
                  }}
                />
                {t("plugins.defaultEnabled")}
              </label>
            </div>
            <details className="client-plugin-details">
              <summary>{t("plugins.details")}</summary>
              <dl className="client-plugin-info">
                <dt>{t("plugins.id")}</dt>
                <dd>{plugin.manifest.id}</dd>
                <dt>{t("plugins.imports")}</dt>
                <dd>
                  {plugin.imports.length
                    ? plugin.imports.join(", ")
                    : t("plugins.noImports")}
                </dd>
                {Boolean(plugin.manifest.network_origins?.length) && (
                  <>
                    <dt>{t("plugins.origins")}</dt>
                    <dd>{plugin.manifest.network_origins?.join(", ")}</dd>
                  </>
                )}
              </dl>
              <label className="client-plugin-priority">
                {t("plugins.priority")}
                <input
                  type="number"
                  className="settings-input"
                  value={plugin.priority}
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.target.valueAsNumber;
                    if (Number.isFinite(value))
                      void run(() =>
                        registry!.setPriority(plugin.manifest.id, value),
                      );
                  }}
                />
              </label>
            </details>
            <div className="client-plugin-entry-actions">
              <div className="client-plugin-toolbar-actions">
                {plugin.manifest.targets.includes("expanded-page") && (
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() =>
                      void dispatch({
                        type: "OpenPlugin",
                        id: plugin.manifest.id,
                      })
                    }
                  >
                    {t("plugins.expand")}
                  </button>
                )}
                <PluginUpload
                  label={t("plugins.update")}
                  disabled={busy}
                  onChange={(event) => upload(event, plugin.manifest.id)}
                />
              </div>
              <div className="client-plugin-maintenance-actions">
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={busy}
                  onClick={() =>
                    void run(() => registry!.reset(plugin.manifest.id))
                  }
                >
                  {t("plugins.reset")}
                </button>
                <button
                  type="button"
                  className="ghost-btn client-plugin-remove"
                  disabled={busy}
                  onClick={() =>
                    void run(() => registry!.remove(plugin.manifest.id))
                  }
                >
                  {t("plugins.remove")}
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
