import { useEffect, useRef, useState } from "react";
import { useApp } from "../state";
import { Payload } from "./Payload";
import type { Block, HistoryPosition } from "../client/types";

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
  outcome?: unknown;
  response?: unknown;
  response_omitted?: boolean;
  completion?: "succeeded" | "failed" | "cancelled" | "pending";
  cancel_reason?: "cancelled";
  usage?: Record<string, unknown> | null;
  baseline_usage?: Record<string, unknown> | null;
  token_delta?: Record<string, number | null> | null;
  sent_request?: unknown;
  request_document?: unknown;
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
export function RequestAudit({
  block,
  schema = false,
  metadata = false,
  presentationScope,
}: {
  block: Block;
  schema?: boolean;
  metadata?: boolean;
  presentationScope?: string;
}) {
  const { state, dispatch } = useApp();
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
  const baseSelector = auditSelector(block, schemaScope);
  const selector = baseSelector && {
    ...baseSelector,
    ...(scope ? { child_session_id: scope.childId } : {}),
  };
  const key = JSON.stringify([
    selector,
    block.sessionId,
    scope?.parentId,
    presentationScope ?? state.history,
  ]);
  const currentScope = useRef(key);
  currentScope.current = key;
  const response = record?.scope === key ? record.response : null;
  useEffect(() => {
    let active = true;
    const isCurrent = () => active && currentScope.current === key;
    setError("");
    if (!selector) return;
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
          return;
        }
        setRecord({ scope: key, response: result });
      })
      .catch((error: unknown) => {
        if (isCurrent()) setError(String(error));
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [key, block.sessionId, scope?.parentId, state.auditRevision, state.history]);
  if (!selector)
    return <p role="status">此历史消息没有持久位置映射，无法可靠定位请求。</p>;
  const attempt = selectedAttempt(response);
  const value = schema
    ? historicalToolSchema(attempt?.tools, block.tool?.name)
    : displayDelta(attempt?.delta);
  const deltaView = !metadata && !schema;
  const evidence = (
    <>
      {loading && !response && <p role="status">正在读取持久请求证据…</p>}
      {error && <p role="alert">{error}</p>}
      {response && (
        <>
          {response.status !== "available" && (
            <p role="status">
              {statusText[response.status] ?? response.status}
            </p>
          )}
          {response.incomplete_tail && <p>审计尾部尚未完整提交。</p>}
          {attempt && !metadata && (
            <>
              <Payload
                key={key}
                variant="trajectory"
                fillBody
                value={value}
                empty={
                  schema
                    ? "此历史请求未记录该工具 Schema"
                    : (statusText[attempt.status] ?? "无请求增量")
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
          {metadata && attempt && (
            <div key={key} className="request-audit-metadata-body">
              <dl>
                <dt>请求 ID</dt>
                <dd>{attempt.request_hash}</dd>
                <dt>调用 ID</dt>
                <dd>{attempt.call_id ?? "未记录"}</dd>
                <dt>上一次请求 ID</dt>
                <dd>{attempt.parent_request ?? "无"}</dd>
                <dt>基线 ID</dt>
                <dd>{attempt.base_request ?? "无兼容基线"}</dd>
                <dt>历史</dt>
                <dd>{attempt.history_head ?? "未记录"}</dd>
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
                <summary>实际发送请求</summary>
                <Payload
                  variant="trajectory"
                  value={attempt.sent_request ?? attempt.request_document}
                  empty="实际发送证据不可用"
                />
              </details>
              <details>
                <summary>模型返回</summary>
                <Payload
                  variant="trajectory"
                  value={attempt.response ?? attempt.outcome}
                  empty="尚无模型返回证据"
                />
              </details>
            </div>
          )}
        </>
      )}
    </div>
  );
}
