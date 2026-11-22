import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { selectSidebarPlugin } from "./plugin-sidebar-selection";

const artifact = process.env.MICROCRAB_TEST_SPEAKER_COMPONENT;
const id = "microcrab.external-speaker-test";
const token = "fixture_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const alias = "abcdef12";
const frame = (index: number, event: string, data: object) =>
  `id: ${index}\nevent: ${event}\ndata: ${JSON.stringify({ dialogue_id: alias, ...data })}\n\n`;

test("real Speaker Component sends once and automatically consumes scoped SSE", async ({
  page,
}) => {
  test.skip(
    !artifact,
    "Build the Zig Speaker Component and set MICROCRAB_TEST_SPEAKER_COMPONENT",
  );
  test.setTimeout(90_000);
  await nativeBackend(page);
  const bytes = readFileSync(artifact!);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = `${id}/${sha256}/plugin.wasm`;
  await page.route("**/plugins/current.json", (route) =>
    route.fulfill({
      json: {
        version: 1,
        plugins: [{ id, file, sha256, default_enabled: true }],
      },
    }),
  );
  await page.route(`**/plugins/${file}`, (route) =>
    route.fulfill({ contentType: "application/wasm", body: bytes }),
  );
  const calls: Array<{
    method: string;
    headers: Record<string, string>;
    data: string | null;
  }> = [];
  await page.route("**/api/v1/sessions/s1/inbox", async (route) => {
    const request = route.request();
    const headers = await request.allHeaders();
    const method = request.method();
    calls.push({ method, headers, data: request.postData() });
    if (method === "POST") {
      await route.fulfill({
        status: 202,
        json: {
          status: "queued",
          operation_id: headers["idempotency-key"],
          ordinal: 3,
          dialogue_id: alias,
        },
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          frame(0, "queued", { status: "queued" }) +
          frame(1, "consumed", { status: "consumed", turn_id: 1 }) +
          frame(2, "chunk", {
            index: 0,
            message: "First explicit reply",
            is_final: false,
          }) +
          frame(3, "chunk", {
            index: 1,
            message: "Last explicit reply",
            is_final: true,
          }) +
          frame(4, "done", { status: "completed", total_chunks: 2 }),
      });
    }
  });
  await page.goto("/#/session/s1");
  const sidebar = page.getByTestId("client-plugin-sidebar");
  if (!(await sidebar.isVisible()))
    await page.locator(".header-right-toggle-btn").click();
  await selectSidebarPlugin(sidebar, "External Speaker Test");
  await sidebar.getByTestId("plugin-expand").click();
  const mounted = page
    .getByTestId("expanded-plugin-page")
    .getByTestId("plugin-webview");
  await expect(mounted).toHaveAttribute("data-status", "ready");
  const panel = mounted.contentFrame();
  await expect(panel.locator("#session")).toHaveText("s1");
  await panel.locator("#token").fill(token);
  await panel.locator("#authorize").click();
  const consent = page.getByRole("dialog", {
    name: /Plugin network access|插件网络访问/,
  });
  await expect(consent).toContainText("/api/v1/sessions/s1/inbox");
  await consent
    .getByRole("button", { name: /^(Allow access|允许访问)$/ })
    .click();
  await expect(panel.locator("#revoke")).toBeVisible();
  await panel.locator("#message").fill("Send once then listen");
  await panel.locator("#send").click();
  await expect(panel.locator("#reply-status")).toContainText(
    /completed|已完成/i,
  );
  await expect(panel.locator("#reply-chunks li")).toHaveText([
    "First explicit reply",
    "Last explicit reply",
  ]);
  expect(calls.map(({ method }) => method)).toEqual(["POST", "GET"]);
  expect(calls[0].data).toBe('{"body":"Send once then listen"}');
  expect(calls[1].data).toBeNull();
  expect(calls[1].headers).toMatchObject({
    accept: "text/event-stream",
    "x-microcrab-dialogue-id": alias,
  });
  for (const call of calls) {
    expect(call.headers.authorization).toBe(`Bearer ${token}`);
    expect(call.headers.cookie).toBeUndefined();
  }
});
