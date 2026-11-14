import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page, theme: "light" | "dark", labelled = false) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as Window & { copiedPayload?: string }).copiedPayload = text;
        },
      },
    });
  });
  await page.route("**/content-dialog-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html data-theme="${theme}"><body><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const {default: React} = await import('/node_modules/.vite/deps/react.js');
const {default: ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
const {Payload} = await import('/src/features/Payload.tsx');
const {setActiveLocale} = await import('/src/i18n/index.ts');
setActiveLocale('en');
await import('/src/styles/tokens.css');
await import('/src/styles/components.css');
const value = Array.from({length:500},(_,i)=>'literal **payload** '+i+' 中文').join('\\n');
ReactDOM.createRoot(document.getElementById('fixture')).render(
  React.createElement(Payload,{value,label:${labelled ? "'Output'" : "undefined"},variant:'trajectory',dialogTitle:'Full tool output',testid:'source-payload'}));
</script></body></html>`,
    }),
  );
  await page.goto("/content-dialog-fixture");
  await expect(page.getByTestId("source-payload")).toBeVisible();
}

for (const labelled of [false, true]) {
  test(`copy and expand share hover and keyboard focus interaction (labelled=${labelled})`, async ({
    page,
  }) => {
    await mount(page, "light", labelled);
    const source = page.getByTestId("source-payload");
    const copy = source.getByRole("button", { name: "Copy", exact: true });
    const expand = source.getByTestId("payload-dialog-expand");
    await page.mouse.move(1400, 850);
    await expect(copy).toHaveCSS("opacity", "0");
    await expect(expand).toHaveCSS("opacity", "0");
    await source.hover();
    await expect(copy).toHaveCSS("opacity", "1");
    await expect(expand).toHaveCSS("opacity", "1");
    const styles = await source
      .locator(".payload-actions button")
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const style = getComputedStyle(button);
          return [
            style.width,
            style.height,
            style.borderRadius,
            style.color,
            style.backgroundColor,
          ];
        }),
      );
    expect(styles[0]).toEqual(styles[1]);
    await page.mouse.move(1400, 850);
    await page.keyboard.press("Tab");
    await expect(copy).toBeFocused();
    await expect(copy).toHaveCSS("opacity", "1");
    await expect(expand).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await expect(expand).toBeFocused();
    await expect(expand).toHaveCSS("outline-style", "solid");
    await expect(expand).toHaveCSS("outline-width", "2px");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(expand).toBeFocused();
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await expect(copy).toHaveCSS("opacity", "0");
    await expect(expand).toHaveCSS("opacity", "0");
  });
}

test.describe("touch content actions", () => {
  test.use({ hasTouch: true });
  for (const labelled of [false, true]) {
    test(`copy and expand stay visible without hover (labelled=${labelled})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 900 });
      await mount(page, "dark", labelled);
      expect(
        await page.evaluate(() => matchMedia("(hover: none)").matches),
      ).toBe(true);
      const source = page.getByTestId("source-payload");
      await expect(
        source.getByRole("button", { name: "Copy", exact: true }),
      ).toHaveCSS("opacity", "1");
      const expand = source.getByTestId("payload-dialog-expand");
      await expect(expand).toHaveCSS("opacity", "1");
      await expand.tap();
      await expect(page.getByRole("dialog")).toBeVisible();
    });
  }
});

for (const { theme, width } of [
  { theme: "light", width: 1440 },
  { theme: "dark", width: 390 },
] as const) {
  test(`trajectory content scroll and controlled accessible dialog at ${width}px ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page, theme);
    const source = page.getByTestId("source-payload");
    const text = await source.locator("pre").innerText();
    await expect(source.getByTestId("payload-expand")).toHaveCount(0);
    await expect(source.locator("strong")).toHaveCount(0);
    const dimensions = await source.locator("pre").evaluate((el) => ({
      height: el.clientHeight,
      scroll: el.scrollHeight,
      mask: getComputedStyle(el).maskImage,
    }));
    expect(dimensions.height).toBeLessThanOrEqual(320);
    expect(dimensions.scroll).toBeGreaterThan(dimensions.height);
    expect(dimensions.mask).toBe("none");
    await source.hover();
    await source.getByRole("button", { name: "Copy", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { copiedPayload?: string }).copiedPayload,
        ),
      )
      .toBe(text);
    const expand = source.getByTestId("payload-dialog-expand");
    await expect(source.locator(".payload-actions button")).toHaveCount(2);
    await expand.click();
    const dialog = page.getByRole("dialog", { name: "Full tool output" });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe(
      "hidden",
    );
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toBeFocused();
    await expect(dialog.locator("pre")).toHaveText(text);
    await expect(dialog.getByTestId("payload-dialog-expand")).toHaveCount(0);
    await expect(dialog.getByTestId("payload-expand")).toHaveCount(0);
    await expect(dialog.locator("strong")).toHaveCount(0);
    const bounds = await dialog.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.height).toBeLessThan(900);
    expect(
      await page
        .getByTestId("content-dialog-body")
        .evaluate((el) => el.scrollHeight > el.clientHeight),
    ).toBe(true);
    await dialog.getByTestId("content-dialog-maximize").focus();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.locator("pre")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByTestId("content-dialog-maximize")).toBeFocused();
    await dialog.getByTestId("content-viewer-copyFormatted").click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { copiedPayload?: string }).copiedPayload,
        ),
      )
      .toBe(text);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
    await expect(expand).toBeFocused();
    await expand.click();
    await page.mouse.click(1, 1);
    await expect(dialog).toHaveCount(0);
    await expect(expand).toBeFocused();
  });
}
