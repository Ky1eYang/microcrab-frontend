import { useEffect, useRef, useState } from "react";
import { registerDocumentLeave } from "../client/document-leave";
import { t } from "../i18n";
import { HTTP_REQUEST_TIMEOUT } from "./http-deadline";
import type { PluginRegistryAPI } from "./types";

/** Host configuration is available even when a plugin declares no SettingPage. */
export function PluginHttpSettings({
  registry,
  pluginId,
  disabled,
}: {
  registry: PluginRegistryAPI;
  pluginId: string;
  disabled: boolean;
}) {
  const saved = registry.getHttpRequestTimeout(pluginId) / 1000;
  const [seconds, setSeconds] = useState(String(saved));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const root = useRef<HTMLFormElement>(null);
  const continuation = useRef<(() => void) | undefined>(undefined);
  const [discard, setDiscard] = useState(false);
  const latest = useRef({ dirty: false, saving: false });
  latest.current = {
    dirty: Number(seconds) !== saved || seconds.trim() === "",
    saving,
  };
  useEffect(
    () =>
      registerDocumentLeave(
        () => root.current,
        (proceed) => {
          if (latest.current.saving) return false;
          if (!latest.current.dirty) return true;
          continuation.current = proceed;
          setDiscard(true);
          return false;
        },
      ),
    [],
  );
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (latest.current.dirty || latest.current.saving) event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);
  const value = Number(seconds);
  const valid =
    seconds.trim() !== "" &&
    Number.isInteger(value) &&
    value >= HTTP_REQUEST_TIMEOUT.minMs / 1000 &&
    value <= HTTP_REQUEST_TIMEOUT.maxMs / 1000;
  return (
    <form
      ref={root}
      className="settings-row"
      data-testid="plugin-http-settings"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid || disabled || saving) return;
        setSaving(true);
        setError(null);
        setApplied(false);
        try {
          await registry.setHttpRequestTimeout(pluginId, value * 1000);
          setApplied(true);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="settings-row-info">
        <label
          className="settings-row-label"
          htmlFor={`http-timeout:${pluginId}`}
        >
          {t("plugins.httpTimeout")}
        </label>
        <div className="settings-row-sub" id={`http-timeout-hint:${pluginId}`}>
          {t("plugins.httpTimeoutHint")}
        </div>
        {discard && (
          <div
            role="alertdialog"
            aria-label={t("contentViewer.discardQuestion")}
          >
            <p>{t("contentViewer.discardQuestion")}</p>
            <button
              type="button"
              className="ghost-btn btn-sm"
              onClick={() => {
                continuation.current = undefined;
                setDiscard(false);
              }}
            >
              {t("contentViewer.keepEditing")}
            </button>
            <button
              type="button"
              className="ghost-btn btn-sm"
              onClick={() => {
                latest.current.dirty = false;
                setSeconds(String(saved));
                setDiscard(false);
                const proceed = continuation.current;
                continuation.current = undefined;
                proceed?.();
              }}
            >
              {t("contentViewer.discard")}
            </button>
          </div>
        )}
        {!valid && <div role="alert">{t("plugins.httpTimeoutRange")}</div>}
        {error && <div role="alert">{error}</div>}
        {applied && <div role="status">{t("plugins.httpTimeoutSaved")}</div>}
      </div>
      <div className="settings-row-action">
        <input
          id={`http-timeout:${pluginId}`}
          type="number"
          className="settings-input client-plugin-priority-input"
          aria-describedby={`http-timeout-hint:${pluginId}`}
          min={10}
          max={300}
          step={1}
          required
          value={seconds}
          disabled={disabled || saving}
          onChange={(event) => {
            setSeconds(event.target.value);
            setApplied(false);
          }}
        />
        <button
          type="submit"
          className="ghost-btn btn-sm"
          disabled={disabled || saving || !valid || value === saved}
        >
          {t("plugins.httpTimeoutSave")}
        </button>
      </div>
    </form>
  );
}
