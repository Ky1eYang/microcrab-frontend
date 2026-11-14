import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("an existing Session resumes when explicit reconciliation makes its retained route ready", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    suspendSessionOnAttach: true,
    reconciling: true,
  });
  let opens = 0;
  await page.route("**/api/v1/sessions/s1/runtime", (route) => {
    opens++;
    return route.fulfill({ json: backend.snapshot() });
  });
  await page.route("**/api/v1/projects/project-1/host-reconcile", (route) =>
    route.fulfill({ json: { ready: true, connected: true } }),
  );
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await page.getByTestId("header-host-connection").click();
  await page.getByLabel("Host WebSocket 地址").fill("ws://127.0.0.1:8788/host");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "连接 Host", exact: true })
    .click();
  await expect(page.locator(".remote-connect-dialog")).toHaveCount(0);
  await expect(page.getByTestId("header-host-connection")).toContainText(
    "已连接",
  );
  expect(opens).toBe(0);
  await page.getByTestId("header-host-connection").click();
  await page
    .getByRole("button", { name: "刷新核对与操作记录", exact: true })
    .click();
  await expect(page.getByTestId("header-host-connection")).toContainText(
    "已就绪",
  );
  expect(opens).toBe(1);
  expect(
    backend.commands.filter(
      (command) => command.method === "host.relay_attach",
    ),
  ).toHaveLength(1);
  expect(
    backend.commands.filter((c) =>
      ["turn.queue", "turn.submit", "turn.retry"].includes(c.method),
    ),
  ).toHaveLength(0);
});
