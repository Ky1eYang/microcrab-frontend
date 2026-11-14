import { useEffect, useState } from "react";
import { unsupported } from "../../client/unsupported";
import { useApp } from "../../state";
import { t } from "../../i18n";

export function ModelRetrySettings() {
  const { state } = useApp();
  const model = state.draftModel;
  const [retries, setRetries] = useState("");
  const [backoff, setBackoff] = useState("");
  const [message, setMessage] = useState("");
  const ready = false;
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setMessage("");
    setRetries("");
    setBackoff("");
    try {
      // TODO: Load model retry configuration through a native configuration command.
      unsupported(t("modelRetry.read"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [state.apiBase, model?.providerId, model?.id]);
  async function save() {
    if (!model) return;
    const max_retries = Number(retries),
      retry_backoff_ms = Number(backoff);
    if (
      !/^\d+$/.test(retries) ||
      !Number.isSafeInteger(max_retries) ||
      max_retries > 4294967295 ||
      !/^\d+$/.test(backoff) ||
      !Number.isSafeInteger(retry_backoff_ms)
    ) {
      setMessage(
        t("modelRetry.invalid"),
      );
      return;
    }
    setSaving(true);
    try {
      // TODO: Save model retry configuration once the native backend exposes it.
      unsupported(t("modelRetry.save"));
    } catch (error) {
      setMessage(String(error));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="settings-card">
      <div className="settings-card-title">{t("modelRetry.title")}</div>
      <p className="settings-description">
        {model ? `${model.providerId} / ${model.id}` : t("modelRetry.noModel")} · {t("modelRetry.override")}
      </p>
      <label className="settings-form-label" htmlFor="model-max-retries">
        {t("modelRetry.max")}
      </label>
      <input
        id="model-max-retries"
        className="settings-input"
        type="number"
        min="0"
        max="4294967295"
        step="1"
        value={retries}
        disabled={!ready || saving}
        onChange={(e) => setRetries(e.target.value)}
      />
      <label className="settings-form-label" htmlFor="model-retry-backoff">
        {t("modelRetry.backoff")}
      </label>
      <input
        id="model-retry-backoff"
        className="settings-input"
        type="number"
        min="0"
        max={Number.MAX_SAFE_INTEGER}
        step="1"
        value={backoff}
        disabled={!ready || saving}
        onChange={(e) => setBackoff(e.target.value)}
      />
      {message && (
        <div className="settings-feedback-banner" role="status">
          {message}
        </div>
      )}
      <button
        className="primary-btn"
        disabled={!ready || saving}
        onClick={save}
      >
        {t("modelRetry.saveBtn")}
      </button>
    </div>
  );
}
