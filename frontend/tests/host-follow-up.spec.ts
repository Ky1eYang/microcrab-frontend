import { test, expect, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

const projects = [
  {
    id: "project-1",
    name: "Assigned",
    root: "/assigned",
    host_id: "h1",
    workspace_id: "w1",
  },
  {
    id: "project-2",
    name: "Second Host",
    root: "/second",
    host_id: "h2",
    workspace_id: "w2",
  },
];
async function seed(page: Page, owner = "u1") {
  await page.addInitScript(
    ({ owner }) => {
      if (localStorage.getItem("fixture-seeded")) return;
      localStorage.setItem("fixture-seeded", "true");
      localStorage.setItem("microcrab.browser-client.v1", "fixture-browser");
      // This suite explicitly chooses the native Project independently of the
      // owner whose Host locator map is being tested.
      for (const selectedOwner of ["u1", "u2"]) {
        localStorage.setItem(
          "microcrab.host-project.v2:" +
            JSON.stringify([
              location.origin + "/",
              selectedOwner,
              "fixture-browser",
            ]),
          "project-1",
        );
      }
      for (const [host, port] of [
        ["h1", 8788],
        ["h2", 8789],
      ]) {
        const key =
          "microcrab.host-locator.v2:" +
          JSON.stringify([
            location.origin + "/",
            owner,
            "fixture-browser",
            host,
          ]);
        localStorage.setItem(key, `ws://127.0.0.1:${port}/host`);
      }
    },
    { owner },
  );
}
async function open(page: Page) {
  await page.getByTestId("header-host-connection").click();
}

test("two pinned Projects resolve their own Host locator on switch and normal reconnect hides URL", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { projects });
  await seed(page);
  await page.goto("/");
  await expect(page.getByTestId("header-host-connection")).toContainText(
    "已就绪",
  );
  await open(page);
  await expect(page.getByLabel("Host WebSocket 地址")).toHaveCount(0);
  await expect(page.getByTestId("host-fixed-project")).toHaveText("Assigned");
  await expect(page.getByTestId("host-saved-transport")).toContainText("WebSocket");
  await page
    .getByRole("button", { name: "关闭连接对话框", exact: true })
    .click();
  const second = page
    .locator(".rail-project-folder")
    .filter({ hasText: "Second Host" });
  await second.locator(".rail-project-more-btn").click();
  await second
    .getByRole("button", { name: "连接项目 Host 执行端", exact: true })
    .click();
  await expect(page.getByTestId("host-fixed-project")).toHaveText(
    "Second Host",
  );
  await expect(page.getByLabel("Host WebSocket 地址")).toHaveCount(0);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "连接 Host", exact: true })
    .click();
  await expect(page.locator(".remote-connect-dialog")).toHaveCount(0);
  expect(
    backend.commands
      .filter((command) => command.method === "host.relay_attach")
      .map((command) => [
        command.params.project_id,
        command.params.url,
        command.params.directory,
      ]),
  ).toEqual([
    ["project-1", "ws://127.0.0.1:8788/host", "/assigned"],
    ["project-2", "ws://127.0.0.1:8789/host", "/second"],
  ]);
  const first = page
    .locator(".rail-project-folder")
    .filter({ hasText: "Assigned" });
  await first.locator(".rail-project-more-btn").click();
  await first
    .getByRole("button", { name: "连接项目 Host 执行端", exact: true })
    .click();
  await expect(page.getByTestId("host-fixed-project")).toHaveText("Assigned");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "连接 Host", exact: true })
    .click();
  await expect(page.locator(".remote-connect-dialog")).toHaveCount(0);
  expect(
    backend.commands
      .filter((command) => command.method === "host.relay_attach")
      .at(-1)?.params.project_id,
  ).toBe("project-1");
});

test("a rejected resume asks for a fresh code without sending Pair automatically", async ({ page }) => {
  const backend = await nativeBackend(page, { projects, rejectHostResume: true });
  await seed(page);
  await page.goto("/");
  await open(page);
  const dialog = page.getByRole("dialog");
  const connect = dialog.getByRole("button", { name: "连接 Host", exact: true });
  await connect.click();
  await expect(dialog.getByTestId("host-recovery-guidance")).toContainText("复制当前配对码");
  const attempts = () => backend.commands.filter((command) => command.method === "host.relay_attach");
  expect(attempts().every((command) => !command.params.token)).toBe(true);
  const previous = attempts().length;
  await dialog.locator("#host-code").fill("fixture-new-pair-code");
  await dialog.getByRole("button", { name: /配对并连接/ }).click();
  await expect(dialog).toHaveCount(0);
  expect(attempts().slice(previous).map((command) => command.params.token)).toEqual(["fixture-new-pair-code"]);
});

test("missing map requires explicit setup and another account cannot use saved Host map", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { owner: "u2", projects });
  await seed(page, "u1");
  await page.goto("/");
  await open(page);
  await expect(page.getByLabel("Host WebSocket 地址")).toHaveValue("");
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "连接 Host", exact: true }),
  ).toBeDisabled();
  expect(
    backend.commands.filter(
      (command) => command.method === "host.relay_attach",
    ),
  ).toHaveLength(0);
  await page.getByLabel("Host WebSocket 地址").fill("ws://127.0.0.1:8788/host");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "连接 Host", exact: true })
    .click();
  await expect(page.locator(".remote-connect-dialog")).toHaveCount(0);
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(
    keys.some(
      (k) => k.includes('"u2"') && k.startsWith("microcrab.host-locator.v2:"),
    ),
  ).toBe(true);
});
