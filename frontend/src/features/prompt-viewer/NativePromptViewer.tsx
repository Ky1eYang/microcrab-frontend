import { t, type ResolvedLocale } from "../../i18n";
import { sessionInspectionStatus } from "../shared/session-inspection-status";
import { JsonValueView } from "../content-inspection/JsonValueView";
import { useId, useMemo, useState, type ReactNode } from "react";
import { describeSchemaFields } from "./schema-fields";
import { formatJson, RICH_TEXT_LIMIT } from "../content-inspection/format";
import type { AppState } from "../../client/types";
import { useAppSelector, useAppStore } from "../../state";
import { useScopedPrompt } from "./use-scoped-prompt";
import {
  readFrozenPrompt,
  type PromptSelection,
  type PromptResult,
  type ReadFrozenPrompt,
} from "./frozen-prompt";
import { promptLabels, type PromptLabels } from "./labels";
import type {
  CurrentToolPermissions,
  ReadCurrentPermissions,
  ToolPermissionDisplay,
} from "./tool-permission";
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
    state.sessionTransportRecovery ||
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

function permissionReadScope(state: AppState, sessionId: string | null) {
  if (state.connection !== "ws" || state.modeSelectionPending) return;
  const session = state.sessions.find((item) => item.id === sessionId);
  // These are invalidation hints, not facts to display or a substitute for the
  // server's live catalog and policy proof. Externally changed policy may not
  // move the local revision, which is why observations expire independently.
  return JSON.stringify([
    session?.status === "closed",
    session?.status === "faulted",
    session?.archived,
    session?.mode,
    state.policy?.revision,
  ]);
}

/** Mount this standalone viewer only when the Prompt panel is selected. */
export function NativePromptViewer({
  sessionId,
  active = true,
  readPrompt,
  readPermissions,
}: {
  sessionId: string | null;
  active?: boolean;
  readPrompt?: ReadFrozenPrompt;
  readPermissions?: ReadCurrentPermissions;
}) {
  return active ? (
    <ActivePromptViewer
      sessionId={sessionId}
      readPrompt={readPrompt}
      readPermissions={readPermissions}
    />
  ) : null;
}

export default NativePromptViewer;

function ActivePromptViewer({
  sessionId,
  readPrompt,
  readPermissions,
}: {
  sessionId: string | null;
  readPrompt?: ReadFrozenPrompt;
  readPermissions?: ReadCurrentPermissions;
}) {
  const store = useAppStore();
  const api = store.api;
  const scope = useAppSelector(
    (state) => promptScope(state, sessionId),
    (a, b) => a?.key === b?.key,
  );
  const locale = useAppSelector((state) => state.resolvedLocale);
  const labels = promptLabels[locale];
  const status = useAppSelector((state) => sessionInspectionStatus(state, sessionId));
  const permissionScope = useAppSelector((state) =>
    permissionReadScope(state, sessionId),
  );
  const currentPermissionScope = useMemo(
    () => () => permissionReadScope(store.getSnapshot(), sessionId),
    [sessionId, store],
  );
  const read = useMemo<ReadFrozenPrompt>(
    () =>
      readPrompt ??
      ((selection, signal) => readFrozenPrompt(api, selection, signal)),
    [readPrompt, api],
  );
  const readRuntime = useMemo<ReadCurrentPermissions>(
    () =>
      readPermissions ??
      ((invalidation, signal) => {
        const owner = store.getSnapshot().authSession?.principal?.owner;
        if (!scope || !owner) return Promise.resolve(undefined);
        return api.readCurrentPermissions(
          owner,
          scope.sessionId,
          invalidation,
          signal,
        );
      }),
    [api, scope, store, readPermissions],
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
          locale={locale}
          selection={scope}
          read={read}
          readPermissions={readRuntime}
          current={current}
          permissionScope={permissionScope}
          currentPermissionScope={currentPermissionScope}
        />
      ) : (
        <p role="status">{status ? t(status, undefined, locale) : labels.outOfScope}</p>
      )}
    </section>
  );
}

function ScopedPrompt({
  labels,
  locale,
  selection,
  read,
  readPermissions,
  current,
  permissionScope,
  currentPermissionScope,
}: {
  labels: PromptLabels;
  locale: ResolvedLocale;
  selection: PromptSelection;
  read: ReadFrozenPrompt;
  readPermissions: ReadCurrentPermissions;
  current: () => boolean;
  permissionScope: string | undefined;
  currentPermissionScope: () => string | undefined;
}) {
  const {
    prompt,
    failure,
    permissions,
    readingPermissions,
    canReadPermissions,
    refresh,
    retry,
  } = useScopedPrompt(
    selection,
    read,
    current,
    readPermissions,
    permissionScope,
    currentPermissionScope,
  );
  if (prompt)
    return (
      <PromptContents
        result={prompt}
        labels={labels}
        locale={locale}
        current={current}
        permissions={permissions}
        readingPermissions={readingPermissions}
        canReadPermissions={canReadPermissions}
        refresh={refresh}
      />
    );
  if (!failure) return <p role="status">{labels.loading}</p>;
  return (
    <>
      <p role="status">{labels[failure]}</p>
      {failure === "failed" || failure === "unavailable" ? (
        <button type="button" className="ghost-btn" onClick={retry}>
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
  locale,
  current,
  permissions,
  readingPermissions,
  canReadPermissions,
  refresh,
}: {
  result: Pick<
    Extract<PromptResult, { status: "available" }>,
    "system" | "tools"
  >;
  labels: PromptLabels;
  locale: ResolvedLocale;
  current: () => boolean;
  permissions: CurrentToolPermissions | undefined;
  readingPermissions: boolean;
  canReadPermissions: boolean;
  refresh: () => void;
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
      {result.tools.length > 0 && (
        <button
          type="button"
          className="ghost-btn native-prompt-permission-refresh"
          aria-disabled={!canReadPermissions || readingPermissions}
          onClick={() => {
            if (canReadPermissions && !readingPermissions) refresh();
          }}
        >
          {labels.refreshPermissions}
        </button>
      )}
      {!result.tools.length ? (
        <p>{labels.noTools}</p>
      ) : (
        <ol start={start + 1} className="native-prompt-tools">
          {result.tools.slice(start, end).map((tool, offset) => {
            const index = start + offset;
            const open = index === expanded;
            const panelId = `${toolListId}-tool-${index}`;
            const permissionStatus: ToolPermissionDisplay = readingPermissions
              ? "loading"
              : permissions
                ? (permissions.get(tool.name) ?? "unregistered")
                : "unavailable";
            const { label, explanation, tone } =
              labels.permission(permissionStatus);
            return (
              <li key={index}>
                <h4>
                  <button
                    type="button"
                    className="native-prompt-tool"
                    aria-expanded={open}
                    aria-controls={panelId}
                    aria-labelledby={`${panelId}-name`}
                    aria-describedby={`${panelId}-permission ${panelId}-permission-description`}
                    onClick={() => setExpanded(open ? undefined : index)}
                  >
                    <span className="native-prompt-tool-label">
                      <code id={`${panelId}-name`} translate="no">
                        {tool.name}
                      </code>{" "}
                      <span
                        id={`${panelId}-permission`}
                        className="native-prompt-permission"
                        data-status={permissionStatus}
                        data-tone={tone}
                        title={explanation}
                      >
                        {label}
                      </span>
                      <span id={`${panelId}-permission-description`} hidden>
                        {explanation}
                      </span>
                    </span>
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
                        locale={locale}
                        current={current}
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
  locale,
  current,
}: {
  source: string;
  current: () => boolean;
  labels: PromptLabels;
  locale: ResolvedLocale;
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
          <JsonValueView
            locale={locale}
            isCurrent={current}
            source={{ kind: "text", text: source }}
            renderText={() => (
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
          />
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
