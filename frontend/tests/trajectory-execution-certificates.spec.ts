import { expect, test } from "@playwright/test";
import { mergeHistoryPage } from "../src/client/loaded-messages";
import {
  applySnapshot,
  replayDisplayObservations,
} from "../src/client/projector";
import {
  binding,
  canonical,
  chunk,
  graphRows,
  message,
  snapshot,
} from "./display-graph-inputs";
import { nativeBackend } from "./native-fixture";

const result = (
  tag: string,
  source: string,
  slot: number,
  id: number,
  owner = "s1",
  call = "reused-call",
) =>
  message(tag, "tool", `Output ${tag}`, {
    call_id: call,
    tool_name: "read",
    execution_id: id,
    execution_session_id: owner,
    execution_call_source_id: source,
    execution_call_index: slot,
  });

const assistant = (tag: string, callId = "reused-call", id?: number) =>
  message(tag, "assistant", "", {
    tool_calls: [
      {
        id: callId,
        name: "read",
        arguments: { path: `${tag}.txt` },
        execution_id: id,
      },
    ],
  });

test("fresh Trajectory labels same-name calls from canonical evidence and prepends exact IDs without remounting", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const user = message("prompt", "user", "Inspect files");
  const older = assistant("earlier");
  const earlierResult = result(
    "earlier-output",
    older.canonical_source_id!,
    0,
    803,
  );
  earlierResult.execution_status = "failed";
  const newer = assistant("recent", "reused-call", 954);
  newer.tool_calls[0].execution_status = "interrupted";
  newer.position = { epoch: 0, turn: 1, round: 2 };
  const recentResult = result(
    "recent-output",
    newer.canonical_source_id!,
    0,
    945,
  );
  recentResult.position = newer.position;
  recentResult.execution_status = "cancelled";
  const legacy = assistant("legacy", "legacy-call");
  legacy.position = { epoch: 0, turn: 1, round: 3 };
  const view = backend.snapshot();
  Object.assign(view, snapshot([newer, recentResult, legacy]), {
    messages_truncated: true,
    next_cursor: 3,
  });
  view.session.status = "idle";
  view.history_view = {
    ...view.history_view!,
    start_cursor: 3,
    end_cursor: 6,
    message_count: 6,
  };
  backend.handleBlocks((params) => {
    expect(params.before_cursor).toBe(3);
    return {
      items: [user, older, earlierResult],
      history_view: { ...view.history_view, start_cursor: 0, end_cursor: 3 },
      truncated: false,
      next_cursor: null,
    };
  });
  await page.route("**/audit/requests", (route) =>
    route.fulfill({ json: { status: "missing", attempts: [] } }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const tools = page.locator(
    '.trajectory-ledger [data-testid="trajectory-entry"][data-kind="tool"]',
  );
  const tool = (path: string) => tools.filter({ hasText: `${path}.txt` });
  const number = (path: string) =>
    tool(path).locator(".trajectory-title-number");
  await expect(number("recent")).toHaveText("#954");
  await expect(number("legacy")).toHaveCount(0);
  await expect(tool("earlier")).toHaveCount(0);
  await tool("recent").click();
  await tool("recent").evaluate((node) => {
    Object.assign(window, { certifiedRow: node });
  });
  const inspector = page.getByTestId("trajectory-inspector");
  await expect(inspector.locator(".trajectory-title-number")).toHaveText(
    "#954",
  );
  await page.getByTestId("trajectory-load-older").click();
  await expect(number("earlier")).toHaveText("#803");
  await expect(tool("earlier")).toHaveAttribute("data-status", "failed");
  await expect(tool("earlier")).toContainText("失败");
  await expect(number("recent")).toHaveText("#954");
  await expect(tool("recent")).toHaveAttribute("data-status", "interrupted");
  await expect(tool("recent")).toHaveAttribute("data-selected", "true");
  expect(
    await tool("recent").evaluate(
      (node) => node === (window as any).certifiedRow,
    ),
  ).toBe(true);
});

test("graph projection uses exact source, slot and owner, independent of live execution metadata", () => {
  const first = assistant("first");
  const second = assistant("second");
  const rows = [
    chunk(1, "first-tool", null, "tool_call", "{}", {
      attempt: "first",
      extra: { id: "reused-call" },
    }),
    binding(2, ["first-tool"], first, "first"),
    chunk(3, "second-tool", "first-tool", "tool_call", "{}", {
      attempt: "second",
      extra: { id: "reused-call" },
    }),
    binding(4, ["second-tool"], second, "second"),
    canonical(5, "earlier-result", "second-tool", {
      ...result("first-result", first.canonical_source_id!, 0, 103),
      execution_status: "failed",
    }),
    canonical(6, "forked-result", "earlier-result", {
      ...result(
        "foreign-result",
        second.canonical_source_id!,
        0,
        499,
        "other-session",
      ),
      execution_status: "cancelled",
    }),
    canonical(
      7,
      "unpaired-result",
      "forked-result",
      result("unpaired", second.canonical_source_id!, 1, 309),
    ),
  ];
  const attached = applySnapshot(snapshot());
  replayDisplayObservations(attached, "s1", rows);
  const expected = [
    ["first-tool", 103, "failed", undefined],
    ["second-tool", undefined, undefined, undefined],
    ["unpaired-result", 309, undefined, undefined],
  ];
  const labels = (view: typeof attached) =>
    graphRows(view).map((block) => [
      block.id,
      block.displayExecutionId,
      block.displayExecutionStatus,
      block.executionId,
    ]);
  expect(labels(attached)).toEqual(expected);
  const refreshed = applySnapshot(
    snapshot([first, assistant("second", "reused-call", 200)]),
    attached,
  );
  expect(labels(refreshed)).toEqual([
    expected[0],
    ["second-tool", 200, undefined, undefined],
    expected[2],
  ]);
});

test("a conflicting second result cannot overwrite the settled tool occurrence", () => {
  const call = assistant("call");
  const first = {
    ...result("first", call.canonical_source_id!, 0, 103),
    execution_status: "failed" as const,
  };
  const duplicate = result("duplicate", call.canonical_source_id!, 0, 104);
  const attached = applySnapshot(snapshot());
  replayDisplayObservations(attached, "s1", [
    chunk(1, "tool", null, "tool_call", "{}", {
      attempt: "call",
      extra: { id: "reused-call" },
    }),
    binding(2, ["tool"], call, "call"),
    canonical(3, "first-result", "tool", first),
    canonical(4, "duplicate-result", "first-result", duplicate),
  ]);
  const settled = graphRows(attached).find((block) => block.id === "tool");
  expect(settled).toMatchObject({
    displayExecutionId: 103,
    displayExecutionStatus: "failed",
    payload: { text: "Output first" },
  });
});

test("overlapping pages preserve exact certificates across truncation and conflicting IDs", () => {
  const current = snapshot([
    assistant("kept", "a", 59),
    assistant("enriched", "b"),
  ]);
  const prior = assistant("prior", "c", Number.MAX_SAFE_INTEGER + 1);
  const page = [
    prior,
    assistant("kept", "a", 60),
    assistant("enriched", "b", 61),
  ];
  current.messages[0].tool_calls[0].execution_status = "failed";
  page[1].tool_calls[0].execution_status = "interrupted";
  page[2].tool_calls[0].execution_status = "cancelled";
  prior.tool_calls[0].execution_status = "interrupted";
  for (const row of page.slice(1)) row.content_truncated = true;
  current.history_view = {
    ...current.history_view!,
    start_cursor: 1,
    end_cursor: 3,
    message_count: 3,
  };
  const merged = mergeHistoryPage(current, {
    items: page,
    history_view: { ...current.history_view, start_cursor: 0 },
    truncated: false,
    next_cursor: null,
  });
  expect(merged).not.toBeNull();
  expect(
    applySnapshot(merged!).blocks.map((block) => [
      block.displayExecutionId,
      block.displayExecutionStatus,
      block.executionId,
    ]),
  ).toEqual([
    [undefined, undefined, undefined],
    [59, "failed", undefined],
    [61, "cancelled", undefined],
  ]);
});
