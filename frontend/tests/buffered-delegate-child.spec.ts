import { test, expect } from "@playwright/test";
import { applySnapshot, applyEvent } from "../src/client/projector";
import { childId, isSubagent } from "../src/features/shared";
import { nativeBackend, nativeSnapshot } from "./native-fixture";
import type {
  NativeChildDetail,
  NativeExecution,
  NativeSnapshot,
} from "../src/client/types";

const child = "0123456789abcdef";
function execution(
  status: NativeExecution["status"] = "running",
): NativeExecution {
  return {
    execution_id: 7,
    session_id: "s1",
    call_id: "delegate-call",
    tool: "delegate",
    agent: "main",
    mode: null,
    capabilities: { input: false },
    status,
    delegate_child: { session_id: child, target: "worker" },
  };
}
function snapshot(): NativeSnapshot {
  return {
    ...structuredClone(nativeSnapshot),
    executions: [execution()],
    messages: [
      {
        id: "u",
        role: "user",
        text: "Inspect child",
        parts: [],
        tool_calls: [],
      },
      {
        id: "a",
        role: "assistant",
        text: null,
        parts: [],
        tool_calls: [
          {
            id: "delegate-call",
            name: "delegate",
            builtin: "delegate",
            arguments: { subagent: "worker", prompt: "Inspect" },
          },
        ],
      },
      {
        id: "t",
        role: "tool",
        text: JSON.stringify({ execution_id: 7, session_id: "s1" }),
        parts: [],
        tool_calls: [],
        call_id: "delegate-call",
        tool_name: "delegate",
        tool_builtin: "delegate",
      },
    ],
  };
}

test("typed binding requires the selected exact execution and ignores ordinary receipt-shaped output", () => {
  const selected = snapshot();
  const transcript = applySnapshot(selected);
  const block = transcript.blocks.find(
    (block) => block.callId === "delegate-call",
  )!;
  expect(childId(block)).toBe(child);
  expect(block.tool.status).toBe("running");
  expect(block.payload.text).toBe(
    JSON.stringify({ execution_id: 7, session_id: "s1" }),
  );
  applyEvent(transcript, {
    v: 1,
    type: "event",
    subscription_id: "sub",
    generation: "g",
    sequence: 1,
    session_id: "s1",
    event: "executions.updated",
    data: { items: [execution("succeeded")] },
  });
  expect(block.tool.status).toBe("completed");
  for (const text of [
    JSON.stringify({ execution_id: 8, session_id: "s1" }),
    JSON.stringify({ execution_id: 7, session_id: "another" }),
    JSON.stringify({ child_id: "spoofed", subagent: "worker", outcome: {} }),
  ]) {
    const candidate = snapshot();
    candidate.messages[1].tool_calls[0].builtin = undefined;
    candidate.messages[2].tool_builtin = undefined;
    candidate.messages[2].text = text;
    const projected = applySnapshot(candidate).blocks.find(
      (block) => block.callId === "delegate-call",
    )!;
    expect(isSubagent(projected)).toBe(false);
    expect(childId(projected)).toBe("");
  }
  const legacy = snapshot();
  legacy.executions = [];
  legacy.messages[2].text = JSON.stringify({
    child_id: child,
    subagent: "worker",
    outcome: { content: "historical" },
  });
  expect(
    childId(
      applySnapshot(legacy).blocks.find(
        (block) => block.callId === "delegate-call",
      )!,
    ),
  ).toBe(child);
});

test("buffered delegate opens real child history under parent read authority", async ({
  page,
}) => {
  const detail: NativeChildDetail = {
    parent_session_id: "s1",
    id: child,
    name: "worker",
    status: "succeeded",
    availability: "persisted",
    receipt: null,
    usage: { samples: 1, input_tokens: 17 },
    executions: [],
    history: null,
    messages_truncated: false,
    next_cursor: null,
    messages: [
      {
        id: "child-answer",
        role: "assistant",
        text: "Real buffered child answer",
        parts: [],
        tool_calls: [],
      },
    ],
  };
  const backend = await nativeBackend(page, { children: [detail] });
  Object.assign(backend.snapshot(), snapshot());
  await page.goto("/#session/s1");
  await page
    .locator(".subagent-accordion-group .tool-accordion-group-header")
    .click();
  const row = page.locator(".subagent-group-item");
  await expect(row).toContainText("worker");
  await expect(row.locator(".subagent-status-dot-sm")).toHaveClass(/running/);
  await row.getByRole("button", { name: "详情", exact: true }).click();
  const view = page.getByRole("region", { name: "子代理内容", exact: true });
  await expect(view).toContainText("Real buffered child answer");
  await expect(
    view.getByRole("textbox", { name: "消息", exact: true }),
  ).toBeDisabled();
  expect(
    backend.requests.some(
      (request) => request.path === `/api/v1/sessions/s1/children/${child}`,
    ),
  ).toBe(true);
  expect(
    backend.requests.some((request) =>
      request.path.startsWith(`/api/v1/sessions/${child}`),
    ),
  ).toBe(false);
  // Child inspection must not open a session socket of its own.
  expect(
    backend.sessionSockets.every(
      (socket) =>
        decodeURIComponent(new URL(socket.url()).pathname.split("/")[4]) ===
        "s1",
    ),
  ).toBe(true);
});
