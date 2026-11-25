import { expect, test } from "@playwright/test";
import { connectHostUI } from "./host-fixture";
import { nativeBackend } from "./native-fixture";

const stem = "0123456789abcdef";
const fullDigest = `${stem}12345678${"a".repeat(40)}`;

test("ContentDialog Payload puts exact-evidence icon toggle inside ContentViewer toolbar without extra header row", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const raw = `{"version":"${fullDigest}","count":18446744073709551615}`;
  await page.route("**/v0236-dialog-exact", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<html><body><div id="root"></div><script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
        const {default: React} = await import('/node_modules/.vite/deps/react.js');
        const {default: ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
        const {Payload} = await import('/src/features/Payload.tsx');
        const {toolReferenceProjection} = await import('/src/features/toolReferences.ts');
        for (const style of ['tokens','chrome','components','interaction-polish']) await import('/src/styles/' + style + '.css');
        const value = ${JSON.stringify(raw)};
        ReactDOM.createRoot(document.getElementById('root')).render(
          React.createElement(Payload, {
            testid: 'inline-ref-payload',
            variant: 'trajectory',
            label: '请求内容增量',
            dialogTitle: '内容',
            value,
            projection: toolReferenceProjection(value, 'coding-file', 'result'),
          }),
        );
      </script></body></html>`,
    }),
  );
  await page.goto("/v0236-dialog-exact");

  const inline = page.getByTestId("inline-ref-payload");
  const inlineExact = inline.getByTestId("payload-exact-toggle");
  const inlineCopy = inline.locator(".payload-copy");
  await expect(inlineExact).toHaveAttribute("aria-pressed", "false");
  await expect(inlineExact).toHaveText("");
  const inlineGeom = await inline.locator(".payload-actions").evaluate((el) => {
    const exactRect = el
      .querySelector('[data-testid="payload-exact-toggle"]')!
      .getBoundingClientRect();
    const copyRect = el.querySelector(".payload-copy")!.getBoundingClientRect();
    return {
      exactWidth: exactRect.width,
      exactHeight: exactRect.height,
      copyWidth: copyRect.width,
      copyHeight: copyRect.height,
      exactBeforeCopy: exactRect.right <= copyRect.left + 1,
    };
  });
  expect(inlineGeom.exactWidth).toBe(inlineGeom.copyWidth);
  expect(inlineGeom.exactHeight).toBe(inlineGeom.copyHeight);
  expect(inlineGeom.exactBeforeCopy).toBe(true);

  await inline.hover();
  await inlineExact.click();
  await expect(inlineExact).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await expect(inlineExact).toHaveCSS("opacity", "1");

  await inline.hover();
  await inline.getByTestId("payload-dialog-expand").click();
  const dialog = page.getByRole("dialog", { name: "内容" });
  await expect(dialog).toBeVisible();
  // No standalone unlabelled payload-head row above the ContentViewer toolbar.
  await expect(dialog.locator(".payload > .payload-head > button")).toHaveCount(
    0,
  );
  const toolbarExact = dialog
    .locator(".content-viewer-primary")
    .getByTestId("content-viewer-exact");
  await expect(toolbarExact).toBeVisible();
  await expect(toolbarExact).toHaveText("");
  await expect(toolbarExact).toHaveAttribute("aria-pressed", "false");
  await toolbarExact.click();
  await expect(toolbarExact).toHaveAttribute("aria-pressed", "true");
  await expect(dialog).toContainText(fullDigest);
  await dialog
    .locator(".content-viewer-primary")
    .getByTestId("content-viewer-copyExact")
    .click();
  expect(
    await page.evaluate(() => navigator.clipboard.readText()),
  ).toBe(raw);
});

test("Home unsent composer draft (text and image) survives switching to an existing session and back", async ({
  page,
}) => {
  await nativeBackend(page, { selectProject: true, images: true });

  await page.goto("/");
  await connectHostUI(page);
  const box = page.locator(".home-composer-textarea");
  await expect(box).toBeEnabled();
  await box.fill("Unsent home prompt draft");
  await box.evaluate((node) => {
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+2W5cAAAAASUVORK5CYII=",
      ),
      (c) => c.charCodeAt(0),
    );
    dt.items.add(new File([bytes], "draft-note.png", { type: "image/png" }));
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      }),
    );
  });
  await expect(page.getByTestId("composer-images").locator("img")).toHaveCount(
    1,
  );

  await page.getByTestId("session-item").first().click();
  await expect(page.locator(".transcript")).toBeVisible();
  await expect(box).toHaveValue("");
  await expect(page.getByTestId("composer-images")).toHaveCount(0);

  await box.fill("Session specific draft");
  await page.getByTestId("nav-new-chat").first().click();

  await expect(page.locator(".home-page-container")).toBeVisible();
  await expect(box).toHaveValue("Unsent home prompt draft");
  await expect(page.getByTestId("composer-images").locator("img")).toHaveCount(
    1,
  );

  await page.getByTestId("session-item").first().click();
  await expect(box).toHaveValue("Session specific draft");
});

test("Home WorkspacePicker opens single-Host flyout with compact root paths without focus theft", async ({
  page,
}) => {
  await page.route("**/v0236-single-host-picker", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<html><body><div id="root"></div><script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
        const {default: React} = await import('/node_modules/.vite/deps/react.js');
        const {default: ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
        const {AppStore} = await import('/src/state/store.ts');
        const {AppProvider} = await import('/src/state/context.tsx');
        const {WorkspacePicker} = await import('/src/features/home/WorkspacePicker/index.tsx');
        for (const style of ['tokens','chrome','components','workspace-picker']) await import('/src/styles/' + style + '.css');
        AppStore.prototype.start = function() {
          this.update({
            authSession: { authenticated: true, principal: { owner: 'owner-1' } },
            connection: 'ws',
            draftWorkspace: { kind: 'chat_only' },
            projects: [
              { id: 'p-old', name: 'Older App', root: '/srv/work/org/older-app', host_id: 'h1', host_connected: true },
              { id: 'p-new', name: 'Active App', root: '/home/dev/code/active-app', host_id: 'h1', host_connected: true },
            ],
            sessions: [
              { id: 's-recent', title: 'Recent', projectID: 'p-new', status: 'idle', lastActiveAt: 500 },
            ],
          });
        };
        ReactDOM.createRoot(document.getElementById('root')).render(
          React.createElement(AppProvider, null, React.createElement(WorkspacePicker)),
        );
      </script></body></html>`,
    }),
  );
  await page.goto("/v0236-single-host-picker");
  const trigger = page.locator(".home-workspace-badge-btn");
  await expect(trigger.locator(".ws-badge-icon")).toBeVisible();
  await trigger.click();
  await expect(trigger).toBeFocused();
  const submenu = page.getByTestId("picker-host-submenu");
  await expect(submenu).toBeVisible();
  const items = submenu.getByTestId("home-project-item");
  await expect(items.nth(0)).toHaveAttribute("data-project-id", "p-new");
  await expect(items.nth(0)).toContainText("…/code/active-app");
  await expect(items.nth(1)).toHaveAttribute("data-project-id", "p-old");
});
