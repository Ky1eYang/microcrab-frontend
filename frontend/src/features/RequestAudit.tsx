import { t } from "../i18n";
import { referenceLabels } from "./referenceLabels";
import { toolReferenceProjection } from "./toolReferences";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { presentContent } from "./content-inspection/format";
import { useApp, useAppStore } from "../state";
import { readFrozenPrompt } from "./prompt-viewer/frozen-prompt";
import { Payload } from "./Payload";
import type { Block, HistoryPosition } from "../client/types";
import { CommandError } from "../client/api";

export function isAncestryBudgetError(error: unknown): boolean {
  if (!(error instanceof CommandError)) return false;
  if (error.code !== "audit_unavailable") return false;
  const details = error.details as { category?: unknown } | undefined;
  return details?.category === "budget";
}

export function auditSelector(
  block: Pick<Block, "position" | "preview" | "callId" | "messageId" | "role"> &
    Partial<Block>,
  schema: boolean,
) {
  const exactSelector = schema
    ? (block.payload?.auditSchemaSelector ??
      block.auditSelector ??
      block.payload?.auditSelector)
    : (block.auditSelector ?? block.payload?.auditSelector);
  if (exactSelector) return exactSelector;
  const position =
    (block.position as HistoryPosition | undefined) ??
    (block.preview?.epoch !== undefined &&
    block.preview.turn !== undefined &&
    block.preview.round !== undefined
      ? block.preview
      : null);
  if (!position) return null;
  return {
    epoch: position.epoch,
    turn: position.turn,
    ...(block.role === "user"
      ? { round: 1 }
      : schema
        ? { round: position.round }
        : block.callId
          ? { tool_call_id: block.callId }
          : { round: position.round }),
  };
}
export function historicalToolSchema(tools: unknown, name: string): unknown {
  if (!Array.isArray(tools)) return undefined;
  for (const raw of tools) {
    if (!raw || typeof raw !== "object") continue;
    const declarations = raw.function_declarations ?? raw.functionDeclarations;
    const candidates = Array.isArray(declarations)
      ? declarations
      : [raw.type === "function" && raw.function ? raw.function : raw];
    for (const tool of candidates) {
      if (!tool || typeof tool !== "object") continue;
      if (tool.name === name)
        return (
          tool.parametersJsonSchema ??
          tool.parameters_json_schema ??
          tool.parameters ??
          tool.input_schema ??
          tool.inputSchema
        );
    }
  }
  return undefined;
}
export interface AuditAttempt {
  request_hash: string;
  sequence?: number;
  call_id?: string;
  parent_request?: string;
  subagent?: string;
  base_request?: string;
  history_head?: string;
  status: string;
  epoch: number;
  turn?: number | null;
  round?: number | null;
  source?: string;
  baseline?: unknown;
  delta?: unknown;
  tools?: unknown;
  frozen_tools?: unknown;
  protected_tool_call_ids?: string[];
  outcome?: unknown;
  /** Persisted normalized response, not the original provider body. */
  response?: unknown;
  response_omitted?: boolean;
  /** Original retained UTF-8 response body; never derived from response or outcome. */
  response_raw?: string | null;
  response_complete?: boolean | null;
  response_status?: number | null;
  response_content_type?: string | null;
  completion?: "succeeded" | "failed" | "cancelled" | "pending";
  cancel_reason?: "cancelled";
  usage?: Record<string, unknown> | null;
  baseline_usage?: Record<string, unknown> | null;
  token_delta?: Record<string, number | null> | null;
  /** Exact UTF-8 text transmitted to the provider, when retained. */
  sent_request?: string | null;
  /** Normalized document used for the request diff; not wire evidence. */
  request_document?: string | null;
  started_at_ms?: number | null;
  ended_at_ms?: number | null;
}
export interface AuditScope {
  parentId: string;
  childId: string;
}
export interface AuditStage {
  kind: "input" | "tool";
  sequence: number;
  epoch: number;
  turn?: number | null;
  round?: number | null;
  tool_call_id?: string | null;
  name?: string | null;
  started_at_ms?: number | null;
  ended_at_ms?: number | null;
  completion: "succeeded" | "failed" | "cancelled" | "pending";
  history_head?: string | null;
  subagent?: string | null;
}
export interface AuditTimeline {
  branch_selected?: boolean;
  history_head?: string | null;
  request_hash: string;
  sequence: number;
  call_id: string;
  epoch: number;
  turn?: number | null;
  round?: number | null;
  started_at_ms?: number | null;
  ended_at_ms?: number | null;
  completion: "succeeded" | "failed" | "cancelled" | "pending";
  cancel_reason?: "cancelled";
}
export interface AuditResponse {
  status: string;
  committed_sequence: number;
  incomplete_tail: boolean;
  selected_request_hash?: string | null;
  attempts: AuditAttempt[];
  authored_tool_arguments?: unknown;
  legacy_unlinked_attempt?: {
    call_id: string;
    epoch: number;
    turn?: number;
    round?: number;
    completion?: string;
    started_at_ms?: number;
    ended_at_ms?: number;
  };
  timeline?: AuditTimeline[];
  stages?: AuditStage[];
}
/** Select one logical position; subsequent tool rounds never become user retries. */
export function selectedAttempt(
  response: AuditResponse | null,
): AuditAttempt | undefined {
  if (!response) return undefined;
  const explicit = response.attempts.find(
    (a) => a.request_hash === response.selected_request_hash,
  );
  if (explicit) return explicit;
  const first = response.attempts[0];
  if (!first) return undefined;
  const same = response.attempts.filter(
    (a) =>
      a.epoch === first.epoch &&
      a.turn === first.turn &&
      a.round === first.round &&
      a.subagent === first.subagent,
  );
  const reversed = [...same].reverse();
  return (
    reversed.find((a) => a.completion === "succeeded") ??
    reversed.find((a) => a.completion === "failed") ??
    reversed[0]
  );
}
const statusText: Record<string, string> = {
  missing: "未找到历史请求证据",
  pending: "请求审计尚未持久提交",
  omitted: "此请求的发送证据已省略",
  unchanged: "发送请求与基线一致，无变动",
  available: "发送请求证据可用",
};
function displayDelta(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.replace(/^--- [^\n]*\n\+\+\+ [^\n]*\n/, "");
}
const tokenFields = [
  ["input_tokens", "输入"],
  ["cache_read_tokens", "缓存读取"],
  ["cache_write_tokens", "缓存写入"],
  ["output_tokens", "输出"],
  ["total_tokens", "总计"],
] as const;
function tokenChange(attempt: AuditAttempt | undefined, field: string) {
  // Provider-reported per-request usage is authoritative; never estimate from text.
  if (!attempt?.usage) return "-";
  const value = attempt.token_delta?.[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value > 0
      ? `+${value.toLocaleString()}`
      : value.toLocaleString()
    : "-";
}
function AuditBodyDisclosure({
  label,
  testid,
  children,
}: {
  label: string;
  testid: string;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <details
      data-testid={testid}
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary>{label}</summary>
      {opened && children}
    </details>
  );
}

function SentRequestEvidence({ attempt }: { attempt: AuditAttempt }) {
  const wire = attempt.sent_request;
  const document = attempt.request_document;
  // Check the shared formatter's display budget before offering Pretty/Raw.
  // Payload always receives the original string; its raw copy uses that source.
  const pretty = useMemo(
    () => typeof wire === "string" && presentContent(wire, "json").kind === "json",
    [wire],
  );
  if (typeof wire !== "string") {
    return (
      <>
        <p role="status">
          {t(
            attempt.frozen_tools
              ? "requestAudit.sentProtected"
              : "requestAudit.sentUnavailable",
          )}
        </p>
        {typeof document === "string" && (
          <Payload
            variant="trajectory"
            label={t("requestAudit.normalizedRequest")}
            value={document}
            empty={t("requestAudit.emptyBody")}
          />
        )}
      </>
    );
  }
  return (
    <>
      <p>{t(pretty ? "requestAudit.prettyRequest" : "requestAudit.rawRequest")}</p>
      <Payload
        variant="trajectory"
        testid="audit-sent-body"
        dialogTitle={t("requestAudit.sentRequest")}
        value={wire}
        defaultFormat={pretty ? "json" : "raw"}
        projection={pretty ? { display: wire } : undefined}
        empty={t("requestAudit.emptyBody")}
      />
    </>
  );
}

function OriginalResponseEvidence({ attempt }: { attempt: AuditAttempt }) {
  const raw = attempt.response_raw;
  const hasText = typeof raw === "string";
  const isSse =
    attempt.response_content_type?.split(";", 1)[0].trim().toLowerCase() ===
    "text/event-stream";
  return (
    <>
      {hasText && (
        <p>
          {t(isSse ? "requestAudit.rawSse" : "requestAudit.rawResponse")}
          {attempt.response_status != null && ` · HTTP ${attempt.response_status}`}
        </p>
      )}
      {!hasText ? (
        <p role="status">
          {t(
            attempt.response_complete === false
              ? "requestAudit.responsePartialUnavailable"
              : "requestAudit.responseUnavailable",
          )}
        </p>
      ) : attempt.response_complete === false ? (
        <p role="status">{t("requestAudit.responsePartial")}</p>
      ) : null}
      {hasText && attempt.response_complete == null && (
        <p role="status">{t("requestAudit.responseCompletenessUnknown")}</p>
      )}
      {hasText && (
        <Payload
          variant="trajectory"
          testid="audit-response-body"
          dialogTitle={t("requestAudit.originalResponse")}
          value={raw}
          defaultFormat="raw"
          empty={t("requestAudit.emptyBody")}
        />
      )}
    </>
  );
}

function NormalizedResponseEvidence({ attempt }: { attempt: AuditAttempt }) {
  // Older servers could return raw text in `response` after a failed parse.
  // Only a normalized response object is evidence for this view.
  const response =
    attempt.response !== null &&
    typeof attempt.response === "object" &&
    !Array.isArray(attempt.response)
      ? attempt.response
      : undefined;
  if (response !== undefined)
    return <Payload variant="trajectory" value={response} />;
  return (
    <>
      <p role="status">
        {t(
          attempt.response_omitted
            ? "requestAudit.normalizedOmitted"
            : "requestAudit.normalizedUnavailable",
        )}
      </p>
      {attempt.outcome != null && (
        <Payload
          variant="trajectory"
          label={t("requestAudit.outcome")}
          value={attempt.outcome}
        />
      )}
    </>
  );
}

export function RequestAudit({
  block,
  schema = false,
  metadata = false,
  authoredArguments = false,
  presentationScope,
}: {
  block: Block;
  schema?: boolean;
  metadata?: boolean;
  authoredArguments?: boolean;
  presentationScope?: string;
}) {
  const { state, dispatch } = useApp();
  const api = useAppStore().api;
  const [legacySchema, setLegacySchema] = useState<{
    key: string;
    schema: unknown;
  } | null>(null);
  const [record, setRecord] = useState<{
    scope: string;
    response: AuditResponse;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [metadataSchema, setMetadataSchema] = useState(false);
  const schemaScope =
    schema || (metadata && Boolean(block.tool) && metadataSchema);
  const scope = block.payload?.auditScope as AuditScope | undefined;
  const baseSelector = authoredArguments
    ? block.position &&
      block.callId &&
      block.position.round != null &&
      block.position.turn != null
      ? {
          epoch: block.position.epoch,
          turn: block.position.turn,
          round: block.position.round,
          tool_call_id: block.callId,
        }
      : null
    : auditSelector(block, schemaScope);
  const selector = baseSelector && {
    ...baseSelector,
    ...(scope ? { child_session_id: scope.childId } : {}),
  };
  const producerSelector = block.payload?.auditSchemaSelector;
  const [legacyAttempt, setLegacyAttempt] = useState<{
    key: string;
    value: AuditResponse["legacy_unlinked_attempt"];
  } | null>(null);
  const history = state.transcript.historyView;
  const key = JSON.stringify([
    selector,
    authoredArguments,
    state.authSession?.principal?.owner,
    history?.lineage,
    block.sessionId,
    scope?.parentId,
    presentationScope ?? state.history,
  ]);
  const currentScope = useRef(key);
  currentScope.current = key;
  const response = record?.scope === key ? record.response : null;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isCurrent = () => active && currentScope.current === key;
    setError("");
    if (!selector) return;
    const delays = [600, 1200, 2400, 4000, 6000];
    const attemptLoad = (retryIndex: number) => {
      if (!isCurrent()) return;
      setLoading(true);
      void dispatch({
        type: "GetRequestAudit",
        sessionId: scope?.parentId ?? block.sessionId,
        selector,
      })
        .then((result: AuditResponse | undefined) => {
          if (!isCurrent()) return;
          if (!result || !Array.isArray(result.attempts)) {
            setError("无法读取请求审计，请重试");
            setLoading(false);
            return;
          }
          setError("");
          setRecord({ scope: key, response: result });
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          if (isAncestryBudgetError(err) && retryIndex < delays.length) {
            setError("正在后台验证历史检查点链，稍后自动重试…");
            timer = setTimeout(() => attemptLoad(retryIndex + 1), delays[retryIndex]);
            return;
          }
          setError(String(err));
          setLoading(false);
        });
    };
    attemptLoad(0);
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [
    key,
    block.sessionId,
    scope?.parentId,
    state.auditRevision,
    state.history,
  ]);
  const attempt = selectedAttempt(response);
  const toolName = block.tool?.name ?? "";
  const epoch = block.position?.epoch;
  const lineage = history?.lineage;
  const frozenFromAudit =
    block.callId && attempt?.protected_tool_call_ids?.includes(block.callId)
      ? historicalToolSchema(attempt.frozen_tools, toolName)
      : undefined;
  const wireSchema = historicalToolSchema(attempt?.tools, toolName);
  useEffect(() => {
    // Legacy protected attempts retained no exact request link. The owner-checked
    // prompt endpoint can independently prove the selected epoch's catalog.
    if (
      !schema ||
      response?.status !== "missing" ||
      scope ||
      !toolName ||
      !lineage ||
      epoch !== history?.epoch ||
      state.sessionId !== block.sessionId ||
      !state.authSession?.authenticated
    )
      return;
    const abort = new AbortController();
    void readFrozenPrompt(
      api,
      { sessionId: block.sessionId, lineage, epoch },
      abort.signal,
    )
      .then((result) => {
        if (
          abort.signal.aborted ||
          currentScope.current !== key ||
          result.status !== "available"
        )
          return;
        const tool = result.tools.find((value) => value.name === toolName);
        if (tool) setLegacySchema({ key, schema: JSON.parse(tool.parameters) });
      })
      .catch(() => {});
    return () => abort.abort();
  }, [
    api,
    block.sessionId,
    epoch,
    history?.epoch,
    key,
    lineage,
    response?.status,
    schema,
    scope,
    state.authSession?.authenticated,
    state.sessionId,
    toolName,
  ]);
  useEffect(() => {
    if (
      !metadata ||
      response?.status !== "missing" ||
      response.legacy_unlinked_attempt ||
      !producerSelector?.call_id ||
      schemaScope
    )
      return;
    let active = true;
    void dispatch({
      type: "GetRequestAudit",
      sessionId: scope?.parentId ?? block.sessionId,
      selector: {
        ...producerSelector,
        ...(scope ? { child_session_id: scope.childId } : {}),
      },
    })
      .then((result: AuditResponse | undefined) => {
        const value = result?.legacy_unlinked_attempt;
        if (
          active &&
          currentScope.current === key &&
          value &&
          value.call_id === producerSelector.call_id
        )
          setLegacyAttempt({ key, value });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [
    block.sessionId,
    dispatch,
    key,
    metadata,
    producerSelector?.call_id,
    producerSelector?.epoch,
    response,
    schemaScope,
    scope,
  ]);
  const legacy = legacySchema?.key === key ? legacySchema.schema : undefined;
  const legacyRequest =
    response?.legacy_unlinked_attempt ??
    (legacyAttempt?.key === key ? legacyAttempt.value : undefined);
  if (!selector)
    return <p role="status">此历史消息没有持久位置映射，无法可靠定位请求。</p>;
  if (authoredArguments) {
    const authored = response?.authored_tool_arguments;
    const fallback = block.tool?.input;
    const historicalProjection = toolReferenceProjection(fallback, block.tool?.presentation, "arguments");
    return (
      <>
        {loading && !response && <p role="status">正在读取工具调用参数…</p>}
        {error && <p role="alert">{error}</p>}
        {authored === undefined && historicalProjection?.synthetic && (
          <p role="status">这条历史只保留了内部来源摘要，原始参数未留存。</p>
        )}
        <Payload
          variant="trajectory"
          value={authored ?? (historicalProjection?.synthetic ? undefined : fallback)}
          fillBody
          empty="未记录原始参数"
        />
      </>
    );
  }
  const value = schema
    ? (wireSchema ?? frozenFromAudit ?? legacy)
    : displayDelta(attempt?.delta);
  const deltaView = !metadata && !schema;
  const auditLabel = referenceLabels(
    "digest",
    (response?.attempts ?? []).flatMap((a) => [a.request_hash, a.parent_request, a.base_request, a.history_head]),
  );
  const evidence = (
    <>
      {loading && !response && <p role="status">正在读取持久请求证据…</p>}
      {error && <p role="alert">{error}</p>}
      {response && (
        <>
          {schema && wireSchema === undefined && value !== undefined ? (
            <p role="status">来源：会话冻结的工具定义；不是提供商请求正文。</p>
          ) : legacyRequest && metadata ? (
            <p role="status">
              仅保留旧版调用元数据；未记录历史请求关联或正文。
            </p>
          ) : (
            response.status !== "available" && (
              <p role="status">
                {statusText[response.status] ?? response.status}
              </p>
            )
          )}
          {response.incomplete_tail && <p>审计尾部尚未完整提交。</p>}
          {(attempt || legacy !== undefined) && !metadata && (
            <>
              <Payload
                key={key}
                variant="trajectory"
                fillBody
                value={schema ? value : attempt?.delta}
                projection={!schema && typeof value === "string" && value !== attempt?.delta ? { display: value } : undefined}
                empty={
                  schema
                    ? "此历史请求未记录该工具 Schema"
                    : (statusText[attempt?.status ?? ""] ?? "无请求增量")
                }
                testid={
                  schema ? "historical-tool-schema" : "historical-request-diff"
                }
              />
            </>
          )}
        </>
      )}
    </>
  );
  return (
    <div
      className={
        deltaView
          ? "request-audit"
          : schema
            ? "request-audit request-audit-schema"
            : "trajectory-scroll-area"
      }
      data-testid={
        metadata
          ? "request-audit-metadata"
          : schema
            ? "request-audit-schema"
            : "request-audit-diff"
      }
    >
      {deltaView ? (
        <>
          <section
            className="request-audit-tokens"
            aria-label="Token 增量"
            data-testid="request-token-delta"
          >
            <h3>Token 增量</h3>
            <dl>
              {tokenFields.map(([field, label]) => (
                <div key={field}>
                  <dt>{label}</dt>
                  <dd data-token={field}>{tokenChange(attempt, field)}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="request-audit-diff" aria-label="请求内容增量">
            <h3>请求内容增量</h3>
            {evidence}
          </section>
        </>
      ) : (
        <>
          {metadata && block.tool && (
            <label>
              请求范围{" "}
              <select
                aria-label="请求范围"
                value={metadataSchema ? "schema" : "delta"}
                onChange={(event) =>
                  setMetadataSchema(event.target.value === "schema")
                }
              >
                <option value="delta">包含工具结果的请求</option>
                <option value="schema">产生工具调用的请求</option>
              </select>
            </label>
          )}
          {schema ? (
            <section className="request-audit-diff">{evidence}</section>
          ) : (
            evidence
          )}
          {metadata && !attempt && legacyRequest && (
            <div className="request-audit-metadata-body">
              <dl>
                <dt>调用 ID</dt>
                <dd>{legacyRequest.call_id}</dd>
                <dt>位置</dt>
                <dd>
                  {legacyRequest.epoch}/{legacyRequest.turn ?? "-"}/
                  {legacyRequest.round ?? "-"}
                </dd>
                <dt>请求结果</dt>
                <dd>
                  {legacyRequest.completion === "succeeded"
                    ? "成功"
                    : legacyRequest.completion === "failed"
                      ? "失败"
                      : "未确认"}
                </dd>
              </dl>
            </div>
          )}
          {metadata && attempt && (
            <div key={key} className="request-audit-metadata-body">
              <dl>
                <dt>请求 ID</dt>
                <dd>{auditLabel(attempt.request_hash)}</dd>
                <dt>调用 ID</dt>
                <dd>{attempt.call_id ?? "未记录"}</dd>
                <dt>上一次请求 ID</dt>
                <dd>{attempt.parent_request ? auditLabel(attempt.parent_request) : "无"}</dd>
                <dt>基线 ID</dt>
                <dd>{attempt.base_request ? auditLabel(attempt.base_request) : "无兼容基线"}</dd>
                <dt>历史</dt>
                <dd>{attempt.history_head ? auditLabel(attempt.history_head) : "未记录"}</dd>
                <dt>位置</dt>
                <dd>
                  {attempt.epoch}/{attempt.turn ?? "-"}/{attempt.round ?? "-"}
                </dd>
                <dt>状态</dt>
                <dd>{statusText[attempt.status] ?? attempt.status}</dd>
                <dt>请求结果</dt>
                <dd>
                  {attempt.completion === "succeeded"
                    ? "成功"
                    : attempt.completion === "failed"
                      ? "失败"
                      : "尚无结果"}
                </dd>
                <dt>来源</dt>
                <dd>{attempt.source ?? "未记录"}</dd>
                <dt>助手</dt>
                <dd>{attempt.subagent ?? "主会话"}</dd>
                <dt>提交序号</dt>
                <dd>{attempt.sequence ?? "未记录"}</dd>
              </dl>
              <details>
                <summary>{t("references.exactEvidence")} · {t("references.auditIdentities")}</summary>
                <Payload variant="trajectory" defaultFormat="raw" value={{
                  request_hash: attempt.request_hash,
                  parent_request: attempt.parent_request,
                  base_request: attempt.base_request,
                  history_head: attempt.history_head,
                }} />
              </details>
              <AuditBodyDisclosure
                label={t("requestAudit.sentRequest")}
                testid="audit-sent"
              >
                <SentRequestEvidence attempt={attempt} />
              </AuditBodyDisclosure>
              <AuditBodyDisclosure
                label={t("requestAudit.originalResponse")}
                testid="audit-response-original"
              >
                <OriginalResponseEvidence attempt={attempt} />
              </AuditBodyDisclosure>
              <AuditBodyDisclosure
                label={t("requestAudit.normalizedResponse")}
                testid="audit-response-normalized"
              >
                <NormalizedResponseEvidence attempt={attempt} />
              </AuditBodyDisclosure>
            </div>
          )}
        </>
      )}
    </div>
  );
}
