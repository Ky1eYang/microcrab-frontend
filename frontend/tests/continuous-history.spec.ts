import { expect, test } from "@playwright/test";
import { retainLoadedMessages } from "../src/client/loaded-messages";
import type { NativeMessage, NativeSnapshot } from "../src/client/types";
import { nativeBackend } from "./native-fixture";

const message = (id: string): NativeMessage => ({
  id,
  role: "assistant",
  text: id,
  parts: [],
  tool_calls: [],
});
const snapshot = (
  ids: string[],
  start: number,
  end: number,
  lineage = "selected",
) =>
  ({
    session: { id: "s1" },
    history: { checkpoint_id: `head-${end}` },
    messages: ids.map(message),
    messages_truncated: start > 0,
    next_cursor: start || null,
    history_view: {
      lineage,
      epoch: 0,
      start_cursor: start,
      end_cursor: end,
      message_count: end,
      turns: [],
    },
  }) as unknown as NativeSnapshot;

test("received canonical history survives append checkpoints while branch replacement remains isolated", () => {
  const previous = snapshot(["a", "b", "c"], 10, 13);
  const next = snapshot(["b", "c", "d"], 11, 14);
  const retained = retainLoadedMessages(next, previous);
  expect(retained.messages.map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
  expect(retained.next_cursor).toBe(10);
  expect(retained.history_view?.start_cursor).toBe(10);
  expect(
    retainLoadedMessages(
      { ...next, history_view: { ...next.history_view!, lineage: "other" } },
      previous,
    ).messages.map((row) => row.id),
  ).toEqual(["b", "c", "d"]);
  const legacy = { ...next, history_view: undefined };
  expect(
    retainLoadedMessages(legacy, {
      ...previous,
      history_view: undefined,
    }).messages.map((row) => row.id),
  ).toEqual(["b", "c", "d"]);
});

test("unbridged gaps retain the proven view and exact adjacent ranges bridge without fabricated splicing", () => {
  const previous = snapshot(["a", "b"], 10, 12);
  const target = snapshot(["e", "f"], 14, 16);
  const earlier = retainLoadedMessages(snapshot(["a", "b"], 0, 2), target);
  expect(earlier.messages.map((row) => row.id)).toEqual(["e", "f"]);
  expect(earlier.history_view?.start_cursor).toBe(14);
  expect(earlier.history_view?.end_cursor).toBe(16);
  const gap = retainLoadedMessages(target, previous);
  expect(gap.history_gap).toBe(true);
  expect(gap.messages.map((row) => row.id)).toEqual(["a", "b"]);
  const bridge = retainLoadedMessages(snapshot(["c", "d"], 12, 14), previous);
  const joined = retainLoadedMessages(target, bridge);
  expect(joined.history_gap).toBe(false);
  expect(joined.messages.map((row) => row.id)).toEqual([
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
  ]);
});

test("covered stale complete prefixes and empty intervals cannot erase a received suffix", () => {
  const previous = snapshot(["a", "b", "c"], 0, 3);
  for (const incoming of [
    snapshot(["a", "b"], 0, 2),
    snapshot([], 3, 3),
    snapshot(["b"], 1, 2),
  ]) {
    const retained = retainLoadedMessages(incoming, previous);
    expect(retained.messages.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(retained.history_view?.end_cursor).toBe(3);
    expect(retained.messages_truncated).toBe(false);
  }
  const replacement = retainLoadedMessages(
    snapshot(["a", "changed"], 0, 2),
    previous,
  );
  expect(replacement.messages.map((row) => row.id)).toEqual(["a", "changed"]);
});

test("cursor conflicts and malformed extents cannot bypass covered-range proof", () => {
  const previous = snapshot(["a", "b", "c"], 0, 3);
  for (const incoming of [
    snapshot(["b", "c"], 0, 2),
    snapshot(["a", "b"], 1, 3),
    snapshot(["b", "c"], 1, 4),
  ]) {
    incoming.messages_truncated = true;
    const result = retainLoadedMessages(incoming, previous);
    expect(result.messages.map((row) => row.id)).toEqual(
      incoming.messages.map((row) => row.id),
    );
    expect(result.history_view).toEqual(incoming.history_view);
  }
});

test("Turn totals retain off-page evidence and stale heads cannot replace newer totals", () => {
  const previous = snapshot(["a", "b", "c"], 0, 3);
  previous.history_view!.turns = [
    {
      epoch: 0,
      turn: 1,
      tool_calls: 3,
      ordinary_tool_calls: 3,
      delegate_calls: 0,
    },
  ];
  const stale = snapshot(["a", "b"], 0, 2);
  stale.history_view!.turns = [
    {
      epoch: 0,
      turn: 1,
      tool_calls: 2,
      ordinary_tool_calls: 2,
      delegate_calls: 0,
    },
  ];
  expect(retainLoadedMessages(stale, previous).history_view?.turns).toEqual(
    previous.history_view!.turns,
  );
  const incoming = snapshot(["c", "d"], 2, 4);
  incoming.history_view!.turns = [
    {
      epoch: 0,
      turn: 2,
      tool_calls: 1,
      ordinary_tool_calls: 1,
      delegate_calls: 0,
    },
  ];
  const retained = retainLoadedMessages(incoming, previous);
  expect(
    retained.history_view?.turns.map((turn) => [
      turn.turn,
      turn.ordinary_tool_calls,
    ]),
  ).toEqual([
    [1, 3],
    [2, 1],
  ]);
  const branch = snapshot(["c", "d"], 2, 4, "other");
  expect(retainLoadedMessages(branch, retained).history_view?.turns).toEqual(
    [],
  );
});

test("a deliberately abbreviated projection does not erase a full received body", () => {
  const previous = snapshot(["a", "b"], 10, 12);
  previous.messages[1].text = "Full payload";
  const incoming = snapshot(["b", "c"], 11, 13);
  incoming.messages[0] = {
    ...incoming.messages[0],
    text: "Full",
    content_truncated: true,
  };
  expect(retainLoadedMessages(incoming, previous).messages[1].text).toBe(
    "Full payload",
  );
  const complete = {
    ...incoming,
    messages_truncated: false,
    history_view: { ...incoming.history_view!, start_cursor: 0 },
  };
  expect(retainLoadedMessages(complete, previous).messages[0].text).toBe(
    "Full payload",
  );
  const linked = {
    ...complete,
    messages: complete.messages.map((row) => ({
      ...row,
      client_invocation_id: "linked-v2",
    })),
  };
  expect(retainLoadedMessages(linked, previous).messages[0].text).toBe("Full");
});

test("an active Turn keeps tool rows and explicit expansion through advancing snapshots and prepend", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const tools = (index: number): NativeMessage[] => [
    {
      id: `a-${index}`,
      role: "assistant",
      text: "",
      parts: [],
      tool_calls: [
        {
          id: `call-${index}`,
          name: `read_${index}`,
          arguments: { path: "file" },
        },
      ],
      position: { epoch: 0, turn: 1, round: index },
    },
    {
      id: `r-${index}`,
      role: "tool",
      text: `Result ${index}\n${"Output line\n".repeat(80)}`,
      parts: [],
      tool_calls: [],
      call_id: `call-${index}`,
      tool_name: `read_${index}`,
      position: { epoch: 0, turn: 1, round: index },
    },
  ];
  const current = backend.snapshot();
  current.messages = tools(2);
  current.inbox = {
    ...(current.inbox ?? {}),
    active: true,
  } as typeof current.inbox;
  current.messages_truncated = true;
  current.next_cursor = 2;
  current.history = { checkpoint_id: "round-2" };
  current.history_view = {
    lineage: "live",
    epoch: 0,
    start_cursor: 2,
    end_cursor: 4,
    message_count: 4,
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
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(header).toContainText("已加载 1 次工具调用");
  await page.getByTestId("tool-row").click();
  await expect(page.getByTestId("tool-row")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const output = page.getByTestId("tool-payload-output");
  await expect(output).toHaveAttribute("data-variant", "trajectory");
  await output.locator("pre").evaluate((body) => {
    body.scrollTop = 140;
    (window as any).__continuousOutput = body;
  });
  await expect
    .poll(() => output.locator("pre").evaluate((body) => body.scrollTop))
    .toBe(140);
  await output.getByTestId("payload-dialog-expand").click();
  const dialog = page.getByRole("dialog", {
    name: "read_2 · 输出",
    exact: true,
  });
  await expect(dialog).toContainText("Result 2");
  await expect(output).toHaveAttribute("data-collapsed", "false");
  current.messages = [...tools(1), ...tools(2), ...tools(3)];
  current.messages_truncated = false;
  current.history = { checkpoint_id: "round-3" };
  current.history_view = {
    ...current.history_view,
    start_cursor: 0,
    end_cursor: 6,
    message_count: 6,
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
  backend.publish(current);
  await expect(page.getByTestId("tool-row")).toHaveCount(3);
  await expect(
    page.getByTestId("tool-row").filter({ hasText: "read_2" }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(output).toHaveAttribute("data-collapsed", "false");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Result 2");
  expect(
    await output
      .locator("pre")
      .evaluate((body) => body === (window as any).__continuousOutput),
  ).toBe(true);
  await expect
    .poll(() => output.locator("pre").evaluate((body) => body.scrollTop))
    .toBe(140);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(output.getByTestId("payload-dialog-expand")).toBeFocused();
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  current.history = { checkpoint_id: "round-4" };
  backend.publish(current);
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  await expect(
    page.getByTestId("tool-row").filter({ hasText: "read_2" }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(output).toContainText("Result 2");
  await expect(output.getByTestId("payload-dialog-expand")).toBeVisible();
  await expect(output).toHaveAttribute("data-collapsed", "false");
});
