// Menus: Esc closes each menu and returns focus to its trigger, and a route
// change (browser Back) leaves no menu or click-outside backdrop behind.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

async function home(page: Page) {
  await nativeBackend(page);
  await page.goto("/");
  await expect(page.locator(".home-composer-box")).toBeVisible();
}

async function session(page: Page) {
  await nativeBackend(page);
  await page.goto("/#session/s1");
  await expect(page.locator("#conversation-transcript")).toBeVisible();
}

/** Open with the mouse, close with Esc, then again from the keyboard. */
async function escCloses(page: Page, trigger: Locator, menu: Locator) {
  for (const open of ["click", "keyboard"] as const) {
    if (open === "click") await trigger.click();
    else {
      await trigger.focus();
      await page.keyboard.press("Enter");
    }
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.locator(".menu-click-outside-backdrop")).toHaveCount(0);
    if (await trigger.getAttribute("aria-expanded"))
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
  }
}

test.describe("Esc closes menus and refocuses the trigger", () => {
  test("home workspace dropdown", async ({ page }) => {
    await home(page);
    await escCloses(
      page,
      page.getByTitle("选择项目工作区"),
      page.locator(".workspace-dropdown-menu"),
    );
  });

  test("composer + menu and model menu", async ({ page }) => {
    await home(page);
    await escCloses(
      page,
      page.getByTitle("快捷操作与工具"),
      page.locator(".composer-action-menu"),
    );
    await escCloses(
      page,
      page.locator(".composer-model-pill"),
      page.locator(".model-variant-picker-dropdown"),
    );
  });

  test("composer dock popovers", async ({ page }) => {
    await session(page);
    const pills = page.locator(".dock-pill-btn");
    for (const index of [0, 1])
      await escCloses(
        page,
        pills.nth(index),
        page.locator(".dock-popover-card"),
      );
  });

  test("rail session and project menus", async ({ page }) => {
    await session(page);
    const row = page.locator(".session-item-row").first();
    await row.hover();
    await escCloses(
      page,
      row.getByTitle("更多操作"),
      page.locator(".session-menu:not(.project-menu)"),
    );
    const project = page.locator(".rail-project-row").first();
    await project.hover();
    await escCloses(
      page,
      project.getByTitle("更多操作"),
      page.locator(".project-menu"),
    );
  });

  test("user card menu", async ({ page }) => {
    await home(page);
    await escCloses(
      page,
      page.locator(".user-card-btn"),
      page.locator(".user-card-menu"),
    );
  });

  test.describe("inside the narrow drawer", () => {
    test.use({ viewport: { width: 390, height: 844 } });
    test("Esc closes the menu but not the drawer", async ({ page }) => {
      await session(page);
      await page.getByRole("button", { name: "展开侧边栏" }).click();
      const drawer = page.getByRole("dialog", { name: "会话列表" });
      await expect(drawer).toBeVisible();
      const row = drawer.locator(".session-item-row").first();
      await row.hover();
      const trigger = row.getByTitle("更多操作");
      await trigger.click();
      await expect(page.locator(".session-menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".session-menu")).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(page.getByTestId("rail-drawer-backdrop")).toBeVisible();
      await expect(drawer).toBeVisible();
      // A second Esc then closes the drawer as before.
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
    });
  });
});

test.describe("route changes leave no stale menu layer", () => {
  test("Back from home with the workspace menu open", async ({ page }) => {
    await session(page);
    await page.getByRole("button", { name: "新对话" }).click();
    await expect(page.locator(".home-composer-box")).toBeVisible();
    await page.getByTitle("选择项目工作区").click();
    await expect(page.locator(".workspace-dropdown-menu")).toBeVisible();
    await expect(page.locator(".menu-click-outside-backdrop")).toHaveCount(1);
    await page.goBack();
    await expect(page).toHaveURL(/#session\/s1$/);
    await expect(page.locator("#conversation-transcript")).toBeVisible();
    await expect(page.locator(".menu-click-outside-backdrop")).toHaveCount(0);
    await expect(page.locator(".workspace-dropdown-menu")).toHaveCount(0);
    // The first click on the session page reaches its target.
    const tab = page.getByRole("tab", { name: "轨迹", exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  });

  test("a hash change with a rail menu open", async ({ page }) => {
    await session(page);
    const row = page.locator(".session-item-row").first();
    await row.hover();
    await row.getByTitle("更多操作").click();
    await expect(page.locator(".menu-click-outside-backdrop")).toHaveCount(1);
    await page.evaluate(() => (location.hash = ""));
    await expect(page.locator(".menu-click-outside-backdrop")).toHaveCount(0);
    await expect(page.locator(".session-menu")).toHaveCount(0);
  });
});

const railMenus = [
  {
    name: "session",
    row: ".session-item-row",
    menu: ".session-menu:not(.project-menu)",
  },
  { name: "project", row: ".rail-project-row", menu: ".project-menu" },
];

test.describe("rail ⋮ menus (Tester F1, F2)", () => {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ])
    for (const rail of railMenus)
      test(`Esc refocuses ${rail.name} ⋮ after the pointer left the row (${size.width})`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        await session(page);
        let scope = page.locator("body");
        if (size.width < 768) {
          await page.getByRole("button", { name: "展开侧边栏" }).click();
          scope = page.getByRole("dialog", { name: "会话列表" });
        }
        const row = scope.locator(rail.row).first();
        await row.hover();
        const trigger = row.getByTitle("更多操作");
        await trigger.click();
        await expect(page.locator(rail.menu)).toBeVisible();
        await page.mouse.move(size.width < 768 ? 150 : 700, 400);
        await page.keyboard.press("Escape");
        await expect(page.locator(rail.menu)).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await expect(trigger).toBeVisible();
        await expect(trigger).toHaveCSS("opacity", "1");
      });

  test("Tab reaches the project and session ⋮ without hovering", async ({
    page,
  }) => {
    await session(page);
    await page.mouse.move(700, 400);
    await page.getByRole("button", { name: "会话历史" }).focus();
    const reached: string[] = [];
    for (let i = 0; i < 12 && reached.length < 2; i++) {
      await page.keyboard.press("Tab");
      const hit = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el.title !== "更多操作") return null;
        return el.classList.contains("rail-project-more-btn")
          ? "project"
          : "session";
      });
      if (!hit) continue;
      reached.push(hit);
      // The focused ⋮ is shown (opacity transitions, so poll) at full size.
      const focused = page.locator(":focus");
      await expect(focused).toHaveCSS("opacity", "1");
      const box = await focused.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(20);
    }
    expect(reached).toEqual(["project", "session"]);
    // Enter opens the focused session ⋮ menu and Esc returns to it.
    const trigger = page.locator(".session-action-more").first();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".session-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });

  test("hidden session actions stay clipped when not hovered or focused", async ({
    page,
  }) => {
    await session(page);
    await page.mouse.move(700, 400);
    const actions = page.locator(".session-item-actions").first();
    const box = await actions.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(1);
    await expect(page.locator(".session-item-time").first()).toBeVisible();
  });

  test.describe("narrow drawer", () => {
    test.use({ viewport: { width: 390, height: 844 } });
    for (const rail of railMenus)
      test(`closing the drawer closes the ${rail.name} menu and its backdrop`, async ({
        page,
      }) => {
        await session(page);
        await page.getByRole("button", { name: "展开侧边栏" }).click();
        const drawer = page.getByRole("dialog", { name: "会话列表" });
        const row = drawer.locator(rail.row).first();
        await row.hover();
        await row.getByTitle("更多操作").click();
        await expect(page.locator(rail.menu)).toBeVisible();
        // Tap the strip of backdrop to the right of the drawer.
        await expect(page.getByTestId("rail-drawer-backdrop")).toBeVisible();
        await page.mouse.click(382, 422);
        await expect(drawer).toHaveCount(0);
        await expect(page.locator(".menu-click-outside-backdrop")).toHaveCount(
          0,
        );
        await expect(page.locator(rail.menu)).toHaveCount(0);
        // The next tap on the page reaches its target.
        const copy = page.locator(".code-block-copy-btn").first();
        const target = (await copy.count())
          ? copy
          : page.locator(".dock-pill-btn").first();
        await target.click();
        if (target === copy)
          await expect(copy).toHaveAccessibleName(/已复制|复制/);
        else await expect(target).toHaveAttribute("aria-expanded", "true");
      });

    test("a press elsewhere in the drawer closes the rail menu, not the drawer", async ({
      page,
    }) => {
      await session(page);
      await page.getByRole("button", { name: "展开侧边栏" }).click();
      const drawer = page.getByRole("dialog", { name: "会话列表" });
      const row = drawer.locator(".session-item-row").first();
      await row.hover();
      await row.getByTitle("更多操作").click();
      await expect(page.locator(".session-menu")).toBeVisible();
      await drawer.getByText("项目", { exact: true }).click();
      await expect(page.locator(".session-menu")).toHaveCount(0);
      await expect(page.locator(".menu-click-outside-backdrop")).toHaveCount(0);
      await expect(drawer).toBeVisible();
    });
  });

  test("a press on the header closes the rail menu and still acts (1440)", async ({
    page,
  }) => {
    await session(page);
    const row = page.locator(".session-item-row").first();
    await row.hover();
    await row.getByTitle("更多操作").click();
    await expect(page.locator(".session-menu")).toBeVisible();
    const tab = page.getByRole("tab", { name: "轨迹", exact: true });
    await tab.click();
    await expect(page.locator(".session-menu")).toHaveCount(0);
    await expect(page.locator(".menu-click-outside-backdrop")).toHaveCount(0);
    await expect(tab).toHaveAttribute("aria-selected", "true");
  });
});
