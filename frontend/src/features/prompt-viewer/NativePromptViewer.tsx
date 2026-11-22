import {
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { describeSchemaFields } from "./schema-fields";
import { formatJson, RICH_TEXT_LIMIT } from "../content-inspection/format";
import type { AppState } from "../../client/types";
import { useAppSelector, useAppStore } from "../../state";
import {
  readFrozenPrompt,
  type PromptSelection,
  type PromptResult,
  type ReadFrozenPrompt,
} from "./frozen-prompt";
import { promptLabels, type PromptLabels } from "./labels";
import "./native-prompt-viewer.css";

function promptScope(state: AppState, sessionId: string | null) {
  const auth = state.authSession;
  const history = state.transcript.historyView;
  if (
    !auth?.authenticated ||
    !auth.principal?.owner ||
    state.authRequired ||
    state.page !== "conversation" ||
    !sessionId ||
    state.sessionId !== sessionId ||
    state.sessionAttachingId ||
    state.popup?.type === "subagentDetail" ||
    state.historyMutationPending ||
    state.retryPending ||
    typeof history?.lineage !== "string" ||
    !history.lineage ||
    !Number.isSafeInteger(history.epoch) ||
    history.epoch < 0
  )
    return undefined;

  return {
    sessionId,
    lineage: history.lineage,
    epoch: history.epoch,
    key: JSON.stringify([
      auth.principal.owner,
      state.apiBase,
      sessionId,
      history.lineage,
      history.epoch,
      state.transcript.historyResetRevision,
    ]),
  };
}

/** Mount this standalone viewer only when the Prompt panel is selected. */
export function NativePromptViewer({
  sessionId,
  active = true,
  readPrompt,
}: {
  sessionId: string | null;
  active?: boolean;
  readPrompt?: ReadFrozenPrompt;
}) {
  return active ? (
    <ActivePromptViewer sessionId={sessionId} readPrompt={readPrompt} />
  ) : null;
}

export default NativePromptViewer;

function ActivePromptViewer({
  sessionId,
  readPrompt,
}: {
  sessionId: string | null;
  readPrompt?: ReadFrozenPrompt;
}) {
  const store = useAppStore();
  const api = store.api;
  const scope = useAppSelector(
    (state) => promptScope(state, sessionId),
    (a, b) => a?.key === b?.key,
  );
  const labels = useAppSelector((state) => promptLabels[state.resolvedLocale]);
  const read = useMemo<ReadFrozenPrompt>(
    () =>
      readPrompt ??
      ((selection, signal) => readFrozenPrompt(api, selection, signal)),
    [readPrompt, api],
  );
  const current = useMemo(
    () => () =>
      store.api === api &&
      scope?.key === promptScope(store.getSnapshot(), sessionId)?.key,
    [api, scope, sessionId, store],
  );
  return (
    <section className="native-prompt-viewer" aria-label={labels.title}>
      {scope ? (
        <ScopedPrompt
          key={scope.key}
          labels={labels}
          selection={scope}
          read={read}
          current={current}
        />
      ) : (
        <p role="status">{labels.outOfScope}</p>
      )}
    </section>
  );
}

function ScopedPrompt({
  labels,
  selection,
  read,
  current,
}: {
  labels: PromptLabels;
  selection: PromptSelection;
  read: ReadFrozenPrompt;
  current: () => boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const request = useMemo(
    () => ({ attempt, current, read, selection }),
    [attempt, current, read, selection],
  );
  const [snapshot, setSnapshot] = useState<{
    request: typeof request;
    result: PromptResult;
  }>();
  useLayoutEffect(() => {
    if (!request.current()) return;
    const controller = new AbortController();
    const accept = (result: PromptResult) => {
      if (!controller.signal.aborted && request.current())
        setSnapshot({ request, result });
    };
    async function load() {
      try {
        const { sessionId, lineage, epoch } = request.selection;
        accept(
          await request.read({ sessionId, lineage, epoch }, controller.signal),
        );
      } catch {
        accept({ status: "failed" });
      }
    }
    void load();
    return () => controller.abort();
  }, [request]);

  const result =
    current() && snapshot?.request === request ? snapshot.result : undefined;
  if (!result) return <p role="status">{labels.loading}</p>;
  if (result.status === "available")
    return <PromptContents result={result} labels={labels} />;
  return (
    <>
      <p role="status">{labels[result.status]}</p>
      {result.status === "failed" || result.status === "unavailable" ? (
        <button
          type="button"
          className="ghost-btn"
          onClick={() => setAttempt((n) => n + 1)}
        >
          {labels.retry}
        </button>
      ) : null}
    </>
  );
}

const PAGE_SIZE = 20;

function PromptContents({
  result,
  labels,
}: {
  result: Extract<PromptResult, { status: "available" }>;
  labels: PromptLabels;
}) {
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<number>();
  const toolListId = useId();
  const start = page * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, result.tools.length);
  function move(delta: number) {
    setExpanded(undefined);
    setPage(page + delta);
  }

  return (
    <>
      <div className="native-prompt-system">
        <h3>{labels.system}</h3>
        {result.system.length ? (
          <pre
            className="native-prompt-source"
            tabIndex={0}
            aria-label={labels.system}
          >
            <code>{result.system}</code>
          </pre>
        ) : (
          <p>{labels.emptySystem}</p>
        )}
      </div>
      <h3>{labels.tools}</h3>
      <p className="native-prompt-declarations-note">
        {labels.declarationsOnly}
      </p>
      {!result.tools.length ? (
        <p>{labels.noTools}</p>
      ) : (
        <ol start={start + 1} className="native-prompt-tools">
          {result.tools.slice(start, end).map((tool, offset) => {
            const index = start + offset;
            const open = index === expanded;
            const panelId = `${toolListId}-tool-${index}`;
            return (
              <li key={index}>
                <h4>
                  <button
                    type="button"
                    className="native-prompt-tool"
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={() => setExpanded(open ? undefined : index)}
                  >
                    <code translate="no">{tool.name}</code>
                  </button>
                </h4>
                <div
                  id={panelId}
                  hidden={!open}
                  className="native-prompt-definition"
                >
                  {open && (
                    <>
                      {tool.description && <p>{tool.description}</p>}
                      <ParameterSchema
                        source={tool.parameters}
                        labels={labels}
                      />
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {result.tools.length > PAGE_SIZE && (
        <div className="native-prompt-pages">
          <button
            type="button"
            className="ghost-btn"
            disabled={!page}
            onClick={() => move(-1)}
          >
            {labels.previous}
          </button>
          <span role="status">
            {start + 1}–{end} / {result.tools.length}
          </span>
          <button
            type="button"
            className="ghost-btn"
            disabled={end >= result.tools.length}
            onClick={() => move(1)}
          >
            {labels.next}
          </button>
        </div>
      )}
    </>
  );
}

function ParameterSchema({
  source,
  labels,
}: {
  source: string;
  labels: PromptLabels;
}) {
  const summary = useMemo(() => describeSchemaFields(source), [source]);
  const [showSource, setShowSource] = useState(false);
  const [raw, setRaw] = useState(false);
  const sourceId = useId();
  const formatted = useMemo(() => {
    if (!showSource || raw || source.length > RICH_TEXT_LIMIT) return source;
    try {
      return formatJson(source);
    } catch {
      return source;
    }
  }, [showSource, raw, source]);
  return (
    <>
      <h5>{labels.parameterFields}</h5>
      {summary?.rows.length ? (
        <dl className="native-prompt-fields">
          {summary.rows.map((field) => (
            <div key={field.name}>
              <dt>
                <code translate="no">{field.name || '""'}</code>
                {field.type && (
                  <code className="native-prompt-field-type">{field.type}</code>
                )}
                {field.required && (
                  <span className="native-prompt-required">
                    {labels.required}
                  </span>
                )}
              </dt>
              {field.description && <dd>{field.description}</dd>}
              {!field.description && <dd>{labels.noDescription}</dd>}
            </div>
          ))}
        </dl>
      ) : (
        <p>{labels.noParameterFields}</p>
      )}
      <p className="native-prompt-schema-note">
        {summary?.truncated ? labels.parameterLimit : labels.parameterScope}
      </p>
      <button
        className="ghost-btn native-prompt-json-toggle"
        type="button"
        aria-expanded={showSource}
        aria-controls={sourceId}
        onClick={() => setShowSource((open) => !open)}
      >
        {labels.parameters}
      </button>
      <div id={sourceId} hidden={!showSource}>
        {showSource && (
          <>
            {formatted !== source || raw ? (
              <label className="native-prompt-raw-choice">
                <input
                  type="checkbox"
                  checked={raw}
                  onChange={(event) => setRaw(event.currentTarget.checked)}
                />
                {labels.rawSource}
              </label>
            ) : null}
            <pre
              className="native-prompt-source native-prompt-schema-source"
              tabIndex={0}
              aria-label={labels.parameters}
            >
              <SchemaSource source={formatted} />
            </pre>
          </>
        )}
      </div>
    </>
  );
}

const MAX_HIGHLIGHTS = 400;

function SchemaSource({ source }: { source: string }) {
  // React text only, no HTML/Markdown, references, or schema interpretation.
  // A large schema keeps its exact source, but cannot create an unbounded DOM.
  const tokens =
    /"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;
  const nodes: ReactNode[] = [];
  let end = 0;
  for (let i = 0; i < MAX_HIGHLIGHTS; i++) {
    const match = tokens.exec(source);
    if (!match) break;
    const token = match[0];
    const kind =
      token[0] === '"' ? "string" : /^[\d-]/.test(token) ? "number" : "literal";
    if (end < match.index) nodes.push(source.slice(end, match.index));
    nodes.push(
      <span key={match.index} className={`native-prompt-json-${kind}`}>
        {token}
      </span>,
    );
    end = match.index + token.length;
  }
  return (
    <code>
      {nodes}
      {source.slice(end)}
    </code>
  );
}
