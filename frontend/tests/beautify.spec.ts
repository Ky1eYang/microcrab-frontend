import { test, expect, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { maintainedPluginBundle } from "./plugin-bundle-fixture";

async function readyPlugins(page: Page) {
  await maintainedPluginBundle(page);
  await nativeBackend(page);
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "展开 Plugins" }),
  ).toBeVisible();
}

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 844 };

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function ready(page: Page) {
  await nativeBackend(page);
  await page.goto("/");
  await expect(page.getByTitle("选择项目工作区")).toBeVisible();
}

for (const viewport of [WIDE, NARROW]) {
  test.describe(`at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("brand, follow-system default and no horizontal overflow", async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: "light" });
      await ready(page);
      const html = page.locator("html");
      await expect(html).toHaveAttribute("data-theme-pref", "system");
      await expect(html).toHaveAttribute("data-theme", "light");
      await expect(page).toHaveTitle(/microcrab/);
      await expect(page.getByText("sbclaw", { exact: false })).toHaveCount(0);
      await noHorizontalOverflow(page);
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(html).toHaveAttribute("data-theme", "dark");
      await noHorizontalOverflow(page);
    });
  });
}

test.describe("narrow drawer", () => {
  test.use({ viewport: NARROW });

  test("collapsed rail opens a drawer that closes on backdrop and Esc", async ({
    page,
  }) => {
    await ready(page);
    // v0.1.18: below 768px there is no resident icon rail; the Header menu
    // button opens the same drawer.
    const rail = page.getByTestId("session-rail");
    await expect(rail).toHaveCount(0);

    const trigger = page.getByTestId("header-open-rail");
    await expect(trigger).toHaveAccessibleName("展开侧边栏");
    await trigger.click();
    const drawer = page.getByRole("dialog", { name: "会话列表" });
    await expect(drawer).toBeVisible();
    const box = await drawer.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(Math.min(300, 390 * 0.85) + 1);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await noHorizontalOverflow(page);

    // Focus is trapped inside the open drawer.
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press("Tab");
      expect(
        await drawer.evaluate((node) => node.contains(document.activeElement)),
      ).toBe(true);
    }

    await page.getByTestId("rail-drawer-backdrop").click({
      position: { x: 380, y: 400 },
    });
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(page.getByTestId("rail-drawer-backdrop")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("selecting a session closes the drawer", async ({ page }) => {
    await ready(page);
    await page.getByRole("button", { name: "展开侧边栏" }).click();
    const drawer = page.getByRole("dialog", { name: "会话列表" });
    await expect(drawer).toBeVisible();
    await drawer.getByTestId("session-item").first().click();
    await expect(drawer).toHaveCount(0);
    await noHorizontalOverflow(page);
  });

  test("a persisted open Plugins rail stays closed until toggled", async ({
    page,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem("microcrab.ui.rightRailCollapsed", "false"),
    );
    await readyPlugins(page);
    await expect(
      page.getByRole("complementary", { name: "Plugins" }),
    ).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.getByRole("button", { name: "展开 Plugins" }).click();
    const plugins = page.getByRole("complementary", { name: "Plugins" });
    await expect(plugins).toBeVisible();
    expect((await plugins.boundingBox())!.width).toBeLessThanOrEqual(
      390 * 0.85 + 1,
    );
    await noHorizontalOverflow(page);
    await page.keyboard.press("Escape");
    await expect(plugins).toHaveCount(0);
    await page.getByRole("button", { name: "展开 Plugins" }).click();
    await expect(plugins).toBeVisible();
    await page.getByTestId("right-rail-backdrop").click({
      position: { x: 10, y: 400 },
    });
    await expect(plugins).toHaveCount(0);
  });

  test("Plugins Escape survives removed focus while respecting child handlers and external popups", async ({
    page,
  }) => {
    await readyPlugins(page);
    const toggle = page.getByRole("button", { name: "展开 Plugins" });
    await toggle.click();
    const plugins = page.getByRole("complementary", { name: "Plugins" });
    await expect(plugins).toBeVisible();
    await page.evaluate(() => {
      const popup = document.createElement("input");
      popup.id = "foreign-popup-focus";
      document.body.append(popup);
      popup.focus();
    });
    await page.keyboard.press("Escape");
    await expect(plugins).toBeVisible();
    await plugins.evaluate((node) => {
      document.getElementById("foreign-popup-focus")?.remove();
      const transient = document.createElement("button");
      node.append(transient);
      transient.focus();
      transient.remove();
    });
    await expect
      .poll(() => page.evaluate(() => document.activeElement === document.body))
      .toBe(true);
    await page.evaluate(() => {
      document.body.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Escape") event.preventDefault();
        },
        { once: true },
      );
    });
    await page.keyboard.press("Escape");
    await expect(plugins).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(plugins).toHaveCount(0);
    await expect(toggle).toBeFocused();
  });

  test("the Plugins overlay has a visible close button", async ({ page }) => {
    await readyPlugins(page);
    const toggle = page.getByRole("button", { name: "展开 Plugins" });
    await toggle.click();
    const plugins = page.getByRole("complementary", { name: "Plugins" });
    await expect(plugins).toBeVisible();
    const close = plugins.getByTestId("right-rail-close");
    await expect(close).toBeVisible();
    await expect(close).toHaveAttribute("aria-label", "关闭 Plugins");
    const box = (await close.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await close.click();
    await expect(plugins).toHaveCount(0);
    await expect(toggle).toBeFocused();
  });

  test("the message column is at least 300px wide", async ({ page }) => {
    await ready(page);
    await page.getByRole("button", { name: "展开侧边栏" }).click();
    await page
      .getByRole("dialog", { name: "会话列表" })
      .getByTestId("session-item")
      .first()
      .click();
    const column = page.locator(".transcript-inner").first();
    await expect(column).toBeVisible();
    expect((await column.boundingBox())!.width).toBeGreaterThanOrEqual(300);
    await noHorizontalOverflow(page);
  });

  test("the settings dialog stacks and does not clip its content", async ({
    page,
  }) => {
    await ready(page);
    await page.getByRole("button", { name: "展开侧边栏" }).click();
    await page
      .getByRole("dialog", { name: "会话列表" })
      .getByRole("button", { name: "Test User", exact: true })
      .click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.locator(".settings-dialog");
    await expect(dialog).toBeVisible();
    for (const tab of ["后端连接", "界面外观"]) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      const body = (await page.locator(".settings-body").boundingBox())!;
      expect(body.width).toBeGreaterThanOrEqual(300);
      const clipped = await page.evaluate(() => {
        const root = document.querySelector(".settings-body")!;
        const edge = root.getBoundingClientRect().right;
        return [
          ...root.querySelectorAll(
            ".settings-row-action > *, .segmented, .badge, button",
          ),
        ]
          .filter((el) => el.getBoundingClientRect().right > edge + 0.5)
          .map((el) => el.textContent);
      });
      expect(clipped, tab).toEqual([]);
    }
    await page.getByTestId("theme-option-system").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("theme-option-system")).toBeInViewport({
      ratio: 1,
    });
    await noHorizontalOverflow(page);
  });
});
