import { selectSidebarPlugin } from "./plugin-sidebar-selection";
import { maintainedPluginBundle } from "./plugin-bundle-fixture";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { stateInspection } from "./state-inspection-fixture";
import type { Json } from "../src/plugins/types";

for (const intent of ["selection", "back"] as const) {
  test(`plugin manager ${intent} guards dirty settings drafts`, async ({
    page,
  }) => {
    const backend = await editorBackend(page);
    await page.goto("/#/session/s1/plugins");
    const manager = page.getByTestId("client-plugins-manager");
    await manager
      .locator('[data-plugin-nav-id="microcrab.state-viewer"]')
      .click();
    const surface = manager.getByTestId("plugin-setting-surface");
    await expect(action(surface, "edit")).toBeVisible();
    const values = await begin(surface);
    values.owned = "manager draft survives guarded intent";
    await fill(surface, values);
    await editor(surface).evaluate(element => element.setAttribute("data-stable-editor", "original"));
    const search = manager.getByRole("searchbox", { name: "搜索插件名称、ID 或描述…", exact: true });
    await search.fill("does-not-match-selected-plugin");
    await expect(editor(surface)).toHaveAttribute("data-stable-editor", "original");
    await expect(manager.locator('[data-plugin-nav-id="microcrab.state-viewer"]')).toBeVisible();
    await search.fill("");
    await expect(manager.getByRole("button", { name: "展开", exact: true })).toHaveCount(0);
    const navigate = () =>
      intent === "selection"
        ? manager.locator('[data-plugin-nav-id="microcrab.mcp-bridge"]').click()
        : manager.getByRole("button", { name: "返回", exact: true }).click();
    await navigate();
    await expect(action(surface, "discard")).toBeVisible();
    await action(surface, "keepEditing").click();
    await expect(editor(surface)).toBeVisible();
    await navigate();
    await action(surface, "discard").click();
    if (intent === "selection")
      await expect(
        manager.locator('article[data-plugin-id="microcrab.mcp-bridge"]'),
      ).toBeVisible();
    else await expect(manager).toHaveCount(0);
    expect(backend.writes).toHaveLength(0);
  });
}

test("plugin manager pending settings save vetoes selection and back", async ({
  page,
}) => {
  const backend = await editorBackend(page);
  await page.goto("/#/session/s1/plugins");
  const manager = page.getByTestId("client-plugins-manager");
  await manager
    .locator('[data-plugin-nav-id="microcrab.state-viewer"]')
    .click();
  const surface = manager.getByTestId("plugin-setting-surface");
  await expect(action(surface, "edit")).toBeVisible();
  const values = await begin(surface);
  values.owned = "one pending manager operation";
  await fill(surface, values);
  const release = backend.hold();
  try {
    await save(surface);
    await expect.poll(() => backend.writes.length).toBe(1);
    await manager
      .locator('[data-plugin-nav-id="microcrab.mcp-bridge"]')
      .click();
    await manager.getByRole("button", { name: "返回", exact: true }).click();
    await expect(manager.getByRole("button", { name: "展开", exact: true })).toHaveCount(0);
    await expect(editor(surface)).toBeVisible();
    await expect(
      manager.locator('article[data-plugin-id="microcrab.state-viewer"]'),
    ).toBeVisible();
    await expect(page.getByTestId("plugin-workspace-dialog")).toHaveCount(0);
    release();
    await saved(surface);
    await expect(manager).toBeVisible();
    expect(backend.writes).toHaveLength(1);
  } finally {
    release();
  }
});

type ScopedWrite = {
  name: string;
  value: Json;
  visibility: string;
  persistence: string;
  editors: string[];
};
type Patch = {
  operation_id: string;
  expected: ReturnType<typeof stateInspection>["witness"];
  change: {
    set?: Record<string, Json>;
    scoped_set?: ScopedWrite[];
    remove?: string[];
  };
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Only HTTP fixtures own server facts; the real Component computes every DTO. */
async function editorBackend(page: Page) {
  await nativeBackend(page);
  await maintainedPluginBundle(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).__editorCopied = text;
        },
      },
    });
  });
  const values: Record<string, Json> = {
    owned: { initial: true },
    hidden_owned: { secret: "full source survives display filtering" },
    searched_out: [false, null, 42],
    delegated: 7,
    framework: "runtime fact",
  };
  const metadata: Record<string, Record<string, Json>> = {
    owned: {
      visibility: "visible",
      persistence: "persisted",
      owner: "client",
      editors: ["client", "agent"],
    },
    hidden_owned: {
      visibility: "invisible",
      persistence: "ephemeral",
      owner: "client",
      editors: ["client"],
    },
    searched_out: {
      visibility: "visible",
      persistence: "persisted",
      owner: "client",
      editors: ["client", "runtime"],
    },
    delegated: {
      visibility: "visible",
      persistence: "ephemeral",
      owner: "agent",
      editors: ["agent", "client"],
    },
  };
  const writes: Patch[] = [];
  const operations: string[] = [];
  const inspections: string[] = [];
  const denied = new Set<string>();
  let revision = 1;
  let failure: "conflict" | "unknown" | null = null;
  let held: ReturnType<typeof deferred> | null = null;
  const snapshot = () => stateInspection(values, metadata, String(revision));
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) => {
    inspections.push(String(revision));
    return route.fulfill({ json: snapshot() });
  });
  await page.route("**/api/v1/sessions/s1/variables", async (route) => {
    const body = route.request().postDataJSON() as Patch;
    writes.push(body);
    const gate = held;
    held = null;
    if (gate) await gate.promise;
    if (failure === "unknown") {
      failure = null;
      await route.abort("failed");
      return;
    }
    if (failure === "conflict") {
      failure = null;
      revision++;
    }
    if (
      body.expected.variables_revision !== String(revision) ||
      body.expected.runtime_instance_id !==
        snapshot().witness.runtime_instance_id
    ) {
      await route.fulfill({
        status: 409,
        json: {
          error: {
            code: "variable_conflict",
            message: "Fixture State revision changed",
            details: { operation_id: body.operation_id },
          },
        },
      });
      return;
    }
    // Revalidate the COMPLETE batch before applying any member. Server policy
    // can revoke a right after the captured inspection without changing values.
    const descriptors = snapshot().descriptors;
    const invalid =
      Object.keys(body.change.set ?? {}).find(
        (key) => denied.has(key) || !descriptors[key]?.editable,
      ) ??
      (body.change.remove ?? []).find(
        (key) => denied.has(key) || !descriptors[key]?.deletable,
      ) ??
      (body.change.scoped_set ?? []).find((entry) => entry.name in values)
        ?.name;
    if (invalid) {
      await route.fulfill({
        status: 403,
        json: {
          error: {
            code: "variable_permission_denied",
            message: `${invalid}: Client write permission revoked; entire batch rejected`,
            details: { operation_id: body.operation_id },
          },
        },
      });
      return;
    }
    const before = snapshot().witness;
    for (const [key, value] of Object.entries(body.change.set ?? {}))
      values[key] = value;
    for (const write of body.change.scoped_set ?? []) {
      values[write.name] = write.value;
      metadata[write.name] = {
        visibility: write.visibility,
        persistence: write.persistence,
        owner: "client",
        editors: write.editors,
      };
    }
    for (const key of body.change.remove ?? []) {
      delete values[key];
      delete metadata[key];
    }
    revision++;
    await route.fulfill({
      json: {
        operation_id: body.operation_id,
        status: "applied",
        boundary: "next_state_patch",
        commit: { before, after: snapshot().witness, changed: true },
      },
    });
  });
  await page.route("**/api/v1/sessions/s1/variables/operations/*", (route) => {
    const operation_id = decodeURIComponent(
      route.request().url().split("/").at(-1)!,
    );
    operations.push(operation_id);
    return route.fulfill({ json: { operation_id, status: "unknown" } });
  });
  return {
    writes,
    operations,
    inspections,
    values,
    metadata,
    denied,
    fail(kind: typeof failure) {
      failure = kind;
    },
    hold() {
      const gate = deferred();
      held = gate;
      return gate.resolve;
    },
  };
}
const editor = (surface: Locator) =>
  surface.getByTestId("content-viewer-editor");
const action = (surface: Locator, name: string) =>
  surface.getByTestId(`content-viewer-${name}`);
async function secondary(surface: Locator, name: string) {
  const control = action(surface, name);
  if (!(await control.isVisible())) await action(surface, "more").click();
  return control;
}
// CodeMirror virtualizes lines. Copy reads the complete public draft, including
// offscreen text and exact whitespace, without importing editor implementation.
async function draftText(surface: Locator) {
  await action(surface, "copyFormatted").click();
  return surface
    .page()
    .evaluate(() => (window as any).__editorCopied as string);
}
async function exactDraft(surface: Locator, text: string) {
  await expect.poll(() => draftText(surface)).toBe(text);
}
async function fillText(surface: Locator, text: string) {
  const input = editor(surface);
  await expect(input).toHaveClass(/cm-content/);
  await input.focus();
  await input.press("ControlOrMeta+a");
  await surface.page().keyboard.insertText(text);
  await exactDraft(surface, text);
}
async function openViewer(page: Page, direct = false) {
  if (direct) {
    await page.goto("/#/session/s1/plugins/microcrab.state-viewer");
  } else {
    await page.goto("/#/session/s1");
    await page.locator(".header-right-toggle-btn").click();
    const sidebar = page.getByTestId("client-plugin-sidebar");
    await selectSidebarPlugin(sidebar, "State Viewer");
    await sidebar.getByTestId("plugin-expand").click();
  }
  const viewer = page.getByTestId("expanded-plugin-page");
  await expect(action(viewer, "edit")).toBeVisible({ timeout: 20_000 });
  return viewer;
}
async function begin(surface: Locator) {
  await action(surface, "edit").click();
  await expect(editor(surface)).toBeVisible();
  await expect(editor(surface)).toHaveClass(/cm-content/);
  await expect(editor(surface).locator(".cm-line").first()).toBeVisible();
  return JSON.parse(await draftText(surface)) as Record<string, Json>;
}
async function fill(surface: Locator, values: Record<string, Json>) {
  const text = JSON.stringify(values, null, 2);
  await fillText(surface, text);
  return text;
}
async function save(surface: Locator) {
  await action(surface, "save").click();
}
async function saved(surface: Locator) {
  await expect(editor(surface)).toHaveCount(0);
  await expect(action(surface, "edit")).toBeVisible();
}
async function discard(surface: Locator) {
  await action(surface, "cancel").click();
  await action(surface, "discard").click();
  await expect(editor(surface)).toHaveCount(0);
}
async function failure(surface: Locator, reason: RegExp, text: string) {
  await expect(
    surface.getByRole("alert").filter({ hasText: reason }),
  ).toBeVisible();
  await exactDraft(surface, text);
  await expect(editor(surface)).toHaveAttribute("contenteditable", "true");
}

test("whole-State save creates all-role visible persisted variables and preserves existing governance on plain set and owner deletion", async ({
  page,
}) => {
  const backend = await editorBackend(page);
  const viewer = await openViewer(page);
  const beforeMetadata = structuredClone(backend.metadata);
  const next = await begin(viewer);
  next.created = [null, false, { exact: 42 }];
  next.owned = "changed scalar";
  next.delegated = { valueOnly: true };
  delete next.searched_out;
  await fill(viewer, next);
  await save(viewer);
  await saved(viewer);
  expect(backend.writes).toHaveLength(1);
  expect(backend.writes[0]).toEqual({
    operation_id: expect.any(String),
    expected: {
      runtime_instance_id: "1a348fbe-3f8f-47e8-b4fc-561531759c42",
      variables_revision: "1",
    },
    change: {
      set: { owned: "changed scalar", delegated: { valueOnly: true } },
      scoped_set: [
        {
          name: "created",
          value: [null, false, { exact: 42 }],
          visibility: "visible",
          persistence: "persisted",
          editors: ["agent", "client", "runtime"],
        },
      ],
      remove: ["searched_out"],
    },
  });
  expect(backend.values).toEqual(next);
  expect(backend.metadata.owned).toEqual(beforeMetadata.owned);
  expect(backend.metadata.delegated).toEqual(beforeMetadata.delegated);
  expect(backend.metadata.hidden_owned).toEqual(beforeMetadata.hidden_owned);
  expect(backend.metadata).not.toHaveProperty("searched_out");
  expect(backend.metadata.created).toEqual({
    owner: "client",
    visibility: "visible",
    persistence: "persisted",
    editors: ["agent", "client", "runtime"],
  });
});

test("hidden and searched-out fields remain in full edit source and unchanged save has no HTTP effect", async ({
  page,
}) => {
  const backend = await editorBackend(page);
  const viewer = await openViewer(page);
  const source = viewer.locator(".content-viewer-reading");
  await expect(source).not.toContainText("hidden_owned");
  await viewer.getByPlaceholder("搜索名称或值", { exact: true }).fill("owned");
  await expect(source).not.toContainText("searched_out");
  const full = await begin(viewer);
  expect(full).toEqual(backend.values);
  await save(viewer);
  await saved(viewer);
  expect(backend.writes).toHaveLength(0);
  const next = await begin(viewer);
  next.owned = { filteredEdit: true };
  await fill(viewer, next);
  // Display updates during editing cannot narrow or replace the captured input.
  await viewer
    .getByPlaceholder("搜索名称或值", { exact: true })
    .fill("delegated");
  await exactDraft(viewer, JSON.stringify(next, null, 2));
  await save(viewer);
  await saved(viewer);
  expect(backend.writes).toHaveLength(1);
  expect(backend.writes[0].change).toEqual({
    set: { owned: { filteredEdit: true } },
  });
  expect(backend.values.hidden_owned).toEqual(full.hidden_owned);
  expect(backend.values.searched_out).toEqual(full.searched_out);
});

test("invalid JSON, duplicate keys and unauthorized root diffs retain exact drafts; server rejection is atomic", async ({
  page,
}) => {
  const backend = await editorBackend(page);
  const viewer = await openViewer(page);
  const original = await begin(viewer);
  for (const [text, reason] of [
    ['{"owned":', /JSON:.*(EOF|expected)/],
    [
      '{"owned":{"duplicate":1,"duplicate":2}}',
      /duplicate object key.*duplicate/,
    ],
    ["[]", /JSON root must be an object/],
  ] as const) {
    await fillText(viewer, text);
    await failure(viewer, reason, text);
    expect(backend.writes).toHaveLength(0);
  }
  const illegal = {
    ...original,
    owned: "authorized change",
    framework: "forbidden",
  };
  let text = await fill(viewer, illegal);
  await failure(viewer, /framework: Framework State is read-only/, text);
  expect(backend.writes).toHaveLength(0);
  const deletion = { ...original, owned: "still authorized" };
  delete deletion.delegated;
  text = await fill(viewer, deletion);
  await failure(viewer, /delegated:.*Only the Client owner may delete/, text);
  expect(backend.writes).toHaveLength(0);
  // Both fields were authorized by the captured snapshot. The server revokes
  // only one, and must reject the other member too before changing any value.
  backend.denied.add("owned");
  text = await fill(viewer, {
    ...original,
    delegated: "must not partially apply",
    owned: "revoked",
  });
  await save(viewer);
  await failure(
    viewer,
    /variable_permission_denied:.*owned: Client write permission revoked/,
    text,
  );
  expect(backend.writes).toHaveLength(1);
  expect(backend.writes[0].change).toEqual({
    set: { delegated: "must not partially apply", owned: "revoked" },
  });
  expect(backend.values).toEqual(original);
});

test("conflict retains captured witness until explicit discard and a fresh editor; refresh never rebases or replays", async ({
  page,
}) => {
  const backend = await editorBackend(page);
  const viewer = await openViewer(page);
  const next = await begin(viewer);
  next.owned = { conflictDraft: true };
  const text = await fill(viewer, next);
  backend.fail("conflict");
  await save(viewer);
  await failure(
    viewer,
    /variable_conflict: Fixture State revision changed/,
    text,
  );
  const inspectionCount = backend.inspections.length;
  await viewer.getByRole("button", { name: "刷新", exact: true }).click();
  await expect
    .poll(() => backend.inspections.length)
    .toBeGreaterThan(inspectionCount);
  await exactDraft(viewer, text);
  expect(backend.writes).toHaveLength(1);
  await save(viewer);
  await failure(
    viewer,
    /variable_conflict: Fixture State revision changed/,
    text,
  );
  expect(backend.writes).toHaveLength(2);
  expect(
    backend.writes.map((write) => write.expected.variables_revision),
  ).toEqual(["1", "1"]);
  expect(backend.values.owned).toEqual({ initial: true });
  await discard(viewer);
  const fresh = await begin(viewer);
  fresh.owned = next.owned;
  await fill(viewer, fresh);
  await save(viewer);
  await saved(viewer);
  expect(backend.writes).toHaveLength(3);
  expect(backend.writes[2].expected.variables_revision).toBe("2");
  expect(new Set(backend.writes.map((write) => write.operation_id)).size).toBe(
    3,
  );
  expect(backend.values.owned).toEqual(next.owned);
});

test("unknown outcome observes its exact operation and never admits a repeated save or refresh replay", async ({
  page,
}) => {
  const backend = await editorBackend(page);
  const viewer = await openViewer(page);
  const next = await begin(viewer);
  next.owned = ["unknown draft", null];
  const text = await fill(viewer, next);
  backend.fail("unknown");
  await save(viewer);
  await expect(viewer.getByRole("alert")).toContainText(
    /unknown|未知|failed|fetch|network/i,
  );
  await exactDraft(viewer, text);
  await expect.poll(() => backend.writes.length).toBe(1);
  const operationId = backend.writes[0].operation_id;
  const repeat = action(viewer, "save");
  if (await repeat.isEnabled()) {
    await repeat.click();
    await expect(viewer.getByRole("alert")).toContainText(
      /unknown|未知|observe|观察/i,
    );
  } else await expect(repeat).toBeDisabled();
  const observe = await secondary(viewer, "reconcile");
  await expect(observe).toBeVisible();
  await observe.click();
  await expect.poll(() => backend.operations.length).toBe(1);
  expect(backend.operations).toEqual([operationId]);
  await viewer.getByRole("button", { name: "刷新", exact: true }).click();
  await exactDraft(viewer, text);
  expect(backend.writes).toHaveLength(1);
  expect(backend.values.owned).toEqual({ initial: true });
  await page.route("**/api/v1/sessions/s1/variables/operations/*", (route) =>
    route.fulfill({
      json: {
        operation_id: operationId,
        status: "rejected",
        reason: {
          code: "variable_permission_denied",
          message: "owned: Client editor permission was revoked",
        },
      },
    }),
  );
  await (await secondary(viewer, "reconcile")).click();
  await expect(viewer.getByRole("alert")).toContainText(
    "owned: Client editor permission was revoked",
  );
  await exactDraft(viewer, text);
  expect(backend.writes).toHaveLength(1);
});

test("simultaneous sidebar and expanded editors keep separate full-State drafts and guard dirty close", async ({
  page,
}) => {
  const backend = await editorBackend(page);
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.rightRailCollapsed", "false"),
  );
  await page.goto("/#/session/s1");
  const sidebar = page.getByTestId("client-plugin-sidebar");
  await expect(action(sidebar, "edit")).toBeVisible({ timeout: 20_000 });
  const sidebarValues = await begin(sidebar);
  sidebarValues.owned = "sidebar draft";
  const sidebarText = await fill(sidebar, sidebarValues);
  await sidebar.getByTestId("plugin-expand").click();
  const expanded = page.getByTestId("expanded-plugin-page");
  const expandedValues = await begin(expanded);
  expandedValues.delegated = "expanded draft";
  const expandedText = await fill(expanded, expandedValues);
  expect(expandedValues.owned).toEqual({ initial: true });
  const dialog = page.getByTestId("content-dialog");
  const close = dialog.getByRole("button", { name: "关闭", exact: true });
  await close.click();
  await expect(dialog).toBeVisible();
  await exactDraft(expanded, expandedText);
  await action(expanded, "keepEditing").click();
  await close.click();
  await action(expanded, "discard").click();
  await expect(dialog).toHaveCount(0);
  await exactDraft(sidebar, sidebarText);
  expect(backend.writes).toHaveLength(0);
});

test("pending HTTP receipt blocks close and success waits for atomic completion; Worker disable revokes authority immediately", async ({
  page,
  baseURL,
}) => {
  const backend = await editorBackend(page);
  await page.route("**/src/main.tsx", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `import { AppStore as EditorScopeStore } from '/src/state/store.ts';
const startEditorScope = EditorScopeStore.prototype.start;
EditorScopeStore.prototype.start = function () { window.editorScopeStore = this; return startEditorScope.call(this); };
${await response.text()}`,
    });
  });
  const viewer = await openViewer(page);
  const next = await begin(viewer);
  next.owned = { admitted: true };
  await fill(viewer, next);
  const release = backend.hold();
  try {
    await save(viewer);
    await expect.poll(() => backend.writes.length).toBe(1);
    await expect(editor(viewer)).toHaveAttribute("aria-disabled", "true");
    await expect(editor(viewer)).toHaveAttribute("contenteditable", "false");
    await expect(action(viewer, "save")).toBeDisabled();
    await expect(action(viewer, "cancel")).toBeDisabled();
    expect(backend.values.owned).toEqual({ initial: true });
    const dialog = page.getByTestId("content-dialog");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(editor(viewer)).toBeVisible();
    if (await page.locator('script[type="module"][src*="/assets/index-"]').count()) {
      release();
      await saved(viewer);
      expect(backend.values.owned).toEqual({ admitted: true });
      expect(backend.writes).toHaveLength(1);
      return;
    }
    // Administrative enablement revocation is an actual authority boundary,
    // independent of ordinary guarded close/navigation actions.
    await page.evaluate(() =>
      (window as any).editorScopeStore.plugins.registry.setEnabled(
        "microcrab.state-viewer",
        "s1",
        false,
      ),
    );
    await expect(editor(viewer)).toHaveCount(0);
    await expect(action(viewer, "discard")).toHaveCount(0);
    await expect(dialog).toBeVisible();
    release();
    await expect.poll(() => backend.values.owned).toEqual({ admitted: true });
    await page.evaluate(() =>
      (window as any).editorScopeStore.plugins.registry.setEnabled(
        "microcrab.state-viewer",
        "s1",
        true,
      ),
    );
    await expect(action(viewer, "edit")).toBeVisible();
    const fresh = await begin(viewer);
    expect(fresh.owned).toEqual({ admitted: true });
    expect(backend.writes).toHaveLength(1);
    expect(backend.operations).toHaveLength(0);
    fresh.owned = { freshAuthority: true };
    await fill(viewer, fresh);
    await save(viewer);
    await saved(viewer);
    expect(backend.writes).toHaveLength(2);
    expect(backend.writes[1].expected.variables_revision).toBe("2");
    expect(backend.writes[1].operation_id).not.toBe(
      backend.writes[0].operation_id,
    );
    expect(backend.values.owned).toEqual({ freshAuthority: true });
  } finally {
    release();
  }
});

test("sidebar dirty close keeps the complete draft until discard completes the original close", async ({
  page,
}) => {
  const backend = await editorBackend(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.rightRailCollapsed", "false"),
  );
  await page.goto("/#/session/s1");
  const sidebar = page.getByTestId("client-plugin-sidebar");
  await expect(action(sidebar, "edit")).toBeVisible({ timeout: 20_000 });
  const next = await begin(sidebar);
  next.owned = "close draft";
  const text = await fill(sidebar, next);
  const close = page.getByTestId("right-rail-close");
  await close.click();
  await expect(action(sidebar, "discard")).toBeVisible();
  await action(sidebar, "keepEditing").click();
  await exactDraft(sidebar, text);
  await expect(close).toBeVisible();
  await close.click();
  await action(sidebar, "discard").click();
  await expect(sidebar).not.toBeVisible();
  await expect(page).toHaveURL(/session\/s1$/);
  expect(backend.writes).toHaveLength(0);
  expect(backend.values.owned).toEqual({ initial: true });
});

test("ordinary direct navigation retains position on continue and discard completes the requested route", async ({
  page,
}) => {
  const backend = await editorBackend(page);
  const viewer = await openViewer(page, true);
  const next = await begin(viewer);
  next.owned = "navigation draft";
  const text = await fill(viewer, next);
  await page.evaluate(() => {
    location.hash = "#/session/s1";
  });
  await expect(action(viewer, "discard")).toBeVisible();
  await expect(page).toHaveURL(/session\/s1\/plugins\/microcrab.state-viewer$/);
  await action(viewer, "keepEditing").click();
  await exactDraft(viewer, text);
  await page.evaluate(() => {
    location.hash = "#/session/s1";
  });
  await action(viewer, "discard").click();
  await expect(page).toHaveURL(/session\/s1$/);
  await expect(viewer).toHaveCount(0);
  expect(backend.writes).toHaveLength(0);
});

test("pending sidebar save blocks close and navigation until its one atomic receipt", async ({
  page,
}) => {
  const backend = await editorBackend(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.rightRailCollapsed", "false"),
  );
  await page.goto("/#/session/s1");
  const sidebar = page.getByTestId("client-plugin-sidebar");
  await expect(action(sidebar, "edit")).toBeVisible({ timeout: 20_000 });
  const next = await begin(sidebar);
  next.owned = "pending sidebar draft";
  const text = await fill(sidebar, next);
  const release = backend.hold();
  try {
    await save(sidebar);
    await expect.poll(() => backend.writes.length).toBe(1);
    await expect(editor(sidebar)).toHaveAttribute("aria-disabled", "true");
    await page.getByTestId("right-rail-close").click();
    await expect(sidebar).toBeVisible();
    await page.evaluate(() => {
      location.hash = "#/session/s1/plugins/microcrab.state-viewer";
    });
    await expect(page).toHaveURL(/session\/s1$/);
    await expect(page.getByTestId("expanded-plugin-page")).toHaveCount(0);
    await expect(action(sidebar, "discard")).toHaveCount(0);
    await exactDraft(sidebar, text);
    expect(backend.values.owned).toEqual({ initial: true });
    release();
    await saved(sidebar);
    expect(backend.values.owned).toBe("pending sidebar draft");
    expect(backend.writes).toHaveLength(1);
    expect(backend.writes[0].expected.variables_revision).toBe("1");
    // A blocked pending exit does not become delayed consent after success.
    await expect(sidebar).toBeVisible();
    await expect(page).toHaveURL(/session\/s1$/);
    await page.getByTestId("right-rail-close").click();
    await expect(sidebar).not.toBeVisible();
  } finally {
    release();
  }
});

test("source editor icon controls remain reachable without horizontal overflow at 1440 and 390 in both themes", async ({
  page,
}) => {
  const backend = await editorBackend(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const viewer = await openViewer(page);
  const edit = action(viewer, "edit");
  await expect(edit).toHaveAttribute(
    "title",
    "编辑完整源码（包含只读视图隐藏的字段）",
  );
  await expect(edit).toHaveAccessibleName("编辑完整源码");
  await expect(edit.locator("svg")).toBeVisible();
  await expect(action(viewer, "copyFormatted")).toBeVisible();
  await expect(action(viewer, "more")).toBeVisible();
  for (const key of ["wrap", "lineNumbers", "pause", "copyOriginal"]) {
    await expect(action(viewer, key)).not.toBeVisible();
  }
  const next = await begin(viewer);
  next.layout = {
    exact: [null, false, 42],
    rows: Array.from({ length: 18 }, (_, index) => ({
      index,
      value: "long-token-".repeat(20),
    })),
  };
  const text = await fill(viewer, next);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const key of [
        "wrap",
        "lineNumbers",
        "pause",
        "copyFormatted",
        "copyOriginal",
        "save",
        "cancel",
      ]) {
        const control = ["save", "cancel", "copyFormatted"].includes(key)
          ? action(viewer, key)
          : await secondary(viewer, key);
        await control.scrollIntoViewIfNeeded();
        await expect(control).toBeInViewport();
        await expect(control).toHaveAttribute("title", /.+/);
        await expect(control).toHaveAttribute("aria-label", /.+/);
        await expect(
          control.locator("svg:not(.content-viewer-action-check)"),
        ).toBeVisible();
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      }
      await editor(viewer).scrollIntoViewIfNeeded();
      await expect(editor(viewer)).toBeInViewport();
      await exactDraft(viewer, text);
      await action(viewer, "save").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `test-results/visual/inspection-dropdown-large-editor-${width}-${theme}.png`,
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
    }
  }
  await discard(viewer);
  expect(backend.writes).toHaveLength(0);
});
