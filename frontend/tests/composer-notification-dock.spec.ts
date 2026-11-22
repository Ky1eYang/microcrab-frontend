import { createHash } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CLIENT_TOOL_DEFINITIONS } from "../src/client/client-tools";
import type { ClientBinding } from "../src/client/client-tool-controller";
import type { PermissionRequest, RoundLimitRequest } from "../src/client/types";
import { connectHostUI } from "./host-fixture";
import { nativeBackend } from "./native-fixture";

const participant: ClientBinding = {
  role: "participant",
  can_interact: true,
  participation_id: "fixture-participant",
  catalog_digest: "fixture-tools",
  definitions: CLIENT_TOOL_DEFINITIONS,
  calls: [],
  pending: [],
};

function round(id: string): RoundLimitRequest {
  return {
    request_id: id,
    parent_session_id: "s1",
    session_id: "s1",
    epoch: 1,
    turn_id: "turn-1",
    kind: "rounds",
    used: 64,
    block: 64,
    created_at_ms: 1,
  };
}

const finalLine = "Last paragraph stays above the notifications.";
const footer = (page: Page) => page.locator(".conversation-input-outer-wrap");
const list = (page: Page) => page.locator("#conversation-transcript");
const dock = (page: Page) => page.getByTestId("composer-notification-dock");
const bounds = (el: Locator) => el.boundingBox().then((rect) => rect!);

async function fixture(
  page: Page,
  requests: RoundLimitRequest[] = [],
  permissionRequests: PermissionRequest[] = [],
  recoveryRequired = false,
  submitError?: { code: string; message: string },
) {
  const backend = await nativeBackend(page, {
    clientTools: structuredClone(participant),
    permissionRequests,
    roundLimitRequests: requests,
    submitError,
  });
  if (recoveryRequired)
    backend.snapshot().session.agent_init_retry_required = true;
  backend.snapshot().messages = [
    {
      id: "dock-answer",
      role: "assistant",
      text: Array.from(
        { length: 85 },
        (_, index) => `History paragraph ${index}.`,
      )
        .concat(finalLine)
        .join("\n\n"),
      parts: [],
      tool_calls: [],
    },
  ];
  await page.goto("/#session/s1");
  await expect(page.getByText(finalLine, { exact: true })).toBeVisible();
  return backend;
}

for (const width of [1440, 390]) {
  test(`Home Host notice keeps one line and the Connect action at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await nativeBackend(page);
    await page.goto("/");
    const notice = page.locator(".home-composer-box .composer-host-notice");
    const label = notice.locator(".composer-notice-text");
    const action = notice.getByRole("button", { name: "连接 Host", exact: true });
    await expect(label).toHaveText(/项目宿主机执行端离线/);
    await expect(label).toHaveCSS("white-space", "nowrap");
    await expect(label).toHaveCSS("text-overflow", "ellipsis");
    await expect.poll(() => label.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    const [textBox, buttonBox] = await Promise.all([bounds(label), bounds(action)]);
    expect(textBox.x + textBox.width).toBeLessThan(buttonBox.x);
    expect(Math.abs(textBox.y + textBox.height / 2 - (buttonBox.y + buttonBox.height / 2))).toBeLessThan(2);
    const detail = notice.locator(".composer-notice-popover");
    await label.hover();
    await expect(detail).toBeVisible();
    await expect(detail).toHaveText(/项目宿主机执行端离线。.*仍可浏览历史记录。/);
    expect(await detail.innerText()).toBe(await label.innerText());
    await action.hover();
    await expect(detail).toBeHidden();
    const reveal = notice.locator(".composer-notice-reveal");
    await reveal.focus();
    await page.keyboard.press("Enter");
    await expect(reveal).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();
    await action.click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test(`a changing dock and jump control stay clear of the transcript at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 720 });
    const backend = await fixture(page);
    const transcript = list(page);
    const notices = dock(page).locator(".composer-notification-row");
    const finalText = page.getByText(finalLine, { exact: true });
    const latest = page.getByRole("button", {
      name: "滚动回最新消息",
      exact: true,
    });
    await expect(notices).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "接管插件执行端" }),
    ).toHaveCount(0);
    for (let index = 0; index < 5; index++)
      backend.event("round_limit.requested", {
        request: round(`limit-${index}`),
      });
    await expect(notices).toHaveCount(6);
    await expect(dock(page)).toHaveCSS("max-height", "120px");
    await expect
      .poll(() =>
        dock(page).evaluate((el) => [
          el.scrollHeight > el.clientHeight,
          el.scrollWidth > el.clientWidth,
        ]),
      )
      .toEqual([true, false]);

    const clearance = async () => {
      const [chat, controls] = await Promise.all([
        bounds(transcript),
        bounds(footer(page)),
      ]);
      return controls.y - (chat.y + chat.height);
    };
    const finalClearance = async () => {
      const [line, chat] = await Promise.all([
        bounds(finalText),
        bounds(transcript),
      ]);
      return chat.y + chat.height - (line.y + line.height);
    };
    await expect(transcript).toHaveAttribute("data-following", "true");
    await expect.poll(clearance).toBeGreaterThanOrEqual(0);
    await expect.poll(finalClearance).toBeGreaterThanOrEqual(15);
    await expect(latest).toBeHidden();

    await transcript.evaluate((el) => {
      el.scrollTop = 400;
    });
    await expect(transcript).toHaveAttribute("data-following", "false");
    await expect(latest).toBeVisible();
    const [button, chat, notice] = await Promise.all([
      bounds(latest),
      bounds(transcript),
      bounds(dock(page)),
    ]);
    expect(button.y).toBeGreaterThanOrEqual(chat.y + chat.height);
    expect(button.y + button.height).toBeLessThanOrEqual(notice.y);
    const top = await transcript.evaluate((el) => el.scrollTop);

    await dock(page).focus();
    await page.keyboard.press("End");
    await expect
      .poll(() => dock(page).evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    for (let index = 0; index < 5; index++)
      backend.event("round_limit.settled", {
        request_id: `limit-${index}`,
        parent_session_id: "s1",
        decision: "continue",
      });
    await expect(notices).toHaveCount(1);
    await connectHostUI(page);
    await expect(dock(page)).toBeHidden();
    await expect(transcript).toHaveAttribute("data-following", "false");
    await expect
      .poll(() => transcript.evaluate((el) => el.scrollTop))
      .toBe(top);
    await expect.poll(clearance).toBeGreaterThanOrEqual(0);
    await latest.click();
    await expect(transcript).toHaveAttribute("data-following", "true");
    await expect(latest).toBeHidden();
    await expect.poll(finalClearance).toBeGreaterThanOrEqual(15);
  });
}

test("idle Sandbox ownership is reclaimable independently of plugin execution", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.locale", "en"),
  );
  const backend = await nativeBackend(page, {
    selectProject: false,
    clientTools: structuredClone(participant),
    sandboxParticipant: true,
  });
  backend.snapshot().session.project_id = null;
  backend.snapshot().session.host_flavor = "browser_sandbox";
  backend.snapshot().session.status = "running";
  const source = `export const BrowserHost = { async create() { return { lease: 'fixture-browser-lease', async descriptor() { return { host_id: 'sandbox' }; }, async close() {}, async handle() {} }; } };`;
  const hash = createHash("sha256").update(source).digest("hex");
  await page.route("**/browser-host/current.json", (route) =>
    route.fulfill({
      json: {
        schema: 1,
        kind: "browser-host",
        wasmsh_version: "0.5.1",
        hash,
        entry: "supervisor.mjs",
        base_url: `/browser-host/${hash}/`,
        files: [
          {
            path: "supervisor.mjs",
            size: Buffer.byteLength(source),
            sha256: hash,
          },
        ],
      },
    }),
  );
  await page.route(`**/browser-host/${hash}/supervisor.mjs`, (route) =>
    route.fulfill({ contentType: "text/javascript", body: source }),
  );
  await page.goto("/#session/s1");
  const notice = page.getByTestId("browser-host-takeover-notice");
  const hostAction = notice.getByRole("button", {
    name: "Take over browser Host",
    exact: true,
  });
  await expect(hostAction).toBeDisabled();
  await expect(notice).toContainText(
    "Another browser tab owns this Sandbox workspace.",
  );
  await expect(
    page.getByRole("button", { name: "Take over plugin execution" }),
  ).toHaveCount(0);
  await expect(dock(page).locator(".composer-offline-banner")).toHaveCount(0);
  const idle = structuredClone(backend.snapshot());
  idle.session.status = "idle";
  backend.publish(idle);
  await expect(hostAction).toBeEnabled();
  await hostAction.click();
  await expect(notice).toHaveCount(0);
  expect(
    backend.commands
      .filter((c) => c.method === "conversation.attach")
      .map((c) => c.params.force_takeover),
  ).toEqual([false, true]);
  expect(
    backend.commands.filter((c) => c.method === "client_tools.takeover"),
  ).toHaveLength(0);
});

test("overflowing notice shows its full text on hover and by keyboard without moving actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await fixture(page, [round("long-text")]);
  const row = page.getByTestId("round-limit-request");
  const text = row.locator(".composer-notice-text");
  const popup = row.locator(".composer-notice-popover");
  const reveal = row.getByRole("button", { name: "查看完整通知" });
  const action = row.getByRole("button", { name: "继续 64 轮" });
  const stop = row.getByRole("button", { name: "停止", exact: true });
  await expect(text).toHaveCSS("text-overflow", "ellipsis");
  await expect(text).toHaveCSS("white-space", "nowrap");
  await expect
    .poll(() => text.evaluate((el) => el.scrollWidth > el.clientWidth))
    .toBe(true);
  const [textBounds, actionBounds, stopBounds] = await Promise.all([
    bounds(text),
    bounds(action),
    bounds(stop),
  ]);
  expect(textBounds.x + textBounds.width).toBeLessThan(actionBounds.x);
  expect(
    Math.abs(
      textBounds.y +
        textBounds.height / 2 -
        actionBounds.y -
        actionBounds.height / 2,
    ),
  ).toBeLessThan(1);
  expect(actionBounds.y).toBe(stopBounds.y);
  await expect(popup).toBeHidden();
  await text.hover();
  await expect(popup).toBeVisible();
  expect(await popup.textContent()).toBe(await text.textContent());
  const tooltip = await bounds(popup);
  expect(tooltip.y + tooltip.height).toBeLessThanOrEqual(
    textBounds.y + textBounds.height / 2,
  );
  await popup.hover();
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await page.mouse.move(5, 5);
  await dock(page).focus();
  await page.keyboard.press("Tab");
  await expect(reveal).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(reveal).toHaveAttribute("aria-expanded", "true");
  await expect(popup).toBeVisible();
  expect(await bounds(action)).toEqual(actionBounds);
  await page.keyboard.press("Escape");
  await expect(reveal).toBeFocused();
  await expect(reveal).toHaveAttribute("aria-expanded", "false");
  await expect(popup).toBeHidden();
});

test.describe("touch notice disclosure", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 720 } });
  test("tap reveals full notice; tapping outside leaves the choices available", async ({
    page,
  }) => {
    await fixture(page, [round("touch")]);
    const row = page.getByTestId("round-limit-request");
    const reveal = row.getByRole("button", { name: "查看完整通知" });
    const popup = row.locator(".composer-notice-popover");
    await reveal.tap();
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("已执行 64 轮");
    await page.touchscreen.tap(3, 3);
    await expect(popup).toBeHidden();
    await expect(row.getByRole("button", { name: "继续 64 轮" })).toBeEnabled();
  });
});

test("permission replacement keeps its details and approval outside the dock", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 720 });
  const permission: PermissionRequest = {
    request_id: "approval",
    parent_session_id: "s1",
    session_id: "s1",
    call_id: "review-call",
    agent: "coding",
    mode: "execute",
    tool: "shell",
    arguments: { command: "approved preview" },
    revision: 1,
    created_at_ms: Date.now(),
    expires_at_ms: Date.now() + 60_000,
  };
  await fixture(page, [round("limit")], [permission]);
  await expect(dock(page).getByTestId("round-limit-request")).toHaveCount(1);
  await expect(dock(page).locator(".composer-offline-banner")).toHaveCount(0);
  const approval = page.getByTestId("permission-request");
  await expect(approval).toBeVisible();
  await approval.locator("summary").click();
  await expect(
    approval.getByTestId("permission-request-payload"),
  ).toContainText("approved preview");
  await expect(approval.locator("button.primary-btn")).toBeEnabled();
  await expect(dock(page).getByTestId("permission-request")).toHaveCount(0);
  await expect(page.getByTestId("composer")).toHaveCount(0);
});

test("session recovery remains separate from the capped notices", async ({
  page,
}) => {
  await fixture(page, [round("limit")], [], true);
  await expect(dock(page).locator(".composer-offline-banner")).toHaveCount(1);
  await expect(
    page.getByTestId("composer").getByTestId("session-recovery-notice"),
  ).toBeVisible();
  await expect(dock(page).getByTestId("session-recovery-notice")).toHaveCount(
    0,
  );
});

test("rejected input feedback cannot obstruct the composer at 390px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await fixture(page, [], [], false, {
    code: "host_unavailable",
    message: "Retry later",
  });
  await connectHostUI(page);
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  const send = page.getByTitle("发送 (Enter)", { exact: true });
  await input.fill("Keep this draft");
  await send.click();
  const toast = page.locator(".toast-container");
  await expect(toast).toContainText("Retry later");
  const [feedback, controls] = await Promise.all([
    bounds(toast),
    bounds(footer(page)),
  ]);
  expect(feedback.y + feedback.height).toBeLessThan(controls.y);
  await expect(input).toHaveValue("Keep this draft");
  await send.click({ trial: true });
});
