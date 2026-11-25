import { expect, test, type Page } from "@playwright/test";
import { LIMIT_FIELDS } from "../src/client/settings";
import { nativeBackend } from "./native-fixture";

function makeSnapshot(overrides: {
  revision?: number;
  projectFuel?: number;
  defaultFuel?: number;
  maxFuel?: number;
}) {
  const limits = Object.fromEntries(LIMIT_FIELDS.map((field) => [field, 1048576]));
  const defaultFuel = overrides.defaultFuel ?? 10_000_000;
  const maxFuel = overrides.maxFuel ?? defaultFuel;
  const effectiveFuel = overrides.projectFuel ?? defaultFuel;
  const savedOverrides: Record<string, unknown> = { limits: {} };
  if (overrides.projectFuel !== undefined) {
    savedOverrides.agent_wasm_fuel = overrides.projectFuel;
  }
  const effective = {
    limits,
    agent_wasm_fuel: effectiveFuel,
  };
  return {
    revision: overrides.revision ?? 1,
    overrides: savedOverrides,
    effective,
    desired_effective: structuredClone(effective),
    constraints: {
      limits,
      agent_wasm_fuel_default: defaultFuel,
      agent_wasm_fuel_max: maxFuel,
    },
    sources: {
      agent_wasm_fuel: overrides.projectFuel !== undefined ? "project" : "admin",
    },
    applied_revision: overrides.revision ?? 1,
    application: "defaults_saved",
    reason: null,
  };
}

async function openProjectAgentsTab(page: Page) {
  const folder = page.locator(".rail-project-folder").first();
  await folder.locator(".rail-project-row").hover();
  await folder.locator(".rail-project-more-btn").click();
  await page.getByTestId("project-menu-settings").click();
  const dialog = page.getByTestId("project-settings");
  await dialog.getByTestId("project-settings-tab-agents").click();
  return dialog;
}

test("project settings agent_wasm_fuel supports inherit, valid override, no silent clamping, and live session distinction", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.addInitScript(() => localStorage.setItem("microcrab.ui.locale", "en"));
  let snapshot = makeSnapshot({
    revision: 1,
    defaultFuel: 10_000_000,
    maxFuel: 25_000_000,
  });
  const puts: Array<Record<string, any>> = [];
  let catalogRequests = 0;

  await page.route("**/api/v1/projects/*/host-state", (route) =>
    route.fulfill({
      json: {
        project_id: "project-1",
        carrier_mode: "server_direct_grpc",
        connection_generation: "101",
        ready: true,
        connected: true,
        reconciling: false,
        descriptor: {
          host_id: "h1",
          workspace_id: "w1",
          workspace_root: "/assigned",
          platform: "test",
          tool_capabilities: ["read"],
          supported_primitives: [],
        },
        readiness: {
          connection_generation: "101",
          ready: true,
          connected: true,
          reconciling: false,
          phase: "ready",
          cause: null,
        },
      },
    }),
  );
  await page.route("**/api/v1/projects/*/settings", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      puts.push(body);
      snapshot = makeSnapshot({
        revision: (body.expected_revision ?? 1) + 1,
        projectFuel: body.overrides?.agent_wasm_fuel,
        defaultFuel: 10_000_000,
        maxFuel: 25_000_000,
      });
    }
    return route.fulfill({ json: snapshot });
  });
  await page.route("**/api/v1/projects/*/agents", async (route) => {
    catalogRequests++;
    return route.fulfill({ json: { items: [] } });
  });

  await page.goto("/#/session/s1");
  await expect(page.getByTestId("composer-session-permissions")).toBeVisible();
  const dialog = await openProjectAgentsTab(page);

  const section = dialog.getByTestId("project-agent-wasm-fuel-section");
  await expect(section).toBeVisible();
  await expect(section).toContainText("not elapsed wall-clock time");
  await expect(section).toContainText("Server default: 10000000 · Max: 25000000");
  await expect(dialog.getByTestId("project-agent-wasm-fuel-live-note")).toBeVisible();

  const mode = dialog.getByTestId("project-agent-wasm-fuel-mode");
  await expect(mode).toHaveValue("inherit");
  await expect(dialog.getByTestId("project-agent-wasm-fuel")).toHaveCount(0);

  // Switch to custom and test over-ceiling rejection without silent clamping
  await mode.selectOption("custom");
  const input = dialog.getByTestId("project-agent-wasm-fuel");
  await input.fill("30000000");
  await dialog.getByTestId("settings-save").click();
  expect(puts).toHaveLength(0);
  await expect(input).toHaveValue("30000000");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.locator(".settings-field-error")).toContainText("25000000");

  // Save valid override within ceiling and clear back to inherit
  const catalogBefore = catalogRequests;
  await input.fill("18000000");
  await dialog.getByTestId("settings-save").click();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0].overrides.agent_wasm_fuel).toBe(18000000);
  await expect.poll(() => catalogRequests).toBeGreaterThan(catalogBefore);

  await mode.selectOption("inherit");
  await dialog.getByTestId("settings-save").click();
  await expect.poll(() => puts.length).toBe(2);
  expect(puts[1].overrides).not.toHaveProperty("agent_wasm_fuel");
});

test("lowered server ceiling shows persisted override warning and session settings remains read-only", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.addInitScript(() => localStorage.setItem("microcrab.ui.locale", "en"));
  await page.route("**/api/v1/projects/*/settings", (route) =>
    route.fulfill({
      json: makeSnapshot({
        revision: 3,
        projectFuel: 20_000_000,
        defaultFuel: 10_000_000,
        maxFuel: 12_000_000,
      }),
    }),
  );
  await page.route("**/api/v1/sessions/*/settings", (route) =>
    route.fulfill({
      json: {
        ...makeSnapshot({
          revision: 1,
          defaultFuel: 10_000_000,
          maxFuel: 12_000_000,
        }),
        effective: {
          limits: Object.fromEntries(LIMIT_FIELDS.map((field) => [field, 1048576])),
          agent_wasm_fuel: 10_000_000,
        },
        desired_effective: {
          limits: Object.fromEntries(LIMIT_FIELDS.map((field) => [field, 1048576])),
          agent_wasm_fuel: 20_000_000,
        },
      },
    }),
  );

  await page.goto("/#/session/s1");
  await expect(page.getByTestId("composer-session-permissions")).toBeVisible();
  const dialog = await openProjectAgentsTab(page);
  await expect(dialog.getByTestId("project-agent-wasm-fuel-over-max")).toContainText("20000000");
  await expect(dialog.getByTestId("project-agent-wasm-fuel")).toHaveValue("20000000");
  await page.keyboard.press("Escape");

  // Open Session Settings (User -> Settings -> Session tab) and verify fuel is read-only
  await page.getByRole("button", { name: "Test User", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Current Session configuration", exact: true })
    .click();
  const sessionDialog = page.getByTestId("owner-settings-session");
  await expect(sessionDialog.getByTestId("session-agent-wasm-fuel")).toContainText(
    "Active Session fuel: 10000000 · Project/Server default for new loads: 20000000",
  );
  await expect(sessionDialog.getByTestId("project-agent-wasm-fuel")).toHaveCount(0);
});
