import { toolReferenceProjection } from "./toolReferences";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useApp } from "../state";
import { t } from "../i18n";
import type { NativeExecution } from "../client/types";
import { ContentDialog } from "./ContentDialog";
import { Payload } from "./Payload";
import { ToolDiagnostic } from "./ToolDiagnostic";
import {
  executionElapsed,
  executionStatus,
  pendingExecution,
  readCompleteExecutionContent,
  readCompleteRetainedOutput,
  type RetainedOutput,
} from "./executionContent";
import "../styles/executions.css";

type ReadState<T> = { loading: boolean; value?: T; error?: string };
type Content = { available: boolean; content: string };

/** Explicit display reads never issue a job drain, release, cancellation or ack. */
export function ExecutionPeek(props: {
  execution: NativeExecution;
  onClose: () => void;
}) {
  const { state } = useApp();
  const row = props.execution;
  const identity = JSON.stringify([
    state.authSession?.principal?.owner,
    state.sessionId,
    row.session_id,
    row.execution_id,
    row.call_id,
    row.started_at_unix_ms,
  ]);
  return <ExecutionPeekContent key={identity} {...props} />;
}

function ExecutionPeekContent({
  execution,
  onClose,
}: {
  execution: NativeExecution;
  onClose: () => void;
}) {
  const { state, dispatch } = useApp();
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const rows: NativeExecution[] | undefined = state.executionHistory;
  const live = rows?.find(
    (row) =>
      row.session_id === execution.session_id &&
      row.execution_id === execution.execution_id &&
      row.call_id === execution.call_id &&
      row.started_at_unix_ms === execution.started_at_unix_ms,
  );
  const [refresh, setRefresh] = useState(0);
  const [args, setArgs] = useState<ReadState<Content>>({ loading: true });
  const [result, setResult] = useState<ReadState<Content>>({ loading: true });
  const [output, setOutput] = useState<ReadState<RetainedOutput>>({
    loading: true,
  });
  const [, tick] = useState(0);
  const generation = useRef(0);
  const scope = JSON.stringify([
    state.authSession?.principal?.owner,
    state.sessionId,
    execution.session_id,
    execution.execution_id,
    execution.call_id,
    execution.started_at_unix_ms,
  ]);
  const argumentsRead = useRef<Content | undefined>(undefined);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const outputSignal = JSON.stringify([
    live?.output?.bytes,
    live?.output?.start_cursor,
    live?.output?.end_cursor,
    live?.output?.closed,
    live?.output_availability,
    live?.status,
    live?.elapsed_ms,
  ]);
  const latestOutputSignal = useRef(outputSignal);
  latestOutputSignal.current = outputSignal;
  const readingRef = useRef(true);
  readingRef.current = args.loading || result.loading || output.loading;
  const capturedSignal = useRef(outputSignal);

  useEffect(() => {
    // One fixed-end batch at a time. Continuous output is sampled, not followed
    // by an unbounded catch-up loop; model drain/release facts trigger refresh too.
    const timer = setInterval(() => {
      if (
        !readingRef.current &&
        latestOutputSignal.current !== capturedSignal.current
      ) {
        capturedSignal.current = latestOutputSignal.current;
        setRefresh((value) => value + 1);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [scope]);

  useEffect(() => {
    if (
      !live ||
      !pendingExecution(live) ||
      live.elapsed_ms != null ||
      live.started_at_unix_ms == null
    )
      return;
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [live?.status, live?.elapsed_ms, live?.started_at_unix_ms]);

  useEffect(() => {
    const request = ++generation.current;
    capturedSignal.current = latestOutputSignal.current;
    const active = () =>
      request === generation.current && currentScope.current === scope;
    if (!live || state.sessionId !== execution.session_id) {
      setArgs({ loading: false });
      setResult({ loading: false });
      setOutput({ loading: false });
      return;
    }
    if (live.arguments_available === false) {
      argumentsRead.current = undefined;
      setArgs({ loading: false, value: { available: false, content: "" } });
    }
    const loading = <T,>(previous: ReadState<T>): ReadState<T> => ({
      ...previous,
      loading: true,
      error: undefined,
    });
    if (argumentsRead.current)
      setArgs({ loading: false, value: argumentsRead.current });
    else setArgs(loading);
    setResult(loading);
    setOutput(loading);
    const settle = <T,>(
      promise: Promise<T>,
      update: Dispatch<SetStateAction<ReadState<T>>>,
    ) => {
      void promise
        .then((value) => {
          if (active()) update({ loading: false, value });
        })
        .catch((cause: unknown) => {
          if (active())
            update((previous) => ({
              ...previous,
              loading: false,
              error:
                cause instanceof Error
                  ? cause.message
                  : t("execution.readFailed"),
            }));
        });
    };
    for (const [field, update] of [
      ["arguments", setArgs],
      ["result", setResult],
    ] as const) {
      if (field === "arguments" && argumentsRead.current) continue;
      settle(
        readCompleteExecutionContent(
          (cursor) =>
            dispatchRef.current({
              type: "ReadExecutionContent",
              sessionId: execution.session_id,
              executionId: execution.execution_id,
              field,
              cursor,
              maxBytes: 65536,
            }),
          execution,
          field,
          active,
        ).then((value) => {
          if (active() && field === "arguments" && value.available)
            argumentsRead.current = value;
          return value;
        }),
        update,
      );
    }
    if (live.output && live.output_availability !== "released") {
      settle(
        readCompleteRetainedOutput(
          (cursor) =>
            dispatchRef.current({
              type: "ReadExecutionOutput",
              sessionId: execution.session_id,
              executionId: execution.execution_id,
              cursor,
              maxBytes: 65536,
            }),
          execution,
          active,
        ),
        setOutput,
      );
    } else setOutput({ loading: false });
    return () => {
      generation.current += 1;
    };
    // Refresh source text when availability changes; output changes are sampled
    // by the bounded periodic refresh above, never chased inside a page loop.
  }, [
    scope,
    refresh,
    Boolean(live),
    live?.output_availability,
    live?.arguments_available,
    live?.result_available,
  ]);

  const reading = args.loading || result.loading || output.loading;
  const elapsed = live ? executionElapsed(live) : null;
  const content = (
    label: string,
    read: ReadState<Content>,
    direction: "arguments" | "result",
    waiting = false,
  ) => (
    <section
      className="execution-peek-section"
      data-refreshing={read.loading}
      aria-busy={read.loading}
      data-stale={Boolean(read.error && read.value)}
    >
      <h3>{label}</h3>
      {read.loading && !read.value && (
        <p role="status">{t("execution.loading")}</p>
      )}
      {read.error && <p role="alert">{read.error}</p>}
      {read.value?.available ? (
        <Payload
          value={read.value.content}
          projection={toolReferenceProjection(read.value.content, live?.presentation, direction)}
          empty={t("execution.empty")}
          variant="trajectory"
        />
      ) : (
        <p role="status">
          {t(waiting ? "execution.waitingResult" : "execution.unavailable")}
        </p>
      )}
    </section>
  );
  return (
    <ContentDialog
      maximizable
      title={t("execution.peekTitle", {
        tool: execution.tool,
        id: execution.execution_id,
      })}
      onClose={onClose}
    >
      <div
        className="execution-peek"
        data-testid="execution-peek"
        data-execution-id={execution.execution_id}
      >
        <div className="execution-peek-toolbar">
          <p role="status" data-status={live?.status}>
            {live ? executionStatus(live) : t("execution.unavailable")}
          </p>
          <button
            type="button"
            className="ghost-btn"
            disabled={reading || !live}
            data-testid="execution-peek-refresh"
            onClick={() => setRefresh((value) => value + 1)}
          >
            {t("execution.refresh")}
          </button>
        </div>
        <dl className="execution-metadata">
          <dt>{t("execution.duration")}</dt>
          <dd data-testid="execution-peek-duration">
            {elapsed == null ? t("execution.unknownTime") : `${elapsed} ms`}
          </dd>
          <dt>{t("execution.outputState")}</dt>
          <dd>
            {t(
              `execution.availability.${live?.output_availability ?? "unknown"}`,
            )}
          </dd>
        </dl>
        {live?.diagnostic && (
          <ToolDiagnostic
            diagnostic={live.diagnostic}
            summary={live.failure?.message}
          />
        )}
        {content(t("execution.arguments"), args, "arguments")}
        {content(
          t("execution.result"),
          result,
          "result",
          Boolean(live && pendingExecution(live)),
        )}
        <section
          className="execution-peek-section"
          data-testid="execution-peek-output"
          data-refreshing={output.loading}
          data-stale={Boolean(output.error && output.value)}
        >
          <h3>{t("execution.output")}</h3>
          {live?.output_availability === "released" && (
            <p role="status">{t("execution.outputReleased")}</p>
          )}
          {output.loading && !output.value && (
            <p role="status">{t("execution.loading")}</p>
          )}
          {output.error && <p role="alert">{output.error}</p>}
          {output.value ? (
            <>
              <p role="status">
                {t("execution.snapshotEnd", { end: output.value.endCursor })}
              </p>
              {output.value.startCursor > 0 && (
                <p role="status">{t("execution.expired")}</p>
              )}
              {!output.value.chunks.length && <p>{t("execution.empty")}</p>}
              {output.value.chunks.map((chunk) => (
                <Payload
                  key={chunk.cursor}
                  label={chunk.channel ?? t("execution.output")}
                  value={chunk.content}
                  empty={t("execution.empty")}
                  variant="trajectory"
                />
              ))}
            </>
          ) : (
            live?.output_availability !== "released" && (
              <p role="status">
                {t(
                  live?.output_availability === "none"
                    ? "execution.outputNone"
                    : "execution.outputUnknown",
                )}
              </p>
            )
          )}
        </section>
      </div>
    </ContentDialog>
  );
}
