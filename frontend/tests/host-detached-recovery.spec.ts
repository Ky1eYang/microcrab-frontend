import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

test("a detached Host still permits explicit disconnect through the existing teardown flow", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/#session/s1");
  await connectHostUI(page);
  backend.event("host_detached", { reason: "disconnected", suspended: true });
  await page.getByTestId("header-host-connection").click();
  const disconnect = page
    .getByRole("dialog")
    .getByRole("button", { name: "断开连接", exact: true });
  await expect(disconnect).toBeEnabled();
  await disconnect.click();
  await expect
    .poll(
      () =>
        backend.requests.filter((request) =>
          request.path.endsWith("/host/disconnect"),
        ).length,
    )
    .toBeGreaterThan(0);
  expect(
    backend.requests
      .filter((request) => request.path.endsWith("/host/disconnect"))
      .map((request) => request.path),
  ).toEqual(["/api/v1/projects/project-1/host/disconnect"]);
});
