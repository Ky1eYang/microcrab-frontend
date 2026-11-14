import type { FeatureBlock } from "./shared";
import type { AuditStage, AuditTimeline } from "./RequestAudit";

const modelStopReason = (block: FeatureBlock, model: AuditTimeline) =>
  (block.preview?.callId ?? block.callId) === model.call_id &&
  block.payload.stopReason
    ? block.payload.stopReason
    : model.cancel_reason
      ? { reason: model.cancel_reason }
      : undefined;

const positionKey = (epoch: number, turn: number, round: number) =>
  `${epoch}:${turn}:${round}`;

export function selectedModelRequests(timeline: AuditTimeline[]) {
  const groups = new Map<string, AuditTimeline[]>();
  for (const row of timeline) {
    if (row.turn == null || row.round == null) continue;
    const key = positionKey(row.epoch, row.turn, row.round);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const selected = new Map<string, AuditTimeline>();
  for (const [key, group] of groups) {
    const witnessed = group.filter((row) => row.branch_selected === true);
    // A verified server ancestry fence wins. Older servers may return an epoch
    // containing rollback branches; neither timestamps nor success pick a branch.
    if (
      !witnessed.length &&
      new Set(group.map((row) => row.history_head ?? null)).size > 1
    )
      continue;
    const reversed = [...(witnessed.length ? witnessed : group)].sort(
      (a, b) => b.sequence - a.sequence,
    );
    selected.set(
      key,
      reversed.find((row) => row.completion === "succeeded") ??
        reversed.find((row) => row.completion === "failed") ??
        reversed[0],
    );
  }
  return selected;
}

/** Apply only observed ranges. Provider boundaries never stand in for tool time. */
export function timedTrajectoryBlocks(
  blocks: FeatureBlock[],
  timeline: AuditTimeline[],
  stages: AuditStage[],
): FeatureBlock[] {
  const models = selectedModelRequests(timeline);
  const inputs = new Map<string, AuditStage>();
  const tools = new Map<string, AuditStage>();
  for (const stage of stages) {
    if (stage.turn == null || stage.subagent != null) continue;
    const model =
      stage.round == null
        ? undefined
        : models.get(positionKey(stage.epoch, stage.turn, stage.round));
    if (
      model?.history_head != null &&
      stage.history_head != null &&
      model.history_head !== stage.history_head
    )
      continue;
    if (stage.kind === "input")
      inputs.set(`${stage.epoch}:${stage.turn}`, stage);
    else if (stage.tool_call_id != null && stage.round != null)
      tools.set(
        `${positionKey(stage.epoch, stage.turn, stage.round)}:${stage.tool_call_id}`,
        stage,
      );
  }
  const seenModels = new Set<string>();
  const seenInputs = new Set<string>();
  const result: FeatureBlock[] = [];
  for (const [index, original] of blocks.entries()) {
    const position = original.position ?? original.preview;
    if (
      position?.epoch == null ||
      position.turn == null ||
      position.round == null
    ) {
      result.push(original);
      continue;
    }
    const key = positionKey(position.epoch, position.turn, position.round);
    const model = models.get(key);
    const modelIdentity =
      model &&
      JSON.stringify([
        model.epoch,
        model.turn,
        model.round,
        model.call_id,
        model.history_head,
        model.request_hash,
      ]);
    const callId = original.tool?.callId ?? original.payload.tool_call_id;
    const stage =
      original.role === "user"
        ? inputs.get(`${position.epoch}:${position.turn}`)
        : original.tool && callId
          ? tools.get(`${key}:${callId}`)
          : undefined;
    const next = blocks[index + 1];
    const nextPosition = next?.position ?? next?.preview;
    const nextInputInRound =
      next?.role === "user" &&
      nextPosition?.epoch === position.epoch &&
      nextPosition?.turn === position.turn &&
      nextPosition?.round === position.round;
    let deferredInput: FeatureBlock | undefined;
    if (
      model &&
      !seenInputs.has(key) &&
      !(original.role === "user" && nextInputInRound)
    ) {
      // User inputs precede their consuming request. A request-start clock is
      // evidence for model input, never an earlier position for the user itself.
      const input: FeatureBlock = {
        id: `model-audit:${modelIdentity}`,
        messageId: model.request_hash,
        sessionId: original.sessionId,
        role: "assistant",
        kind: "model-request",
        stream: "complete",
        position: {
          epoch: model.epoch,
          turn: model.turn!,
          round: model.round!,
        },
        startedMs: model.started_at_ms,
        payload: {
          text: "",
          auditStatus: model.completion,
          stopReason: modelStopReason(original, model),
          auditTimingKey: `model-input:${modelIdentity}`,
          auditSequence: model.sequence,
          auditScope: original.payload.auditScope,
          auditSelector: { epoch: model.epoch, call_id: model.call_id },
        },
      };
      if (original.role === "user") deferredInput = input;
      else result.push(input);
      seenInputs.add(key);
    }
    // Tool-only provider responses otherwise have no model lane entry at all.
    if (
      original.tool &&
      model &&
      !seenModels.has(key) &&
      !blocks.some(
        (b) =>
          !b.tool &&
          b.role === "assistant" &&
          b.position?.epoch === position.epoch &&
          b.position?.turn === position.turn &&
          b.position?.round === position.round,
      )
    ) {
      result.push({
        id: `model-generation:${modelIdentity}`,
        messageId: model.request_hash,
        sessionId: original.sessionId,
        role: "assistant",
        kind: "model-generation",
        stream: "complete",
        position: {
          epoch: model.epoch,
          turn: model.turn!,
          round: model.round!,
        },
        startedMs: model.started_at_ms,
        endedMs: model.ended_at_ms,
        payload: {
          text: "",
          auditStatus: model.completion,
          stopReason: modelStopReason(original, model),
          auditTimingKey: `model:${modelIdentity}`,
          auditSequence: model.sequence,
          auditScope: original.payload.auditScope,
          auditSelector: { epoch: model.epoch, call_id: model.call_id },
        },
      });
      seenModels.add(key);
    }
    const inputModel =
      original.role === "user"
        ? models.get(positionKey(position.epoch, position.turn, 1))
        : model;
    const requestSelector = inputModel && {
      epoch: inputModel.epoch,
      call_id: inputModel.call_id,
    };
    const range =
      stage ??
      (!original.tool && original.role === "assistant" ? model : undefined);
    result.push(
      range || requestSelector
        ? {
            ...original,
            startedMs: range?.started_at_ms ?? original.startedMs,
            endedMs: range?.ended_at_ms ?? original.endedMs,
            payload: {
              ...original.payload,
              ...(requestSelector
                ? original.tool
                  ? { auditSchemaSelector: requestSelector }
                  : { auditSelector: requestSelector }
                : {}),
              ...(!original.tool && original.role === "assistant" && model
                ? {
                    auditStatus: model.completion,
                    stopReason: modelStopReason(original, model),
                  }
                : {}),
              ...(range
                ? {
                    auditTimingKey: stage
                      ? `${stage.kind}:${stage.epoch}:${stage.turn}:${stage.round}:${stage.tool_call_id ?? stage.sequence}`
                      : `model:${modelIdentity}`,
                  }
                : {}),
            },
          }
        : original,
    );
    if (deferredInput) result.push(deferredInput);
  }
  return result;
}

/** Union actual intervals so parallel work and call/result rows count once. */
export function measuredDuration(blocks: FeatureBlock[]): number | null {
  const ranges = blocks
    .flatMap((block) => {
      const start = block.startedMs ?? block.tool?.startedMs;
      const end = block.endedMs ?? block.tool?.endedMs;
      return typeof start === "number" &&
        Number.isFinite(start) &&
        typeof end === "number" &&
        Number.isFinite(end) &&
        end >= start
        ? [[start, end] as const]
        : [];
    })
    .sort((a, b) => a[0] - b[0]);
  if (!ranges.length) return null;
  let total = 0;
  let start = ranges[0][0],
    end = ranges[0][1];
  for (const next of ranges.slice(1)) {
    if (next[0] <= end) end = Math.max(end, next[1]);
    else {
      total += end - start;
      [start, end] = next;
    }
  }
  return total + end - start;
}
