import { expect, type Page } from "@playwright/test";
export async function connectHostUI(
  page: Page,
  code = "test-pair",
  expectedStatus: string | RegExp = /已就绪|Ready/,
) {
  await page.getByTestId("header-host-connection").click();
  if (await page.getByLabel(/^(Host WebSocket 地址|Host WebSocket address)$/).count())
    await page
      .getByLabel(/^(Host WebSocket 地址|Host WebSocket address)$/)
      .fill("ws://127.0.0.1:8788/host");
  await page.getByLabel(/一次性配对码|One-time pairing code/).fill(code);
  await page
    .getByRole("dialog")
    .getByRole("button", {
      name: code
        ? /^(配对并连接 Host|Pair and connect Host)$/
        : /^(连接 Host|Connect Host)$/,
    })
    .click();
  await expect(page.getByTestId("header-host-connection")).toContainText(
    expectedStatus,
  );
  await expect(page.locator(".remote-connect-dialog")).toHaveCount(0);
}
