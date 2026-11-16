import { expect, type Page } from "@playwright/test";

export async function mountMarkdown(
  page: Page,
  text: string,
  rich: { streaming: boolean } | null = { streaming: false },
) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as any).copiedSource = value;
        },
      },
    }),
  );
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/markdown-extensions-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html data-theme="light"><body><div id="fixture" style="max-width:760px"></div><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const {default:React}=await import('/node_modules/.vite/deps/react.js');
const {default:ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');
const {Markdown}=await import('/src/features/views.tsx');
const {setActiveLocale}=await import('/src/i18n/index.ts'); setActiveLocale('en');
await import('/src/styles/tokens.css'); await import('/src/styles/components.css');
const root=ReactDOM.createRoot(document.getElementById('fixture'));
window.markdownProps=${JSON.stringify({ text, ...(rich ? { rich } : {}) }).replace(/</g, "\\u003c")};
window.renderMarkdown=(patch={})=>{Object.assign(window.markdownProps,patch); root.render(React.createElement(Markdown,window.markdownProps));};window.renderMarkdown();
</script></body></html>`,
    }),
  );
  await page.goto("/markdown-extensions-fixture");
  await expect(page.locator(".markdown-body")).toBeVisible();
  expect(errors).toEqual([]);
  return errors;
}
