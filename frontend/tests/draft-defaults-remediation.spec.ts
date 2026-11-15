import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

for (const change of ["none", "flavor", "identity"] as const) {
  test(`deferred Host preparation fences ${change} conversation changes`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(async (change) => {
      const { AppStore } = await import("/src/state/store.ts");
      const store: any = new AppStore();
      store.state.connection = "ws";
      store.state.authSession = {
        authenticated: true,
        principal: { owner: "owner" },
      };
      store.state.draftWorkspace = { kind: "chat_only" };
      store.draftConversationId = "initial-conversation";
      store.state.hostConnection = {
        conversationId: "initial-conversation",
        hostFlavor: "chat_only",
        state: "ready",
        connected: true,
        catalogReady: true,
      };
      store.state.agents = [
        {
          name: "X",
          component: "component-X",
          modes: [{ name: "x", role: "main_agent" }],
        },
      ];
      store.state.draftAgent = "X";
      store.state.draftMode = "x";
      store.state.composer = "create";
      store.state.draftModel = {
        id: "frozen",
        providerId: "p",
        name: "Frozen",
        variants: [],
      };
      let release: any;
      const prepared = new Promise<void>((resolve) => {
        release = resolve;
      });
      let preparedId: string | null = null;
      store.connectBrowserConversation = async (id: string) => {
        preparedId = id;
        await prepared;
      };
      let payload: any = null;
      store.call = async (method: string, params: any) => {
        if (method === "session.create") {
          payload = params;
          throw Error("captured admission");
        }
      };
      const submission = store.submit().catch(() => {});
      if (change === "flavor")
        store.state.draftWorkspace = { kind: "browser_sandbox" };
      if (change === "identity")
        store.draftConversationId = "replacement-conversation";
      store.state.draftModel = {
        id: "later",
        providerId: "p",
        name: "Later",
        variants: [],
      };
      release();
      await submission;
      return { preparedId, payload };
    }, change);
    expect(result.preparedId).toBe("initial-conversation");
    if (change === "none")
      expect(result.payload).toMatchObject({
        conversation_id: "initial-conversation",
        model_selection: { provider_id: "p", model: "frozen", variant: null },
      });
    else expect(result.payload).toBeNull();
  });
}

for (const manual of [false, true]) {
  test(`unknown Project defaults ${manual ? "preserve explicit" : "block inherited"} Agent admission`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(async (manual) => {
      const { AppStore } = await import("/src/state/store.ts");
      const store: any = new AppStore();
      store.state.connection = "ws";
      store.state.authSession = {
        authenticated: true,
        principal: { owner: "owner" },
      };
      store.state.draftWorkspace = { kind: "local", projectId: "P" };
      store.state.hostConnection = {
        projectId: "P",
        connected: true,
        state: "ready",
        catalogReady: true,
      };
      store.state.agents = [
        {
          name: "X",
          component: "component-X",
          modes: [{ name: "x", role: "main_agent" }],
        },
      ];
      store.state.draftAgent = "X";
      store.state.draftMode = "x";
      store.state.composer = "create";
      store.draftAgentExplicit = manual;
      store.draftModeExplicit = manual;
      const effective = {
        agent: "Y",
        mode: "y",
        model_selection: { provider_id: "p", model: "new" },
      };
      store.state.projectSessionDefaults = {
        projectId: "P",
        effective: { agent: "X", mode: "x" },
      };
      store.api.request = async (method: string) => {
        if (method === "project.settings.get")
          throw Error("Project reread failed");
        return { effective };
      };
      let payload: any = null;
      store.call = async (method: string, params: any) => {
        if (method === "session.create") {
          payload = params;
          throw Error("captured admission");
        }
      };
      await store.dispatch({
        type: "SettingsRequest",
        method: "settings.set",
        params: { overrides: {} },
      });
      const selection = {
        agent: store.state.draftAgent,
        mode: store.state.draftMode,
      };
      try {
        await store.submit();
      } catch {
        /* Inspect whether creation was admitted. */
      }
      return { selection, payload };
    }, manual);
    expect(result.selection).toEqual(
      manual ? { agent: "X", mode: "x" } : { agent: "", mode: "" },
    );
    if (manual)
      expect(result.payload).toMatchObject({
        agent: "X",
        mode: "x",
        component: "component-X",
      });
    else expect(result.payload).toBeNull();
  });
}

test("Host catalog replacement preserves unavailable explicit Agent and mode", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    store.state.authSession = {
      authenticated: true,
      principal: { owner: "owner" },
    };
    store.state.hostConnection = {
      projectId: "P",
      connected: true,
      state: "ready",
    };
    store.state.draftWorkspace = { kind: "local", projectId: "P" };
    store.state.draftAgent = "X";
    store.state.draftMode = "x";
    store.draftAgentExplicit = true;
    store.draftModeExplicit = true;
    store.call = async () => ({
      items: [
        {
          name: "Y",
          component: "Y-component",
          modes: [{ name: "y", role: "main_agent" }],
        },
      ],
    });
    await store.loadHostCatalog("P");
    return {
      agent: store.state.draftAgent,
      mode: store.state.draftMode,
      catalog: store.state.agents[0].name,
    };
  });
  expect(result).toEqual({ agent: "X", mode: "x", catalog: "Y" });
});

for (const explicit of [false, true]) {
  test(`default saves preserve ${explicit ? "explicit" : "inherited"} draft intent and New Chat resets`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(async (explicit) => {
      const { AppStore } = await import("/src/state/store.ts");
      const { selectedModel } = await import("/src/state/model.ts");
      const store: any = new AppStore();
      const choice = (id: string) => ({
        id,
        name: id,
        providerId: "p",
        variants: [],
      });
      store.state.availableModels = [
        choice("a"),
        choice("b"),
        choice("manual"),
      ];
      store.state.agents = [
        {
          name: "first",
          component: "one",
          modes: [{ name: "plan", role: "main_agent" }],
        },
        {
          name: "preferred",
          component: "two",
          modes: [{ name: "code", role: "main_agent" }],
        },
      ];
      let effective: any = {
        model_selection: { provider_id: "p", model: "a" },
        agent: "first",
        mode: "plan",
      };
      store.api.request = async (method: string, params: any) => {
        if (method === "settings.set")
          effective = {
            model_selection: { provider_id: "p", model: "b" },
            agent: "preferred",
            mode: "code",
          };
        return { effective, overrides: params?.overrides ?? {} };
      };
      await store.refreshDraftDefaults();
      if (explicit) {
        store.state.draftModel = choice("manual");
        store.draftAgentExplicit = true;
        store.draftModeExplicit = true;
      }
      await store.dispatch({
        type: "SettingsRequest",
        method: "settings.set",
        params: { overrides: {} },
      });
      const saved = {
        model: selectedModel(store.state)?.id,
        agent: store.state.draftAgent,
        mode: store.state.draftMode,
      };
      store.newChat(false);
      await store.refreshDraftDefaults();
      return {
        saved,
        reset: {
          model: selectedModel(store.state)?.id,
          explicit: store.state.draftModel,
          agent: store.state.draftAgent,
          mode: store.state.draftMode,
        },
      };
    }, explicit);
    expect(result.saved).toEqual(
      explicit
        ? { model: "manual", agent: "first", mode: "plan" }
        : { model: "b", agent: "preferred", mode: "code" },
    );
    expect(result.reset).toEqual({
      model: "b",
      explicit: null,
      agent: "preferred",
      mode: "code",
    });
  });
}

test("successful defaults save remains authoritative when follow-up reads fail", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const { selectedModel } = await import("/src/state/model.ts");
    const store: any = new AppStore();
    store.state.userSessionDefaults = {
      model_selection: { provider_id: "p", model: "old" },
    };
    store.api.request = async (method: string) => {
      if (method === "settings.set")
        return {
          effective: { model_selection: { provider_id: "p", model: "saved" } },
        };
      throw Error("read failed");
    };
    await store.dispatch({
      type: "SettingsRequest",
      method: "settings.set",
      params: { overrides: {} },
    });
    return selectedModel(store.state)?.id;
  });
  expect(result).toBe("saved");
});

test("late Project defaults cannot overwrite a newer scope or an explicit selection", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const { selectedModel } = await import("/src/state/model.ts");
    const store: any = new AppStore();
    const snapshot = (id: string) => ({
      effective: { model_selection: { provider_id: "p", model: id } },
    });
    let release: any;
    store.api.request = async (method: string, params: any) => {
      if (method === "settings.get") return snapshot("user");
      if (params.project_id === "P")
        return await new Promise((resolve) => {
          release = resolve;
        });
      return snapshot("Q-default");
    };
    store.state.draftWorkspace = { kind: "local", projectId: "P" };
    const old = store.refreshDraftDefaults();
    store.state.draftWorkspace = { kind: "local", projectId: "Q" };
    await store.refreshDraftDefaults();
    const before = selectedModel(store.state)?.id;
    store.state.draftModel = {
      id: "manual",
      providerId: "p",
      name: "manual",
      variants: [],
    };
    release(snapshot("P-default"));
    await old;
    return {
      before,
      after: selectedModel(store.state)?.id,
      scope: store.state.projectSessionDefaults.projectId,
    };
  });
  expect(result).toEqual({ before: "Q-default", after: "manual", scope: "Q" });
});

test("draft identity survives unavailable catalog entries and presentation follows refreshed metadata", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { initialState, selectedModel } = await import("/src/state/model.ts");
    const state = initialState();
    state.userSessionDefaults = {
      model_selection: {
        provider_id: "target",
        model: "same",
        variant: "high",
      },
    };
    state.availableModels = [
      { id: "same", providerId: "other", name: "Wrong provider", variants: [] },
    ];
    const missing = selectedModel(state);
    state.draftModel = {
      id: "same",
      providerId: "target",
      name: "Old label",
      variants: ["high"],
      contextWindowTokens: 5,
      variant: "high",
    };
    state.availableModels.push({
      id: "same",
      providerId: "target",
      name: "New label",
      variants: [],
      contextWindowTokens: 100,
    });
    const refreshed = selectedModel(state);
    return { missing, refreshed };
  });
  expect(result.missing).toMatchObject({
    id: "same",
    providerId: "target",
    name: "same",
    variant: "high",
  });
  expect(result.refreshed).toMatchObject({
    name: "New label",
    contextWindowTokens: 100,
    variants: [],
    variant: "high",
  });
});
