import { expect, test } from "@playwright/test";
import { applyEvent, applySnapshot } from "../src/client/projector";
import { operationFailureRoute } from "../src/client/operation-failure";
import type { NativeOperation } from "../src/client/types";
import { nativeBackend, nativeSnapshot } from "./native-fixture";

function failure(method: string): NativeOperation {
  return {
    version: 1,
    id: method,
    session_id: "s1",
    owner: "u1",
    method,
    payload_hash: "opaque",
    status: "failed",
    revision: 1,
    created_at_ms: 1,
    updated_at_ms: 2,
    result: {
      error: { code: "variable_conflict", message: "Unrelated error wording" },
    },
  };
}

for (const method of [
  "turn.submit",
  "turn.retry",
  "turn.inbox",
  "inbox.resume",
  "session.compact",
  "session.retry_agent_init",
  "session.retry_auto_compaction",
]) {
  test(`${method} preserves runtime failure in live and restored conversation`, () => {
    const operation = failure(method);
    const snapshot = { ...nativeSnapshot, operations: [operation] };
    const restored = applySnapshot(snapshot);
    expect(
      restored.blocks.filter(
        (block) => block.operationId === method && block.stream === "error",
      ),
    ).toHaveLength(1);
    const live = applySnapshot({ ...nativeSnapshot, operations: [] });
    applyEvent(live, {
      event: "turn",
      session_id: "s1",
      data: operation,
    } as any);
    expect(
      live.blocks.filter(
        (block) => block.operationId === method && block.stream === "error",
      ),
    ).toHaveLength(1);
    expect(
      applySnapshot(snapshot, live).blocks.filter(
        (block) => block.stream === "error",
      ),
    ).toHaveLength(1);
  });
}

for (const method of [
  "session.variables.patch",
  "permission.set",
  "session.rename",
  "turn.queue",
  "turn.steer",
  "inbox.update",
  "inbox.remove",
  "future.request",
]) {
  test(`${method} receipt never becomes an assistant failure`, () => {
    const operation = failure(method);
    const before = structuredClone(operation);
    expect(operationFailureRoute(operation)).toBe("request");
    const snapshot = { ...nativeSnapshot, operations: [operation] };
    const live = applySnapshot({ ...nativeSnapshot, operations: [] });
    applyEvent(live, {
      event: "turn",
      session_id: "s1",
      data: operation,
    } as any);
    expect(live.blocks.some((block) => block.stream === "error")).toBe(false);
    expect(
      applySnapshot(snapshot).blocks.some((block) => block.stream === "error"),
    ).toBe(false);
    // Previously shown request notices must also retire on canonical refresh.
    const legacy = applySnapshot({
      ...nativeSnapshot,
      operations: [{ ...operation, method: "turn.submit" }],
    });
    expect(
      applySnapshot(snapshot, legacy).blocks.some(
        (block) => block.stream === "error",
      ),
    ).toBe(false);
    expect(operation).toEqual(before);
  });
}

test("plugin request feedback preserves certified rejection, uncertainty, queue admission and scoped observation", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    // @ts-expect-error Browser source import is resolved by Vite.
    const { ClientPlugins } = await import("/src/state/client-plugins.ts");
    // @ts-expect-error Browser source import is resolved by Vite.
    const { CommandError } = await import("/src/client/errors.ts");
    const notices: string[] = [];
    const calls: any[] = [];
    let result: any = { operation_id: "op", status: "queued" };
    let error: any;
    let release: ((value: any) => void) | undefined;
    let deferred = false;
    const bridge: any = new ClientPlugins(
      () => ({
        request: async (...args: any[]) => {
          calls.push(args);
          if (deferred)
            return new Promise((resolve) => {
              release = resolve;
            });
          if (error) throw error;
          return result;
        },
      }),
      undefined,
      (message: string) => notices.push(message),
    );
    bridge.session = "s1";
    const effect = {
      kind: "state-change",
      payload: { operation_id: "op", expected: {}, change: {} },
      sessionId: "s1",
      context: { session_id: "s1", user_action: true },
      signal: new AbortController().signal,
    };
    const queued = await bridge.effect(effect, 0);
    const afterQueued = notices.length;
    result = {
      operation_id: "op",
      status: "rejected",
      reason: { code: "variable_conflict", message: "Stale inspection" },
    };
    const observe = {
      ...effect,
      kind: "state-operation",
      payload: { operation_id: "op" },
    };
    const rejected = await bridge.effect(observe, 0);
    await bridge.effect(observe, 0);
    const afterRejected = notices.length;
    error = new CommandError("disconnected", "Receipt lost", true, true);
    const unknown = await bridge.effect(
      { ...effect, payload: { ...effect.payload, operation_id: "unknown" } },
      0,
    );
    error = undefined;
    result = {
      operation_id: "unknown",
      status: "rejected",
      reason: { code: "variable_conflict", message: "Observed rejection" },
    };
    const reconciled = await bridge.effect(
      { ...observe, payload: { operation_id: "unknown" } },
      0,
    );
    error = new CommandError(
      "variable_conflict",
      "Checked rejection",
      false,
      false,
      { operation_id: "checked" },
    );
    const checked = await bridge.effect(
      { ...effect, payload: { ...effect.payload, operation_id: "checked" } },
      0,
    );
    error = new CommandError("variable_conflict", "Uncertified response", false, false);
    const uncertified = await bridge.effect(
      { ...effect, payload: { ...effect.payload, operation_id: "uncertified" } },
      0,
    );
    error = undefined;
    result = {
      operation_id: "uncertified",
      status: "rejected",
      reason: { code: "variable_conflict", message: "Exact observed rejection" },
    };
    await bridge.effect(
      { ...observe, payload: { operation_id: "uncertified" } },
      0,
    );
    error = new CommandError("variable_conflict", "Checked rejection", false, false, { operation_id: "checked" });
    const beforeTool = notices.length;
    await bridge.effect(
      { ...effect, context: { ...effect.context, tool_invocation: {} } },
      0,
    );
    const afterTool = notices.length;
    error = undefined;
    deferred = true;
    const pending = bridge.effect(
      { ...observe, payload: { operation_id: "expired" } },
      0,
    );
    bridge.resetHistory();
    release!({ ...result, operation_id: "expired" });
    try {
      await pending;
    } catch {}
    return {
      queued,
      rejected,
      unknown,
      reconciled,
      checked,
      uncertified,
      afterQueued,
      afterRejected,
      beforeTool,
      afterTool,
      notices,
      calls: calls.length,
    };
  });
  expect(actual.queued.status).toBe("queued");
  expect(actual.rejected.status).toBe("rejected");
  expect(actual.checked.status).toBe("rejected");
  expect(actual.unknown.status).toBe("unknown");
  expect(actual.uncertified.status).toBe("unknown");
  expect(actual.reconciled.status).toBe("rejected");
  expect(actual.afterQueued).toBe(0);
  expect(actual.afterRejected).toBe(1);
  expect(actual.afterTool).toBe(actual.beforeTool);
  expect(actual.notices).toEqual([
    "Stale inspection",
    "Receipt lost",
    "Observed rejection",
    "Checked rejection",
    "Uncertified response",
    "Exact observed rejection",
  ]);
  expect(actual.calls).toBe(10);
});
