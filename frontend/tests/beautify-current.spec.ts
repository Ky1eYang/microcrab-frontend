import { test, expect, type Locator, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

async function tokenColor(page: Page, token: string) {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

async function fitsViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const box = (await locator.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

async function showUnsupportedToast(page: Page) {
  // Help remains explicitly unavailable; projectless Conversations are supported.
  await page.locator(".user-card-btn").first().click();
  await page
    .locator(".user-card-menu")
    .getByRole("button", { name: "帮助", exact: true })
    .click();
  await expect(page.locator(".toast-body")).toHaveText("帮助内容尚未接入");
  await expect(page.locator(".toast-container")).toHaveAttribute(
    "data-kind",
    "info",
  );
  // Choosing Help closes its menu without selecting or creating a workspace.
  await expect(page.locator(".user-card-menu")).toHaveCount(0);
  await expect(page.locator(".workspace-dropdown-menu")).toHaveCount(0);
  await expect(page.locator(".menu-click-outside-backdrop")).toHaveCount(0);
  // Advance animation frames as well as timers before hover/click actionability.
  await page.clock.runFor(200);
}

// Exercise each layout and theme once; lifecycle assertions do not depend on
// repeating their full Cartesian product.
for (const { colorScheme, width } of [
  { colorScheme: "dark", width: 1440 },
  { colorScheme: "light", width: 390 },
] as const) {
  test.describe(`${colorScheme} at ${width}px current UI`, () => {
    test.use({ colorScheme, viewport: { width, height: 900 } });

    test("toast keeps its deadline through unrelated state, pauses on hover and can be dismissed", async ({
      page,
    }) => {
      await nativeBackend(page);
      await page.goto("/");
      await expect(page.getByTitle("选择项目工作区")).toBeVisible();
      await page.clock.install();
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      await showUnsupportedToast(page);
      const toast = page.locator(".toast-container");
      await fitsViewport(page, toast);
      await expect(toast).toHaveCSS(
        "background-color",
        await tokenColor(page, "--surface"),
      );
      await expect(toast).toHaveCSS(
        "border-top-color",
        await tokenColor(page, "--text"),
      );
      await page.clock.fastForward(3000);
      // Opening a menu updates application state without replacing the toast.
      await page.getByTitle("选择项目工作区").click();
      await page.clock.fastForward(1100);
      await expect(toast).toHaveCount(0);
      await page.keyboard.press("Escape");

      await showUnsupportedToast(page);
      await page.clock.fastForward(1000);
      await toast.hover();
      await expect(toast.locator(".toast-progress-bar")).toHaveCSS(
        "animation-play-state",
        "paused",
      );
      // A keyboard action updates state while the pointer remains over the toast.
      await page.getByTitle("选择项目工作区").focus();
      await page.keyboard.press("Enter");
      await page.clock.fastForward(5000);
      await expect(toast).toBeVisible();
      await expect(toast.locator(".toast-progress-bar")).toHaveCSS(
        "animation-play-state",
        "paused",
      );
      await page.keyboard.press("Escape");
      await page.mouse.move(0, 0);
      await page.clock.fastForward(2500);
      await expect(toast).toBeVisible();
      await page.clock.fastForward(600);
      await expect(toast).toHaveCount(0);

      await showUnsupportedToast(page);
      await toast
        .getByRole("button", { name: "关闭提示", exact: true })
        .click();
      await expect(toast).toHaveCount(0);
    });

    test("offline history remains readable and reconnect restores the composer and project status", async ({
      page,
    }, testInfo) => {
      const backend = await nativeBackend(page);
      await page.goto("/#session/s1");
      await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
      const banner = page.locator(".composer-offline-banner");
      const message = page.getByLabel("消息", { exact: true });
      await expect(message).toBeDisabled();
      await fitsViewport(page, banner);
      await expect(banner).toHaveCSS(
        "color",
        await tokenColor(page, "--text-2"),
      );
      // Tip-strip: left warn rail, no wash background.
      await expect(banner).toHaveCSS(
        "border-left-color",
        await tokenColor(page, "--warn"),
      );
      await banner
        .getByRole("button", { name: "连接 Host", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "连接项目 Host 执行端",
        exact: true,
      });
      await fitsViewport(page, dialog);
      await dialog
        .getByLabel("Host WebSocket 地址")
        .fill("ws://127.0.0.1:8788/host");
      await dialog
        .getByLabel("一次性配对码", { exact: false })
        .fill("test-pair");
      await dialog
        .getByRole("button", { name: "配对并连接 Host", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(message).toBeEnabled();
      await expect(banner).toHaveCount(0);
      await expect(page.getByText("历史回答", { exact: true })).toBeVisible();

      await page.getByTestId("header-host-connection").click();
      await dialog
        .getByRole("button", { name: "断开连接", exact: true })
        .click();
      await expect(dialog.getByTestId("host-status")).toContainText("未连接");
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(message).toBeDisabled();
      await expect(banner).toBeVisible();
      await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
      await connectHostUI(page);
      await expect(message).toBeEnabled();
      if (colorScheme === "dark" && width === 1440) {
        await page.screenshot({
          path: testInfo.outputPath("dark-desktop-conversation.png"),
          fullPage: true,
        });
      }
      await page
        .getByRole("button", {
          name: "新对话",
          exact: true,
        })
        .click();
      await page.getByTitle("选择项目工作区").click();
      const online = page.locator(".workspace-menu-item[data-active=true]");
      await expect(online).toHaveAccessibleName("Assigned");
      await expect(online.locator(".picker-project-status")).toHaveCount(0);
      expect(
        backend.commands.filter((command) => command.method === "turn.queue"),
      ).toHaveLength(0);
      expect(
        backend.requests.filter(
          (request) =>
            request.method === "POST" && request.path === "/api/v1/sessions",
        ),
      ).toHaveLength(0);
    });

    test("inline project creation uses themed surfaces, fits the Host dialog and selects its result", async ({
      page,
    }, testInfo) => {
      const backend = await nativeBackend(page);
      await page.goto("/");
      await page.getByTitle("选择项目工作区").click();
      await page.getByTestId("picker-create-project").click();
      const dialog = page.getByRole("dialog", {
        name: "新建项目与工作目录",
        exact: true,
      });
      const inline = dialog.locator(".host-connect-create");
      await fitsViewport(page, dialog);
      await fitsViewport(page, inline);
      // E1 flattens the create panel: no second card fill, only a top divider.
      const bg = await inline.evaluate(
        (node) => getComputedStyle(node).backgroundColor,
      );
      expect(["rgba(0, 0, 0, 0)", "transparent"]).toContain(bg);
      await expect(inline).toHaveCSS(
        "border-top-color",
        await tokenColor(page, "--border"),
      );
      const create = dialog.getByRole("button", {
        name: "创建并连接",
        exact: true,
      });
      await expect(create).toBeDisabled();
      await inline
        .getByLabel("项目名称", { exact: true })
        .fill("Beautify project");
      await inline
        .getByLabel("工作目录 (Workspace Directory)", { exact: true })
        .fill("/workspace/beautify");
      await expect(inline.locator("input").first()).toHaveCSS(
        "color",
        await tokenColor(page, "--text"),
      );
      await dialog
        .getByLabel("Host WebSocket 地址")
        .fill("ws://127.0.0.1:8788/host");
      await create.scrollIntoViewIfNeeded();
      await expect(create).toBeInViewport({ ratio: 1 });
      if (colorScheme === "light" && width === 390) {
        await page.screenshot({
          path: testInfo.outputPath("light-narrow-host-create.png"),
          fullPage: true,
        });
      }
      await create.click();
      await expect(dialog).toHaveCount(0);
      await page.getByTestId("header-host-connection").click();
      const fixed = page.getByRole("dialog", {
        name: "连接项目 Host 执行端",
        exact: true,
      });
      await expect(fixed.getByTestId("host-fixed-project")).toHaveText(
        "Beautify project",
      );
      await expect(fixed).toContainText("/workspace/beautify");
      const creates = backend.requests.filter(
        (r) => r.method === "POST" && r.path === "/api/v1/projects",
      );
      expect(creates).toHaveLength(1);
      expect(creates[0].body).toMatchObject({
        name: "Beautify project",
        root: "/workspace/beautify",
      });
      expect(
        backend.commands.filter(
          (command) =>
            command.method === "host.relay_attach" &&
            command.params.project_id === "project-new-1" &&
            command.params.url === "ws://127.0.0.1:8788/host",
        ),
      ).toHaveLength(1);
    });
  });
}
