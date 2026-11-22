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

function selectedToolStage(
  stages: AuditStage[] | undefined,
  model: AuditTimeline | undefined,
  start?: number | null,
) {
  const exact = stages?.filter(
    (stage) =>
      (!model?.history_head ||
        !stage.history_head ||
        model.history_head === stage.history_head) &&
      (start == null ||
        stage.started_at_ms == null ||
        start === stage.started_at_ms),
  );
  if (exact?.length === 1) return exact[0];
  // In the absence of exact branch/clock evidence, do not choose whichever
  // invocation happened to be last in a bounded audit response.
  const timed =
    start == null
      ? []
      : exact?.filter((stage) => stage.started_at_ms === start);
  return timed?.length === 1 ? timed[0] : undefined;
}

/** Apply only observed ranges. Provider boundaries never stand in for tool time. */
export function timedTrajectoryBlocks(
  blocks: FeatureBlock[],
  timeline: AuditTimeline[],
  stages: AuditStage[],
): FeatureBlock[] {
  const models = selectedModelRequests(timeline);
  const inputs = new Map<string, AuditStage>();
  const tools = new Map<string, AuditStage[]>();
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
    else if (stage.tool_call_id != null && stage.round != null) {
      const key = `${positionKey(stage.epoch, stage.turn, stage.round)}:${stage.tool_call_id}`;
      const matches = tools.get(key);
      if (matches) matches.push(stage);
      else tools.set(key, [stage]);
    }
  }
  const seenModels = new Set<string>();
  const seenInputs = new Set<string>();
  const result: FeatureBlock[] = [];
  const requestIdentity = (model: AuditTimeline) =>
    JSON.stringify([
      model.epoch,
      model.turn,
      model.round,
      model.call_id,
      model.history_head,
      model.request_hash,
    ]);
  const inputRow = (
    original: FeatureBlock,
    model: AuditTimeline,
  ): FeatureBlock => ({
    id: `model-audit:${requestIdentity(model)}`,
    messageId: model.request_hash,
    sessionId: original.sessionId,
    role: "assistant",
    kind: "model-request",
    stream: "complete",
    position: { epoch: model.epoch, turn: model.turn!, round: model.round! },
    startedMs: model.started_at_ms,
    payload: {
      text: "",
      auditStatus: model.completion,
      stopReason: modelStopReason(original, model),
      auditTimingKey: `model-input:${requestIdentity(model)}`,
      auditSequence: model.sequence,
      auditScope: original.payload.auditScope,
      auditSelector: { epoch: model.epoch, call_id: model.call_id },
    },
  });
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
    const modelIdentity = model && requestIdentity(model);
    const callId = original.tool?.callId ?? original.payload.tool_call_id;
    const stage =
      original.role === "user"
        ? inputs.get(`${position.epoch}:${position.turn}`)
        : original.tool && callId
          ? selectedToolStage(
              tools.get(`${key}:${callId}`),
              model,
              original.startedMs,
            )
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
      const input = inputRow(original, model);
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
              ...(original.tool &&
              stage?.kind === "tool" &&
              stage.completion !== "pending"
                ? { auditToolOutcome: stage.completion }
                : {}),
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
  // The provider can already have received a continuation while its first
  // visible output block has not arrived. Anchor that witnessed request within
  // its known turn, not to the preceding tool's detail and not to another turn.
  const pendingRows = new Map<number, FeatureBlock[]>();
  for (const [key, model] of [...models].sort(
    ([, a], [, b]) => a.sequence - b.sequence,
  )) {
    if (seenInputs.has(key) || !model.call_id) continue;
    let anchor = -1;
    for (let index = 0; index < result.length; index++) {
      const row = result[index];
      const position = row.position ?? row.preview;
      if (
        position?.epoch === model.epoch &&
        position.turn === model.turn &&
        position.round != null &&
        position.round < model.round!
      )
        anchor = index;
    }
    if (anchor < 0) continue;
    const rows = pendingRows.get(anchor) ?? [];
    rows.push(inputRow(result[anchor], model));
    pendingRows.set(anchor, rows);
  }
  return pendingRows.size
    ? result.flatMap((block, index) => [
        block,
        ...(pendingRows.get(index) ?? []),
      ])
    : result;
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
