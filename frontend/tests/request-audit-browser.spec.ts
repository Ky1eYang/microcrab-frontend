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
        timeline: [
          {
            epoch: 7,
            turn: 3,
            round: 2,
            sequence: 2,
            call_id: "provider-second",
            request_hash: "immutable_second",
            completion: "succeeded",
          },
        ],
        attempts: ["immutable_first", "immutable_second"].map((hash, i) => ({
          request_hash: hash,
          call_id: i === 1 ? "provider-second" : "provider-first",
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
  expect(selectors.at(-1)).toEqual({ epoch: 7, call_id: "provider-second" });
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
  await expect(
    page.getByRole("tab", { name: "请求增量", exact: true }),
  ).toHaveCount(0);
  await page
    .locator('[data-testid="trajectory-entry"][data-kind="model-request"]')
    .click();
  await page.getByRole("tab", { name: "请求增量", exact: true }).click();
  await expect(
    page.getByText("delta_attempt_1", { exact: false }),
  ).toBeVisible();
  expect(selectors.at(-1)).toEqual({ epoch: 7, call_id: "provider-second" });
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
  await page
    .locator('[data-testid="trajectory-entry"][data-kind="tool"]')
    .click();
  await page.getByRole("tab", { name: "请求信息", exact: true }).click();
  await page.getByLabel("请求范围").selectOption("schema");
  await expect
    .poll(() => selectors.at(-1))
    .toEqual({ epoch: 7, call_id: "provider-second" });
});

for (const width of [390, 1440]) {
  test(`request info at ${width}px renders and copies retained wire text without reconstruction`, async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    const position = { epoch: 2, turn: 1, round: 1 };
    const request =
      '\r\n{ "n":900719925474099312345,"n":-0,"escaped":"\\u754c", "fraction":1.20e+03 } \r\n';
    const pretty =
      '{\n  "n": 900719925474099312345,\n  "n": -0,\n  "escaped": "\\u754c",\n  "fraction": 1.20e+03\n}';
    const frames = [
      ": comment 界\r\n\r\n",
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"n\\":"}}]}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1.20e+03}"}}]},"finish_reason":"tool_calls"}]}\r\n\r\n',
      "data: [DONE]\r\n\r\n",
    ];
    const terminal = frames.join("");
    const prefix = frames.slice(0, 2).join("");
    const normalized = { tool_calls: [{ arguments: { n: 1200 } }] };
    const timeline = {
      ...position,
      sequence: 1,
      call_id: "wire-call",
      request_hash: "wire-hash",
      completion: "succeeded",
    };
    backend.snapshot().messages = [
      {
        id: "wire-user",
        role: "user",
        text: "Inspect wire evidence",
        parts: [],
        tool_calls: [],
        position: { ...position, round: 0 },
      },
    ];
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text: string) =>
            Reflect.set(window, "__copiedAuditText", text),
        },
      });
    });
    type WireWitness = {
      sent_request?: string | null;
      response_raw?: string | null;
      response_complete?: boolean | null;
      response?: unknown;
      response_omitted?: boolean;
      outcome?: unknown;
    };
    let witness: WireWitness = {
      sent_request: request,
      response_raw: terminal,
      response_complete: true,
      response: normalized,
    };
    await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
      route.fulfill({
        json: {
          status: "available",
          committed_sequence: 3,
          incomplete_tail: false,
          timeline: [timeline],
          attempts: [
            {
              ...timeline,
              status: "available",
              request_document: '{"normalizedRequestOnly":true}',
              response_status: 200,
              response_content_type: "text/event-stream; charset=utf-8",
              ...witness,
            },
          ],
        },
      }),
    );
    await page.goto("/#session/s1");
    await page.getByRole("tab", { name: "轨迹", exact: true }).click();
    await page
      .locator('[data-testid="trajectory-entry"][data-kind="model-request"]')
      .click();
    await page.getByRole("tab", { name: "请求信息", exact: true }).click();
    const info = page.getByTestId("request-audit-metadata");
    const sent = info.getByTestId("audit-sent");
    const original = info.getByTestId("audit-response-original");
    const formatted = info.getByTestId("audit-response-normalized");
    const copied = () =>
      page.evaluate(() => Reflect.get(window, "__copiedAuditText"));

    await sent.locator("summary").click();
    const sentBody = sent.getByTestId("audit-sent-body");
    await expect(sentBody).toHaveAttribute("data-format", "json");
    expect(await sentBody.locator("pre").textContent()).toBe(pretty);
    await sentBody.getByRole("button", { name: "显示精确证据" }).click();
    await expect(sentBody).toHaveAttribute("data-format", "text");
    expect(await sentBody.locator("pre").textContent()).toBe(request);
    await sentBody.getByRole("button", { name: "复制精确证据" }).click();
    await expect.poll(copied).toBe(request);
    await sentBody.getByRole("button", { name: "显示简洁视图" }).click();
    await expect(sentBody).toHaveAttribute("data-format", "json");

    await original.locator("summary").click();
    await expect(original).toContainText("原始 SSE 文本 · HTTP 200");
    await expect(original.getByRole("status")).toHaveCount(0);
    const rawBody = original.getByTestId("audit-response-body");
    expect(await rawBody.locator("pre").textContent()).toBe(terminal);
    await rawBody.locator(".payload-copy").click();
    await expect.poll(copied).toBe(terminal);
    await formatted.locator("summary").click();
    await expect(formatted).toContainText('"n": 1200');
    await expect(formatted).not.toContainText("[DONE]");
    expect(
      await info.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);

    witness = {
      response_raw: prefix,
      response_complete: false,
      outcome: "cancelled",
    };
    backend.event("audit.available", { epoch: 2 });
    await expect(original.getByRole("status")).toContainText("响应已截断");
    expect(await rawBody.locator("pre").textContent()).toBe(prefix);
    await rawBody.locator(".payload-copy").click();
    await expect.poll(copied).toBe(prefix);
    await expect(formatted).toContainText("请求尝试结果（仅元数据）");
    await expect(sent).toContainText("实际发送的原始请求正文不可用");
    await expect(sent).toContainText("规范化请求文档（非原始正文）");
    await expect(sentBody).toHaveCount(0);

    witness = {
      response_raw: null,
      response_complete: false,
      response_omitted: true,
    };
    backend.event("audit.available", { epoch: 2 });
    await expect(original).toContainText(
      "响应捕获不完整，没有可显示的原始文本",
    );
    await expect(rawBody).toHaveCount(0);
    await expect(formatted).toContainText("当前视图已省略规范化模型返回");

    witness = { response: prefix }; // Legacy fallback returned raw text in the normalized field.
    backend.event("audit.available", { epoch: 2 });
    await expect(formatted).toContainText("没有可用的规范化模型返回");
    await expect(formatted).not.toContainText("tool_calls");
    await expect(original).toContainText("原始响应文本不可用");
    await expect(original).not.toContainText("响应捕获不完整");
    await expect(rawBody).toHaveCount(0);

    const overBudget = `{"long":"${"x".repeat(130 * 1024)}"}`;
    witness = { sent_request: overBudget, response_raw: prefix, response_complete: null };
    backend.event("audit.available", { epoch: 2 });
    await expect(original).toContainText("无法确认捕获内容是否包含完整响应");
    expect(await rawBody.locator("pre").textContent()).toBe(prefix);
    await expect(sent).toContainText("无格式化 JSON 预览");
    expect(await sentBody.locator("pre").textContent()).toBe(overBudget);
    await sentBody.locator(".payload-copy").click();
    await expect.poll(copied).toBe(overBudget);
  });
}

test("protected image trajectory separates authored arguments, frozen schema and omitted wire body", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const position = { epoch: 7, turn: 3, round: 2 };
  const callId = "protected-image-call";
  backend.snapshot().messages = [
    {
      id: "image-user",
      role: "user",
      text: "Inspect the file",
      parts: [],
      tool_calls: [],
      position: { ...position, round: 0 },
    },
    {
      id: "image-assistant",
      role: "assistant",
      text: null,
      parts: [],
      tool_calls: [
        {
          id: callId,
          name: "view_image",
          presentation: "view-image",
          arguments: { image_url: "file:[redacted]" },
        },
      ],
      position,
    },
    {
      id: "image-result",
      role: "tool",
      text: "image admitted",
      parts: [],
      tool_calls: [],
      call_id: callId,
      tool_name: "view_image",
      position,
    },
  ];
  const selectors: any[] = [];
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) => {
    const selector = route.request().postDataJSON();
    selectors.push(selector);
    const authored = selector.tool_call_id === callId && selector.round === 2;
    return route.fulfill({
      json: {
        status: "omitted",
        committed_sequence: 20,
        incomplete_tail: false,
        ...(authored
          ? { authored_tool_arguments: { image_url: "file:///work/image.png" } }
          : {}),
        attempts: [
          {
            request_hash: "protected-record",
            call_id: "provider-protected",
            ...position,
            status: "omitted",
            completion: "succeeded",
            protected_tool_call_ids: [callId],
            frozen_tools: [
              {
                name: "view_image",
                parameters: {
                  type: "object",
                  required: ["image_url"],
                  properties: { image_url: { type: "string" } },
                },
              },
            ],
          },
        ],
      },
    });
  });
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await page
    .locator('[data-testid="trajectory-entry"][data-kind="tool"]')
    .click();
  await page.getByRole("tab", { name: "参数", exact: true }).click();
  await expect(page.getByText(/file:\/\/\/work\/image\.png/)).toBeVisible();
  expect(selectors).toContainEqual({ ...position, tool_call_id: callId });
  await page.getByRole("tab", { name: "Schema", exact: true }).click();
  await expect(page.getByTestId("request-audit-schema")).toContainText(
    "不是提供商请求正文",
  );
  await expect(page.getByTestId("historical-tool-schema")).toContainText(
    "image_url",
  );
  await page.getByRole("tab", { name: "请求信息", exact: true }).click();
  const info = page.getByTestId("request-audit-metadata");
  await expect(info).toContainText("provider-protected");
  await info.getByText("实际发送请求", { exact: true }).click();
  await expect(info).toContainText("敏感请求正文未留存");
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
        timeline: [
          {
            epoch: 2,
            turn: 1,
            round: 1,
            sequence: 1,
            call_id: "omitted-provider",
            request_hash: "omitted_request",
            completion: "succeeded",
          },
        ],
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
    .locator('[data-testid="trajectory-entry"][data-kind="model-request"]')
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
        timeline: [
          {
            epoch: 3,
            turn: 1,
            round: 1,
            sequence: 1,
            call_id: "initial-provider",
            request_hash: "initial_hash",
            completion: "succeeded",
          },
        ],
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
    .locator('[data-testid="trajectory-entry"][data-kind="model-request"]')
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
