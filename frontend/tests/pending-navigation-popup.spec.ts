import { expect, test, type Page } from "@playwright/test";
import { nativeBackend, nativeSnapshot } from "./native-fixture";

// Capture the real running store; subscription frames, rendering and popup
// lifetimes remain owned by the application rather than a copied reducer.
async function captureApplication(page: Page) {
  await page.route("**/src/main.tsx", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `import { AppStore as PopupNavigationStore } from '/src/state/store.ts';
const startPopupNavigation = PopupNavigationStore.prototype.start;
PopupNavigationStore.prototype.start = function () { window.popupNavigationStore = this; return startPopupNavigation.call(this); };
${await response.text()}`,
    });
  });
}
async function openPopup(page: Page, type: "OpenSearch" | "OpenModelSelect") {
  await page.evaluate(
    (type) => (window as any).popupNavigationStore.dispatch({ type }),
    type,
  );
}
async function beginNavigation(page: Page, sessionId: string) {
  // The navigation must remain pending while a newer user popup is opened.
  await page.evaluate((value) => {
    void (window as any).popupNavigationStore.dispatch({
      type: "Attach",
      value,
    });
  }, sessionId);
}
async function selectedSession(page: Page) {
  return page.evaluate(
    () =>
      (window as any).popupNavigationStore.getSnapshot().sessionId as
        string | null,
  );
}
function targetSession() {
  const target = structuredClone(nativeSnapshot);
  target.session.id = "s2";
  target.session.title = "Target conversation";
  target.messages = [
    {
      id: "target-answer",
      role: "assistant",
      text: "Target history",
      parts: [],
      tool_calls: [],
    },
  ];
  return target;
}

test("initial pending attachment preserves the newer search input node, exact query and focus", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await captureApplication(page);
  backend.holdNextSubscription();
  await page.goto("/#/session/s1");
  await expect.poll(() => backend.pendingSubscriptions.length).toBe(1);
  expect(await selectedSession(page)).toBeNull();
  await openPopup(page, "OpenSearch");
  const dialog = page.locator(".search-dialog[role=dialog]");
  const input = dialog.locator(".search-dialog-input");
  await expect(input).toBeFocused();
  const query = "  pending search / 精确 draft  ";
  await input.fill(query);
  const original = await input.elementHandle();
  expect(original).not.toBeNull();
  backend.releaseSubscription();
  await expect.poll(() => selectedSession(page)).toBe("s1");
  await expect(
    page.getByTestId("chat-message").filter({ hasText: "历史回答" }),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue(query);
  await expect(input).toBeFocused();
  expect(
    await original!.evaluate(
      (node) =>
        node.isConnected &&
        node === document.querySelector(".search-dialog-input"),
    ),
  ).toBe(true);
  expect(backend.pendingSubscriptions).toHaveLength(0);
});

test("a newer model popup opened in the outgoing Session is revoked when the held target attachment commits", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { sessions: [targetSession()] });
  await captureApplication(page);
  await page.goto("/#/session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  backend.holdNextSubscription();
  await beginNavigation(page, "s2");
  await expect.poll(() => backend.pendingSubscriptions.length).toBe(1);
  expect(await selectedSession(page)).toBe("s1");
  await openPopup(page, "OpenModelSelect");
  const model = page.locator(".model-dialog[role=dialog]");
  await expect(model).toBeVisible();
  const original = await model.elementHandle();
  expect(original).not.toBeNull();
  backend.releaseSubscription();
  await expect.poll(() => selectedSession(page)).toBe("s2");
  await expect(page.getByText("Target history", { exact: true })).toBeVisible();
  await expect(model).toHaveCount(0);
  expect(await original!.evaluate((node) => node.isConnected)).toBe(false);
  expect(
    backend.commands.filter(
      (command) => command.method === "session.set_model",
    ),
  ).toHaveLength(0);
});

test("explicit navigation still closes the unchanged search popup captured before the target attachment", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { sessions: [targetSession()] });
  await captureApplication(page);
  await page.goto("/#/session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await openPopup(page, "OpenSearch");
  const dialog = page.locator(".search-dialog[role=dialog]");
  const input = dialog.locator(".search-dialog-input");
  await input.fill("captured search");
  backend.holdNextSubscription();
  await beginNavigation(page, "s2");
  await expect.poll(() => backend.pendingSubscriptions.length).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue("captured search");
  backend.releaseSubscription();
  await expect.poll(() => selectedSession(page)).toBe("s2");
  await expect(page.getByText("Target history", { exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);
});
