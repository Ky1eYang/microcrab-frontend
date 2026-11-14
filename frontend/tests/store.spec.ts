import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("permission edits retain CAS revision without a JSON editor in the composer", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const store = new AppStore();
    await new Promise<void>((resolve) => store.api.connect({ open: resolve }));
    store.update({
      sessionId: "s1",
      capabilities: {
        protocol: 1,
        methods: ["permission.set"],
        features: {},
        limits: {},
      },
    });
    await store.dispatch({
      type: "SetPermissions",
      expectedRevision: 3,
      overrides: [{ tool: { kind: "exact", value: "patch" }, action: "deny" }],
      review: true,
    });
    const revision = store.state.policy?.revision;
    store.stop();
    return revision;
  });
  expect(result).toBe(4);
  expect(
    backend.requests.find(
      (request) =>
        request.method === "PUT" &&
        request.path === "/api/v1/sessions/s1/permission",
    )?.body.expected_revision,
  ).toBe(3);
  await expect(page.locator(".composer-dock-row textarea")).toHaveCount(0);
});

for (const missingCatalog of [false, true]) {
  test(`backend hydration ${missingCatalog ? "reloads a missing" : "preserves the loaded"} project catalog without reconnecting its ready bridge`, async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(async (missing) => {
      const { AppStore } = await import("/src/state/store.ts");
      const store: any = new AppStore();
      store.update({
        authSession: { authenticated: true, principal: { owner: "u1" } },
        draftWorkspace: { kind: "local", projectId: "project-1" },
        draftAgent: "coding",
        hostConnection: {
          state: "ready",
          connected: true,
          projectId: "project-1",
          catalogReady: true,
        },
        agents: missing
          ? []
          : [
              {
                name: "coding",
                component: "already-loaded",
                modes: [{ name: "plan", role: "main_agent" }],
                tools: [],
                variables: {},
              },
            ],
      });
      let reconnects = 0;
      store.resumeProject = async () => {
        reconnects++;
      };
      await store.bootstrap(store.lifecycle);
      const snapshot = {
        reconnects,
        state: store.state.hostConnection.state,
        catalogReady: store.state.hostConnection.catalogReady,
        component: store.state.agents[0]?.component,
      };
      store.stop();
      return snapshot;
    }, missingCatalog);
    expect(result).toEqual({
      reconnects: 0,
      state: "ready",
      catalogReady: true,
      component: missingCatalog ? "component-sha256" : "already-loaded",
    });
    expect(
      backend.requests.filter(
        (r) => r.path === "/api/v1/projects/project-1/agents",
      ),
    ).toHaveLength(missingCatalog ? 1 : 0);
  });
}
