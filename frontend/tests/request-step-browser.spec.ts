import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

const messages = [
  {
    id: "u",
    role: "user",
    text: "Inspect one step",
    parts: [],
    tool_calls: [],
    position: { epoch: 2, turn: 6, round: 0 },
  },
  {
    id: "a",
    role: "assistant",
    text: null,
    parts: [],
    tool_calls: [{ id: "c", name: "pwsh", arguments: { command: "Get-Date" } }],
    position: { epoch: 2, turn: 6, round: 1 },
  },
  {
    id: "t",
    role: "tool",
    text: "date",
    parts: [],
    tool_calls: [],
    call_id: "c",
    tool_name: "pwsh",
    position: { epoch: 2, turn: 6, round: 1 },
  },
];

test("user first request and tool continuation have separate deltas; pending usage stays unknown", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = messages;
  const selectors: any[] = [];
  let answered = false;
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) => {
    const selector = route.request().postDataJSON();
    if (selector.internal_assistants)
      return route.fulfill({
        json: {
          status: "available",
          attempts: [],
          timeline: [1, 2].map((round) => ({
            epoch: 2,
            turn: 6,
            round,
            sequence: round,
            call_id: `provider-${round}`,
            request_hash: round === 1 ? "initial" : "continuation",
            completion: answered ? "succeeded" : "pending",
          })),
        },
      });
    selectors.push(selector);
    const continuation = selector.call_id === "provider-2";
    return route.fulfill({
      json: {
        status: "available",
        committed_sequence: 20,
        incomplete_tail: false,
        selected_request_hash: continuation ? "continuation" : "initial",
        attempts: [
          {
            request_hash: continuation ? "continuation" : "initial",
            epoch: 2,
            turn: 6,
            round: continuation ? 2 : 1,
            status: "available",
            base_request: "previous",
            delta: continuation ? "ONLY_TOOL_RESULT_DELTA" : "ONLY_USER_DELTA",
            completion: answered ? "succeeded" : "pending",
            usage: answered ? { input_tokens: 123 } : null,
            token_delta: answered ? { input_tokens: 12 } : null,
          },
        ],
      },
    });
  });
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const requests = page.locator(
    '[data-testid="trajectory-entry"][data-kind="model-request"]',
  );
  await expect(requests).toHaveCount(2);
  await expect(
    requests.first().getByRole("img", { name: "已发送模型请求" }),
  ).toBeVisible();
  await requests.first().click();
  await page.getByRole("tab", { name: "请求增量", exact: true }).click();
  await expect(page.getByTestId("historical-request-diff")).toContainText(
    "ONLY_USER_DELTA",
  );
  expect(selectors.at(-1)).toEqual({ epoch: 2, call_id: "provider-1" });
  await expect(
    page.getByTestId("request-token-delta").locator("dd"),
  ).toHaveText(["-", "-", "-", "-", "-"]);
  const geometry = await page
    .getByTestId("request-audit-diff")
    .evaluate((root) => {
      const token = root
        .querySelector(".request-audit-tokens")!
        .getBoundingClientRect();
      const diff = root
        .querySelector(".request-audit-diff")!
        .getBoundingClientRect();
      const body = root.getBoundingClientRect();
      return {
        tokenHeight: token.height,
        diffHeight: diff.height,
        gap: diff.top - token.bottom,
        bottom: body.bottom - diff.bottom,
        height: body.height,
      };
    });
  expect(geometry.tokenHeight).toBeGreaterThan(40);
  expect(geometry.diffHeight).toBeGreaterThan(40);
  expect(Math.abs(geometry.gap)).toBeLessThan(2);
  expect(Math.abs(geometry.bottom)).toBeLessThan(2);
  answered = true;
  backend.event("audit.available", { epoch: 2, turn: 6, round: 1 });
  await expect(page.locator('[data-token="input_tokens"]')).toHaveText("+12");
  for (const kind of ["user", "tool", "model-generation"]) {
    const row = page.locator(
      `[data-testid="trajectory-entry"][data-kind="${kind}"]`,
    );
    await row.click();
    await expect(
      page.getByRole("tab", { name: "请求增量", exact: true }),
    ).toHaveCount(0);
    await expect(row.getByRole("img", { name: "已发送模型请求" })).toHaveCount(
      0,
    );
  }
  await requests.last().click();
  await page.getByRole("tab", { name: "请求增量", exact: true }).click();
  await expect(page.getByTestId("historical-request-diff")).toContainText(
    "ONLY_TOOL_RESULT_DELTA",
  );
  expect(selectors.at(-1)).toEqual({ epoch: 2, call_id: "provider-2" });
  await expect(page.getByLabel("请求尝试")).toHaveCount(0);
});

test("failed retries select the final result while helpers retain exact assistant scope", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = messages;
  const selectors: any[] = [];
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) => {
    const selector = route.request().postDataJSON();
    selectors.push(selector);
    if (selector.internal_assistants)
      return route.fulfill({
        json: {
          status: "available",
          timeline: [
            {
              epoch: 2,
              turn: 6,
              round: 1,
              sequence: 2,
              call_id: "failed-provider",
              request_hash: "failed_2",
              completion: "failed",
            },
          ],
          attempts: [
            {
              request_hash: "helper",
              call_id: "rename-call",
              epoch: 2,
              turn: null,
              round: null,
              subagent: "rename",
              status: "available",
              completion: "succeeded",
              response: { content: "SESSION_TITLE" },
            },
          ],
        },
      });
    const helper = selector.subagent === "rename";
    return route.fulfill({
      json: {
        status: "available",
        incomplete_tail: false,
        attempts: helper
          ? [
              {
                request_hash: "helper",
                call_id: "rename-call",
                epoch: 2,
                subagent: "rename",
                status: "available",
                completion: "succeeded",
                delta: "HELPER_ONLY_DELTA",
                response: { content: "SESSION_TITLE" },
                sent_request: "HELPER_REQUEST",
                usage: { input_tokens: 4 },
                token_delta: { input_tokens: 4 },
              },
            ]
          : [1, 2].map((i) => ({
              request_hash: `failed_${i}`,
              epoch: 2,
              turn: 6,
              round: 1,
              status: "available",
              completion: "failed",
              delta: `FAILED_REQUEST_${i}`,
            })),
      },
    });
  });
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await page
    .locator('[data-testid="trajectory-entry"][data-kind="model-request"]')
    .click();
  await page.getByRole("tab", { name: "请求增量", exact: true }).click();
  await expect(page.getByTestId("historical-request-diff")).toContainText(
    "FAILED_REQUEST_2",
  );
  await expect(page.getByTestId("historical-request-diff")).not.toContainText(
    "FAILED_REQUEST_1",
  );
  const helper = page.locator(
    '[data-testid="trajectory-entry"][data-kind="internal-assistant"]',
  );
  await expect(helper).toContainText("rename");
  await helper.click();
  await page.getByRole("tab", { name: "请求增量", exact: true }).click();
  await expect(page.getByTestId("historical-request-diff")).toContainText(
    "HELPER_ONLY_DELTA",
  );
  expect(selectors.at(-1)).toEqual({
    epoch: 2,
    subagent: "rename",
    call_id: "rename-call",
  });
  await page.getByRole("tab", { name: "请求信息", exact: true }).click();
  const metadata = page.getByTestId("request-audit-metadata");
  const disclosure = metadata.getByTestId("audit-response-normalized");
  await disclosure.locator("summary").click();
  await expect(disclosure).toContainText("SESSION_TITLE");
  await expect(disclosure).toHaveAttribute("open", "");
  await disclosure.evaluate((node) => {
    (window as any).__auditDisclosure = node;
  });
  const beforeRefresh = selectors.length;
  backend.event("audit.available", { epoch: 2 });
  await expect.poll(() => selectors.length).toBeGreaterThan(beforeRefresh);
  await expect(disclosure).toHaveAttribute("open", "");
  expect(
    await disclosure.evaluate(
      (node) => node === (window as any).__auditDisclosure,
    ),
  ).toBe(true);
});

test("internal request without a terminal result is never labelled completed", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = messages;
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
    route.fulfill({
      json: {
        status: "pending",
        attempts: [
          {
            request_hash: "pending_helper",
            call_id: "pending_call",
            epoch: 2,
            turn: null,
            round: null,
            subagent: "rename",
            status: "available",
            completion: "pending",
            response: null,
          },
        ],
      },
    }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await page
    .locator('[data-testid="trajectory-entry"][data-kind="internal-assistant"]')
    .click();
  const inspector = page.getByTestId("trajectory-inspector");
  await expect(inspector).toContainText("尚无结果");
  await expect(inspector).toContainText("尚无模型返回证据");
  await expect(inspector).not.toContainText("已完成");
  await expect(inspector).not.toContainText("进行中");
});

test("helpers use their names and appear between conversation events by actual audit time", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = [
    {
      id: "u1",
      role: "user",
      text: "First",
      parts: [],
      tool_calls: [],
      position: { epoch: 2, turn: 1, round: 0 },
    },
    {
      id: "a1",
      role: "assistant",
      text: "First reply",
      parts: [],
      tool_calls: [],
      position: { epoch: 2, turn: 1, round: 1 },
    },
    {
      id: "u2",
      role: "user",
      text: "Second",
      parts: [],
      tool_calls: [],
      position: { epoch: 2, turn: 2, round: 0 },
    },
    {
      id: "a2",
      role: "assistant",
      text: "Second reply",
      parts: [],
      tool_calls: [],
      position: { epoch: 2, turn: 2, round: 1 },
    },
  ];
  const helper = (name: string, start: number, sequence: number) => ({
    request_hash: name,
    call_id: name,
    epoch: 2,
    turn: null,
    round: null,
    subagent: name,
    status: "available",
    completion: "succeeded",
    response: name + " response",
    started_at_ms: start,
    ended_at_ms: start + 1,
    sequence,
  });
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
    route.fulfill({
      json: {
        status: "available",
        attempts: [helper("rename", 1500, 3), helper("action_review", 1100, 2)],
        timeline: [
          {
            request_hash: "main1",
            call_id: "main1",
            epoch: 2,
            turn: 1,
            round: 1,
            sequence: 1,
            started_at_ms: 1000,
            ended_at_ms: 1200,
            completion: "succeeded",
          },
          {
            request_hash: "main2",
            call_id: "main2",
            epoch: 2,
            turn: 2,
            round: 1,
            sequence: 4,
            started_at_ms: 2000,
            ended_at_ms: 2200,
            completion: "succeeded",
          },
        ],
      },
    }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const entries = page.getByTestId("trajectory-entry");
  await expect(entries).toHaveCount(8);
  await expect(entries.locator(".trajectory-entry-kind")).toHaveText([
    "用户",
    "模型输入",
    "action_review",
    "消息",
    "rename",
    "用户",
    "模型输入",
    "消息",
  ]);
  await expect(page.locator(".trajectory-ledger")).not.toContainText(
    "内部助手",
  );
  backend.event("audit.available", { epoch: 2 });
  await expect(entries.locator(".trajectory-entry-kind")).toHaveText([
    "用户",
    "模型输入",
    "action_review",
    "消息",
    "rename",
    "用户",
    "模型输入",
    "消息",
  ]);
});
