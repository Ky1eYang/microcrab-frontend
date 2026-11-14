import { expect, test } from "@playwright/test";
import type { NativeMessage } from "../src/client/types";
import { nativeBackend } from "./native-fixture";

const toolMessages = (index: number): NativeMessage[] => [
  {
    id: `continuous-assistant-${index}`,
    role: "assistant",
    text: "",
    parts: [],
    tool_calls: [
      {
        id: `continuous-call-${index}`,
        name: `continuous_read_${index}`,
        arguments: { path: `file-${index}` },
      },
    ],
    position: { epoch: 0, turn: 1, round: index },
  },
  {
    id: `continuous-result-${index}`,
    role: "tool",
    text: `Result ${index}`,
    parts: [],
    tool_calls: [],
    call_id: `continuous-call-${index}`,
    tool_name: `continuous_read_${index}`,
    position: { epoch: 0, turn: 1, round: index },
  },
];

test("busy conversation keeps received tools and complete history through live/canonical and stale covered ranges", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const current = backend.snapshot();
  const user: NativeMessage = {
    id: "continuous-user",
    role: "user",
    text: "Inspect files continuously",
    parts: [],
    tool_calls: [],
    position: { epoch: 0, turn: 1, round: 0 },
  };
  current.session.status = "running";
  current.inbox = { items: [], active: true, paused: false };
  current.messages = [user, ...toolMessages(1), ...toolMessages(2)];
  current.messages_truncated = false;
  current.next_cursor = null;
  current.history = { checkpoint_id: "continuous-head-2" };
  current.history_view = {
    lineage: "continuous-lineage",
    epoch: 0,
    start_cursor: 0,
    end_cursor: 5,
    message_count: 5,
    turns: [
      {
        epoch: 0,
        turn: 1,
        tool_calls: 2,
        ordinary_tool_calls: 2,
        delegate_calls: 0,
      },
    ],
  };
  await page.goto("/#session/s1");
  const header = page.locator(".tool-accordion-group-header");
  await expect(header).toContainText("工具调用 2 次");
  await expect(header).not.toContainText("更早记录未加载");
  const chosen = page
    .getByTestId("tool-row")
    .filter({ hasText: "continuous_read_2" });
  await chosen.click();
  await expect(chosen).toHaveAttribute("aria-expanded", "true");
  await chosen.evaluate((node) => {
    (window as any).__continuousSelectedNode = node;
  });
  backend.event("tool", {
    operation_id: "continuous-operation",
    epoch: 0,
    turn: 1,
    round: 3,
    call_id: "continuous-call-3",
    name: "continuous_read_3",
    phase: "completed",
    arguments: { path: "file-3" },
    result: "Result 3",
  });
  await expect(page.getByTestId("tool-row")).toHaveCount(3);
  await expect(header).toContainText("工具调用 3 次");
  const assertStable = async () => {
    await expect(page.getByTestId("tool-row")).toHaveCount(3);
    await expect(header).toContainText("工具调用 3 次");
    await expect(header).not.toContainText("更早记录未加载");
    await expect(chosen).toHaveAttribute("aria-expanded", "true");
    expect(
      await chosen.evaluate(
        (node) => node === (window as any).__continuousSelectedNode,
      ),
    ).toBe(true);
  };
  // A newly published snapshot can still cover the earlier canonical boundary.
  backend.publish(structuredClone(current));
  await assertStable();
  current.messages = [
    user,
    ...toolMessages(1),
    ...toolMessages(2),
    ...toolMessages(3),
  ];
  current.history = { checkpoint_id: "continuous-head-3" };
  current.history_view = {
    ...current.history_view,
    end_cursor: 7,
    message_count: 7,
    turns: [
      {
        epoch: 0,
        turn: 1,
        tool_calls: 3,
        ordinary_tool_calls: 3,
        delegate_calls: 0,
      },
    ],
  };
  backend.publish(structuredClone(current));
  await assertStable();
  const stale = structuredClone(current);
  stale.messages = [user, ...toolMessages(1), ...toolMessages(2)];
  stale.history_view = {
    ...stale.history_view!,
    end_cursor: 5,
    message_count: 5,
    turns: [
      {
        epoch: 0,
        turn: 1,
        tool_calls: 2,
        ordinary_tool_calls: 2,
        delegate_calls: 0,
      },
    ],
  };
  backend.publish(stale);
  await assertStable();
  const bounded = structuredClone(current);
  bounded.messages = toolMessages(3);
  bounded.messages_truncated = true;
  bounded.next_cursor = 5;
  bounded.history_view = { ...bounded.history_view!, start_cursor: 5 };
  backend.publish(bounded);
  await assertStable();
  const empty = structuredClone(bounded);
  empty.messages = [];
  empty.next_cursor = 7;
  empty.history_view = { ...empty.history_view!, start_cursor: 7, turns: [] };
  backend.publish(empty);
  await assertStable();
  // Leaving the selected lineage revokes the retained range and its summaries.
  const replacement = structuredClone(bounded);
  replacement.messages = toolMessages(9);
  replacement.history_view = {
    ...replacement.history_view!,
    lineage: "replacement-lineage",
    start_cursor: 0,
    end_cursor: 2,
    message_count: 2,
    turns: [
      {
        epoch: 0,
        turn: 1,
        tool_calls: 1,
        ordinary_tool_calls: 1,
        delegate_calls: 0,
      },
    ],
  };
  replacement.messages_truncated = false;
  replacement.next_cursor = null;
  backend.publish(replacement);
  await expect(page.getByTestId("tool-row")).toHaveCount(1);
  await expect(page.getByTestId("tool-row")).toContainText("continuous_read_9");
  await expect(header).toContainText("工具调用 1 次");
});
