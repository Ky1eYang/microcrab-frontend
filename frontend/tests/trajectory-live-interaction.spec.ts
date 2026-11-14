import { expect, test } from "@playwright/test";
import type { NativeMessage } from "../src/client/types";
import { nativeBackend } from "./native-fixture";

const position = { epoch: 0, turn: 1, round: 1 };
const messages = (count: number): NativeMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `trajectory-live-${index}`,
    role: index % 2 ? "assistant" : "user",
    text: `Trajectory record ${index}`,
    parts: [],
    tool_calls: [],
    position: { epoch: 0, turn: Math.floor(index / 2) + 1, round: index % 2 },
  }));

// The fixture supplies transport facts; these assertions exercise real DOM
// layout, audit hydration, subscription updates and explicit selection.
test("trajectory enters at latest, retains read history and detail during live appends", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  snapshot.messages = messages(120);
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
    route.fulfill({ json: { status: "missing", attempts: [] } }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const ledger = page.locator(".trajectory-ledger");
  const rows = ledger.getByTestId("trajectory-entry");
  await expect(rows).toHaveCount(96);
  await expect
    .poll(() =>
      ledger.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
      ),
    )
    .toBeLessThan(2);
  await expect(rows.last()).toBeInViewport();

  // Load resident history using the existing upward gesture and preserve it.
  await ledger.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(rows).toHaveCount(120);
  const chosen = rows.filter({ hasText: "Trajectory record 0" });
  await chosen.click();
  const inspector = page.getByTestId("trajectory-inspector");
  await inspector.getByRole("tab", { name: "原始内容", exact: true }).click();
  const before = await ledger.evaluate((node) => node.scrollTop);
  snapshot.messages = messages(140);
  backend.publish(snapshot);
  await expect(rows).toHaveCount(140);
  await expect(chosen).toHaveAttribute("data-selected", "true");
  await expect(
    inspector.getByRole("tab", { name: "原始内容", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() => ledger.evaluate((node) => node.scrollTop))
    .toBe(before);
  await expect(chosen).toBeInViewport();

  await page.getByRole("tab", { name: "对话", exact: true }).click();
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await expect
    .poll(() =>
      ledger.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
      ),
    )
    .toBeLessThan(2);
});

test("returning from child inspection opens the retained parent trajectory at latest", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    children: [
      {
        parent_session_id: "s1",
        id: "scroll-child",
        name: "coding",
        status: "succeeded",
        availability: "persisted",
        messages: [],
        next_cursor: null,
        messages_truncated: false,
        executions: [],
      },
    ],
  });
  backend.snapshot().messages = messages(120);
  await page.route("**/audit/requests", (route) =>
    route.fulfill({ json: { status: "missing", attempts: [] } }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const ledger = page.locator(".trajectory-ledger");
  await expect
    .poll(() =>
      ledger.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
      ),
    )
    .toBeLessThan(2);
  await ledger.evaluate((node) => {
    node.scrollTop = 300;
  });
  await page.getByTestId("header-subagents").click();
  await page
    .locator(".subagent-menu-item")
    .getByRole("button", { name: "详情", exact: true })
    .click();
  await expect(page.getByTestId("child-content-view")).toBeVisible();
  await page
    .getByRole("navigation", { name: "会话路径" })
    .getByRole("button", { name: "原生会话", exact: true })
    .click();
  await expect(page.getByTestId("child-content-view")).toHaveCount(0);
  await expect
    .poll(() =>
      ledger.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
      ),
    )
    .toBeLessThan(2);
  await expect(ledger.getByTestId("trajectory-entry").last()).toBeInViewport();
});

test("live append retains an unselected history viewport across the recent-window limit", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  snapshot.messages = messages(96);
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
    route.fulfill({ json: { status: "missing", attempts: [] } }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const ledger = page.locator(".trajectory-ledger");
  await expect
    .poll(() =>
      ledger.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
      ),
    )
    .toBeLessThan(2);
  await ledger.evaluate((node) => {
    node.scrollTop = 300;
  });
  const before = await ledger.evaluate((node) => node.scrollTop);
  const anchor = ledger
    .getByTestId("trajectory-entry")
    .filter({ hasText: /Trajectory record 10(?!\d)/ });
  const top = (await anchor.boundingBox())!.y;
  snapshot.messages = messages(120);
  backend.publish(snapshot);
  await expect(ledger.getByTestId("trajectory-entry")).toHaveCount(120);
  await expect
    .poll(() => ledger.evaluate((node) => node.scrollTop))
    .toBe(before);
  expect(Math.abs((await anchor.boundingBox())!.y - top)).toBeLessThan(2);
  await expect(page.getByTestId("trajectory-inspector")).toHaveCount(0);
});

test("current Journal epoch discovers action review with no positioned messages and refreshes its result", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  snapshot.messages = [];
  snapshot.history_view = {
    lineage: "selected",
    epoch: 0,
    message_count: 0,
    start_cursor: 0,
    end_cursor: 0,
    turns: [],
  };
  let completed = false;
  const selectors: Record<string, unknown>[] = [];
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) => {
    selectors.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        status: "available",
        attempts: [
          {
            request_hash: "review-request",
            call_id: "review-call",
            sequence: 64,
            ...position,
            subagent: "action_review",
            status: "available",
            completion: completed ? "succeeded" : "pending",
            response: completed ? { content: '{"decision":"allow"}' } : null,
            started_at_ms: 1000,
            ended_at_ms: completed ? 5508 : null,
          },
        ],
      },
    });
  });
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const review = page.locator(
    '[data-testid="trajectory-entry"][data-kind="internal-assistant"]',
  );
  await expect(review).toHaveCount(1);
  await expect(review).toContainText("action_review");
  await expect(review).toHaveAttribute("data-status", "awaiting-result");
  expect(selectors).toContainEqual(
    expect.objectContaining({ epoch: 0, internal_assistants: true }),
  );
  await expect(page.locator('[data-lane="sub"] button')).toHaveCount(1);
  await review.click();
  await page
    .getByTestId("trajectory-inspector")
    .getByRole("tab", { name: "预览", exact: true })
    .click();
  completed = true;
  backend.event("audit.available", { sequence: 65 });
  await expect(review).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("trajectory-inspector")).toContainText("allow");
  await expect(review).toHaveAttribute("data-selected", "true");
});

test("late audit hydration cannot scroll after trajectory user interaction", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = messages(80);
  let release: (() => Promise<void>) | undefined;
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) => {
    release = () =>
      route.fulfill({ json: { status: "missing", attempts: [] } });
  });
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const ledger = page.locator(".trajectory-ledger");
  await expect(ledger.getByTestId("trajectory-entry")).toHaveCount(80);
  await expect.poll(() => Boolean(release)).toBe(true);
  // Audit can be slow or disconnected. Entry must already show the latest row
  // before that independent request completes.
  await expect
    .poll(() =>
      ledger.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
      ),
    )
    .toBeLessThan(2);
  await expect(ledger.getByTestId("trajectory-entry").last()).toBeInViewport();
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await expect
    .poll(() =>
      ledger.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
      ),
    )
    .toBeLessThan(2);
  const chosen = ledger.getByTestId("trajectory-entry").first();
  await chosen.click();
  const before = await ledger.evaluate((node) => node.scrollTop);
  await release!();
  await expect(page.getByTestId("trajectory-inspector")).toBeVisible();
  await expect
    .poll(() => ledger.evaluate((node) => node.scrollTop))
    .toBe(before);
  await expect(chosen).toHaveAttribute("data-selected", "true");
});
