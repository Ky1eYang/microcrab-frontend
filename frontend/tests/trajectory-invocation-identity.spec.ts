import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

const position = { epoch: 0, turn: 1, round: 1 };

test("selected live tool keeps its DOM, inspector tab and pixel anchor through canonical admission", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  snapshot.session.status = "running";
  snapshot.messages = [
    {
      id: "handoff-user",
      role: "user",
      text: "Inspect exact invocation",
      parts: [],
      tool_calls: [],
      position,
    },
  ];
  snapshot.history_view = {
    lineage: "handoff-lineage",
    epoch: 0,
    message_count: 1,
    start_cursor: 0,
    end_cursor: 1,
    turns: [],
  };
  await page.route("**/audit/requests", (route) =>
    route.fulfill({ json: { status: "missing", attempts: [] } }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  backend.event("model_observation", {
    operation_id: "handoff-op",
    call_id: "model-call",
    ...position,
    phase: "tool_call_delta",
    index: 0,
    id: "handoff-tool",
    name: "read",
    arguments: '{"path":"stable-handoff.txt"}',
  });
  const ledger = page.locator(".trajectory-ledger");
  const chosen = ledger
    .getByTestId("trajectory-entry")
    .filter({ hasText: "stable-handoff.txt" });
  await expect(chosen).toHaveCount(1);
  await chosen.click();
  const inspector = page.getByTestId("trajectory-inspector");
  await inspector.getByRole("tab", { name: "参数", exact: true }).click();
  const before = (await chosen.boundingBox())!.y;
  await chosen.evaluate((node) => {
    (window as any).__handoffRow = node;
  });
  await inspector.evaluate((node) => {
    (window as any).__handoffInspector = node;
  });
  snapshot.messages.push({
    id: "handoff-assistant",
    role: "assistant",
    text: "",
    parts: [],
    tool_calls: [
      {
        id: "handoff-tool",
        name: "read",
        arguments: { path: "stable-handoff.txt" },
      },
    ],
    position,
  });
  snapshot.history_view!.message_count = 2;
  snapshot.history_view!.end_cursor = 2;
  snapshot.session.revision++;
  backend.publish(snapshot);
  await expect(chosen).toHaveAttribute("data-selected", "true");
  await expect(
    inspector.getByRole("tab", { name: "参数", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    await chosen.evaluate((node) => node === (window as any).__handoffRow),
  ).toBe(true);
  expect(
    await inspector.evaluate(
      (node) => node === (window as any).__handoffInspector,
    ),
  ).toBe(true);
  expect(Math.abs((await chosen.boundingBox())!.y - before)).toBeLessThan(2);
  // Repeated canonical snapshots must retain the same presentation identity too.
  snapshot.session.revision++;
  backend.publish(snapshot);
  await expect(chosen).toHaveAttribute("data-selected", "true");
  expect(
    await chosen.evaluate((node) => node === (window as any).__handoffRow),
  ).toBe(true);
  // Forward Context changes preserve the exact canonical survivor and tab.
  snapshot.history_view!.epoch = 1;
  snapshot.session.revision++;
  backend.publish(snapshot);
  await expect(page.locator(".trajectory-view")).toHaveAttribute(
    "data-history-epoch",
    "1",
  );
  await expect(chosen).toHaveAttribute("data-selected", "true");
  await expect(
    inspector.getByRole("tab", { name: "参数", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    await chosen.evaluate((node) => node === (window as any).__handoffRow),
  ).toBe(true);
  expect(
    await inspector.evaluate(
      (node) => node === (window as any).__handoffInspector,
    ),
  ).toBe(true);
  expect(Math.abs((await chosen.boundingBox())!.y - before)).toBeLessThan(2);

  // A selected branch may still contain that exact canonical invocation.
  snapshot.history_view!.lineage = "other-selected-branch";
  snapshot.session.revision++;
  backend.publish(snapshot);
  await expect(page.locator(".trajectory-view")).toHaveAttribute(
    "data-history-lineage",
    "other-selected-branch",
  );
  await expect(chosen).toHaveAttribute("data-selected", "true");
  expect(
    await inspector.evaluate(
      (node) => node === (window as any).__handoffInspector,
    ),
  ).toBe(true);

  // Real branch replacement with different canonical identity revokes selection,
  // even if the tool call id, coordinates and payload remain identical.
  snapshot.history_view!.lineage = "replacement-without-survivor";
  snapshot.messages[1].id = "replacement-assistant";
  snapshot.session.revision++;
  backend.publish(snapshot);
  await expect(page.locator(".trajectory-view")).toHaveAttribute(
    "data-history-lineage",
    "replacement-without-survivor",
  );
  await expect(page.getByTestId("trajectory-inspector")).toHaveCount(0);
  await expect(chosen).toHaveAttribute("data-selected", "false");
});

test("identical audited request hashes keep separate invocation rows, lanes and selection", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  snapshot.messages = [1, 2].flatMap((turn) => [
    {
      id: `repeat-user-${turn}`,
      role: "user" as const,
      text: `Input ${turn}`,
      parts: [],
      tool_calls: [],
      position: { ...position, turn },
    },
    {
      id: `repeat-answer-${turn}`,
      role: "assistant" as const,
      text: `Answer ${turn}`,
      parts: [],
      tool_calls: [],
      position: { ...position, turn },
    },
  ]);
  snapshot.history_view = {
    lineage: "repeated-body-lineage",
    epoch: 0,
    message_count: 4,
    start_cursor: 0,
    end_cursor: 4,
    turns: [],
  };
  await page.route("**/audit/requests", (route) =>
    route.fulfill({
      json: {
        status: "available",
        attempts: [1, 2].map((turn) => ({
          request_hash: "identical-review-body",
          call_id: `review-call-${turn}`,
          sequence: turn,
          ...position,
          turn,
          subagent: "action_review",
          history_head: `head-${turn}`,
          completion: "succeeded",
          response: `Distinct helper ${turn}`,
          started_at_ms: 1000 * turn,
          ended_at_ms: 1000 * turn + 10,
        })),
        timeline: [1, 2].map((turn) => ({
          request_hash: "identical-model-body",
          call_id: `model-call-${turn}`,
          sequence: turn,
          ...position,
          turn,
          history_head: `head-${turn}`,
          branch_selected: true,
          completion: "succeeded",
          started_at_ms: 1000 * turn + 20,
          ended_at_ms: 1000 * turn + 100,
        })),
        stages: [],
      },
    }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const helpers = page.locator(
    '[data-testid="trajectory-entry"][data-kind="internal-assistant"]',
  );
  const models = page.locator(
    '[data-testid="trajectory-entry"][data-kind="model-request"]',
  );
  await expect(helpers).toHaveCount(2);
  await expect(models).toHaveCount(2);
  expect(
    new Set(
      await helpers.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-trajectory-id")),
      ),
    ).size,
  ).toBe(2);
  expect(
    new Set(
      await models.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-trajectory-id")),
      ),
    ).size,
  ).toBe(2);
  await expect(page.locator('[data-lane="sub"] button')).toHaveCount(2);
  await expect(
    page.locator('[data-lane="input"] button[title^="模型输入"]'),
  ).toHaveCount(2);
  await helpers.nth(1).click();
  await page
    .getByTestId("trajectory-inspector")
    .getByRole("tab", { name: "原始内容", exact: true })
    .click();
  await expect(page.getByTestId("trajectory-inspector")).toContainText(
    "Distinct helper 2",
  );
  await expect(helpers.nth(0)).toHaveAttribute("data-selected", "false");
  await expect(helpers.nth(1)).toHaveAttribute("data-selected", "true");
});
