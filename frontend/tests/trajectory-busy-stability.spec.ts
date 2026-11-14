import { expect, test, type Route } from "@playwright/test";
import type { NativeMessage } from "../src/client/types";
import { nativeBackend } from "./native-fixture";

const messages = (count: number): NativeMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `busy-history-${index}`,
    role: index % 2 ? "assistant" : "user",
    text: `Busy historical record ${index}`,
    parts: [],
    tool_calls: [],
    position: { epoch: 0, turn: Math.floor(index / 2) + 1, round: 1 },
  }));
const helper = {
  request_hash: "busy-old-review",
  call_id: "busy-review-call",
  sequence: 1,
  epoch: 0,
  turn: 21,
  round: 1,
  subagent: "action_review",
  status: "available",
  completion: "succeeded",
  response: "Retained historical helper result",
  started_at_ms: 5050,
  ended_at_ms: 5055,
};
const model = {
  request_hash: "busy-old-model",
  call_id: "busy-model-call",
  sequence: 2,
  epoch: 0,
  turn: 1,
  round: 1,
  branch_selected: true,
  history_head: "head-1",
  completion: "succeeded",
  started_at_ms: 1001,
  ended_at_ms: 1005,
};
const audit = (extra = false) => ({
  status: "available",
  committed_sequence: extra ? 5 : 2,
  incomplete_tail: false,
  attempts: [helper],
  timeline: [
    ...Array.from({ length: 30 }, (_, index) => ({
      ...model,
      request_hash: index ? `busy-model-${index}` : model.request_hash,
      call_id: `busy-model-call-${index}`,
      turn: index * 2 + 1,
      started_at_ms: 1001 + index * 400,
      ended_at_ms: 1005 + index * 400,
    })),
    ...(extra
      ? [
          {
            ...model,
            request_hash: "late-historical-clock",
            call_id: "late-clock",
            sequence: 3,
            turn: 10,
            started_at_ms: 2801,
            ended_at_ms: 2805,
          },
        ]
      : []),
  ],
  stages: [],
});

// Exercise the actual busy subscription/projector, audit hook and execution
// content hydration together. No direct component-state injection replaces them.
test("busy trajectory keeps historical helper selection and viewport across queued audit reads and delayed execution hydration", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    extraMethods: ["executions.content"],
  });
  const snapshot = backend.snapshot();
  snapshot.session.status = "busy";
  snapshot.messages = messages(120);
  snapshot.history = { checkpoint: "head-1" };
  snapshot.history_view = {
    lineage: "busy-selected",
    epoch: 0,
    message_count: 120,
    start_cursor: 0,
    end_cursor: 120,
    turns: [],
  };
  let first = true;
  const pendingAudit: Route[] = [];
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) => {
    if (!route.request().postDataJSON().internal_assistants)
      return route.fulfill({ json: audit() });
    if (first) {
      first = false;
      return route.fulfill({ json: audit() });
    }
    pendingAudit.push(route);
  });
  const content: Route[] = [];
  await page.route("**/api/v1/sessions/s1/executions/23/content?*", (route) => {
    content.push(route);
  });
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const ledger = page.locator(".trajectory-ledger");
  await expect(
    ledger.locator('[data-trajectory-id*="busy-review-call"]'),
  ).toHaveCount(1);
  await ledger.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(ledger.getByTestId("trajectory-entry")).toHaveCount(151);
  const chosen = ledger.locator('[data-trajectory-id*="busy-review-call"]');
  await chosen.click();
  const inspector = page.getByTestId("trajectory-inspector");
  await inspector.getByRole("tab", { name: "原始内容", exact: true }).click();
  await expect(inspector).toContainText("Retained historical helper result");
  const before = await chosen.boundingBox();
  await chosen.evaluate((node) => {
    const state = { node, removed: false };
    (window as any).__busyRead = state;
    new MutationObserver(() => {
      state.removed ||= !state.node.isConnected;
    }).observe(node.closest(".trajectory-ledger")!, {
      childList: true,
      subtree: true,
    });
  });

  snapshot.messages = messages(124);
  snapshot.history = { checkpoint: "head-2" };
  snapshot.session.revision++;
  snapshot.history_view!.message_count = 124;
  snapshot.history_view!.end_cursor = 124;
  backend.publish(snapshot);
  await expect.poll(() => pendingAudit.length).toBe(1);
  await expect(chosen).toHaveAttribute("data-selected", "true");
  await expect(inspector).toContainText("Retained historical helper result");
  // More appends/control-audit notifications arrive while the first read waits.
  // They must coalesce, not cancel every earlier request or clear loaded rows.
  snapshot.messages = messages(128);
  snapshot.history = { checkpoint: "head-3" };
  snapshot.session.revision++;
  snapshot.history_view!.message_count = 128;
  snapshot.history_view!.end_cursor = 128;
  backend.publish(snapshot);
  backend.event("audit.available", { sequence: 3 });
  backend.event("audit.available", { sequence: 4 });
  backend.event("tool", {
    execution_id: 23,
    call_id: "busy-tail-tool",
    name: "read",
    phase: "completed",
    operation_id: "busy-operation",
    epoch: 0,
    turn: 65,
    round: 1,
    started_at_unix_ms: 15000,
    elapsed_ms: 8,
  });
  await expect.poll(() => content.length).toBe(2);
  expect(pendingAudit).toHaveLength(1);
  await expect(chosen).toHaveAttribute("data-selected", "true");
  expect(Math.abs((await chosen.boundingBox())!.y - before!.y)).toBeLessThan(2);

  for (const route of content) {
    const field = new URL(route.request().url()).searchParams.get("field")!;
    const text =
      field === "arguments"
        ? '{"path":"fixture"}'
        : "Late hydrated tail output";
    const bytes = new TextEncoder().encode(text).length;
    await route.fulfill({
      json: {
        session_id: "s1",
        execution_id: 23,
        call_id: "busy-tail-tool",
        field,
        content: text,
        cursor: 0,
        next_cursor: bytes,
        end_cursor: bytes,
        revision: 1,
        source_hash: `${field}-source`,
        available: true,
      },
    });
  }
  await expect(
    ledger.getByTestId("trajectory-entry").filter({ hasText: "fixture" }),
  ).toHaveCount(1);
  await pendingAudit[0].fulfill({ json: audit(true) });
  await expect.poll(() => pendingAudit.length).toBe(2);
  // The first completion still enriches this proven lineage even though a newer
  // checkpoint is already waiting. New clock rows above the reader are anchored.
  await expect(
    ledger.locator('[data-trajectory-id*="late-historical-clock"]'),
  ).toHaveCount(1);
  await expect(chosen).toHaveAttribute("data-selected", "true");
  expect(Math.abs((await chosen.boundingBox())!.y - before!.y)).toBeLessThan(2);
  // A bounded suffix response must not erase already loaded helper/model evidence.
  await pendingAudit[1].fulfill({
    json: { ...audit(), attempts: [], timeline: [] },
  });
  await expect(
    inspector.getByRole("tab", { name: "原始内容", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(inspector).toContainText("Retained historical helper result");
  await expect(chosen).toHaveAttribute("data-selected", "true");
  expect(Math.abs((await chosen.boundingBox())!.y - before!.y)).toBeLessThan(2);
  expect(await page.evaluate(() => (window as any).__busyRead.removed)).toBe(
    false,
  );
  expect(
    await chosen.evaluate((node) => node === (window as any).__busyRead.node),
  ).toBe(true);
});

test("busy audit cache is fenced by selected lineage and delayed obsolete replies cannot restore an old helper", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  snapshot.session.status = "busy";
  snapshot.messages = messages(8);
  snapshot.history = { checkpoint: "head-1" };
  snapshot.history_view = {
    lineage: "original-lineage",
    epoch: 0,
    message_count: 8,
    start_cursor: 0,
    end_cursor: 8,
    turns: [],
  };
  let reads = 0;
  const delayed: Route[] = [];
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) => {
    if (++reads === 1) return route.fulfill({ json: audit() });
    delayed.push(route);
  });
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const helperRow = page.locator('[data-trajectory-id*="busy-review-call"]');
  await expect(helperRow).toHaveCount(1);
  snapshot.history = { checkpoint: "head-2" };
  snapshot.session.revision++;
  backend.publish(snapshot);
  await expect.poll(() => delayed.length).toBe(1);
  await expect(helperRow).toHaveCount(1);
  snapshot.history = { checkpoint: "other-branch" };
  snapshot.history_view!.lineage = "replacement-lineage";
  snapshot.session.revision++;
  backend.publish(snapshot);
  await expect.poll(() => delayed.length).toBe(2);
  await expect(helperRow).toHaveCount(0);
  await delayed[0].fulfill({ json: audit() });
  await delayed[1].fulfill({
    json: {
      ...audit(),
      attempts: [
        {
          ...helper,
          request_hash: "replacement-review",
          call_id: "replacement-call",
          turn: 1,
          response: "Replacement lineage helper",
        },
      ],
      timeline: [],
    },
  });
  await expect(
    page.locator('[data-trajectory-id*="replacement-call"]'),
  ).toHaveCount(1);
  await expect(helperRow).toHaveCount(0);
  await expect(
    page.locator('[data-trajectory-id*="busy-old-model"]'),
  ).toHaveCount(0);
});
