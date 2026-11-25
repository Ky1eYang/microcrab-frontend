import { expect, test } from "@playwright/test";
import { connectHostUI } from "./host-fixture";
import { nativeBackend } from "./native-fixture";
import { LIMIT_FIELDS } from "../src/client/settings";

const browser = {
  name: "browser",
  component: "sha256:browser-component",
  modes: [{ name: "observe", role: "main_agent" }],
};
const coding = {
  name: "coding",
  component: "sha256:coding-component",
  modes: [{ name: "plan", role: "main_agent" }],
};

for (const manual of [false, true]) {
  test(`a compatible Browser-named Agent uses ordinary ${manual ? "mode selection" : "Project defaults"}`, async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    await page.route("**/projects/project-1/agents", (route) =>
      route.fulfill({
        json: { items: manual ? [browser, coding] : [browser] },
      }),
    );
    if (!manual) {
      const limits = Object.fromEntries(
        LIMIT_FIELDS.map((field) => [field, 1048576]),
      );
      const effective = { limits, agent: browser.name, mode: "observe" };
      await page.route("**/projects/project-1/settings", (route) =>
        route.fulfill({
          json: {
            revision: 0,
            overrides: {},
            effective,
            desired_effective: effective,
            sources: {},
            constraints: { limits },
            applied_revision: 0,
            application: "defaults_saved",
            reason: null,
          },
        }),
      );
    }
    await page.goto("/");
    await connectHostUI(page);
    const agent = page.getByTestId("composer-agent-pill");
    await expect(agent).toBeEnabled();
    if (manual) {
      await expect(agent).toContainText(coding.name);
      await agent.click();
      await page
        .getByTestId("composer-agent-item")
        .getByText(browser.name, { exact: true })
        .click();
      await page
        .getByRole("menuitemradio", { name: "observe", exact: true })
        .click();
    }
    await expect(agent).toContainText(browser.name);
    await expect(agent).toContainText("observe");
    await page.getByLabel(/^(消息|Message)$/).fill("Draft question");
    await page.getByRole("button", { name: /发送|Send/ }).click();

    const creations = () =>
      backend.requests.filter(
        ({ method, path }) => method === "POST" && path === "/api/v1/sessions",
      );
    await expect.poll(creations).toHaveLength(1);
    expect(creations()[0].body).toEqual({
      project_id: "project-1",
      agent: browser.name,
      mode: "observe",
      component: browser.component,
      client_tools: expect.any(Array),
      operation_id: expect.any(String),
    });
  });
}

test("a draft submits the picked component, not a same-named catalog replacement", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(
    async ({ browser, coding }) => {
      const { AppStore } = await import("/src/state/store.ts");
      const store: any = new AppStore();
      const project = (projectId: string) => ({ kind: "local", projectId });
      const host = (projectId: string, connectionGeneration = "first") => ({
        projectId,
        state: "ready",
        connected: true,
        catalogReady: true,
        connectionGeneration,
      });
      const defaults = { agent: null, mode: null };
      store.update({
        connection: "ws",
        authSession: { authenticated: true, principal: { owner: "test" } },
        draftWorkspace: project("P"),
        hostConnection: host("P"),
        projectSessionDefaults: { projectId: "P", effective: defaults },
      });
      const alternative = { ...browser, component: coding.component };
      let rows = [alternative, browser];
      let payload: any;
      store.api.request = async () => ({ effective: defaults });
      store.call = async (method: string, params: unknown) => {
        if (method === "agent.catalog") return { items: structuredClone(rows) };
        if (method !== "session.create")
          throw Error(`Unexpected method: ${method}`);
        payload = params;
        throw Error("Captured creation without opening a session");
      };
      const submit = async () => {
        payload = null;
        store.update({ composer: "test" });
        await store.submit().catch(() => {});
        return payload;
      };
      const choose = (row: typeof browser) =>
        store.dispatch({
          type: "SetAgentMode",
          agent: row.name,
          mode: "observe",
          catalogRow: row,
        });

      await store.loadHostCatalog("P");
      const picked = store.state.agents[1];
      await choose(picked);
      const exact = await submit();
      await store.loadHostCatalog("P");
      const refreshed = await submit();
      rows = [alternative];
      await store.loadHostCatalog("P");
      await choose(picked);
      const removed = await submit();

      rows = [alternative, browser];
      await store.loadHostCatalog("P");
      store.update({ draftWorkspace: project("Q") });
      const mismatchedProject = await submit();
      store.update({ draftWorkspace: project("P") });
      await store.loadHostCatalog("P");
      store.update({ hostConnection: host("P", "replacement") });
      const staleHost = await submit();
      await store.loadHostCatalog("P");
      store.newChat(false);
      const freshDraft = await submit();
      return {
        exact,
        refreshed,
        removed,
        mismatchedProject,
        staleHost,
        freshDraft,
      };
    },
    { browser, coding },
  );

  for (const payload of [result.exact, result.refreshed, result.freshDraft]) {
    expect(payload).toEqual({
      project_id: "P",
      agent: browser.name,
      mode: "observe",
      component:
        payload === result.freshDraft ? coding.component : browser.component,
      client_tools: expect.any(Array),
      operation_id: expect.any(String),
    });
  }
  expect(result.removed).toBeNull();
  expect(result.mismatchedProject).toBeNull();
  expect(result.staleHost).toBeNull();
});
