import { expect, test, type Page } from "@playwright/test";
import {
  validateSpeakerSnapshot,
  validateSpeakerUpdate,
  validSpeakerIdentity,
  validSpeakerCustomKey,
} from "../src/client/external-speakers";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import zh from "../src/i18n/locales/zh-CN.json" with { type: "json" };

const fp = "a".repeat(64);
const initial = {
  revision: 7,
  speakers: [
    { identity: "shared", fingerprint: fp, source: "project", disabled: false },
    { identity: "local", fingerprint: fp, source: "session", disabled: false },
    { identity: "blocked", source: "session", disabled: true },
  ],
  overrides: {
    local: { action: "set", key: { kind: "keep" } },
    blocked: { action: "disable" },
  },
};
async function mount(page: Page, kind = "session", strict = false) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as any).__copied = value;
        },
      },
    });
  });
  await page.route("**/speaker-settings-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html data-theme="light"><body><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const {default: React} = await import('/node_modules/.vite/deps/react.js');
const {default: ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
const {SpeakerSettingsDocument} = await import('/src/features/popups/ExternalSpeakersSettings.tsx');
const {ApiClient} = await import('/src/client/api.ts');
const {setActiveLocale} = await import('/src/i18n/index.ts');
setActiveLocale('en');
await import('/src/styles/tokens.css'); await import('/src/styles/components.css'); await import('/src/styles/owner-settings.css');
window.__alive = true; window.__toasts = [];
window.__root = ReactDOM.createRoot(document.getElementById('fixture'));
const node = React.createElement(SpeakerSettingsDocument, {api: new ApiClient(location.origin), scope: {kind: '${kind}', id: 'session/a'}, isCurrent: () => window.__alive, notify: text => window.__toasts.push(text)});
window.__root.render(${strict ? "React.createElement(React.StrictMode, null, node)" : "node"});
</script></body></html>`,
    }),
  );
  await page.goto("/speaker-settings-fixture");
  await expect(page.getByTestId("external-speakers")).toBeVisible();
}
async function routeResource(page: Page, onPut?: (body: any) => unknown) {
  const puts: any[] = [];
  const reveals: any[] = [];
  await page.route("**/api/v1/**/external-speakers**", async (route) => {
    const request = route.request();
    if (request.url().endsWith("/key")) {
      reveals.push(request.postDataJSON());
      await route.fulfill({
        json: {
          identity: request.postDataJSON().identity,
          fingerprint: fp,
          key: "secret_" + "x".repeat(43),
        },
      });
    } else if (request.method() === "PUT") {
      const body = request.postDataJSON();
      puts.push(body);
      const response = onPut?.(body) ?? {
        ...initial,
        operation_id: body.operation_id,
        revision: 8,
        overrides: Object.fromEntries(
          Object.entries(body.speakers).map(
            ([identity, binding]: [string, any]) => [
              identity,
              binding.action === "set"
                ? { action: "set", key: { kind: "keep" } }
                : binding,
            ],
          ),
        ),
      };
      await route.fulfill({ json: response });
    } else await route.fulfill({ json: initial });
  });
  return { puts, reveals };
}

test("validates sparse metadata and bounded identities/keys without leaking secrets", () => {
  expect(() => validateSpeakerSnapshot(initial)).not.toThrow();
  expect(() =>
    validateSpeakerSnapshot({
      ...initial,
      overrides: {
        local: {
          action: "set",
          key: { kind: "custom", value: "never-return" },
        },
      },
    }),
  ).toThrow(/local keep/);
  expect(() =>
    validateSpeakerSnapshot({
      ...initial,
      speakers: [...initial.speakers, initial.speakers[0]],
    }),
  ).toThrow(/invalid identity/);
  expect(validSpeakerIdentity("_safe-1")).toBe(true);
  for (const value of ["1bad", "a/b", "a".repeat(65), "é"])
    expect(validSpeakerIdentity(value)).toBe(false);
  expect(validSpeakerCustomKey("a".repeat(43))).toBe(true);
  expect(validSpeakerCustomKey("a".repeat(128))).toBe(true);
  for (const value of ["a".repeat(42), "a".repeat(129), "é".repeat(43)])
    expect(validSpeakerCustomKey(value)).toBe(false);
  expect(() =>
    validateSpeakerUpdate(
      { kind: "project", id: "p" },
      {
        operation_id: "11111111-1111-4111-8111-111111111111",
        expected_revision: 7,
        speakers: { blocked: { action: "disable" } },
      },
    ),
  ).toThrow(/only available for sessions/);
  expect(
    Object.keys(en)
      .filter((key) => key.startsWith("speakers."))
      .sort(),
  ).toEqual(
    Object.keys(zh)
      .filter((key) => key.startsWith("speakers."))
      .sort(),
  );
});

test("saves complete local sparse layer, never copies inherited rows, keeps disabled tombstones", async ({
  page,
}) => {
  const requests = await routeResource(page);
  await mount(page, "session", true);
  await expect(
    page.getByText("Inherited from project", { exact: false }),
  ).toBeVisible();
  await page.getByTestId("speaker-identity").fill("new_speaker");
  await page
    .getByRole("button", { name: "Apply to draft", exact: true })
    .click();
  await expect(page.getByTestId("speakers-save")).toBeEnabled();
  await page.getByTestId("speakers-save").click();
  await expect(
    page.getByText("Speaker settings saved.", { exact: false }),
  ).toBeVisible();
  expect(requests.puts).toHaveLength(1);
  expect(requests.puts[0]).toMatchObject({
    expected_revision: 7,
    speakers: {
      local: { action: "set", key: { kind: "keep" } },
      blocked: { action: "disable" },
      new_speaker: { action: "set", key: { kind: "generated" } },
    },
  });
  expect(requests.puts[0].speakers).not.toHaveProperty("shared");
  expect(requests.puts[0].operation_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(requests.reveals).toHaveLength(0);
});

test("disables inherited speaker, reset omits local binding and custom draft is kept on concrete CAS failure", async ({
  page,
}) => {
  const puts: any[] = [];
  await page.route("**/api/v1/**/external-speakers", async (route) => {
    if (route.request().method() === "PUT") {
      puts.push(route.request().postDataJSON());
      await route.fulfill({
        status: 409,
        json: {
          error: {
            code: "revision_conflict",
            message: "owner revision changed from 7 to 9",
            retryable: false,
          },
        },
      });
    } else await route.fulfill({ json: initial });
  });
  await mount(page);
  const shared = page.getByTestId("speaker-row").filter({ hasText: "shared" });
  await shared
    .getByRole("button", { name: "Disable / revoke here", exact: true })
    .click();
  await page
    .getByTestId("speaker-row")
    .filter({ hasText: "local" })
    .getByRole("button", { name: "Reset to project", exact: true })
    .click();
  await page.getByTestId("speaker-identity").fill("custom");
  await page.getByLabel("Key source", { exact: true }).selectOption("custom");
  await page.getByLabel("Custom key", { exact: true }).fill("c".repeat(43));
  await page
    .getByRole("button", { name: "Apply to draft", exact: true })
    .click();
  await page.getByTestId("speakers-save").click();
  await expect(page.getByRole("alert")).toHaveText(
    "revision_conflict: owner revision changed from 7 to 9",
  );
  expect(puts[0].speakers.shared).toEqual({ action: "disable" });
  expect(puts[0].speakers).not.toHaveProperty("local");
  expect(puts[0].speakers.custom).toEqual({
    action: "set",
    key: { kind: "custom", value: "c".repeat(43) },
  });
  await expect(
    page.getByTestId("speaker-row").filter({ hasText: "custom" }),
  ).toContainText("Unsaved change");
  await page
    .getByRole("button", { name: "Read latest settings", exact: true })
    .click();
  await expect(page.getByTestId("speakers-observed")).toBeVisible();
  expect(puts).toHaveLength(1);
});

test("explicit reveal/copy only, owner fence rejects delayed key and dirty leave requires discard", async ({
  page,
}) => {
  const requests = await routeResource(page);
  await mount(page);
  const shared = page.getByTestId("speaker-row").filter({ hasText: "shared" });
  await expect(
    shared.getByRole("button", { name: "Reveal key", exact: true }),
  ).toBeEnabled();
  expect(requests.reveals).toHaveLength(0);
  await shared.getByRole("button", { name: "Reveal key", exact: true }).click();
  await expect(page.getByLabel("Key for shared", { exact: true })).toHaveValue(
    "secret_" + "x".repeat(43),
  );
  await shared.getByRole("button", { name: "Hide key", exact: true }).click();
  await shared.getByRole("button", { name: "Copy key", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__copied))
    .toBe("secret_" + "x".repeat(43));
  await page.getByTestId("speaker-identity").fill("draft");
  await expect(
    shared.getByRole("button", { name: "Reveal key", exact: true }),
  ).toBeDisabled();
  const left = await page.evaluate(async () => {
    // @ts-expect-error browser source import
    const { requestDocumentLeave } =
      await import("/src/client/document-leave.ts");
    (window as any).__left = false;
    return requestDocumentLeave(() => {
      (window as any).__left = true;
    });
  });
  expect(left).toBe(false);
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Discard and leave", exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).__left)).toBe(true);
});

test("unknown save retains frozen operation, observes exact receipt, never retries mutation", async ({
  page,
}) => {
  const puts: any[] = [];
  const observations: string[] = [];
  let found = false;
  await page.route("**/api/v1/**/external-speakers**", async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      puts.push(request.postDataJSON());
      await route.abort("failed");
    } else if (request.url().includes("/operations/")) {
      observations.push(request.url());
      if (!found)
        await route.fulfill({
          status: 404,
          json: {
            error: {
              code: "operation_not_found",
              message: "No saved receipt for this operation",
            },
          },
        });
      else
        await route.fulfill({
          json: {
            ...initial,
            operation_id: puts[0].operation_id,
            revision: 8,
            overrides: {
              ...initial.overrides,
              added: { action: "set", key: { kind: "keep" } },
            },
          },
        });
    } else await route.fulfill({ json: initial });
  });
  await mount(page);
  await page.getByTestId("speaker-identity").fill("added");
  await page
    .getByRole("button", { name: "Apply to draft", exact: true })
    .click();
  await page.getByTestId("speakers-save").click();
  await expect(
    page.getByText("The operation outcome is unresolved.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId("speakers-save")).toBeDisabled();
  await page
    .getByRole("button", { name: "Read latest settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Discard draft and use latest settings",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Read operation receipt", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("operation_not_found");
  await expect(
    page.getByTestId("speaker-row").filter({ hasText: "added" }),
  ).toContainText("Unsaved change");
  await expect(page.getByTestId("speakers-save")).toBeDisabled();
  found = true;
  await page
    .getByRole("button", { name: "Read operation receipt", exact: true })
    .click();
  await expect(
    page.getByText("The exact operation was applied.", { exact: false }),
  ).toBeVisible();
  expect(puts).toHaveLength(1);
  expect(observations).toHaveLength(2);
  expect(
    observations.every((url) =>
      url.endsWith(`/operations/${puts[0].operation_id}`),
    ),
  ).toBe(true);
});

test("late reveal cannot copy or render a key after owner revocation", async ({
  page,
}) => {
  await routeResource(page);
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/external-speakers/key", async (route) => {
    await waiting;
    await route.fulfill({
      json: {
        identity: "shared",
        fingerprint: fp,
        key: "secret_" + "x".repeat(43),
      },
    });
  });
  await mount(page);
  await page
    .getByTestId("speaker-row")
    .filter({ hasText: "shared" })
    .getByRole("button", { name: "Copy key", exact: true })
    .click();
  await expect(
    page.getByText("Waiting for the server receipt…", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).__alive = false;
  });
  const response = page.waitForResponse((item) => item.url().endsWith("/key"));
  release!();
  await response;
  expect(await page.evaluate(() => (window as any).__copied)).toBeUndefined();
  expect(await page.evaluate(() => (window as any).__toasts)).toEqual([]);
});

test("custom key is redacted from causal server errors and diagnostics", async ({
  page,
}) => {
  const key = "c".repeat(43);
  const messages: string[] = [];
  page.on("console", (message) => messages.push(message.text()));
  await page.route("**/api/v1/**/external-speakers", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 400,
          json: {
            error: {
              code: "binding_conflict",
              message: `Key ${key} already belongs to another declared origin`,
              details: { key },
            },
          },
        })
      : route.fulfill({ json: initial }),
  );
  await mount(page);
  await page.getByTestId("speaker-identity").fill("custom");
  await page.getByLabel("Key source", { exact: true }).selectOption("custom");
  await page.getByLabel("Custom key", { exact: true }).fill(key);
  await page
    .getByRole("button", { name: "Apply to draft", exact: true })
    .click();
  await page.getByTestId("speakers-save").click();
  await expect(page.getByRole("alert")).toHaveText(
    "binding_conflict: Key [redacted] already belongs to another declared origin",
  );
  expect(messages.join("\n")).not.toContain(key);
  expect(
    JSON.stringify(await page.evaluate(() => (window as any).__toasts)),
  ).not.toContain(key);
});

for (const failure of ["network", "json", "schema"] as const) {
  test(`read-only key ${failure} failure leaves settings editable and explicit retry works`, async ({ page }) => {
    const requests = await routeResource(page);
    let attempts = 0;
    await page.route("**/external-speakers/key", async (route) => {
      attempts++;
      if (attempts > 1) return route.fulfill({ json: { identity: "shared", fingerprint: fp, key: "s".repeat(43) } });
      if (failure === "network") return route.abort("failed");
      if (failure === "json") return route.fulfill({ contentType: "application/json", body: "{" });
      return route.fulfill({ json: { identity: "shared", fingerprint: "bad", key: "bad" } });
    });
    await mount(page);
    const row = page.getByTestId("speaker-row").filter({ hasText: "shared" });
    await row.getByRole("button", { name: "Reveal key", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText("The operation outcome is unresolved.", { exact: false })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Reveal key", exact: true })).toBeEnabled();
    await row.getByRole("button", { name: "Reveal key", exact: true }).click();
    await expect(page.getByLabel("Key for shared", { exact: true })).toHaveValue("s".repeat(43));
    await page.getByTestId("speaker-identity").fill("after_read_failure");
    await page.getByRole("button", { name: "Apply to draft", exact: true }).click();
    await expect(page.getByTestId("speakers-save")).toBeEnabled();
    await page.getByTestId("speakers-save").click();
    await expect(page.getByText("Speaker settings saved.", { exact: false })).toBeVisible();
    expect(requests.puts).toHaveLength(1);
    expect(attempts).toBe(2);
  });
}

test("project revoke removes only local default and wraps at mobile width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.route("**/api/v1/projects/**/external-speakers", (route) =>
    route.fulfill({
      json: {
        revision: 2,
        speakers: [
          {
            identity: "local",
            fingerprint: fp,
            source: "project",
            disabled: false,
          },
        ],
        overrides: { local: { action: "set", key: { kind: "keep" } } },
      },
    }),
  );
  await mount(page, "project");
  await page
    .getByRole("button", { name: "Remove / revoke default", exact: true })
    .click();
  await expect(page.getByTestId("speakers-save")).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Disable / revoke here", exact: true }),
  ).toHaveCount(0);
  expect(
    await page
      .getByTestId("external-speakers")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
});
