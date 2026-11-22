import { expect, test, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

const endpoint = "http://127.0.0.1:8789";
const projects = [
  { id: "project-1", name: "Old project", root: "/old", host_id: "h1", workspace_id: "w1" },
  { id: "project-2", name: "Healthy project", root: "/healthy", host_id: "h1", workspace_id: "w2" },
];
function attached(projectId: string) {
  const project = projects.find((item) => item.id === projectId)!;
  return {
    descriptor: {
      protocol_version: 1, host_id: project.host_id, workspace_id: project.workspace_id,
      bridge_instance_id: "fixture-bridge", workspace_root: project.root, platform: "test",
      info: {}, tool_capabilities: [], supported_primitives: [], descriptor_digest: "a".repeat(64),
    },
    transport: "grpc", connected: true, ready: true,
  };
}
const mismatch = {
  error: {
    code: "binding_mismatch", message: "Authenticated descriptor differs from immutable binding",
    retryable: false,
    details: { reason: "host_descriptor_mismatch", retryable: false,
      action_required: "use_compatible_host_or_different_workspace" },
  },
};
async function seed(page: Page) {
  await page.addInitScript(({ endpoint }) => {
    const clientId = localStorage.getItem("microcrab.browser-client.v1") ?? "host-mismatch-browser";
    localStorage.setItem("microcrab.browser-client.v1", clientId);
    const scope = JSON.stringify([location.origin + "/", "u1", clientId]);
    const key = "microcrab.host-locator.v2:" + JSON.stringify([...JSON.parse(scope), "h1"]);
    if (!localStorage.getItem(key)) localStorage.setItem(key, endpoint);
  }, { endpoint });
}
async function selectProject(page: Page, projectId: string) {
  await page.getByTitle("选择项目工作区").click();
  // v0.1.18 P1 picker is a flat list (Recent + All projects), no Host cascade.
  // The attribute belongs to the button itself; do not depend on project sorting.
  const item = page.locator(`[data-testid="home-project-item"][data-project-id="${projectId}"]`).first();
  if (!(await item.isVisible())) await page.getByTestId("picker-all-projects").click();
  await item.click();
}
async function explicitConnect(page: Page) {
  await page.getByTestId("header-host-connection").click();
  await page.getByRole("dialog").getByRole("button", { name: "连接 Host", exact: true }).click();
}

test("candidate mismatch survives repeated selection and bootstrap while another project on the same Host connects; manual retry probes once", async ({ page }) => {
  await nativeBackend(page, { projects });
  await seed(page);
  const calls: string[] = [];
  let compatible = false;
  await page.route("**/api/v1/projects/*/host/connect", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[4];
    calls.push(id);
    if (id === "project-1" && !compatible)
      return route.fulfill({ status: 409, json: mismatch });
    return route.fulfill({ json: attached(id) });
  });
  await page.goto("/");
  const header = page.getByTestId("header-host-connection");
  await expect(header).toContainText("Host 身份不匹配");
  expect(calls).toEqual(["project-1"]);
  await expect(page.locator(".composer-offline-banner")).toContainText("Host 已响应");
  await expect(page.locator(".composer-offline-banner")).not.toContainText("离线");
  for (let index = 0; index < 3; index++) await selectProject(page, "project-1");
  expect(calls).toEqual(["project-1"]);
  await page.reload();
  await expect(header).toContainText("Host 身份不匹配");
  expect(calls).toEqual(["project-1"]);
  await selectProject(page, "project-2");
  await expect(header).toContainText("已就绪");
  expect(calls).toEqual(["project-1", "project-2"]);
  await selectProject(page, "project-1");
  await expect(header).toContainText("Host 身份不匹配");
  expect(calls).toHaveLength(2);
  await explicitConnect(page);
  await expect(page.getByTestId("host-public-cause")).toContainText("binding_mismatch");
  await expect(page.getByTestId("host-terminal-guidance")).toContainText("不同工作区");
  expect(calls).toEqual(["project-1", "project-2", "project-1"]);
  const persisted = await page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith("microcrab.host-quarantine.v1:")));
  expect(JSON.stringify(persisted)).not.toContain(endpoint);
  expect(JSON.stringify(persisted)).not.toContain(mismatch.error.message);
  await page.reload();
  await expect(header).toContainText("Host 身份不匹配");
  expect(calls).toHaveLength(3);
  compatible = true;
  await explicitConnect(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(header).toContainText("已就绪");
  expect(calls).toHaveLength(4);
  await page.reload();
  await expect(header).toContainText("已就绪");
  expect(calls).toHaveLength(5);
});

async function storePage(page: Page) {
  await page.route("**/host-mismatch-store-fixture", (route) => route.fulfill({
    contentType: "text/html", body: "<!doctype html><html><body></body></html>",
  }));
  await page.goto("/host-mismatch-store-fixture");
  await page.evaluate(async ({ projects, endpoint }) => {
    const { AppStore } = await import("/src/state/store.ts");
    const { hostPreferenceScope, rememberHost } = await import("/src/client/host-locators.ts");
    const store = new AppStore();
    const auth = { authenticated: true, principal: { owner: "u1" } };
    store.update({ authSession: auth, connection: "ws", projects,
      knownProjects: projects.map((item) => ({ ...item, path: item.root })),
      sessionId: null, sessions: [], draftWorkspace: { kind: "local", projectId: "project-1" },
      capabilities: { methods: ["agent.catalog", "project.list", "project.create"], features: {}, limits: {} } });
    rememberHost(hostPreferenceScope(store.api.base, auth), "h1", "project-1", endpoint);
    store.api.request = async (method: string) => {
      if (method === "project.host_state") return { connected: false, ready: false, reconciling: false, carrier_mode: "detached", connection_generation: null };
      if (method === "agent.catalog") return { items: [{ name: "coding", component: "component", modes: [{ name: "plan" }] }] };
      if (method === "project.list") return { items: projects };
      if (method === "settings.get" || method === "project.settings.get") return { effective: {} };
      throw Error("Unexpected fixture request: " + method);
    };
    Object.assign(window, { mismatchStore: store });
  }, { projects, endpoint });
}

for (const change of ["owner", "locator", "directory"] as const) {
  test(`late mismatch cannot quarantine a changed ${change} candidate`, async ({ page }) => {
    await storePage(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let requested!: () => void;
    const started = new Promise<void>((resolve) => { requested = resolve; });
    await page.route("**/api/v1/projects/project-1/host/connect", async (route) => {
      requested();
      await held;
      await route.fulfill({ status: 409, json: mismatch });
    });
    await page.evaluate(() => {
      const store = (window as any).mismatchStore;
      (window as any).mismatchPending = store.dispatch({ type: "ConnectHost", projectId: "project-1" }).catch(() => {});
    });
    await started;
    await page.evaluate(async ({ change }) => {
      const store = (window as any).mismatchStore;
      const { hostPreferenceScope, rememberHost } = await import("/src/client/host-locators.ts");
      if (change === "owner") store.update({ authSession: { authenticated: true, principal: { owner: "u2" } }, hostConnection: { state: "detached" } });
      else if (change === "locator") rememberHost(hostPreferenceScope(store.api.base, store.state.authSession), "h1", "project-1", "http://127.0.0.1:9799");
      else store.update({ projects: store.state.projects.map((item: any) => item.id === "project-1" ? { ...item, root: "/changed" } : item) });
    }, { change });
    release();
    await page.evaluate(() => (window as any).mismatchPending);
    const result = await page.evaluate(() => ({
      reason: (window as any).mismatchStore.state.hostConnection.reason,
      entries: Object.entries(localStorage).filter(([key]) => key.startsWith("microcrab.host-quarantine.v1:")),
    }));
    expect(result.reason).not.toBe("binding_mismatch");
    expect(result.entries).toEqual([]);
  });
}

test("changing a candidate directory or locator permits one fresh automatic check without clearing the old witness", async ({ page }) => {
  await storePage(page);
  const calls: { url: string; directory: string }[] = [];
  await page.route("**/api/v1/projects/project-1/host/connect", async (route) => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: mismatch });
  });
  await page.evaluate(async () => {
    const store = (window as any).mismatchStore;
    await store.resumeProject("project-1", "resume_project:select_project");
    await store.resumeProject("project-1", "resume_project:attach");
    store.update({ projects: store.state.projects.map((item: any) => item.id === "project-1" ? { ...item, root: "/changed" } : item) });
    await store.resumeProject("project-1", "resume_project:select_project");
    const { hostPreferenceScope, rememberHost } = await import("/src/client/host-locators.ts");
    rememberHost(hostPreferenceScope(store.api.base, store.state.authSession), "h1", "project-1", "http://127.0.0.1:9799");
    await store.resumeProject("project-1", "resume_project:bootstrap");
    await store.resumeProject("project-1", "resume_project:attach");
  });
  expect(calls.map(({ url, directory }) => [url, directory])).toEqual([
    [endpoint, "/old"], [endpoint, "/changed"], ["http://127.0.0.1:9799", "/changed"],
  ]);
});

for (const consumed of [false, undefined] as const) {
  test(`canonical duplicate forwards one-use token only when preflight proves unconsumed (${String(consumed)})`, async ({ page }) => {
    await storePage(page);
    const calls: { id: string; token?: string }[] = [];
    await page.route("**/api/v1/projects/*/host/connect", async (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[4];
      calls.push({ id, token: route.request().postDataJSON().token });
      if (id === "provisional") return route.fulfill({ json: {
        ...attached("project-1"), status: "existing_project", existing_project_id: "project-1",
        ...(consumed === false ? { pairing_token_consumed: false } : {}),
      } });
      return route.fulfill({ json: attached(id) });
    });
    await page.evaluate(async ({ endpoint }) => {
      const store = (window as any).mismatchStore;
      store.update({ projects: [...store.state.projects, { id: "provisional", name: "Temporary", root: "." }] });
      await store.dispatch({ type: "ConnectHost", projectId: "provisional", endpoint, pairingToken: "one-use-token" });
    }, { endpoint });
    expect(calls).toEqual([
      { id: "provisional", token: "one-use-token" },
      { id: "project-1", token: consumed === false ? "one-use-token" : undefined },
    ]);
  });
}

test("unsupported preflight is a separate terminal Bridge-upgrade state", async ({ page }) => {
  await storePage(page);
  let calls = 0;
  await page.route("**/api/v1/projects/project-1/host/connect", (route) => {
    calls++;
    return route.fulfill({ status: 409, json: { error: {
      code: "host_preflight_unsupported", message: "Bridge has no authenticated Inspect method", retryable: false,
    } } });
  });
  const status = await page.evaluate(async () => {
    const store = (window as any).mismatchStore;
    await store.resumeProject("project-1", "resume_project:bootstrap");
    await store.resumeProject("project-1", "resume_project:select_project");
    const { hostReadiness } = await import("/src/state/host-readiness.ts");
    return hostReadiness(store.state).status;
  });
  expect(calls).toBe(1);
  expect(status).toBe("host_preflight_unsupported");
});

test("a rejected candidate in an independent API client does not release the healthy client's server-owned route", async ({ page }) => {
  await storePage(page);
  const disconnects: string[] = [];
  await page.route("**/api/v1/projects/*/host/disconnect", (route) => {
    disconnects.push(route.request().url());
    return route.fulfill({ json: {} });
  });
  await page.route("**/api/v1/projects/*/host/connect", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[4];
    return id === "project-1" ? route.fulfill({ status: 409, json: mismatch })
      : route.fulfill({ json: attached(id) });
  });
  const result = await page.evaluate(async ({ endpoint }) => {
    const { ApiClient } = await import("/src/client/api.ts");
    const healthy = new ApiClient();
    const candidate = new ApiClient();
    await healthy.connectHost("project-2", endpoint, undefined, () => {});
    let rejected;
    try { await candidate.connectHost("project-1", endpoint, undefined, () => {}); }
    catch (error) { rejected = (error as any).code; }
    return { rejected, project: healthy.currentHostProject(), transport: healthy.currentHostTransport() };
  }, { endpoint });
  expect(result).toEqual({ rejected: "binding_mismatch", project: "project-2", transport: "grpc" });
  expect(disconnects).toEqual([]);
});
