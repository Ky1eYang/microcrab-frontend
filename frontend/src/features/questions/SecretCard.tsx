import { useEffect, useRef, useState } from "react";
import type { PendingQuestion } from "../../client/types";
import { useAppSelector, useAppStore } from "../../state";
import { t } from "../../i18n";

/** Plaintext lives only in native uncontrolled inputs and the one-shot sideband
 * request. No action payload, AppState, browser persistence or settled card owns it. */
export function SecretCard({ value }: { value: PendingQuestion }) {
  const store = useAppStore();
  const scope = useAppSelector((state) => JSON.stringify([
    state.authSession?.principal?.owner, state.apiBase, state.sessionId,
    state.transcript.historyView?.lineage, state.transcript.historyResetRevision,
  ]));
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const inputCallbacks = useRef(new Map<string, (input: HTMLInputElement | null) => void>());
  const inputRef = (key: string) => {
    let callback = inputCallbacks.current.get(key);
    if (!callback) {
      callback = (input) => {
        if (input) inputs.current.set(key, input);
        else {
          const previous = inputs.current.get(key);
          if (previous) previous.value = "";
          inputs.current.delete(key);
        }
      };
      inputCallbacks.current.set(key, callback);
    }
    return callback;
  };
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const request = value.secret;
  const clear = () => {
    for (const input of inputs.current.values()) input.value = "";
  };
  useEffect(() => { clear(); return () => clear(); }, [value.id, scope]);
  useEffect(() => {
    if (value.disabled || value.awaitingConfirmation) clear();
  }, [value.disabled, value.awaitingConfirmation]);
  if (!request) return null;
  const disabled = value.disabled || submitting;
  const reply = async (decline: boolean) => {
    if (disabled) return;
    setError("");
    const values = Object.create(null) as Record<string, string>;
    if (!decline) {
      for (const { key } of request.secrets) {
        const text = inputs.current.get(key)?.value ?? "";
        const bytes = new TextEncoder().encode(text).byteLength;
        if (bytes < 1 || bytes > 8192) {
          setError(t("secret.invalidValue"));
          return;
        }
        values[key] = text;
      }
    }
    clear();
    setSubmitting(true);
    try {
      if (decline) await store.declineSecret(value.id);
      else await store.submitSecret(value.id, values);
    } catch {
      // Neither server messages nor field values are public error content here.
      setError(t("secret.unconfirmed"));
    } finally {
      for (const key of Object.keys(values)) delete values[key];
      setSubmitting(false);
    }
  };
  return (
    <article className="flow-card" data-testid="secret-request" data-invocation-id={value.id}>
      <h3>{t("secret.title")}</h3>
      <p>{request.reason}</p>
      <p className="inline-notice">{t("secret.private")}</p>
      {value.observer && <p role="status">{t("secret.observer")}</p>}
      {value.awaitingConfirmation && <p role="status">{t("secret.awaiting")}</p>}
      <form autoComplete="off" onSubmit={(event) => { event.preventDefault(); void reply(false); }}>
        {request.secrets.map(({ key, label, description }) => (
          <label className="settings-field" key={key}>
            <span>{label}</span>
            {description && <span className="settings-input-hint">{description}</span>}
            <input type="password" name={key} aria-label={label}
              autoComplete="new-password" spellCheck={false} autoCapitalize="off"
              disabled={disabled} maxLength={8192}
              ref={inputRef(key)} />
          </label>
        ))}
        {error && <p role="alert" className="inline-notice">{error}</p>}
        <div className="settings-actions-row">
          <button className="ghost-btn" type="button" disabled={disabled}
            onClick={() => void reply(true)}>{t("secret.decline")}</button>
          <button className="primary-btn" type="submit" disabled={disabled}>{t("secret.submit")}</button>
          {value.awaitingConfirmation && <button type="button" className="ghost-btn"
            onClick={() => void store.observeSecret(value.id).catch(() => setError(t("secret.unconfirmed")))}>
            {t("secret.observe")}
          </button>}
        </div>
      </form>
    </article>
  );
}
