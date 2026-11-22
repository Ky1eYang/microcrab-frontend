import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { PendingQuestion } from "../../client/types";
import { activeLocale, subscribeLocale, t } from "../../i18n";
import { useAppSelector, useAppStore } from "../../state";
import { ExpandableNotice } from "../ExpandableNotice";
import { Icon } from "../shared";
import "./secret-card.css";

const visibilityLabels = {
  en: {
    reveal: (label: string) => `Reveal ${label}`,
    remask: (label: string) => `Hide ${label}`,
  },
  "zh-CN": {
    reveal: (label: string) => `显示：${label}`,
    remask: (label: string) => `隐藏：${label}`,
  },
};

type SecretField = NonNullable<PendingQuestion["secret"]>["secrets"][number];

function SecretInput({
  field,
  inputs,
  disabled,
  scope,
  locale,
}: {
  field: SecretField;
  inputs: Map<string, HTMLInputElement>;
  disabled: boolean;
  scope: string;
  locale: ReturnType<typeof activeLocale>;
}) {
  const { key, label, description } = field;
  const id = useId();
  const [revealedScope, setRevealedScope] = useState<string | null>(null);
  const revealed = !disabled && revealedScope === scope;
  useLayoutEffect(() => {
    if (revealedScope !== null && (disabled || revealedScope !== scope))
      setRevealedScope(null);
  }, [disabled, revealedScope, scope]);
  const selection = useRef<
    [number, number, HTMLInputElement["selectionDirection"]] | null
  >(null);
  const inputRef = useCallback(
    (input: HTMLInputElement | null) => {
      if (input) inputs.set(key, input);
      else {
        const previous = inputs.get(key);
        if (previous) {
          previous.type = "password";
          previous.value = "";
        }
        inputs.delete(key);
      }
    },
    [inputs, key],
  );
  useLayoutEffect(() => {
    const saved = selection.current;
    selection.current = null;
    if (saved && !disabled)
      inputs
        .get(key)
        ?.setSelectionRange(saved[0], saved[1], saved[2] ?? undefined);
  }, [disabled, inputs, key, revealed]);
  const visibilityLabel =
    visibilityLabels[locale][revealed ? "remask" : "reveal"](label);
  return (
    <div className="secret-field">
      <label htmlFor={id}>{label}</label>
      {description && (
        <span id={`${id}-hint`} className="settings-input-hint">
          {description}
        </span>
      )}
      <div className="secret-field-controls">
        <input
          id={id}
          type={revealed ? "text" : "password"}
          name={key}
          aria-describedby={description ? `${id}-hint` : undefined}
          autoComplete="new-password"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={disabled}
          maxLength={8192}
          ref={inputRef}
        />
        <button
          className="ghost-btn secret-visibility"
          type="button"
          disabled={disabled}
          aria-controls={id}
          aria-label={visibilityLabel}
          title={visibilityLabel}
          onPointerDown={(event) => {
            // Pointer toggles don't interrupt editing; keyboard users retain button focus.
            if (
              event.button === 0 &&
              document.activeElement === inputs.get(key)
            )
              event.preventDefault();
          }}
          onClick={() => {
            const input = inputs.get(key);
            if (
              input &&
              input.selectionStart != null &&
              input.selectionEnd != null
            ) {
              selection.current = [
                input.selectionStart,
                input.selectionEnd,
                input.selectionDirection,
              ];
            }
            setRevealedScope(revealed ? null : scope);
          }}
        >
          <Icon
            name={revealed ? "eye-off" : "eye"}
            size={16}
            aria-hidden="true"
            focusable="false"
          />
        </button>
      </div>
    </div>
  );
}

/** Plaintext lives only in native uncontrolled inputs and the one-shot sideband
 * request. No action payload, AppState, browser persistence or settled card owns it. */
export function SecretCard({ value }: { value: PendingQuestion }) {
  const store = useAppStore();
  const viewScope = useAppSelector((state) =>
    JSON.stringify([
      state.authSession?.principal?.owner,
      state.apiBase,
      state.sessionId,
      state.transcript.historyView?.lineage,
      state.transcript.historyResetRevision,
    ]),
  );
  const [replyRevision, setReplyRevision] = useState(0);
  const scope = JSON.stringify([
    viewScope,
    value.id,
    value.parentSessionId,
    value.sessionId,
    value.callId,
    value.epoch,
    replyRevision,
  ]);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const locale = useSyncExternalStore(
    subscribeLocale,
    activeLocale,
    activeLocale,
  );
  const request = value.secret;
  const disabled = value.disabled || value.awaitingConfirmation || submitting;
  const clear = useCallback(() => {
    for (const input of inputs.current.values()) input.value = "";
  }, []);
  // Clear live DOM values before a changed scope can paint.
  useLayoutEffect(clear, [clear, scope]);
  useLayoutEffect(() => {
    if (disabled) clear();
  }, [clear, disabled]);
  if (!request) return null;
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
    // Remask even if a failed operation starts and finishes in the same render batch.
    setReplyRevision((revision) => revision + 1);
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
    <article
      className="flow-card secret-card"
      data-testid="secret-request"
      data-invocation-id={value.id}
      data-status={
        value.observer
          ? "observer"
          : value.awaitingConfirmation
            ? "awaiting"
            : submitting
              ? "submitting"
              : "ready"
      }
      aria-busy={submitting || undefined}
    >
      <h3 className="secret-card-title">
        <Icon name="key" size={16} aria-hidden="true" focusable="false" />
        {t("secret.title")}
      </h3>
      <p>{request.reason}</p>
      <p className="secret-card-private">{t("secret.private")}</p>
      {value.observer && (
        <ExpandableNotice
          className="inline-notice"
          tone="neutral"
          marker="none"
          role="status"
          data-testid="secret-observer"
          text={t("secret.observer")}
        />
      )}
      {value.awaitingConfirmation && (
        <ExpandableNotice
          className="inline-notice"
          tone="neutral"
          marker="none"
          role="status"
          data-testid="secret-awaiting"
          text={t("secret.awaiting")}
        />
      )}
      {/* Observers only see their status line: disabled fields and buttons
          would read as something this view could still answer. */}
      {!value.observer && (
        <form
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            void reply(false);
          }}
        >
          {request.secrets.map((field) => (
            <SecretInput
              key={field.key}
              field={field}
              inputs={inputs.current}
              disabled={disabled}
              scope={scope}
              locale={locale}
            />
          ))}
          {error && (
            <ExpandableNotice
              className="inline-notice"
              tone="danger"
              marker="none"
              role="alert"
              data-testid="secret-error"
              text={error}
            />
          )}
          <div className="settings-actions-row flow-card-actions">
            <button
              className="ghost-btn"
              type="button"
              disabled={disabled}
              onClick={() => void reply(true)}
            >
              {t("secret.decline")}
            </button>
            <button className="primary-btn" type="submit" disabled={disabled}>
              {t("secret.submit")}
            </button>
            {value.awaitingConfirmation && (
              <button
                type="button"
                className="ghost-btn"
                onClick={() =>
                  void store
                    .observeSecret(value.id)
                    .catch(() => setError(t("secret.unconfirmed")))
                }
              >
                {t("secret.observe")}
              </button>
            )}
          </div>
        </form>
      )}
    </article>
  );
}
