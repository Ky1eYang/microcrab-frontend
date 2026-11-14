import { useEffect, useState } from "react";
import { t } from "../i18n";
import { ExecutionPeek } from "./ExecutionPeek";
import {
  executionElapsed,
  executionStatus,
  pendingExecution,
  validateOutputPage,
} from "./executionContent";
import { useApp } from "../state";
import type {
  NativeExecution,
  NativeExecutionOutputPage,
} from "../client/types";
import { Payload } from "./Payload";
import { ToolDiagnostic } from "./ToolDiagnostic";
import "../styles/executions.css";

const pending = new Set(["running", "waiting", "cancelling"]);

/** Pages are read-only observations; output inspection never drains model output. */
function Execution({ execution }: { execution: NativeExecution }) {
  const { dispatch } = useApp();
  const [peek, setPeek] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    if (
      !pendingExecution(execution) ||
      execution.elapsed_ms != null ||
      execution.started_at_unix_ms == null
    )
      return;
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [execution.status, execution.elapsed_ms, execution.started_at_unix_ms]);
  const duration = executionElapsed(execution);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [reading, setReading] = useState(false);
  const [page, setPage] = useState<NativeExecutionOutputPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelling = execution.status === "cancelling" || cancelRequested;
  const read = async (cursor: number) => {
    if (reading) return;
    setReading(true);
    setError(null);
    try {
      const result: NativeExecutionOutputPage = await dispatch({
        type: "ReadExecutionOutput",
        executionId: execution.execution_id,
        sessionId: execution.session_id,
        cursor,
      });
      validateOutputPage(result, execution.execution_id, cursor);
      setPage(result);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("execList.readFailed"),
      );
    } finally {
      setReading(false);
    }
  };
  return (
    <div
      className="settings-row execution-record"
      data-status={execution.status}
      data-testid={`execution-${execution.execution_id}`}
    >
      <div className="execution-record-body">
        <strong>{execution.tool}</strong>
        <button
          type="button"
          className="ghost-btn execution-action"
          data-testid={`execution-peek-${execution.execution_id}`}
          onClick={() => setPeek(true)}
        >
          {t("execution.peek")}
        </button>
        <p role="status">
          {pending.has(execution.status) && cancelling
            ? t("execList.cancellingShort")
            : executionStatus(execution)}{" "}
          · #{execution.execution_id}
        </p>
        <dl className="execution-metadata">
          <dt>{t("execution.duration")}</dt>
          <dd>
            {duration == null ? t("execution.unknownTime") : `${duration} ms`}
          </dd>
          <dt>{t("execution.outputState")}</dt>
          <dd>
            {t(
              `execution.availability.${execution.output_availability ?? "unknown"}`,
            )}
          </dd>
          {execution.output && (
            <>
              <dt>{t("execList.outputBytes")}</dt>
              <dd>
                {t("execList.bytes", {
                  bytes: execution.output.bytes,
                  retained:
                    execution.output.end_cursor - execution.output.start_cursor,
                })}
              </dd>
            </>
          )}
        </dl>
        {execution.diagnostic ? (
          <ToolDiagnostic
            diagnostic={execution.diagnostic}
            summary={execution.failure?.message}
          />
        ) : (
          execution.failure && (
            <p role="alert">
              {execution.failure.message} · {execution.failure.code}
            </p>
          )
        )}
        {execution.output && (
          <>
            <p>
              {execution.output.closed
                ? t("execList.closed")
                : t("execList.open")}
              {execution.output_availability !== "released" &&
              execution.output.start_cursor > 0
                ? t("execList.truncated")
                : ""}
            </p>
            <button
              className="ghost-btn execution-action"
              type="button"
              disabled={reading || execution.output_availability === "released"}
              onClick={() => void read(0)}
            >
              {reading ? t("execList.reading") : t("execList.read")}
            </button>
            {page && execution.output_availability !== "released" && (
              <>
                {page.chunks.length === 0 && <p>{t("execList.empty")}</p>}
                {page.chunks.map((chunk, index) => (
                  <Payload
                    key={`${page.revision}:${chunk.cursor}:${index}`}
                    label={chunk.channel ?? t("execList.output")}
                    value={chunk.content}
                    empty={t("execList.empty")}
                  />
                ))}
                {page.start_cursor > 0 && (
                  <p role="status">{t("execList.expired")}</p>
                )}
                {page.next_cursor < page.end_cursor && (
                  <p role="status">{t("execList.partial")}</p>
                )}
                <p role="status">
                  {page.closed ? t("execList.closed") : t("execList.open")}
                </p>
                {page.next_cursor < page.end_cursor ? (
                  <button
                    className="ghost-btn execution-action"
                    type="button"
                    disabled={reading}
                    onClick={() => void read(page.next_cursor)}
                  >
                    {t("execList.nextPage")}
                  </button>
                ) : (
                  !page.closed && (
                    <button
                      className="ghost-btn execution-action"
                      type="button"
                      disabled={reading}
                      onClick={() => void read(page.next_cursor)}
                    >
                      {t("execList.more")}
                    </button>
                  )
                )}
              </>
            )}
          </>
        )}
        {execution.result != null && (
          <details>
            <summary>{t("execList.final")}</summary>
            <Payload value={execution.result} empty={t("execList.none")} />
          </details>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      {peek && (
        <ExecutionPeek execution={execution} onClose={() => setPeek(false)} />
      )}
      {pending.has(execution.status) && (
        <button
          className="ghost-btn execution-action execution-cancel"
          type="button"
          disabled={cancelling}
          onClick={async () => {
            setCancelRequested(true);
            setError(null);
            try {
              await dispatch({
                type: "CancelExecution",
                executionId: execution.execution_id,
                sessionId: execution.session_id,
              });
              // Acceptance is not completion. Retain the pending state until a terminal event.
            } catch (cause) {
              setCancelRequested(false);
              setError(
                cause instanceof Error
                  ? cause.message
                  : t("execList.cancelFailed"),
              );
            }
          }}
        >
          {cancelling
            ? t("execList.cancelling")
            : t("execList.cancel", { id: execution.execution_id })}
        </button>
      )}
    </div>
  );
}

export function Executions() {
  const { state } = useApp();
  const executions: NativeExecution[] = state.executionHistory ?? [];
  if (!state.sessionId) return null;
  return (
    <section
      aria-label={t("execList.title")}
      className="settings-section executions"
    >
      <h3>{t("execList.title")}</h3>
      <p role="status">{t("execList.retainedOnly")}</p>
      {state.executionHistoryTruncated && (
        <p role="status">{t("execList.budget")}</p>
      )}
      {executions.length === 0 && <p>{t("execList.noneShown")}</p>}
      {executions.map((execution) => (
        <Execution
          key={`${execution.session_id}:${execution.execution_id}`}
          execution={execution}
        />
      ))}
    </section>
  );
}
