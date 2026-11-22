import { expect, test, type Page } from "@playwright/test";
import { LIMIT_FIELDS } from "../src/client/settings";
import { nativeBackend } from "./native-fixture";

async function open(page: Page) {
  const folder = page.locator(".rail-project-folder").first();
  await folder.locator(".rail-project-row").hover();
  await folder.locator(".rail-project-more-btn").click();
  await page.getByTestId("project-menu-settings").click();
  return page.getByTestId("project-settings");
}

async function start(page: Page) {
  await nativeBackend(page);
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.locale", "en"),
  );
  await page.goto("/#/session/s1");
  await expect(page.getByTestId("composer-session-permissions")).toBeVisible();
  return open(page);
}

const ids = [
  "host",
  "agents",
  "models",
  "prompts",
  "speakers",
  "permissions",
  "references",
];

for (const width of [1440, 390]) {
  test(`seven named tabs use keyboard selection at ${width}px`, async ({
    page,
  }) => {
    const dialog = await start(page);
    await page.setViewportSize({ width, height: 900 });
    const tab = (id: string) =>
      dialog.getByTestId(`project-settings-tab-${id}`);
    const tabs = dialog.getByRole("tablist");
    await expect(tabs).toHaveAttribute(
      "aria-orientation",
      width === 390 ? "horizontal" : "vertical",
    );
    await expect(tabs.getByRole("tab")).toHaveCount(ids.length);
    expect(
      await tabs
        .getByRole("tab")
        .evaluateAll((items) =>
          items.map((item) => item.getAttribute("data-project-tab")),
        ),
    ).toEqual(ids);
    await expect(tabs.getByRole("tab")).toHaveText([
      "Host & binding",
      "Agents (WASM)",
      "Models",
      "Prompts",
      "Speakers",
      "Permissions",
      "References",
    ]);
    await tab("host").focus();
    await page.keyboard.press(width === 390 ? "ArrowRight" : "ArrowDown");
    await expect(tab("agents")).toBeFocused();
    await expect(tab("host")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(tab("agents")).toHaveAttribute("aria-selected", "true");
    const panel = dialog.getByRole("tabpanel");
    await expect(panel).toHaveAccessibleName("Agents (WASM)");
    await expect(tab("agents")).toHaveAttribute(
      "aria-controls",
      (await panel.getAttribute("id"))!,
    );
    await page.keyboard.press("End");
    await expect(tab("references")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(tab("host")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(panel).toHaveAccessibleName("Host & binding");
    await expect(dialog.getByRole("tab", { selected: true })).toHaveCount(1);
    if (width === 1440) {
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".rail-project-more-btn").first()).toBeFocused();
    }
  });
}

test("shares one sparse CAS draft, routes cross-tab validation, and retains conflicts until reload", async ({
  page,
}) => {
  const limits = Object.fromEntries(LIMIT_FIELDS.map((field) => [field, 64]));
  const effective = {
    limits,
    agent: "configured-agent",
    mode: "configured-mode",
  };
  let snapshot = {
    revision: 7,
    overrides: { agent: "configured-agent", system_template: "inherited? no" },
    effective,
    desired_effective: effective,
    sources: {},
    constraints: { limits },
    applied_revision: 7,
    application: "defaults_saved",
    reason: null,
  };
  const writes: any[] = [];
  let conflict = true;
  await nativeBackend(page);
  await page.route("**/api/v1/projects/project-1/settings", async (route) => {
    if (route.request().method() !== "PUT")
      return route.fulfill({ json: snapshot });
    const body = route.request().postDataJSON();
    writes.push(body);
    if (conflict)
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: "revision_conflict",
            message: "Project revision changed",
          },
        },
      });
    snapshot = {
      ...snapshot,
      revision: 8,
      applied_revision: 8,
      overrides: body.overrides,
    };
    return route.fulfill({ json: snapshot });
  });
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.locale", "en"),
  );
  await page.goto("/#/session/s1");
  await expect(page.getByTestId("composer-session-permissions")).toBeVisible();
  const dialog = await open(page);
  const go = (id: string) =>
    dialog.getByTestId(`project-settings-tab-${id}`).click();
  const save = () => dialog.getByTestId("settings-save").click();
  await go("models");
  const limit = dialog.getByTestId("limit-max_rounds");
  await limit.fill("65");
  await dialog
    .getByLabel("Action review", { exact: true })
    .selectOption("false");
  await go("prompts");
  await dialog
    .getByTestId("prompt-mode-system_template")
    .selectOption("inherit");
  await dialog.getByTestId("prompt-mode-client_prompt").selectOption("empty");
  await save();
  await expect(limit).toBeFocused();
  await expect(limit).toHaveAttribute("aria-invalid", "true");
  expect(writes).toEqual([]);
  await limit.fill("32");
  await go("permissions");
  await expect(dialog.getByLabel("Action review", { exact: true })).toHaveCount(
    0,
  );
  await dialog
    .getByRole("checkbox", { name: "Override permission defaults" })
    .check();
  const rawRules = dialog.getByTestId("settings-permission-rules");
  await rawRules.fill("[broken");
  await go("agents");
  await save();
  await expect(rawRules).toBeFocused();
  expect(writes).toEqual([]);
  const rules = [
    { tool: { kind: "exact", value: "shell" }, args: [], action: "deny" },
  ];
  await rawRules.fill(JSON.stringify(rules));
  await go("host");
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("alertdialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("alertdialog")).toHaveCount(0);
  await go("models");
  await expect(limit).toHaveValue("32");
  await save();
  await expect(dialog.getByRole("alert")).toContainText(
    "Project revision changed",
  );
  const body = {
    expected_revision: 7,
    overrides: {
      agent: "configured-agent",
      limits: { max_rounds: 32 },
      review: false,
      client_prompt: "",
      permissions: rules,
    },
  };
  expect(writes).toEqual([body]);
  await go("prompts");
  await expect(dialog.getByTestId("prompt-mode-client_prompt")).toHaveValue(
    "empty",
  );
  await expect(dialog.getByTestId("prompt-mode-system_template")).toHaveValue(
    "inherit",
  );
  conflict = false;
  await save();
  expect(writes).toEqual([body, body]);
  await go("models");
  await expect(dialog.getByTestId("settings-revisions")).toContainText("8");
  await go("prompts");
  await dialog.getByTestId("prompt-mode-client_prompt").selectOption("custom");
  await go("models");
  await dialog
    .getByRole("button", { name: "Reload saved values", exact: true })
    .click();
  await expect(limit).toHaveValue("32");
  await go("prompts");
  await expect(dialog.getByTestId("prompt-mode-client_prompt")).toHaveValue(
    "empty",
  );
});

test("separates Speaker credentials, guarded drafts and unresolved receipts from Project defaults", async ({
  page,
}) => {
  await nativeBackend(page);
  const fingerprint = "a".repeat(64);
  const key = "s".repeat(43);
  const initial = {
    revision: 3,
    speakers: [
      { identity: "known", fingerprint, source: "project", disabled: false },
    ],
    overrides: { known: { action: "set", key: { kind: "keep" } } },
  };
  const writes: any[] = [];
  const reads: string[] = [];
  let returnsReceipt = false;
  await page.route(
    "**/api/v1/projects/project-1/external-speakers**",
    (route) => {
      const request = route.request();
      if (request.url().endsWith("/key"))
        return route.fulfill({ json: { identity: "known", fingerprint, key } });
      if (request.method() === "PUT") {
        writes.push(request.postDataJSON());
        return route.abort("failed");
      }
      if (request.url().includes("/operations/")) {
        reads.push(request.url());
        if (!returnsReceipt)
          return route.fulfill({
            status: 404,
            json: {
              error: {
                code: "operation_not_found",
                message: "No operation receipt yet",
              },
            },
          });
        return route.fulfill({
          json: {
            ...initial,
            revision: 4,
            operation_id: writes[0].operation_id,
          },
        });
      }
      return route.fulfill({ json: initial });
    },
  );
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.locale", "en"),
  );
  await page.goto("/#/session/s1");
  await expect(page.getByTestId("composer-session-permissions")).toBeVisible();
  const dialog = await open(page);
  const go = (id: string) =>
    dialog.getByTestId(`project-settings-tab-${id}`).click();
  await go("models");
  await dialog.getByTestId("limit-max_rounds").fill("16");
  await go("speakers");
  const speakers = dialog.getByTestId("external-speakers");
  await expect(dialog.getByTestId("settings-save")).not.toBeVisible();
  await speakers
    .getByRole("button", { name: "Reveal key", exact: true })
    .click();
  await expect(speakers.getByLabel("Key for known")).toHaveValue(key);
  await go("models");
  await expect(speakers).toHaveCount(0);
  await expect(dialog.getByTestId("limit-max_rounds")).toHaveValue("16");
  await go("speakers");
  await expect(speakers.getByLabel("Key for known")).toHaveCount(0);
  const identity = speakers.getByTestId("speaker-identity");
  await identity.fill("draft");
  await go("permissions");
  const confirm = speakers.getByRole("alertdialog");
  await expect(
    confirm.getByRole("button", { name: "Keep editing" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(identity).toHaveValue("draft");
  await go("permissions");
  await confirm.getByRole("button", { name: "Discard and leave" }).click();
  await expect(speakers).toHaveCount(0);
  expect(writes).toEqual([]);
  await go("speakers");
  await expect(identity).toHaveValue("");
  await identity.fill("added");
  await speakers
    .getByRole("button", { name: "Apply to draft", exact: true })
    .click();
  await speakers.getByTestId("speakers-save").click();
  const observe = speakers.getByRole("button", {
    name: "Read operation receipt",
    exact: true,
  });
  await expect(observe).toBeEnabled();
  await go("models");
  await expect(speakers).toBeVisible();
  await expect(confirm).toHaveCount(0);
  await observe.click();
  await expect(speakers.getByRole("alert")).toContainText(
    "operation_not_found",
  );
  await expect(speakers.getByTestId("speakers-save")).toBeDisabled();
  returnsReceipt = true;
  await observe.click();
  await expect(
    speakers.getByText("The exact operation was applied."),
  ).toBeVisible();
  await go("models");
  await expect(speakers).toHaveCount(0);
  await expect(dialog.getByTestId("limit-max_rounds")).toHaveValue("16");
  expect(writes).toHaveLength(1);
  expect(reads).toHaveLength(2);
  expect(
    reads.every((url) => url.endsWith(`/operations/${writes[0].operation_id}`)),
  ).toBe(true);
});
