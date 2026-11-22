import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

const messages = [
  {
    id: "u",
    role: "user",
    text: "Work",
    parts: [],
    tool_calls: [],
    position: { epoch: 2, turn: 1, round: 0 },
  },
  {
    id: "a",
    role: "assistant",
    text: null,
    parts: [],
    tool_calls: [
      { id: "one", name: "pwsh", arguments: { command: "one" } },
      { id: "two", name: "read", arguments: { path: "two" } },
    ],
    position: { epoch: 2, turn: 1, round: 1 },
  },
  ...["one", "two"].map((id) => ({
    id: `result-${id}`,
    role: "tool",
    text: `${id} result`,
    parts: [],
    tool_calls: [],
    call_id: id,
    tool_name: id === "one" ? "pwsh" : "read",
    position: { epoch: 2, turn: 1, round: 1 },
  })),
  {
    id: "final",
    role: "assistant",
    text: "Done",
    parts: [],
    tool_calls: [],
    position: { epoch: 2, turn: 1, round: 2 },
  },
];
const model = (round: number, start: number, end: number) => ({
  request_hash: `model-${round}`,
  sequence: round,
  call_id: `model-${round}`,
  epoch: 2,
  turn: 1,
  round,
  started_at_ms: start,
  ended_at_ms: end,
  completion: "succeeded",
  history_head: "branch",
});
const tool = (id: string, start: number, end: number, head = "branch") => ({
  kind: "tool",
  sequence: 3,
  epoch: 2,
  turn: 1,
  round: 1,
  tool_call_id: id,
  name: id,
  started_at_ms: start,
  ended_at_ms: end,
  completion: "succeeded",
  history_head: head,
});

test("historical failure is red and explicit on a narrow trajectory; sibling branch failures do not transfer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 760 });
  const backend = await nativeBackend(page);
  backend.snapshot().messages = messages;
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
    route.fulfill({
      json: {
        status: "available",
        attempts: [],
        timeline: [model(1, 1000, 2000), model(2, 2600, 3000)],
        stages: [
          { ...tool("one", 2000, 2400), completion: "failed" },
          tool("two", 2100, 2600),
          { ...tool("two", 2100, 2600, "sibling"), completion: "failed" },
        ],
      },
    }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const failed = page.locator(
    '[data-testid="trajectory-entry"][data-kind="tool"][data-status="failed"]',
  );
  await expect(failed).toHaveCount(1);
  await expect(failed).toContainText("pwsh");
  await expect(failed).toContainText("失败");
  await expect(failed.locator(".trajectory-title-number")).toHaveCount(0);
  await expect(failed.locator(".trajectory-entry-time")).toHaveCSS(
    "color",
    /rgb\((248, 113, 113|220, 38, 38)\)/,
  );
  const segment = page.locator(
    '[data-testid="trajectory-seg"][data-lane="tool"][data-status="failed"]',
  );
  await expect(segment).toHaveAccessibleName(/失败/);
  await segment.focus();
  await page.keyboard.press("Enter");
  const inspector = page.getByTestId("trajectory-inspector");
  await expect(inspector.locator('dd[data-status="failed"]')).toHaveText(
    "失败",
  );
  await expect(inspector.getByRole("tab", { name: "请求增量" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.keyboard.press("Escape");
  await expect(inspector).toHaveCount(0);
});

for (const inputRound of [0, 1]) {
  test(`model and parallel tool ranges preserve input order (input round ${inputRound})`, async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    backend.snapshot().messages = messages.map((message, index) =>
      index === 0
        ? { ...message, position: { ...message.position, round: inputRound } }
        : message,
    );
    await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
      route.fulfill({
        json: {
          status: "available",
          attempts: [
            {
              request_hash: "rename",
              call_id: "rename",
              sequence: 4,
              epoch: 2,
              turn: null,
              round: null,
              subagent: "rename",
              completion: "succeeded",
              response: "Title",
              started_at_ms: 1300,
              ended_at_ms: 1400,
            },
          ],
          timeline: [model(1, 1000, 2000), model(2, 2600, 3000)],
          stages: [
            tool("one", 2000, 2400),
            tool("two", 2100, 2600),
            tool("one", 2000, 99000, "other-branch"),
          ],
        },
      }),
    );
    await page.goto("/#session/s1");
    await page.getByRole("tab", { name: "轨迹", exact: true }).click();
    await expect(page.getByTestId("trajectory-total-duration")).toHaveText(
      "2.00s",
    );
    const inputBars = page.locator('[data-lane="input"] button');
    const modelInputs = page.locator(
      '[data-lane="input"] button[aria-label*="模型输入"]',
    );
    await expect(modelInputs).toHaveCount(2);
    await expect(modelInputs.first()).toHaveAttribute(
      "data-started-ms",
      "1000",
    );
    await expect(modelInputs.last()).toHaveAttribute("data-started-ms", "2600");
    expect(
      await modelInputs.evaluateAll((nodes) =>
        nodes.every((node) => !node.hasAttribute("data-duration-ms")),
      ),
    ).toBe(true);
    expect(
      await inputBars.evaluateAll((nodes) =>
        nodes.every((node) => !node.hasAttribute("data-duration-ms")),
      ),
    ).toBe(true);
    await expect(
      page.locator(
        '[data-testid="trajectory-entry"][data-kind="model-generation"]',
      ),
    ).toContainText("模型生成");
    const modelBars = page.locator(
      '[data-lane="message"] button[data-duration-ms]',
    );
    await expect(modelBars).toHaveCount(2);
    await expect(modelBars.first()).toHaveAttribute("data-duration-ms", "1000");
    await expect(modelBars.last()).toHaveAttribute("data-duration-ms", "400");
    // The input point and generation span start at the same clock. Pointer clicks
    // must select the button's identity rather than whichever interval contains it.
    await modelInputs.first().click();
    await expect(modelInputs.first()).toHaveAttribute("data-current", "true");
    await expect(modelBars.first()).toHaveAttribute("data-current", "false");
    await expect(
      page.locator('[data-testid="trajectory-entry"][data-selected="true"]'),
    ).toHaveAttribute("data-kind", "model-request");
    await modelBars.first().click();
    await expect(modelBars.first()).toHaveAttribute("data-current", "true");
    await expect(modelInputs.first()).toHaveAttribute("data-current", "false");
    await expect(
      page.locator('[data-testid="trajectory-entry"][data-selected="true"]'),
    ).toHaveAttribute("data-kind", "model-generation");
    const toolBars = page.locator(
      '[data-lane="tool"] button[data-duration-ms]',
    );
    await expect(toolBars).toHaveCount(2);
    await expect(toolBars.first()).toHaveAttribute("data-duration-ms", "400");
    await expect(toolBars.last()).toHaveAttribute("data-duration-ms", "500");
    await expect(page.locator('[data-lane="sub"] button')).toHaveAttribute(
      "data-duration-ms",
      "100",
    );
    await expect
      .poll(() =>
        modelBars.first().evaluate((el) => parseFloat(el.style.width)),
      )
      .toBeGreaterThan(40);
    await page
      .locator('[data-testid="trajectory-entry"][data-kind="tool"]')
      .filter({ hasText: "pwsh" })
      .last()
      .click();
    await expect(page.getByTestId("trajectory-inspector")).toContainText(
      "400ms",
    );
    await expect(page.getByTestId("trajectory-inspector")).not.toContainText(
      "未记录",
    );
    const kinds = () =>
      page
        .getByTestId("trajectory-entry")
        .evaluateAll((entries) =>
          entries.map((entry) => entry.getAttribute("data-kind")),
        );
    const expectedOrder = await kinds();
    expect(expectedOrder[0]).toBe("user");
    expect(expectedOrder[1]).toBe("model-request");
    expect(expectedOrder.indexOf("model-generation")).toBeGreaterThan(1);
    expect(expectedOrder.indexOf("tool")).toBeGreaterThan(
      expectedOrder.indexOf("model-generation"),
    );
    await page.reload();
    await page.getByRole("tab", { name: "轨迹", exact: true }).click();
    await expect.poll(kinds).toEqual(expectedOrder);
  });
}

test("missing historical tool clocks stay unknown rather than inheriting the gap between model calls", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = messages;
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
    route.fulfill({
      json: {
        status: "available",
        attempts: [],
        timeline: [model(1, 1000, 2000), model(2, 9000, 10000)],
        stages: [],
      },
    }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await expect(page.getByTestId("trajectory-total-duration")).toHaveText(
    "2.00s",
  );
  await expect(
    page.locator('[data-lane="tool"] button[data-duration-ms]'),
  ).toHaveCount(0);
  await expect(
    page.locator(
      '[data-testid="trajectory-entry"][data-kind="tool"] .trajectory-entry-time',
    ),
  ).toHaveText(["—", "—"]);
});
