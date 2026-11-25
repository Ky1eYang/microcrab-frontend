import { expect, test } from "@playwright/test";

test("Dashboard details keep plain telemetry, reset scoped Tree, and retain existing copy", async ({
  page,
}) => {
  await page.route("**/dashboard-usage-inspector-fixture", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<html data-theme="dark"><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const { default: React } = await import('/node_modules/.vite/deps/react.js');
const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
const { mockCallLogs } = await import('/src/features/dashboard/mockData.ts');
const { setActiveLocale } = await import('/src/i18n/index.ts');
await import('/src/styles/tokens.css');
await import('/src/styles/components.css');
await import('/src/styles/dashboard.css');
setActiveLocale('en');
const { UsageLogsView } = await import('/src/features/dashboard/views/UsageLogsView.tsx');
mockCallLogs[0].argsJson = '{"nested":{"id":900719925474099312345}}';
mockCallLogs[0].outputJson = 'plain <span>telemetry</span>';
mockCallLogs[1].argsJson = { data: [1, 2] };
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.copied = text; } } });
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(UsageLogsView));
</script></body></html>`,
    }),
  );
  await page.goto("/dashboard-usage-inspector-fixture");
  const reader = page.getByTestId("json-value-view");
  await expect(reader).toHaveCount(1);
  await expect(page.locator("pre").filter({ hasText: "plain" })).toHaveText(
    "plain <span>telemetry</span>",
  );
  await reader.getByRole("button", { name: "Tree", exact: true }).click();
  await reader
    .getByRole("button", { name: "Copy exact value: nested" })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).copied))
    .toBe('{"id":900719925474099312345}');
  await page.getByRole("button", { name: "复制 JSON" }).first().click();
  await expect
    .poll(() => page.evaluate(() => (window as any).copied))
    .toBe('{"nested":{"id":900719925474099312345}}');
  await page.locator("tbody > tr").nth(1).click();
  await expect(page.getByTestId("object-inspector")).toHaveCount(0);
  await expect(page.locator("pre").filter({ hasText: '"data"' })).toBeVisible();
});
