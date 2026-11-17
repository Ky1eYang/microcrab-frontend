import { expect, test } from "@playwright/test";
import type { NativeMessage } from "../src/client/types";
import { nativeBackend } from "./native-fixture";

const position = { epoch: 0, turn: 1, round: 1 };
const user: NativeMessage = {
  id: "scope-user",
  role: "user",
  text: "Read selected history",
  parts: [],
  tool_calls: [],
  position,
};
function invocation(index: number): NativeMessage[] {
  return [
    {
      id: `scope-call-${index}`,
      role: "assistant",
      text: "",
      parts: [],
      tool_calls: [
        {
          id: `scope-tool-${index}`,
          name: `scope_read_${index}`,
          arguments: { path: `file-${index}` },
        },
      ],
      position: { ...position, round: index },
    },
    {
      id: `scope-result-${index}`,
      role: "tool",
      text: `Result ${index}`,
      parts: [],
      tool_calls: [],
      call_id: `scope-tool-${index}`,
      tool_name: `scope_read_${index}`,
      position: { ...position, round: index },
    },
  ];
}

test("conversation choices survive append but reset on lineage and epoch replacement with reused invocation IDs", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const current = backend.snapshot();
  current.session.status = "idle";
  current.inbox = { active: false, paused: false, items: [] };
  current.messages = [user, ...invocation(1), ...invocation(2)];
  current.messages_truncated = false;
  current.next_cursor = null;
  current.history_view = {
    lineage: "scope-original",
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
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  const chosen = page
    .getByTestId("tool-row")
    .filter({ hasText: "scope_read_2" });
  await chosen.click();
  await expect(chosen).toHaveAttribute("aria-expanded", "true");
  current.messages.push(...invocation(3));
  current.history_view = {
    ...current.history_view!,
    message_count: 7,
    end_cursor: 7,
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
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(chosen).toHaveAttribute("aria-expanded", "true");
  for (const view of [
    { ...current.history_view!, lineage: "scope-replaced" },
    { ...current.history_view!, lineage: "scope-replaced", epoch: 1 },
  ]) {
    current.history_view = view;
    current.messages = current.messages.map((message) => ({
      ...message,
      id: `branch-${view.epoch}:${message.id}`,
    }));
    // Forward epoch alone preserves reading. This case replaces all canonical
    // inputs, so supply the actual reset receipt rather than treating the epoch
    // counter as proof that inspected content was removed.
    if (view.epoch === 1)
      backend.event("history.reset", {
        lineage: view.lineage,
        epoch: view.epoch,
        reason: "rewritten",
      });
    backend.publish(structuredClone(current));
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await header.click();
    await expect(chosen).toHaveAttribute("aria-expanded", "false");
    await chosen.click();
    await expect(chosen).toHaveAttribute("aria-expanded", "true");
  }
});

test("separate chronological tool groups keep consistent headers without turn-total suffix", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const current = backend.snapshot();
  current.session.status = "running";
  current.inbox = { active: true, paused: false, items: [] };
  current.messages = [
    user,
    ...invocation(1),
    {
      id: "scope-explanation",
      role: "assistant",
      text: "Continue with the next two files",
      parts: [],
      tool_calls: [],
      position: { ...position, round: 2 },
    },
    ...invocation(2),
    ...invocation(3),
  ];
  current.history_view = {
    lineage: "scope-groups",
    epoch: 0,
    start_cursor: 0,
    end_cursor: current.messages.length,
    message_count: current.messages.length,
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
  await page.goto("/#session/s1");
  const groups = page.locator(".tool-accordion-group-header");
  await expect(groups).toHaveCount(2);
  // v0.1.18: active state is a spinner glyph with a readable (sr-only) name.
  await expect(groups.nth(0)).toHaveText("本组工具调用 1 次本轮进行中");
  await expect(groups.nth(1)).toHaveText("本组工具调用 2 次本轮进行中");
  await expect(
    groups.nth(0).locator('.tool-group-glyph[data-status="running"]'),
  ).toHaveCount(1);
  await expect(page.getByTestId("tool-turn-count")).toHaveCount(0);
  await expect(page.getByTestId("tool-row")).toHaveCount(3);
});
