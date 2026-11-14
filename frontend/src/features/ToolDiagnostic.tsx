import { Fragment } from "react";
import type { NativeToolDiagnostic } from "../client/types";
import { diagnosticText } from "../client/diagnostics";
import { t } from "../i18n";
import "../styles/executions.css";

const knownEffects = new Set([
  "not_started",
  "none",
  "committed",
  "partial",
  "may_have_occurred",
  "unknown",
]);
const effectText = (effect: string) =>
  knownEffects.has(effect)
    ? t(`toolDiagnostic.effects.${effect}`)
    : diagnosticText(effect, 128);
export function ToolDiagnostic({
  diagnostic,
  summary,
}: {
  diagnostic: NativeToolDiagnostic;
  summary?: string | null;
}) {
  return (
    <section
      aria-label={t("toolDiagnostic.title")}
      className="settings-section tool-diagnostic"
    >
      <strong className="tool-diagnostic-summary">
        {diagnosticText(summary ?? diagnostic.reason ?? diagnostic.message) ||
          t("toolDiagnostic.failed")}
      </strong>
      {diagnostic.reason &&
        summary &&
        diagnosticText(diagnostic.reason) !== diagnosticText(summary) && (
          <p>{diagnosticText(diagnostic.reason)}</p>
        )}
      <dl className="execution-metadata">
        <dt>{t("failure.code", { value: "" })}</dt>
        <dd>{diagnosticText(diagnostic.code, 128)}</dd>
        <dt>{t("toolDiagnostic.location")}</dt>
        <dd>
          {diagnosticText(diagnostic.layer, 128)}
          {diagnostic.operation
            ? ` · ${diagnosticText(diagnostic.operation, 128)}`
            : ""}
        </dd>
        <dt>{t("toolDiagnostic.phase")}</dt>
        <dd>{diagnosticText(diagnostic.phase, 128)}</dd>
        <dt>{t("toolDiagnostic.effects")}</dt>
        <dd>{effectText(diagnostic.effects)}</dd>
        {diagnostic.operation_effects && (
          <>
            <dt>{t("toolDiagnostic.operationEffects")}</dt>
            <dd>{effectText(diagnostic.operation_effects)}</dd>
          </>
        )}
        {(
          [
            "requested_timeout_ms",
            "effective_timeout_ms",
            "json_line",
            "json_column",
          ] as const
        ).map((key) => {
          const value = diagnostic[key];
          return typeof value === "number" &&
            Number.isSafeInteger(value) &&
            value >= 0 ? (
            <Fragment key={key}>
              <dt>{t(`failure.${key}`, { value: "" })}</dt>
              <dd>
                {value}
                {key.endsWith("_ms") ? " ms" : ""}
              </dd>
            </Fragment>
          ) : null;
        })}
        {diagnostic.evidence_id && (
          <>
            <dt>{t("toolDiagnostic.evidence")}</dt>
            <dd>{diagnosticText(diagnostic.evidence_id, 128)}</dd>
          </>
        )}
        {typeof diagnostic.retryable === "boolean" && (
          <>
            <dt>{t("toolDiagnostic.retryability")}</dt>
            <dd>
              {t(
                diagnostic.retryable
                  ? "failure.retryable"
                  : "failure.notRetryable",
              )}
            </dd>
          </>
        )}
        {diagnostic.limit_owner && (
          <>
            <dt>{t("toolDiagnostic.limitOwner")}</dt>
            <dd>{diagnosticText(diagnostic.limit_owner, 128)}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
