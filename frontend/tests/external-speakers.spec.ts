import { expect, test, type Page } from "@playwright/test";
import {
  validateSpeakerSnapshot,
  validateSpeakerOperation,
  validateSpeakerUpdate,
  validSpeakerIdentity,
  validSpeakerCustomKey,
} from "../src/client/external-speakers";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import zh from "../src/i18n/locales/zh-CN.json" with { type: "json" };
import { nativeBackend } from "./native-fixture";

const fp = "a".repeat(64);
const initial = {
  revision: 7,
  enabled: true,
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
async function mount(
  page: Page,
  kind = "session",
  strict = false,
  locale = "en",
) {
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
setActiveLocale('${locale}');
await import('/src/styles/tokens.css'); await import('/src/styles/components.css'); await import('/src/styles/owner-settings.css');
window.__alive = true; window.__toasts = [];
window.__root = ReactDOM.createRoot(document.getElementById('fixture'));
const api = new ApiClient(location.origin);
window.__renderScope = (kind, id) => {
  const scope = {kind, id};
  window.__scope = scope;
  const node = React.createElement(SpeakerSettingsDocument, {key: JSON.stringify(scope), api, scope, isCurrent: () => window.__alive && window.__scope === scope, notify: text => window.__toasts.push(text)});
  window.__root.render(${strict ? "React.createElement(React.StrictMode, null, node)" : "node"});
};
window.__renderScope('${kind}', 'session/a');
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
  const scope = { kind: "session", id: "s" } as const;
  expect(() => validateSpeakerSnapshot(initial, scope)).not.toThrow();
  const { enabled, ...legacy } = initial;
  const operationId = "11111111-1111-4111-8111-111111111111";
  const receipt = { ...legacy, operation_id: operationId };
  expect(() => validateSpeakerSnapshot(legacy, scope)).toThrow(
    /project status/,
  );
  expect(() =>
    validateSpeakerOperation(receipt, scope, operationId, { historical: true }),
  ).not.toThrow();
  expect(() =>
    validateSpeakerOperation(receipt, scope, operationId, {
      historical: false,
    }),
  ).toThrow(/project status/);
  expect(() =>
    validateSpeakerOperation({ ...receipt, enabled }, scope, operationId, {
      historical: false,
      expectedEnabled: false,
    }),
  ).toThrow(/requested setting/);
  expect(() =>
    validateSpeakerSnapshot({ ...initial, enabled: false }, scope),
  ).toThrow(/project status/);
  expect(() =>
    validateSpeakerSnapshot(
      { ...initial, enabled: false, disabled_reason: "no_project" },
      scope,
    ),
  ).not.toThrow();
  expect(() =>
    validateSpeakerSnapshot(
      { ...initial, enabled: false, disabled_reason: "no_project" },
      { kind: "project", id: "p" },
    ),
  ).toThrow(/project status/);
  const update = {
    operation_id: operationId,
    expected_revision: 7,
    speakers: {},
  };
  expect(() =>
    validateSpeakerUpdate(scope, { ...update, enabled: true }),
  ).toThrow(/forbidden/);
  expect(() =>
    validateSpeakerUpdate({ kind: "project", id: "p" }, update),
  ).toThrow(/required/);
  expect(() =>
    validateSpeakerSnapshot(
      {
        ...initial,
        overrides: {
          local: {
            action: "set",
            key: { kind: "custom", value: "never-return" },
          },
        },
      },
      scope,
    ),
  ).toThrow(/local keep/);
  expect(() =>
    validateSpeakerSnapshot(
      {
        ...initial,
        speakers: [...initial.speakers, initial.speakers[0]],
      },
      scope,
    ),
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
        enabled: false,
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
  expect(requests.puts[0]).not.toHaveProperty("enabled");
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
    "The settings changed on the server. Your draft is still here. Read the latest settings before saving again.",
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
  test(`read-only key ${failure} failure leaves settings editable and explicit retry works`, async ({
    page,
  }) => {
    const requests = await routeResource(page);
    let attempts = 0;
    await page.route("**/external-speakers/key", async (route) => {
      attempts++;
      if (attempts > 1)
        return route.fulfill({
          json: { identity: "shared", fingerprint: fp, key: "s".repeat(43) },
        });
      if (failure === "network") return route.abort("failed");
      if (failure === "json")
        return route.fulfill({ contentType: "application/json", body: "{" });
      return route.fulfill({
        json: { identity: "shared", fingerprint: "bad", key: "bad" },
      });
    });
    await mount(page);
    const row = page.getByTestId("speaker-row").filter({ hasText: "shared" });
    await row.getByRole("button", { name: "Reveal key", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(
      page.getByText("The operation outcome is unresolved.", { exact: false }),
    ).toHaveCount(0);
    await expect(
      row.getByRole("button", { name: "Reveal key", exact: true }),
    ).toBeEnabled();
    await row.getByRole("button", { name: "Reveal key", exact: true }).click();
    await expect(
      page.getByLabel("Key for shared", { exact: true }),
    ).toHaveValue("s".repeat(43));
    await page.getByTestId("speaker-identity").fill("after_read_failure");
    await page
      .getByRole("button", { name: "Apply to draft", exact: true })
      .click();
    await expect(page.getByTestId("speakers-save")).toBeEnabled();
    await page.getByTestId("speakers-save").click();
    await expect(
      page.getByText("Speaker settings saved.", { exact: false }),
    ).toBeVisible();
    expect(requests.puts).toHaveLength(1);
    expect(attempts).toBe(2);
  });
}

test("project toggle is keyboard accessible at mobile width; only Save writes the flag and keeps credentials", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const key = "s".repeat(43);
  const puts: any[] = [];
  let current: object = {
    revision: 7,
    enabled: false,
    disabled_reason: "project_disabled",
    speakers: [
      {
        identity: "known",
        fingerprint: fp,
        source: "project",
        disabled: false,
      },
    ],
    overrides: { known: { action: "set", key: { kind: "keep" } } },
  };
  await page.route(
    "**/api/v1/projects/**/external-speakers**",
    async (route) => {
      const request = route.request();
      if (request.url().endsWith("/key"))
        return route.fulfill({
          json: { identity: "known", fingerprint: fp, key },
        });
      if (request.method() === "PUT") {
        const body = request.postDataJSON();
        puts.push(body);
        const { disabled_reason: _, ...previous } = current as {
          disabled_reason?: string;
        };
        current = {
          ...previous,
          enabled: body.enabled,
          ...(body.enabled ? {} : { disabled_reason: "project_disabled" }),
          revision: body.expected_revision + 1,
        };
        return route.fulfill({
          json: { ...current, operation_id: body.operation_id },
        });
      }
      return route.fulfill({ json: current });
    },
  );
  await mount(page, "project");
  const toggle = page.getByRole("switch", { name: "Allow external messaging" });
  const status = page.getByTestId("external-messaging-status");
  const save = page.getByTestId("speakers-save");
  const reveal = page.getByRole("button", { name: "Reveal key" });
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toHaveAccessibleDescription(
    /suspends external submissions/,
  );
  await expect(status).toContainText("is off");
  await expect(reveal).toBeDisabled();
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toBeChecked();
  await expect(status).toContainText("is off");
  await expect(reveal).toBeDisabled();
  expect(puts).toEqual([]);
  await save.click();
  await expect(status).toContainText("is on");
  await expect(
    page.getByText(
      /does not confirm that the Session tool catalog has been updated/,
    ),
  ).toBeVisible();
  await reveal.click();
  await expect(page.getByLabel("Key for known")).toHaveValue(key);
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(page.getByLabel("Key for known")).toHaveCount(0);
  await expect(reveal).toBeDisabled();
  await save.click();
  await expect(status).toContainText("is off");
  expect(puts).toEqual(
    [true, false].map((enabled, index) => ({
      operation_id: expect.any(String),
      expected_revision: 7 + index,
      enabled,
      speakers: { known: { action: "set", key: { kind: "keep" } } },
    })),
  );
  expect(JSON.stringify(puts)).not.toContain(key);
  expect(
    await page
      .getByTestId("external-speakers")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
});

for (const reason of ["no_project", "project_disabled"] as const) {
  test(`Session status is read-only when ${reason}; binding edits remain available`, async ({
    page,
  }) => {
    await page.route("**/api/v1/sessions/**/external-speakers", (route) =>
      route.fulfill({
        json: {
          ...initial,
          enabled: false,
          disabled_reason: reason,
        },
      }),
    );
    await mount(page, "session", false, "zh-CN");
    await expect(page.getByTestId("external-messaging-status")).toHaveText(
      zh[`speakers.disabledStatus.${reason}`],
    );
    await expect(page.getByRole("switch")).toHaveCount(0);
    const identity = page.getByTestId("speaker-identity");
    await expect(identity).toBeEnabled();
    await identity.fill("new_sender");
    await expect(
      page.getByRole("button", { name: zh["speakers.reveal"] }).first(),
    ).toBeDisabled();
  });
}

test("busy toggle keeps both drafts; unknown retry uses only exact receipt and reloads status explicitly", async ({
  page,
}) => {
  const writes: any[] = [];
  const observations: string[] = [];
  const off = {
    ...initial,
    enabled: false,
    disabled_reason: "project_disabled",
    speakers: [],
    overrides: {},
  };
  let historical = true;
  await page.route(
    "**/api/v1/projects/**/external-speakers**",
    async (route) => {
      const request = route.request();
      if (request.method() === "PUT") {
        writes.push(request.postDataJSON());
        if (writes.length === 1)
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: "project_external_messaging_busy",
                message: "server busy",
              },
            },
          });
        return route.abort("failed");
      }
      if (request.url().includes("/operations/")) {
        observations.push(request.url());
        return route.fulfill({
          json: {
            revision: 8,
            speakers: [],
            overrides: {},
            operation_id: writes[1].operation_id,
            ...(historical ? {} : { enabled: true }),
          },
        });
      }
      return route.fulfill({ json: off });
    },
  );
  await mount(page, "project");
  const toggle = page.getByRole("switch", { name: "Allow external messaging" });
  await toggle.click();
  await page.getByTestId("speaker-identity").fill("new_sender");
  await page.getByRole("button", { name: "Apply to draft" }).click();
  const save = page.getByTestId("speakers-save");
  const row = page.getByTestId("speaker-row").filter({ hasText: "new_sender" });
  await save.click();
  await expect(page.getByRole("alert")).toContainText(
    "Wait for running turns or Session activation to finish",
  );
  await expect(toggle).toBeChecked();
  await expect(row).toContainText("Unsaved change");
  await save.click();
  await expect(save).toBeDisabled();
  const observe = page.getByRole("button", { name: "Read operation receipt" });
  await observe.click();
  await expect(page.getByRole("alert")).toContainText(
    "does not acknowledge the requested setting",
  );
  await expect(row).toContainText("Unsaved change");
  historical = false;
  await observe.click();
  const status = page.getByTestId("external-messaging-status");
  await expect(status).toHaveText(
    "Read latest settings to see the current project status.",
  );
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "Read latest settings" }).click();
  await expect(status).toContainText("is off");
  await expect(toggle).not.toBeChecked();
  expect(writes).toHaveLength(2);
  expect(writes[0].operation_id).not.toBe(writes[1].operation_id);
  expect(writes[0].speakers).toEqual(writes[1].speakers);
  expect(writes.map((write) => write.enabled)).toEqual([true, true]);
  expect(observations).toHaveLength(2);
  expect(
    observations.every((url) =>
      url.endsWith(`/operations/${writes[1].operation_id}`),
    ),
  ).toBe(true);
});

test("a superseded project scope cannot install its stale enablement or bindings", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/projects/**/external-speakers", async (route) => {
    if (route.request().url().includes("session%2Fa")) {
      await delayed;
      await route
        .fulfill({ json: { ...initial, enabled: true } })
        .catch(() => {});
    } else {
      await route.fulfill({
        json: {
          revision: 1,
          enabled: false,
          disabled_reason: "project_disabled",
          speakers: [],
          overrides: {},
        },
      });
    }
  });
  const oldRequest = page.waitForRequest((request) =>
    request.url().includes("session%2Fa/external-speakers"),
  );
  await mount(page, "project");
  await oldRequest;
  const toggle = page.getByRole("switch", { name: "Allow external messaging" });
  await expect(toggle).toBeDisabled();
  await page.evaluate(() =>
    (window as any).__renderScope("project", "replacement"),
  );
  await expect(toggle).toBeEnabled();
  release!();
  await expect(page.getByTestId("external-messaging-status")).toContainText(
    "is off",
  );
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId("speaker-row")).toHaveCount(0);
});

test("legacy runtime open preserves history and draft, and gives localized new Session guidance", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    suspendSessionOnAttach: true,
    reconciling: true,
  });
  await page.route("**/api/v1/projects/project-1/host-reconcile", (route) =>
    route.fulfill({ json: { ready: true, connected: true } }),
  );
  let opens = 0;
  let finishOpen: (() => Promise<void>) | undefined;
  await page.route("**/api/v1/sessions/s1/runtime", (route) => {
    opens++;
    finishOpen = () =>
      route.fulfill({
        status: 409,
        json: {
          error: {
            code: "legacy_external_dialogue_catalog",
            message: "raw server error",
          },
        },
      });
  });
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  const composer = page.getByTestId("composer").locator("textarea");
  await composer.fill("保留此草稿");
  await page.getByTestId("header-host-connection").click();
  await page.getByLabel("Host WebSocket 地址").fill("ws://127.0.0.1:8788/host");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "连接 Host", exact: true })
    .click();
  await expect(page.locator(".remote-connect-dialog")).toHaveCount(0);
  await page.getByTestId("header-host-connection").click();
  await page
    .getByRole("button", { name: "刷新核对与操作记录", exact: true })
    .click();
  await expect.poll(() => opens).toBe(1);
  await finishOpen!();
  await expect(
    page.getByText(zh["session.legacyExternalDialogueCatalog"], {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("保留此草稿");
  await expect(page).toHaveURL(/#session\/s1$/);
  expect(
    backend.requests.some(
      ({ method, path }) => method === "POST" && path === "/api/v1/sessions",
    ),
  ).toBe(false);
});

test("project revoke removes only local default and wraps at mobile width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.route("**/api/v1/projects/**/external-speakers", (route) =>
    route.fulfill({
      json: {
        revision: 2,
        enabled: true,
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
