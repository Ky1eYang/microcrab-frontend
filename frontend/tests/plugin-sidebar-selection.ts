import { expect, type Locator } from "@playwright/test";

/** Select the same plugin through whichever responsive control is currently visible. */
export async function selectSidebarPlugin(sidebar: Locator, name: string) {
  await expect(async () => {
    const select = sidebar.locator("select.client-plugin-select");
    if (await select.isVisible()) {
      await select.selectOption({ label: name });
      await expect(select.locator("option:checked")).toHaveText(name);
    } else {
      const tab = sidebar.getByRole("tab", { name, exact: true });
      await tab.click({ timeout: 1000 });
      await expect(tab).toHaveAttribute("aria-selected", "true", {
        timeout: 1000,
      });
    }
  }).toPass({ timeout: 10_000 });
}
