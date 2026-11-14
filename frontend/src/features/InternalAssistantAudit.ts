import { useEffect, useRef, useState } from "react";
import { useApp } from "../state";
import type { Transcript } from "../client/types";
import {
  timedTrajectoryBlocks,
  selectedModelRequests,
} from "./trajectoryTiming";
import type { FeatureBlock } from "./shared";
import type {
  AuditAttempt,
  AuditResponse,
  AuditTimeline,
  AuditStage,
  AuditScope,
} from "./RequestAudit";

interface AssistantRecords {
  session: string;
  blocks: FeatureBlock[];
  timeline: AuditTimeline[];
  stages: AuditStage[];
}

function mergeEvidence<T>(
  previous: T[],
  incoming: T[],
  key: (row: T) => string,
): T[] {
  const rows = new Map(previous.map((row) => [key(row), row]));
  for (const row of incoming) rows.set(key(row), row);
  return [...rows.values()];
}

/** Keep only evidence belonging to the server-proven selected lineage. A moving
 * checkpoint is a refresh trigger, not permission to erase already loaded rows.
 * Legacy servers without a lineage witness retain exact-cursor isolation.
 */
export function useInternalAssistantAudit(
  options: { transcript?: Transcript; auditScope?: AuditScope } = {},
): {
  blocks: FeatureBlock[];
  error: string;
  timeline: AuditTimeline[];
  stages: AuditStage[];
  loading: boolean;
} {
  const { state, dispatch } = useApp();
  const [error, setError] = useState("");
  const [records, setRecords] = useState<AssistantRecords | null>(null);
  const transcript = options.transcript ?? state.transcript;
  const parentId = options.auditScope?.parentId ?? state.sessionId;
  const childId = options.auditScope?.childId;
  const epochs = [
    ...new Set(
      [
        ...transcript.blocks.map(
          (block) => block.position?.epoch ?? block.preview?.epoch,
        ),
        transcript.historyView?.epoch,
      ].filter((epoch): epoch is number => typeof epoch === "number"),
    ),
  ].sort((a, b) => a - b);
  const epochKey = JSON.stringify(epochs);
  const lineage = transcript.historyView;
  const sessionKey = JSON.stringify([
    parentId,
    childId,
    lineage ? [lineage.lineage, lineage.epoch] : state.history,
  ]);
  const refreshKey = JSON.stringify([
    epochKey,
    state.history,
    state.auditRevision,
  ]);
  const desired = useRef({ refreshKey, epochs });
  desired.current = { refreshKey, epochs };
  const refresh = useRef<(() => void) | null>(null);

  useEffect(() => {
    let active = true;
    let running = false;
    let requested: string | null = null;
    setError("");
    const read = async () => {
      if (!active || running || requested === desired.current.refreshKey)
        return;
      const target = desired.current;
      requested = target.refreshKey;
      if (!parentId || !target.epochs.length) return;
      running = true;
      try {
        const responses = await Promise.all(
          target.epochs.map(
            (epoch) =>
              dispatch({
                type: "GetRequestAudit",
                sessionId: parentId,
                selector: {
                  epoch,
                  internal_assistants: true,
                  ...(childId ? { child_session_id: childId } : {}),
                },
              }) as Promise<AuditResponse | undefined>,
          ),
        );
        if (!active) return;
        const attempts = responses
          .flatMap((response) => response?.attempts ?? [])
          .filter((attempt) => Boolean(attempt.subagent));
        const groups = new Map<string, AuditAttempt[]>();
        for (const attempt of attempts) {
          const key = JSON.stringify([
            attempt.epoch,
            attempt.turn,
            attempt.round,
            attempt.subagent,
            attempt.history_head,
            attempt.call_id ?? attempt.request_hash,
          ]);
          const group = groups.get(key);
          if (group) group.push(attempt);
          else groups.set(key, [attempt]);
        }
        const blocks = [...groups.entries()].map(([identity, group]) => {
          const reversed = [...group].reverse();
          const attempt =
            reversed.find((row) => row.completion === "succeeded") ??
            reversed.find((row) => row.completion === "failed") ??
            reversed[0];
          const text = attempt.response_omitted
            ? "返回内容超出列表预算，请在请求信息中查看。"
            : attempt.response == null
              ? "尚无模型返回证据。"
              : typeof attempt.response === "string"
                ? attempt.response
                : JSON.stringify(attempt.response, null, 2);
          return {
            id: `internal-audit:${identity}`,
            messageId: attempt.request_hash,
            sessionId: parentId,
            role: "assistant",
            kind: "internal-assistant",
            stream: "done",
            startedMs: attempt.started_at_ms ?? undefined,
            endedMs: attempt.ended_at_ms ?? undefined,
            payload: {
              text,
              auditIdentity: identity,
              auditResponseOmitted: attempt.response_omitted === true,
              auditAssistant: attempt.subagent,
              auditScope: options.auditScope,
              auditEpoch: attempt.epoch,
              auditSequence: attempt.sequence,
              auditTurn: attempt.turn,
              auditStatus: attempt.completion,
              auditSelector: {
                epoch: attempt.epoch,
                subagent: attempt.subagent,
                call_id: attempt.call_id,
              },
            },
          } satisfies FeatureBlock;
        });
        const timeline = responses.flatMap(
          (response) => response?.timeline ?? [],
        );
        const stages = responses.flatMap((response) => response?.stages ?? []);
        setRecords((previous) => {
          const retained = previous?.session === sessionKey ? previous : null;
          const oldHelpers = new Map(
            (retained?.blocks ?? []).map((block) => [
              block.payload.auditIdentity,
              block,
            ]),
          );
          const updated = blocks.map((block) => {
            const old = oldHelpers.get(block.payload.auditIdentity);
            return old
              ? {
                  ...block,
                  id: old.id,
                  payload: {
                    ...block.payload,
                    ...(block.payload.auditResponseOmitted &&
                    !old.payload.auditResponseOmitted
                      ? { text: old.payload.text, auditResponseOmitted: false }
                      : {}),
                  },
                }
              : block;
          });
          return {
            session: sessionKey,
            blocks: mergeEvidence(
              retained?.blocks ?? [],
              updated,
              (row) => row.payload.auditIdentity,
            ),
            timeline: mergeEvidence(retained?.timeline ?? [], timeline, (row) =>
              JSON.stringify([
                row.epoch,
                row.request_hash,
                row.call_id,
                row.history_head,
              ]),
            ),
            stages: mergeEvidence(retained?.stages ?? [], stages, (row) =>
              JSON.stringify([
                row.kind,
                row.epoch,
                row.turn,
                row.round,
                row.tool_call_id,
                row.sequence,
                row.history_head,
                row.subagent,
              ]),
            ),
          };
        });
        setError("");
      } catch (failure: unknown) {
        if (active) {
          // A failed refresh cannot erase previously verified selected-lineage
          // evidence or remove the selected inspector out from under its reader.
          setRecords((previous) =>
            previous?.session === sessionKey
              ? previous
              : {
                  session: sessionKey,
                  blocks: [],
                  timeline: [],
                  stages: [],
                },
          );
          setError(`内部助手审计读取失败：${String(failure)}`);
        }
      } finally {
        running = false;
        // Coalesce a busy burst to one follow-up. Finishing an older read remains
        // useful on this same lineage; continuous appends must not starve it.
        if (active && requested !== desired.current.refreshKey) void read();
      }
    };
    refresh.current = () => {
      void read();
    };
    void read();
    return () => {
      active = false;
      refresh.current = null;
    };
  }, [sessionKey]);
  useEffect(() => {
    refresh.current?.();
  }, [sessionKey, refreshKey]);
  const current = records?.session === sessionKey ? records : null;
  return {
    loading: Boolean(parentId && epochs.length && !current),
    blocks: current?.blocks ?? [],
    error,
    timeline: current?.timeline ?? [],
    stages: current?.stages ?? [],
  };
}

/** Merge audit helpers into canonical order using real request-clock boundaries.
 * Missing message clocks are positioning anchors only, never fabricated timings.
 * Canonical relative order and unknown duration labels remain unchanged.
 */
export function orderTrajectoryBlocks(
  conversation: FeatureBlock[],
  helpers: FeatureBlock[],
  timeline: AuditTimeline[],
  stages: AuditStage[] = [],
): FeatureBlock[] {
  const key = (epoch: number, turn: number, round: number) =>
    `${epoch}:${turn}:${round}`;
  const chosen = selectedModelRequests(timeline);
  conversation = timedTrajectoryBlocks(conversation, timeline, stages);
  const anchors = conversation.map((block) => {
    const pos = block.position ?? block.preview;
    const request =
      pos?.epoch != null && pos.turn != null && pos.round != null
        ? chosen.get(
            key(pos.epoch, pos.turn, block.role === "user" ? 1 : pos.round),
          )
        : undefined;
    return {
      block,
      epoch: pos?.epoch,
      turn: pos?.turn,
      time:
        block.role === "assistant" &&
        !block.tool &&
        !["model-request", "model-generation"].includes(block.kind)
          ? (request?.ended_at_ms ?? block.startedMs ?? request?.started_at_ms)
          : (block.startedMs ??
            (block.role === "user"
              ? request?.started_at_ms
              : (request?.ended_at_ms ?? request?.started_at_ms))),
      sequence: request?.sequence,
    };
  });
  const buckets = new Map<number, FeatureBlock[]>();
  const sorted = [...helpers].sort(
    (a, b) =>
      (a.startedMs != null && b.startedMs != null
        ? a.startedMs - b.startedMs
        : 0) ||
      a.payload.auditEpoch - b.payload.auditEpoch ||
      (a.payload.auditSequence ?? 0) - (b.payload.auditSequence ?? 0),
  );
  for (const helper of sorted) {
    const epoch = helper.payload.auditEpoch;
    const time = helper.startedMs;
    const sequence = helper.payload.auditSequence;
    let index = anchors.findIndex(
      (anchor) =>
        anchor.epoch != null &&
        (anchor.epoch > epoch ||
          (anchor.epoch === epoch &&
            (time != null && anchor.time != null
              ? anchor.time > time
              : sequence != null &&
                anchor.sequence != null &&
                anchor.sequence > sequence))),
    );
    if (index < 0) index = conversation.length;
    // A scoped helper cannot precede the user who admitted that turn.
    if (helper.payload.auditTurn != null) {
      const user = anchors.findIndex(
        (a) =>
          a.epoch === epoch &&
          a.turn === helper.payload.auditTurn &&
          a.block.role === "user",
      );
      if (user >= 0) index = Math.max(index, user + 1);
    }
    buckets.set(index, [...(buckets.get(index) ?? []), helper]);
  }
  const result: FeatureBlock[] = [];
  anchors.forEach((anchor, index) => {
    result.push(...(buckets.get(index) ?? []));
    result.push(
      anchor.time == null
        ? anchor.block
        : {
            ...anchor.block,
            payload: { ...anchor.block.payload, auditTimelineAt: anchor.time },
          },
    );
  });
  result.push(...(buckets.get(conversation.length) ?? []));
  return result;
}
