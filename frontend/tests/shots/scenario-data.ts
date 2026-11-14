/* Pure fixture payloads shared by the Playwright shot specs and the opt-in
 * Designer fixture server (frontend/fixture). No Playwright runtime imports. */
import type {
  PermissionRequest,
  RoundLimitRequest,
} from "../../src/client/types";

export const permissionRequest = (): PermissionRequest => ({
  request_id: "permission-shot",
  parent_session_id: "s1",
  session_id: "child-agent-with-a-very-long-identifier-0123456789",
  call_id: "native-call",
  agent: "coding",
  mode: "execute",
  tool: "shell",
  arguments: {
    command:
      "Get-Content frontend/src/features/popups/SessionPermissionsDialog.tsx | Select-String -Pattern permission",
  },
  revision: 4,
  created_at_ms: Date.now(),
  expires_at_ms: Date.now() + 300000,
});

export const roundLimit = (): RoundLimitRequest => ({
  request_id: "round-shot",
  parent_session_id: "s1",
  session_id: "s1",
  epoch: 1,
  turn_id: "turn-1",
  kind: "tool_calls",
  used: 128,
  block: 64,
  created_at_ms: 1,
});

export const text = (value: string) => ({
  variables: { set: {}, remove: [] },
  parts: [{ type: "text", text: value }],
});

export const mixedInbox = () => ({
  inbox_id: "inbox-shot",
  items: [
    {
      id: 7,
      revision: 3,
      claimed: false,
      mode: "steer",
      input: text(
        "Please also check the narrow footer at 390px before you finish",
      ),
    },
    {
      id: 8,
      revision: 3,
      claimed: false,
      mode: "queue",
      input: text(
        "After that, run the complete Playwright regression batch for permission-session, tool grouping and inbox mutations, then summarise any failures with exact file and line references so I can review them.",
      ),
    },
    {
      id: 9,
      revision: 3,
      claimed: true,
      mode: "queue",
      input: text("Claimed follow-up input"),
    },
  ],
  paused: false,
  active: true,
});

/** Valid NativeStatistics (shape from tests/statistics.spec.ts) with explicit zero measurements. */
export function zeroStatistics() {
  return {
    context: {
      scope: "current_selected_context",
      provenance: "context_budget_json_v1",
      epoch: 0,
      pending_epoch: false,
      fingerprint: "measured",
      bytes: 0,
      limit_bytes: 100000,
      remaining_bytes: 100000,
      categories: {
        system: 0,
        tools: 0,
        state: 0,
        user: 0,
        assistant: 0,
        tool_result: 0,
        framing: 0,
      },
      counts: {
        items: 0,
        tool_definitions: 0,
        pending_tool_calls: 0,
        state_frames: 0,
        user_messages: 0,
        assistant_messages: 0,
        tool_results: 0,
        tool_calls: 0,
        turns: 0,
        steps: 0,
      },
    },
    activity: {
      scope: "selected_context_history",
      turns: 0,
      steps: 0,
      tool_calls: 0,
      operation: null,
    },
    usage: {
      scope: "append_only_consumption",
      main: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      aggregate: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      main_cache_hit_rate: null,
      aggregate_cache_hit_rate: null,
    },
    provider: {
      scope: "latest_main_provider_attempt",
      available: false,
      audit_sequence: null,
      latest_prompt: null,
      timing: null,
    },
    model: {
      context_window_tokens: null,
      measured_headroom_tokens: null,
      headroom_reason: "model_window_unknown",
    },
  };
}

/** Terminal model failure for an admitted operation (retry-failure-path staging). */
export function modelFailure(id: string) {
  const position = { epoch: 0, turn: 1, round: 1 };
  return {
    position,
    observation: { operation_id: id, call_id: "model-call", ...position },
    failure: {
      version: 1,
      id,
      session_id: "s1",
      owner: "u1",
      method: "turn.inbox",
      payload_hash: "fixture",
      status: "failed",
      revision: 1,
      created_at_ms: 100,
      updated_at_ms: 101,
      result: {
        error: {
          code: "provider_error",
          message: "Provider unavailable after retries",
        },
        position,
        after_message_id: `user-${id}`,
        retry_ready: true,
        partial_output: {
          call_id: "model-call",
          ...position,
          text: "Retained failed partial",
          reasoning: "",
        },
      },
    },
  };
}

export const travelConflict = {
  error: {
    code: "checkpoint_conflict",
    message: "Checkpoint changed before travel; nothing was restored",
  },
};
