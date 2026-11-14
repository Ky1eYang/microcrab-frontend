import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { stateInspection } from "./state-inspection-fixture";

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`State inspection remains unobscured with readable ${theme} syntax at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await nativeBackend(page);
      await page.addInitScript(
        (theme) => localStorage.setItem("microcrab.ui.theme", theme),
        theme,
      );
      const values = {
        session: { epoch: 3, turn: 12, round: 2 },
        mode: "execute",
        enabled: true,
        optional: null,
        model: "structured-state-example",
        limits: { max_processes: 16, output_bytes: 262144 },
        ...Object.fromEntries(
          Array.from({ length: 32 }, (_, index) => [
            `setting_${index + 1}`,
            {
              label: `Session setting ${index + 1}`,
              value: index,
              enabled: index % 2 === 0,
            },
          ]),
        ),
      };
      await page.route("**/api/v1/sessions/s1/state/inspection", (route) =>
        route.fulfill({ json: stateInspection(values, {}) }),
      );
      await page.goto("/#/session/s1");
      await page.locator(".header-right-toggle-btn").click();
      const rail = page.getByRole("complementary", { name: "Plugins" });
      await expect(rail.locator(".syntax-key").first()).toBeVisible();
      await expect(
        page
          .getByTestId("session-plugin-tab")
          .filter({ hasText: "State Viewer" }),
      ).toHaveCount(0);
      await expect(rail.getByRole("combobox")).toHaveValue("json");
      await expect(rail.locator(".content-viewer-kind")).toHaveCount(0);
      const toolbar = rail.locator(".content-viewer-toolbar");
      await expect(
        rail.getByTestId("content-viewer-more").locator("svg"),
      ).toHaveCount(1);
      expect(
        await toolbar.evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/visual/inspection-dropdown-sidebar-${width}-${theme}.png`,
      });
      await rail.getByTestId("plugin-expand").click();
      const expanded = page.getByTestId("expanded-plugin-page");
      await expect(expanded.locator(".syntax-key").first()).toBeVisible();
      const viewer = expanded.getByTestId("content-viewer");
      const colors = await viewer.evaluate((node) => {
        const color = (selector: string) =>
          getComputedStyle(node.querySelector(selector)!).color;
        const style = getComputedStyle(node);
        return {
          key: color(".syntax-key"),
          string: color(".syntax-string"),
          literal: color(".syntax-literal"),
          punctuation: color(".syntax-punctuation"),
          backgrounds: [
            style.getPropertyValue("--surface"),
            style.getPropertyValue("--bg-muted"),
          ],
        };
      });
      expect(colors.key).toBe(
        theme === "light" ? "rgb(50, 56, 62)" : "rgb(180, 199, 218)",
      );
      expect(colors.string).toBe(
        theme === "light" ? "rgb(53, 98, 77)" : "rgb(189, 203, 183)",
      );
      const rgb = (color: string) =>
        color.startsWith("#")
          ? color
              .trim()
              .slice(1)
              .match(/../g)!
              .map((value) => parseInt(value, 16))
          : color
              .match(/[\d.]+/g)!
              .map(Number)
              .slice(0, 3);
      const luminance = (color: string) =>
        rgb(color)
          .map((value) => {
            const c = value / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          })
          .reduce(
            (sum, value, index) =>
              sum + value * [0.2126, 0.7152, 0.0722][index],
            0,
          );
      for (const foreground of [
        colors.key,
        colors.string,
        colors.literal,
        colors.punctuation,
      ]) {
        for (const background of colors.backgrounds) {
          const a = luminance(foreground),
            b = luminance(background.trim());
          expect(
            (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      await viewer.getByTestId("content-viewer-more").click();
      for (const action of ["wrap", "lineNumbers", "pause", "copyOriginal"]) {
        const row = viewer.getByTestId(`content-viewer-${action}`);
        await row.hover();
        expect(
          await row.evaluate((node) => getComputedStyle(node).backgroundColor),
        ).toBe("rgba(0, 0, 0, 0)");
      }
      await page.screenshot({
        path: `test-results/visual/inspection-dropdown-menu-${width}-${theme}.png`,
      });
      await page.keyboard.press("Escape");
      await page.screenshot({
        path: `test-results/visual/inspection-dropdown-expanded-${width}-${theme}.png`,
      });
      await viewer.getByTestId("content-viewer-edit").click();
      await expect(viewer.locator(".cm-content")).toContainText(
        '"enabled": true',
      );
      await expect(viewer.locator(".cm-gutters")).toBeVisible();
      await page.screenshot({
        path: `test-results/visual/inspection-dropdown-editor-${width}-${theme}.png`,
      });
      await viewer.getByTestId("content-viewer-cancel").click();
      const owner = await viewer.evaluate((node) => {
        for (
          let parent = node.parentElement;
          parent;
          parent = parent.parentElement
        ) {
          if (
            /auto|scroll/.test(getComputedStyle(parent).overflowY) &&
            parent.scrollHeight > parent.clientHeight
          ) {
            parent.setAttribute("data-audit-scroll", "true");
            return true;
          }
        }
        return false;
      });
      expect(owner).toBe(true);
      const before = (await viewer
        .locator(".content-viewer-toolbar")
        .boundingBox())!;
      await expanded
        .page()
        .locator('[data-audit-scroll="true"]')
        .evaluate((node) => (node.scrollTop += 300));
      await expect
        .poll(async () => {
          const box = (await viewer
            .locator(".content-viewer-toolbar")
            .boundingBox())!;
          return box.y + box.height;
        })
        .toBeLessThan(before.y + before.height - 150);
      expect(
        await viewer
          .locator(".content-viewer-toolbar")
          .evaluate((node) => getComputedStyle(node).position),
      ).toBe("static");
    });
  }
}
