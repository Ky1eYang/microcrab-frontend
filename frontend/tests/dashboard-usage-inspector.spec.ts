import { expect, test } from "@playwright/test";

test("Dashboard details keep plain telemetry, reset scoped Tree, and retain existing copy", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("microcrab.ui.locale", "en"));
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        principal: { owner: "fixture-owner", subject: "sub", display_name: "Fixture", expires_at: 9999999999 },
      },
    }),
  );
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: { items: [] } }));
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
const { AppProvider } = await import('/src/state/context.tsx');
const { UsageLogsView } = await import('/src/features/dashboard/views/UsageLogsView.tsx');
const initialLogs = [
  {
    event_id: 'evt-1',
    ts_ms: 1700000000000,
    source: 'session',
    source_id: 's1',
    source_label: '{"nested":{"id":900719925474099312345}}',
    request_id: 'req-1',
    provider_id: 'openai',
    model: 'plain <span>telemetry</span>',
    protocol: 'openai-compatible',
    outcome: 'accepted',
    status_code: 200,
    latency_ms: 120,
    ttft_ms: 40,
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, cache_read_tokens: 80, cache_write_tokens: 0, reasoning_tokens: 0, uncached_input_tokens: 20, non_reasoning_output_tokens: 20, samples: 1 },
    cache_hit_rate: 0.8,
    pricing: { estimated_cost_usd: 0.001, estimated_saved_usd: 0.002, rough_input_estimate: false },
  },
  {
    event_id: 'evt-2',
    ts_ms: 1700000001000,
    source: 'relay',
    source_id: 'k1',
    source_label: '{"data":[1,2]}',
    request_id: 'req-2',
    provider_id: 'openai',
    model: 'gpt-4o-mini',
    protocol: 'openai-compatible',
    outcome: 'accepted',
    status_code: 200,
    latency_ms: 95,
    ttft_ms: 30,
    usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, uncached_input_tokens: 50, non_reasoning_output_tokens: 10, samples: 1 },
    cache_hit_rate: 0,
    pricing: { estimated_cost_usd: null, estimated_saved_usd: null, rough_input_estimate: false },
  },
];
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.copied = text; } } });
ReactDOM.createRoot(document.getElementById('root')).render(
  React.createElement(AppProvider, null, React.createElement(UsageLogsView, { initialLogs }))
);
</script></body></html>`,
    }),
  );
  await page.goto("/dashboard-usage-inspector-fixture");
  const reader = page.getByTestId("json-value-view");
  await expect(reader).toHaveCount(1);
  await expect(page.locator("tbody > tr").first()).toContainText(
    "plain <span>telemetry</span>",
  );
  await reader.getByRole("button", { name: "Tree", exact: true }).click();
  await reader
    .getByRole("button", { name: "Copy exact value: source_label" })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).copied))
    .toBe('{"nested":{"id":900719925474099312345}}');
  await page.getByRole("button", { name: "Copy JSON" }).first().click();
  await expect
    .poll(async () =>
      JSON.parse(String(await page.evaluate(() => (window as any).copied))),
    )
    .toMatchObject({ event_id: "evt-1" });
  await page.locator("tbody > tr").nth(1).click();
  await expect(page.getByTestId("object-inspector")).toHaveCount(0);
  await expect(reader).toContainText('"evt-2"');
});
