import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { maintainedPluginBundle } from "./plugin-bundle-fixture";

test("a real HTML guest retains its document and pending local draft across an atomic structural rerender", async ({
  page,
}) => {
  await nativeBackend(page);
  const bundle = await maintainedPluginBundle(page);
  const fixture = bundle.plugins.find(
    (plugin) => plugin.id === "microcrab.fixture",
  )!;
  await page.route("**/plugins/current.json", (route) =>
    route.fulfill({
      json: { version: 1, plugins: [{ ...fixture, default_enabled: true }] },
    }),
  );
  await page.addInitScript(() => {
    const scope = window as any;
    scope.heldFixtureRenders = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: any, ...rest: any[]) {
      if (
        scope.deferFixtureRenders &&
        message.type === "call" &&
        message.method === "renderView"
      ) {
        scope.heldFixtureRenders.push(() => post.call(this, message, ...rest));
        return;
      }
      return post.call(this, message, ...rest);
    } as typeof Worker.prototype.postMessage;
  });
  await page.goto("/#/session/s1/plugins/microcrab.fixture");
  const surface = page.getByTestId("expanded-plugin-page");
  await surface.getByRole("button", { name: "Use HTML", exact: true }).click();
  const frame = surface.frameLocator("iframe");
  await expect(
    frame.getByRole("button", { name: "Fixture HTML", exact: true }),
  ).toBeVisible();
  await expect(frame.getByLabel("Fixture count")).toHaveText("0");
  const iframe = surface.locator("iframe");
  await iframe.evaluate((element) => {
    (window as any).originalFixtureFrame = element;
    (window as any).deferFixtureRenders = true;
  });
  // The genuine guest remains unchanged. Add document-local editing state to its
  // sandbox, then invoke its real increment action through the production bridge.
  await frame.locator("body").evaluate((body) => {
    const dialog = document.createElement("dialog");
    dialog.id = "pending-draft";
    const draft = document.createElement("textarea");
    draft.setAttribute("aria-label", "Pending local draft");
    draft.value = "unsaved owner draft";
    const save = document.createElement("button");
    save.textContent = "Save local draft";
    save.onclick = () => {
      save.disabled = true;
      dialog.dataset.pending = "true";
      (window as any).microcrab.action("increment", null);
    };
    dialog.append(draft, save);
    body.append(dialog);
    dialog.showModal();
  });
  await frame.getByRole("button", { name: "Save local draft" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).heldFixtureRenders.length))
    .toBe(1);
  await expect(frame.getByLabel("Pending local draft")).toHaveValue(
    "unsaved owner draft",
  );
  await expect(frame.locator("#pending-draft")).toHaveAttribute("open", "");
  await expect(frame.locator("#pending-draft")).toHaveAttribute(
    "data-pending",
    "true",
  );
  await expect(
    frame.getByRole("button", { name: "Save local draft" }),
  ).toBeDisabled();
  expect(
    await iframe.evaluate(
      (element) => element === (window as any).originalFixtureFrame,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    const scope = window as any;
    scope.deferFixtureRenders = false;
    for (const release of scope.heldFixtureRenders.splice(0)) release();
  });
  await expect(frame.getByLabel("Fixture count")).toHaveText("1");
  await expect(frame.getByLabel("Pending local draft")).toHaveValue(
    "unsaved owner draft",
  );
  await expect(frame.locator("#pending-draft")).toHaveAttribute("open", "");
  await expect(
    frame.getByRole("button", { name: "Save local draft" }),
  ).toBeDisabled();
  expect(
    await iframe.evaluate(
      (element) => element === (window as any).originalFixtureFrame,
    ),
  ).toBe(true);
});
