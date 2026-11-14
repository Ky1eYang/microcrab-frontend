import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("trajectory selects successful retry and historical schema for each exact request position", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = [
    {
      id: "content_hash_user",
      role: "user",
      text: "Read historical file",
      parts: [],
      tool_calls: [],
      position: { epoch: 7, turn: 3, round: 0 },
    },
    {
      id: "content_hash_assistant",
      role: "assistant",
      text: null,
      parts: [],
      tool_calls: [
        { id: "call_historical", name: "read", arguments: { path: "old.txt" } },
      ],
      position: { epoch: 7, turn: 3, round: 2 },
    },
    {
      id: "content_hash_result",
      role: "tool",
      text: "historical contents",
      parts: [],
      tool_calls: [],
      call_id: "call_historical",
      tool_name: "read",
      position: { epoch: 7, turn: 3, round: 2 },
    },
  ];
  const selectors: any[] = [];
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) => {
    selectors.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        status: "available",
        committed_sequence: 20,
        incomplete_tail: false,
        selected_request_hash: "immutable_second",
        attempts: ["immutable_first", "immutable_second"].map((hash, i) => ({
          request_hash: hash,
          completion: i === 1 ? "succeeded" : "failed",
          usage: i === 1 ? { input_tokens: 120, output_tokens: 8 } : null,
          token_delta: i === 1 ? { input_tokens: 23, output_tokens: -2 } : null,
          base_request: "immutable_base",
          history_head: `branch_${i}`,
          status: "available",
          epoch: 7,
          turn: 3,
          round: 2,
          baseline: "historical baseline",
          delta: `delta_attempt_${i}`,
          tools: [
            {
              type: "function",
              function: {
                name: "read",
                parameters: {
                  type: "object",
                  properties: { historical_only: { type: "boolean" } },
                },
              },
            },
          ],
          sent_request: "actual historical sent request",
        })),
      },
    });
  });
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await page
    .locator('[data-testid="trajectory-entry"][data-kind="tool"]')
    .click();
  await page.getByRole("tab", { name: "Schema", exact: true }).click();
  await expect(page.getByText("historical_only", { exact: false })).toBeVisible(
    { timeout: 30000 },
  );
  expect(selectors.at(-1)).toEqual({ epoch: 7, turn: 3, round: 2 });
  await expect(page.getByTestId("request-audit-schema")).not.toContainText(
    "请求 ID",
  );
  await expect(page.getByTestId("request-audit-schema")).not.toContainText(
    "immutable_base",
  );
  await expect(page.getByTestId("request-audit-schema")).not.toContainText(
    "实际发送请求",
  );
  await expect(page.getByLabel("请求尝试")).toHaveCount(0);
  backend.event("audit.available", {
    request_hash: "immutable_third",
    epoch: 7,
    turn: 3,
    round: 2,
  });
  await expect.poll(() => selectors.length).toBeGreaterThan(1);
  await expect(page.getByLabel("请求尝试")).toHaveCount(0);
  await page.getByRole("tab", { name: "请求增量", exact: true }).click();
  await expect(
    page.getByText("delta_attempt_1", { exact: false }),
  ).toBeVisible();
  expect(selectors.at(-1)).toEqual({
    epoch: 7,
    turn: 3,
    tool_call_id: "call_historical",
  });
  await expect(page.getByTestId("request-audit-diff")).not.toContainText(
    "historical baseline",
  );
  await expect(page.getByTestId("request-audit-diff")).not.toContainText(
    "immutable_base",
  );
  await expect(page.getByTestId("request-audit-diff")).not.toContainText(
    "实际发送请求",
  );
  await expect(page.locator('[data-token="input_tokens"]')).toHaveText("+23");
  await expect(page.locator('[data-token="output_tokens"]')).toHaveText("-2");
  await expect(page.locator('[data-token="cache_read_tokens"]')).toHaveText(
    "-",
  );
  await page.getByRole("tab", { name: "请求信息", exact: true }).click();
  const metadata = page.getByTestId("request-audit-metadata");
  await expect(metadata).toContainText("请求 ID");
  await expect(metadata).toContainText("immutable_base");
  await expect(metadata).not.toContainText("delta_attempt_0");
  await metadata.getByText("实际发送请求", { exact: true }).click();
  await expect(metadata).toContainText("actual historical sent request");
  await page.getByLabel("请求范围").selectOption("schema");
  await expect
    .poll(() => selectors.at(-1))
    .toEqual({ epoch: 7, turn: 3, round: 2 });
});

test("unavailable request diff never falls back to displaying the full baseline", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = [
    {
      id: "position_user",
      role: "user",
      text: "Inspect audit",
      parts: [],
      tool_calls: [],
      position: { epoch: 2, turn: 1, round: 0 },
    },
  ];
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
    route.fulfill({
      json: {
        status: "omitted",
        committed_sequence: 3,
        incomplete_tail: false,
        attempts: [
          {
            request_hash: "omitted_request",
            epoch: 2,
            turn: 1,
            round: 0,
            status: "omitted",
            baseline: "FULL_BASELINE_MUST_NOT_APPEAR",
            delta: null,
          },
        ],
      },
    }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await page
    .locator('[data-testid="trajectory-entry"][data-kind="user"]')
    .click();
  await page.getByRole("tab", { name: "请求增量", exact: true }).click();
  const diff = page.getByTestId("request-audit-diff");
  await expect(diff).toContainText("发送证据已省略");
  await expect(diff).not.toContainText("FULL_BASELINE_MUST_NOT_APPEAR");
  await expect(diff).not.toContainText("omitted_request");
});

test("request diff preserves unified context hunks and identifies an initial empty basis", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = [
    {
      id: "position_initial",
      role: "user",
      text: "Initial request",
      parts: [],
      tool_calls: [],
      position: { epoch: 3, turn: 1, round: 0 },
    },
  ];
  const delta =
    '--- empty\n+++ initial_hash\n@@ -0,0 +1,3 @@\n+{\n+  "messages": []\n+}\n';
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
    route.fulfill({
      json: {
        status: "available",
        committed_sequence: 4,
        incomplete_tail: false,
        attempts: [
          {
            request_hash: "initial_hash",
            epoch: 3,
            turn: 1,
            round: 0,
            status: "available",
            base_request: null,
            baseline: "",
            delta,
          },
        ],
      },
    }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await page
    .locator('[data-testid="trajectory-entry"][data-kind="user"]')
    .click();
  await page.getByRole("tab", { name: "请求增量", exact: true }).click();
  await expect(page.getByTestId("request-audit-diff")).not.toContainText(
    "初始增量",
  );
  await expect(page.getByTestId("request-audit-diff")).not.toContainText(
    "usage",
  );
  await expect(
    page.getByTestId("historical-request-diff").locator("pre"),
  ).toHaveText(delta.trimEnd().replace(/^--- [^\n]*\n\+\+\+ [^\n]*\n/, ""));
  await expect(page.getByTestId("request-audit-diff")).not.toContainText(
    "initial_hash",
  );
});
