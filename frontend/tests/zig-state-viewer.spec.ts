import { selectSidebarPlugin } from "./plugin-sidebar-selection";
import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nativeBackend } from "./native-fixture";
import { maintainedPluginBundle } from "./plugin-bundle-fixture";
import { stateInspection } from "./state-inspection-fixture";

// Run only after the build coordinator confirms BOTH Zig and maintained ABI 0.4
// guests are rebuilt. Read bytes at fixture setup, never from historical public hashes.
const id = "microcrab.state-viewer";
const output = resolve(import.meta.dirname, "../../../temp/v018-zig");
const componentPath = process.env.MICROCRAB_TEST_ZIG_COMPONENT
  ? resolve(process.env.MICROCRAB_TEST_ZIG_COMPONENT)
  : resolve(
      import.meta.dirname,
      "../../../microcrab-frontend-plugins/zig-out/bin/state_viewer.component.wasm",
    );
test.setTimeout(120_000);
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus && !page.isClosed()) {
    mkdirSync(output, { recursive: true });
    await page.screenshot({
      path: resolve(
        output,
        `failure-${info.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 100)}.png`,
      ),
      fullPage: true,
    });
  }
});

async function zigBundle(page: Page) {
  const index = await maintainedPluginBundle(page);
  const bytes = readFileSync(componentPath);
  expect([...bytes.subarray(0, 8)]).toEqual([0, 97, 115, 109, 13, 0, 1, 0]);
  expect(
    bytes.includes(Buffer.from("microcrab:client-plugin/view-types@0.4.0")),
  ).toBe(true);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const record = {
    id,
    sha256,
    file: `${id}/${sha256}/plugin.wasm`,
    default_enabled: true,
  };
  const plugins = index.plugins.map((entry) =>
    entry.id === id ? record : entry,
  );
  expect(plugins.filter((entry) => entry.id === id)).toHaveLength(1);
  await page.route("**/plugins/current.json", (route) =>
    route.fulfill({
      json: { ...index, plugins },
      headers: { "cache-control": "no-store" },
    }),
  );
  await page.route(`**/plugins/${record.file}`, (route) =>
    route.fulfill({
      contentType: "application/wasm",
      body: bytes,
      headers: { "cache-control": "no-store" },
    }),
  );
  console.log("Real Zig Component", {
    componentPath,
    sha256,
    bytes: bytes.length,
  });
  return record;
}

async function openExpanded(page: Page) {
  await page.goto("/#/session/s1");
  const sidebar = page.getByTestId("client-plugin-sidebar");
  if (!(await sidebar.isVisible()))
    await page.locator(".header-right-toggle-btn").click();
  await selectSidebarPlugin(sidebar, "State Viewer");
  await sidebar.getByTestId("plugin-expand").click();
  const webview = page
    .getByTestId("expanded-plugin-page")
    .getByTestId("plugin-webview");
  await expect(webview).toHaveAttribute("data-status", "ready");
  return webview;
}

async function screenshot(page: Page, name: string) {
  mkdirSync(output, { recursive: true });
  await page.screenshot({
    path: resolve(output, name),
    fullPage: true,
    animations: "disabled",
  });
}

test("real Zig 0.4 Component declares only inspection targets and rejects undeclared views before State calls", async ({
  page,
}) => {
  await nativeBackend(page);
  const artifact = await zigBundle(page);
  await page.route("**/zig-acceptance", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Zig acceptance</title>",
    }),
  );
  await page.goto("/zig-acceptance");
  const result = await page.evaluate(async ({ file, sha256 }) => {
    const path = "/src/plugins/component.ts";
    const { inspectComponent, instantiate } = await import(path);
    const bytes = new Uint8Array(
      await (await fetch(`/plugins/${file}`)).arrayBuffer(),
    );
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    if (digest !== sha256) throw new Error("Zig route digest mismatch");
    const inspection = await inspectComponent(bytes);
    const effects: string[] = [];
    const { guest, manifest } = await instantiate(inspection, {
      "microcrab:client-plugin/view-types@0.4.0": {},
      "microcrab:client-plugin/session-state@0.4.0": {
        request: (kind: string) => {
          effects.push(kind);
          return effects.length;
        },
      },
      "microcrab:client-plugin/session-state-write@0.4.0": {
        request: (kind: string) => {
          effects.push(kind);
          return effects.length;
        },
      },
    });
    const contexts = [null, "s1"].flatMap((session_id) =>
      ["en", "zh-CN"].map((locale) => ({
        schema_version: 1,
        server_origin: location.origin,
        owner_id: "zig-acceptance",
        session_id,
        locale,
        instance_generation: 1,
        surface: {
          surface_id: `setting-${locale}-${session_id}`,
          target: "setting-page",
        },
      })),
    );
    const unsupported = contexts.flatMap((ctx) => {
      const initialized = JSON.parse(guest.init(JSON.stringify(ctx)));
      const vars = JSON.stringify(initialized.vars_patch ?? {});
      const views = ["setting-page", "session-tab", "block-slot"].map(
        (target) => guest.renderView(target, vars, JSON.stringify(ctx)),
      );
      // Invalid context proves undeclared targets return before context parsing.
      views.push(guest.renderView("setting-page", vars, "not JSON"));
      for (const action of [
        "refresh",
        "save-json",
        "delete-field",
        "observe-operation",
      ])
        guest.onAction(
          action,
          JSON.stringify({
            key: "owned",
            value: 99,
            operation_id: "93b8007f-c111-4b5a-a819-e222cf000001",
          }),
          vars,
          JSON.stringify(ctx),
        );
      return views;
    });
    const absent = contexts
      .filter((ctx) => ctx.session_id === null)
      .flatMap((ctx) =>
        ["sidebar", "expanded-page"].map((target) => {
          const context = {
            ...ctx,
            surface: { surface_id: `absent-${ctx.locale}-${target}`, target },
          };
          const initialized = JSON.parse(guest.init(JSON.stringify(context)));
          return {
            locale: ctx.locale,
            view: guest.renderView(
              target,
              JSON.stringify(initialized.vars_patch ?? {}),
              JSON.stringify(context),
            ),
          };
        }),
      );
    return {
      imports: inspection.imports,
      manifest,
      effects,
      unsupported,
      absent,
      digest,
    };
  }, artifact);
  expect([...result.imports].sort()).toEqual(
    [
      "microcrab:client-plugin/session-state@0.4.0",
      "microcrab:client-plugin/session-state-write@0.4.0",
      "microcrab:client-plugin/view-types@0.4.0",
    ].sort(),
  );
  expect(result.manifest).toMatchObject({
    id,
    version: "0.4.0",
    targets: ["sidebar", "expanded-page"],
  });
  expect(result.effects).toEqual([]);
  expect(result.absent).toHaveLength(4);
  for (const { view, locale } of result.absent) {
    expect(view.mode).toBe("webview-html");
    expect(view.content).toContain(
      locale === "en"
        ? "Select a conversation to inspect its session state."
        : "请选择一个会话以查看其状态。",
    );
    expect(view.content).not.toMatch(/<(?:input|textarea|form|button)\b/i);
  }
  expect(result.unsupported).toHaveLength(16);
  for (const view of result.unsupported) {
    expect(view.mode).toBe("native-json");
    expect(JSON.parse(view.content)).toBeNull();
    expect(view.error).toBeUndefined();
  }
});

for (const session of [false, true]) {
  test(`real Zig manager never mounts inspection views with Session=${session}`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await zigBundle(page);
    const stateCalls: string[] = [];
    await page.route("**/api/v1/sessions/s1/state/inspection", (route) => {
      stateCalls.push(route.request().url());
      return route.fulfill({
        json: stateInspection({ owned: "inspection-view" }, {}),
      });
    });
    await page.goto(session ? "/#/session/s1/plugins" : "/#/plugins");
    const manager = page.getByTestId("client-plugins-manager");
    await manager.locator(`[data-plugin-nav-id="${id}"]`).click();
    await expect(
      manager.locator(`article[data-plugin-id="${id}"]`),
    ).toHaveAttribute("data-status", "ready");
    await expect(manager.getByTestId("plugin-webview")).toHaveCount(0);
    await expect(
      manager.getByRole("button", { name: "展开", exact: true }),
    ).toHaveCount(0);
    expect(stateCalls).toEqual([]);
  });
}

test("real Zig sidebar and expanded editor follow live host themes without losing the document or draft", async ({
  page,
}) => {
  await nativeBackend(page);
  await zigBundle(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) =>
    route.fulfill({
      json: stateInspection(
        { owned: { original: true }, framework: "locked" },
        {
          owned: { visibility: "visible", persistence: "persisted" },
        },
      ),
    }),
  );
  await page.goto("/#/session/s1");
  await page.locator(".header-right-toggle-btn").click();
  const sidebar = page
    .getByTestId("client-plugin-sidebar")
    .getByTestId("plugin-webview");
  await expect(sidebar).toHaveAttribute("data-status", "ready");

  const assertTheme = async (
    webview: ReturnType<Page["getByTestId"]>,
    theme: "light" | "dark",
  ) => {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const frame = webview.contentFrame();
    await expect(frame.locator("html")).toHaveAttribute("data-theme", theme);
    const host = await page.locator("html").evaluate((root) => {
      const style = getComputedStyle(root);
      const probe = document.createElement("span");
      document.body.appendChild(probe);
      const color = (token: string) => {
        probe.style.color = style.getPropertyValue(token);
        return getComputedStyle(probe).color;
      };
      const colors = {
        background: color("--bg"),
        text: color("--text"),
        surface: color("--surface"),
        subtle: color("--bg-subtle"),
        ink: color("--ink"),
        contrast: color("--ink-contrast"),
        warning: color("--warn"),
        danger: color("--danger"),
        control: color("--control-border"),
      };
      probe.remove();
      return colors;
    });
    await expect(frame.locator("body")).toHaveCSS(
      "background-color",
      host.background,
    );
    await expect(frame.locator("body")).toHaveCSS("color", host.text);
    await expect(frame.locator('[data-key="owned"].var-card')).toHaveCSS(
      "background-color",
      host.surface,
    );
    await expect(frame.locator('[data-key="owned"] .val-preview')).toHaveCSS(
      "background-color",
      host.subtle,
    );
    await expect(frame.locator('[data-key="owned"] .card-title')).toHaveCSS(
      "color",
      host.text,
    );
    await expect(
      frame.locator('[data-key="framework"] .badge-locked'),
    ).toHaveCSS("color", host.warning);
    await expect(frame.locator("#btn-new")).toHaveCSS(
      "background-color",
      host.ink,
    );
    await expect(frame.locator("#btn-new")).toHaveCSS("color", host.contrast);
    await expect(frame.locator("#search")).toHaveCSS(
      "border-top-color",
      host.control,
    );
    await expect(frame.locator("#delete-confirm")).toHaveCSS(
      "border-top-color",
      host.danger,
    );
    return host;
  };

  for (const theme of ["light", "dark"] as const)
    await assertTheme(sidebar, theme);
  const webview = await openExpanded(page);
  const frame = webview.contentFrame();
  await expect(frame.locator('[data-key="owned"].var-card')).toBeVisible();
  await frame
    .locator("body")
    .evaluate((body) => body.setAttribute("data-theme-document", "retained"));
  await frame.locator('[data-key="owned"] .op-edit').click();
  await frame.locator("#modal-val").fill('{"unsaved":"theme draft"}');
  for (const theme of ["light", "dark", "light"] as const) {
    const host = await assertTheme(webview, theme);
    await expect(frame.locator("body")).toHaveAttribute(
      "data-theme-document",
      "retained",
    );
    await expect(frame.locator("#edit-modal")).toHaveClass(/open/);
    await expect(frame.locator("#modal-val")).toHaveValue(
      '{"unsaved":"theme draft"}',
    );
    await expect(frame.locator("#edit-modal .modal-box")).toHaveCSS(
      "background-color",
      host.surface,
    );
    await expect(frame.locator("#modal-val")).toHaveCSS("color", host.text);
  }
  await frame.locator("#modal-cancel").click();
  await frame.locator('[data-key="owned"] .op-del').click();
  for (const theme of ["light", "dark"] as const) {
    const host = await assertTheme(webview, theme);
    await expect(frame.locator("#delete-modal")).toHaveClass(/open/);
    await frame.locator("#delete-confirm").hover();
    await expect(frame.locator("#delete-confirm")).toHaveCSS(
      "background-color",
      host.ink,
    );
    await expect(frame.locator("#delete-confirm")).toHaveCSS(
      "color",
      host.contrast,
    );
  }
});

test("real Zig Worker renders sidebar and expanded Webview with inspection governance and updates projection without iframe reload", async ({
  page,
}) => {
  await nativeBackend(page);
  await zigBundle(page);
  let revision = 1;
  let reads = 0;
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) => {
    reads++;
    return route.fulfill({
      json: stateInspection(
        {
          framework: `framework-${revision}`,
          owned: { revision },
          delegated: 7,
          secret: "invisible-source",
        },
        {
          owned: { visibility: "visible", persistence: "persisted" },
          delegated: {
            owner: "agent",
            editors: ["agent", "client"],
            visibility: "visible",
            persistence: "ephemeral",
          },
          secret: { visibility: "invisible", persistence: "ephemeral" },
        },
        String(revision),
      ),
    });
  });
  await page.goto("/#/session/s1");
  await page.locator(".header-right-toggle-btn").click();
  const sidebar = page
    .getByTestId("client-plugin-sidebar")
    .getByTestId("plugin-webview");
  await expect(sidebar).toHaveAttribute("data-status", "ready");
  await expect(
    sidebar.contentFrame().locator("#observe-operation"),
  ).toBeHidden();
  await expect(
    sidebar.contentFrame().locator('[data-key="owned"].var-card'),
  ).toContainText('"revision": 1');
  await expect(
    sidebar.contentFrame().locator('[data-key="framework"] .op-edit'),
  ).toBeDisabled();
  await expect(
    sidebar.contentFrame().locator('[data-key="framework"] .op-del'),
  ).toBeDisabled();
  await expect(
    sidebar.contentFrame().locator('[data-key="delegated"] .op-edit'),
  ).toBeEnabled();
  await expect(
    sidebar.contentFrame().locator('[data-key="delegated"] .op-del'),
  ).toBeDisabled();
  await expect(
    sidebar.contentFrame().locator('[data-key="secret"].var-card'),
  ).toHaveCount(0);
  await screenshot(page, "sidebar.png");
  const webview = await openExpanded(page);
  const frame = webview.contentFrame();
  await expect(frame.locator('[data-key="owned"].var-card')).toContainText(
    '"revision": 1',
  );
  await frame
    .locator("body")
    .evaluate((node) => node.setAttribute("data-zig-document", "survived"));
  await frame.locator("#btn-invisible").click();
  await expect(frame.locator('[data-key="secret"].var-card')).toContainText(
    "invisible-source",
  );
  revision = 2;
  const beforeReads = reads;
  await frame.locator("#btn-refresh").click();
  await expect.poll(() => reads).toBeGreaterThan(beforeReads);
  await expect(frame.locator('[data-key="owned"].var-card')).toContainText(
    '"revision": 2',
  );
  await expect(frame.locator("body")).toHaveAttribute(
    "data-zig-document",
    "survived",
  );
  await expect(frame.locator('[data-key="framework"].var-card')).toContainText(
    "framework-2",
  );
  await screenshot(page, "expanded-live.png");
});

test("real Zig unknown writes are observed by exact operation identity through queued to applied without replay", async ({
  page,
}) => {
  await nativeBackend(page);
  await zigBundle(page);
  let revision = 1;
  let current = 1;
  const snapshot = () =>
    stateInspection(
      { owned: current },
      {
        owned: { visibility: "visible", persistence: "persisted" },
      },
      String(revision),
    );
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) =>
    route.fulfill({ json: snapshot() }),
  );
  const writes: any[] = [];
  await page.route("**/api/v1/sessions/s1/variables", async (route) => {
    const body = route.request().postDataJSON();
    writes.push(body);
    if (writes.length === 1) return route.abort("failed");
    const before = snapshot().witness;
    current = body.change.set.owned;
    revision++;
    return route.fulfill({
      json: {
        operation_id: body.operation_id,
        status: "applied",
        boundary: "next_state_patch",
        commit: { before, after: snapshot().witness, changed: true },
      },
    });
  });
  const observations: string[] = [];
  await page.route("**/api/v1/sessions/s1/variables/operations/*", (route) => {
    expect(route.request().method()).toBe("GET");
    const operation_id = decodeURIComponent(
      route.request().url().split("/").at(-1)!,
    );
    observations.push(operation_id);
    if (observations.length === 1)
      return route.fulfill({ json: { operation_id, status: "queued" } });
    const before = snapshot().witness;
    current = 2;
    revision++;
    return route.fulfill({
      json: {
        operation_id,
        status: "applied",
        boundary: "next_state_patch",
        commit: { before, after: snapshot().witness, changed: true },
      },
    });
  });
  const webview = await openExpanded(page);
  const frame = webview.contentFrame();
  const card = frame.locator('[data-key="owned"].var-card');
  await expect(card).toContainText("1");
  await card.locator(".op-edit").click();
  await frame.locator("#modal-val").fill("2");
  await frame.locator("#modal-save").click();
  await expect.poll(() => writes.length).toBe(1);
  const observe = frame.locator("#observe-operation");
  await expect(observe).toBeVisible();
  await expect(frame.locator("#modal-save")).toBeDisabled();
  await expect(frame.locator("#modal-val")).toHaveValue("2");
  await expect(card.locator(".val-preview")).toHaveText("1");
  await screenshot(page, "edit-unknown.png");
  await observe.click();
  await expect.poll(() => observations.length).toBe(1);
  await expect(frame.locator("#modal-save")).toBeDisabled();
  await expect(observe).toBeEnabled();
  expect(writes).toHaveLength(1);
  await observe.click();
  await expect(card.locator(".val-preview")).toHaveText("2");
  expect(observations).toEqual([
    writes[0].operation_id,
    writes[0].operation_id,
  ]);
  expect(writes).toHaveLength(1);
  await expect(frame.locator("#edit-modal")).not.toHaveClass(/open/);
  await card.locator(".op-edit").click();
  await frame.locator("#modal-val").fill("3");
  await frame.locator("#modal-save").click();
  await expect(card.locator(".val-preview")).toHaveText("3");
  expect(writes).toHaveLength(2);
  expect(writes[1].operation_id).not.toBe(writes[0].operation_id);
  expect(writes[1].expected.variables_revision).toBe("2");
  await screenshot(page, "edit-observed-applied.png");
});

for (const outcome of ["applied", "rejected", "conflict"] as const) {
  test(`real Zig edit keeps its draft pending until the checked ${outcome} receipt`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await zigBundle(page);
    const failureMessage =
      outcome === "conflict"
        ? "variable inspection is stale; inspect current variables and explicitly save again"
        : "Client write authority revoked by fixture";
    let revision = 1;
    let current = { before: true } as Record<string, boolean>;
    const snapshot = () =>
      stateInspection(
        { owned: current },
        {
          owned: { visibility: "visible", persistence: "persisted" },
        },
        String(revision),
      );
    let inspections = 0;
    await page.route("**/api/v1/sessions/s1/state/inspection", (route) => {
      inspections++;
      return route.fulfill({ json: snapshot() });
    });
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const writes: any[] = [];
    await page.route("**/api/v1/sessions/s1/variables", async (route) => {
      const body = route.request().postDataJSON();
      writes.push(body);
      await held;
      if (outcome !== "applied") {
        await route.fulfill({
          status: outcome === "conflict" ? 409 : 403,
          json: {
            error: {
              code:
                outcome === "conflict"
                  ? "variable_conflict"
                  : "variable_permission_denied",
              message: failureMessage,
              details: { operation_id: body.operation_id },
            },
          },
        });
      } else {
        const before = snapshot().witness;
        current = body.change.set.owned;
        revision++;
        await route.fulfill({
          json: {
            operation_id: body.operation_id,
            status: "applied",
            boundary: "next_state_patch",
            commit: { before, after: snapshot().witness, changed: true },
          },
        });
      }
    });
    const webview = await openExpanded(page);
    const frame = webview.contentFrame();
    const card = frame.locator('[data-key="owned"].var-card');
    await expect(card).toContainText('"before": true');
    await card.locator(".op-edit").click();
    await frame.locator("#modal-val").fill('{"after":true}');
    const readsBefore = inspections;
    await frame.locator("#modal-save").click();
    try {
      await expect.poll(() => writes.length).toBe(1);
      expect(Object.keys(writes[0]).sort()).toEqual([
        "change",
        "expected",
        "operation_id",
      ]);
      expect(writes[0]).toMatchObject({
        expected: snapshot().witness,
        change: { set: { owned: { after: true } } },
      });
      expect(writes[0].operation_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      await expect(frame.locator("#edit-modal")).toHaveClass(/open/);
      await expect(frame.locator("#modal-save")).toBeDisabled();
      await expect(frame.locator("#modal-val")).toHaveValue('{"after":true}');
      await expect(card).toContainText('"before": true');
      expect(inspections).toBe(readsBefore);
      await screenshot(page, `edit-${outcome}-pending.png`);
    } finally {
      release();
    }
    if (outcome === "applied") {
      await expect(card).toContainText('"after": true');
      await expect(frame.locator("#edit-modal")).not.toHaveClass(/open/);
      await expect.poll(() => inspections).toBeGreaterThan(readsBefore);
    } else {
      await expect(frame.locator("#edit-modal")).toHaveClass(/open/);
      await expect(frame.locator("#modal-val")).toHaveValue('{"after":true}');
      await expect(page.locator('.toast[data-kind="error"]')).toContainText(
        failureMessage,
      );
      await expect(frame.locator("#modal-alert")).toContainText(failureMessage);
      await expect(frame.locator("#modal-save")).toBeEnabled();
      await expect(card).toContainText('"before": true');
      expect(current).toEqual({ before: true });
    }
    expect(writes).toHaveLength(1);
    await screenshot(page, `edit-${outcome}-receipt.png`);
  });
}

for (const locale of ["en", "zh-CN"] as const) {
  test(`real Zig Worker Secret metadata remains value-readonly with authorized deletion (${locale})`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.addInitScript(
      (value) => localStorage.setItem("microcrab.ui.locale", value),
      locale,
    );
    await zigBundle(page);
    let revision = 1;
    let deleted = false;
    const snapshot = () => {
      const inspection = stateInspection(
        { owned: "ordinary visible value", SECRET_TOKEN: "{{secret:SECRET_TOKEN}}" },
        {
          owned: { visibility: "visible", persistence: "persisted" },
          SECRET_TOKEN: { visibility: "secret", persistence: "ephemeral" },
          ...(!deleted
            ? { SECRET_METADATA_ONLY: { visibility: "secret", persistence: "ephemeral" } }
            : {}),
        },
        String(revision),
      );
      inspection.descriptors.SECRET_TOKEN = {
        kind: "custom",
        editable: false,
        owner_editable: false,
        deletable: true,
      };
      if (!deleted) {
        inspection.descriptors.SECRET_METADATA_ONLY = {
          kind: "custom",
        editable: false,
        owner_editable: false,
        deletable: true,
        };
      }
      return inspection;
    };
    await page.route("**/api/v1/sessions/s1/state/inspection", (route) =>
      route.fulfill({ json: snapshot() }),
    );
    const writes: Record<string, any>[] = [];
    await page.route("**/api/v1/sessions/s1/variables", (route) => {
      const body = route.request().postDataJSON();
      writes.push(body);
      expect(Object.keys(body).sort()).toEqual(["change", "expected", "operation_id"]);
      expect(body.change).toEqual({ remove: ["SECRET_METADATA_ONLY"] });
      expect(body.expected).toEqual(snapshot().witness);
      expect(body.operation_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(JSON.stringify(body)).not.toContain("{{secret:");
      const before = snapshot().witness;
      deleted = true;
      revision++;
      return route.fulfill({
        json: {
          operation_id: body.operation_id,
          status: "applied",
          boundary: "next_state_patch",
          commit: { before, after: snapshot().witness, changed: true },
        },
      });
    });
    const webview = await openExpanded(page);
    const frame = webview.contentFrame();
    const secret = frame.locator('[data-key="SECRET_TOKEN"].var-card');
    const metadataOnly = frame.locator('[data-key="SECRET_METADATA_ONLY"].var-card');
    const label = locale === "en" ? "Secret" : "机密";
    const preview = locale === "en" ? "Secret value is not readable" : "机密值不可读取";
    for (const card of [secret, metadataOnly]) {
      await expect(card).toBeVisible();
      await expect(card.locator(".card-badges")).toContainText(label);
      await expect(card.locator(".badge-locked")).toContainText(
        locale === "en" ? "Read Only" : "只读受保护",
      );
      await expect(card.locator(".val-preview")).toHaveText(preview);
      await expect(card.locator(".op-edit")).toBeDisabled();
      await expect(card.locator(".op-del")).toBeEnabled();
    }
    await expect(frame.locator("#vars-list")).not.toContainText("{{secret:");
    await expect(frame.locator("#summary")).toContainText(
      locale === "en" ? "3 fields (2 read-only)" : "共 3 个字段 (2 个只读)",
    );
    await frame.locator("#search").fill("{{secret:");
    await expect(frame.locator(".var-card")).toHaveCount(0);
    await frame.locator("#search").fill("secret_metadata");
    await expect(metadataOnly).toBeVisible();
    await expect(secret).toHaveCount(0);
    await frame.locator("#search").fill("");
    // Ordinary descriptor-governed values still open their normal editor.
    await frame.locator('[data-key="owned"] .op-edit').click();
    await expect(frame.locator("#modal-val")).toHaveValue('"ordinary visible value"');
    await frame.locator("#modal-cancel").click();
    expect(writes).toEqual([]);
    await metadataOnly.locator(".op-del").click();
    await expect(frame.locator("#delete-msg")).toContainText("SECRET_METADATA_ONLY");
    await frame.locator("#delete-confirm").click();
    await expect(metadataOnly).toHaveCount(0);
    await expect(secret.locator(".val-preview")).toHaveText(preview);
    await expect(frame.locator("#delete-modal")).not.toHaveClass(/open/);
    expect(writes).toHaveLength(1);
  });
}

test("real Zig Worker rechecks Secret deletion descriptor after confirmation opens", async ({
  page,
}) => {
  await nativeBackend(page);
  await zigBundle(page);
  let deletable = true;
  let reads = 0;
  const snapshot = () => {
    const inspection = stateInspection(
      {},
      { SECRET_METADATA_ONLY: { visibility: "secret", persistence: "ephemeral" } },
      deletable ? "1" : "2",
    );
    inspection.descriptors.SECRET_METADATA_ONLY = {
      kind: "custom", editable: false, owner_editable: false, deletable,
    };
    return inspection;
  };
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) => {
    reads++;
    return route.fulfill({ json: snapshot() });
  });
  const writes: unknown[] = [];
  await page.route("**/api/v1/sessions/s1/variables", (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ status: 403, json: { error: { code: "unexpected_write", message: "Revoked descriptor must not dispatch" } } });
  });
  const webview = await openExpanded(page);
  const frame = webview.contentFrame();
  const card = frame.locator('[data-key="SECRET_METADATA_ONLY"].var-card');
  await expect(card.locator(".op-del")).toBeEnabled();
  await card.locator(".op-del").click();
  await expect(frame.locator("#delete-modal")).toHaveClass(/open/);
  deletable = false;
  const beforeReads = reads;
  // Trigger the existing refresh action while preserving the open confirmation.
  await frame.locator("#btn-refresh").evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => reads).toBeGreaterThan(beforeReads);
  await expect(card.locator(".op-del")).toBeDisabled();
  await frame.locator("#delete-confirm").click();
  await expect(frame.locator("#delete-modal")).toHaveClass(/open/);
  expect(writes).toEqual([]);
});


test("real Zig State renders typed short labels without changing exact inspected or custom values", async ({ page }) => {
  await nativeBackend(page);
  const bytes = readFileSync(componentPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = `${id}/${sha256}/plugin.wasm`;
  await page.route("**/plugins/current.json", (route) => route.fulfill({ json: {
    version: 1, plugins: [{ id, sha256, file, default_enabled: true }],
  } }));
  await page.route(`**/plugins/${file}`, (route) => route.fulfill({ contentType: "application/wasm", body: bytes }));
  const stem = "1234567890abcdef12345678";
  const a = stem + "a".repeat(40);
  const b = stem + "b".repeat(40);
  const inspection = stateInspection({ references: [{ content_digest: a }, { content_digest: b }], custom: { content_digest: a } }, { custom: { visibility: "visible" } });
  inspection.descriptors.references.kind = "reference";
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) => route.fulfill({ json: inspection }));
  const webview = await openExpanded(page);
  const frame = webview.contentFrame();
  const typed = frame.locator('.var-card[data-key="references"]');
  const custom = frame.locator('.var-card[data-key="custom"]');
  const value = typed.locator(".val-preview");
  await expect(value).toContainText(`${stem}…~1`);
  await expect(value).toContainText(`${stem}…~2`);
  await expect(value).not.toContainText(a);
  await expect(custom.locator(".val-preview")).toContainText(a);
  await typed.getByRole("button", { name: /Show exact evidence|显示精确证据/ }).click();
  await expect(value).toContainText(a);
  await expect(value).toContainText(b);
  await typed.getByRole("button", { name: /Show compact view|显示简洁视图/ }).click();
  await expect(value).not.toContainText(a);
});
