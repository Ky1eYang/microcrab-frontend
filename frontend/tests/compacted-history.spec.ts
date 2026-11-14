import { expect, test } from "@playwright/test";
import { applySnapshot } from "../src/client/projector";
import { auditSelector } from "../src/features/RequestAudit";
import type { NativeMessage } from "../src/client/types";
import { nativeBackend, nativeSnapshot } from "./native-fixture";

const message = (index: number): NativeMessage => ({
  id: `history-${index}`,
  role: "assistant",
  text: `Historical answer ${index}`,
  parts: [],
  tool_calls: [],
  position: { epoch: 1, turn: index + 1, round: 1 },
});

test("reopened compact display preserves preceding message identities and audit positions", () => {
  const marker = {
    id: "compact-first",
    epoch: 1,
    summary: "Durable compact summary",
    message_id: "summary",
  };
  const snapshot = {
    ...nativeSnapshot,
    compactions: [],
    messages: [
      message(0),
      {
        ...message(1),
        id: "summary",
        role: "user" as const,
        text: marker.summary,
        compaction: marker,
      },
      { ...message(2), position: { epoch: 2, turn: 3, round: 1 } },
    ],
  };
  // No prior in-memory transcript is supplied: the selected durable history is enough.
  const transcript = applySnapshot(snapshot);
  expect(transcript.blocks.map((block) => block.messageId)).toEqual([
    "history-0",
    "summary",
    "history-2",
  ]);
  expect(transcript.blocks[1].kind).toBe("compaction");
  expect(transcript.blocks[1].compaction?.id).toBe(marker.id);
  expect(transcript.blocks[0].position).toEqual({
    epoch: 1,
    turn: 1,
    round: 1,
  });
  expect(auditSelector(transcript.blocks[0], false)).toMatchObject({
    epoch: 1,
    turn: 1,
    round: 1,
  });
  expect(
    applySnapshot(snapshot, transcript).blocks.map((block) => block.id),
  ).toEqual(transcript.blocks.map((block) => block.id));
});

test("trajectory defaults to recent records and explicitly reveals older resident history without losing selection", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = Array.from({ length: 160 }, (_, index) =>
    message(index),
  );
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
    route.fulfill({ json: { status: "missing", attempts: [] } }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await expect(page.getByTestId("trajectory-entry")).toHaveCount(96);
  const loadOlder = page.getByTestId("trajectory-load-older");
  await expect(loadOlder).toHaveAccessibleName("加载更早轨迹");
  expect(await loadOlder.innerText()).toBe("");
  const buttonRect = await loadOlder.boundingBox();
  const timelineRect = await page.locator(".trajectory-timeline").boundingBox();
  expect(buttonRect!.x - timelineRect!.x).toBeLessThan(8);
  expect(buttonRect!.y).toBeGreaterThan(timelineRect!.y);
  expect(buttonRect!.y + buttonRect!.height).toBeLessThan(
    timelineRect!.y + timelineRect!.height,
  );
  await expect(page.getByTestId("trajectory-entry").first()).toContainText(
    "Historical answer 64",
  );
  await page.getByTestId("trajectory-entry").last().click();
  await expect(page.getByTestId("trajectory-inspector")).toContainText(
    "Historical answer 159",
  );
  await page.getByTestId("trajectory-load-older").click();
  await expect(page.getByTestId("trajectory-entry")).toHaveCount(160);
  await expect(page.getByTestId("trajectory-entry").first()).toContainText(
    "Historical answer 0",
  );
  await expect(page.getByTestId("trajectory-inspector")).toContainText(
    "Historical answer 159",
  );
  await expect(page.getByTestId("trajectory-load-older")).toHaveCount(0);
  expect(
    backend.commands.filter((command) => command.method === "session.blocks"),
  ).toHaveLength(0);
});

test("trajectory loads older nonresident records through the existing bounded message page", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = Array.from({ length: 64 }, (_, index) =>
    message(index + 64),
  );
  backend.snapshot().messages_truncated = true;
  backend.snapshot().next_cursor = 64;
  backend.snapshot().history_view = {
    lineage: "compacted-page-lineage",
    epoch: 1,
    start_cursor: 64,
    end_cursor: 128,
    message_count: 128,
    turns: [],
  };
  let request: Record<string, unknown> = {};
  backend.handleBlocks((params) => {
    request = params;
    return {
      items: Array.from({ length: 64 }, (_, index) => message(index)),
      history_view: {
        lineage: "compacted-page-lineage",
        epoch: 1,
        start_cursor: 0,
        end_cursor: 64,
        message_count: 128,
        turns: [],
      },
      truncated: false,
      next_cursor: null,
    };
  });
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
    route.fulfill({ json: { status: "missing", attempts: [] } }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await expect(page.getByTestId("trajectory-entry")).toHaveCount(64);
  await page.getByTestId("trajectory-load-older").click();
  await expect(page.getByTestId("trajectory-entry")).toHaveCount(128);
  expect(request.before_cursor).toBe(64);
  expect(request.limit).toBe(64);
  await expect(page.getByTestId("trajectory-entry").first()).toContainText(
    "Historical answer 0",
  );
  await expect(page.getByTestId("trajectory-load-older")).toHaveCount(0);
});

test("trajectory upward loading preserves the reading anchor and stays alongside the icon control", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = Array.from({ length: 160 }, (_, index) =>
    message(index),
  );
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
    route.fulfill({ json: { status: "missing", attempts: [] } }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const entries = page.getByTestId("trajectory-entry");
  await expect(entries).toHaveCount(96);
  const ledger = page.locator(".trajectory-ledger");
  await expect
    .poll(() =>
      ledger.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
      ),
    )
    .toBeLessThan(2);
  const anchor = entries.filter({ hasText: "Historical answer 64" });
  // Measure the row's position at scrollTop=0 without triggering a separate
  // programmatic scroll/load before the real wheel gesture.
  const before = await ledger.evaluate((node) => {
    const row = [
      ...node.querySelectorAll<HTMLElement>('[data-testid="trajectory-entry"]'),
    ].find((row) => row.textContent?.includes("Historical answer 64"))!;
    return row.getBoundingClientRect().y + node.scrollTop;
  });
  await ledger.hover();
  await page.mouse.wheel(0, -100000);
  await expect(entries).toHaveCount(160);
  await expect
    .poll(async () => Math.abs((await anchor.boundingBox())!.y - before))
    .toBeLessThan(2);
  await expect(page.getByTestId("trajectory-load-older")).toHaveCount(0);
  expect(
    backend.commands.filter((command) => command.method === "session.blocks"),
  ).toHaveLength(0);
});
