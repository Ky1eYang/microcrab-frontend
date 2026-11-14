import { test, expect, type Page, type Route } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

async function selectionBackend(page: Page) {
  const backend = await nativeBackend(page);
  backend.snapshot().session.model_selection = {
    provider_id: "provider-b",
    model: "shared",
    variant: "low",
  };
  backend.snapshot().session.model = "shared";
  await page.route("**/api/v1/models", (route) =>
    route.fulfill({
      json: {
        default_model_selection: {
          provider_id: "provider-b",
          model: "shared",
          variant: "low",
        },
        items: [
          {
            id: "shared",
            name: "Model A",
            provider_id: "provider-a",
            variants: [],
          },
          {
            id: "shared",
            name: "Model B",
            provider_id: "provider-b",
            variants: ["low", "medium", "high"],
          },
        ],
      },
    }),
  );
  const updates: any[] = [];
  let respond = async (route: Route) => {
    const { expected_revision, ...selection } = route.request().postDataJSON();
    backend.snapshot().session = {
      ...backend.snapshot().session,
      model: selection.model,
      model_selection: selection,
      revision: expected_revision + 1,
    };
    await route.fulfill({ json: backend.snapshot() });
  };
  await page.route("**/api/v1/sessions/s1/model", async (route) => {
    updates.push({
      method: route.request().method(),
      body: route.request().postDataJSON(),
    });
    await respond(route);
  });
  return {
    ...backend,
    updates,
    setResponse: (handler: typeof respond) => {
      respond = handler;
    },
  };
}
async function pickModel(page: Page, name: string) {
  await page.locator(".composer-model-pill").click();
  await page.getByRole("button", { name: /^选择模型\.\.\./ }).click();
  await page
    .locator(".model-item-row")
    .filter({ has: page.locator(".model-item-name", { hasText: name }) })
    .click();
}
async function pickVariant(page: Page, variant: string) {
  await page.locator(".composer-model-pill").click();
  await page.getByRole("button", { name: variant, exact: true }).click();
}

test("draft uses the server default and sends the selected provider/model/variant on create", async ({
  page,
}) => {
  const backend = await selectionBackend(page);
  await page.goto("/");
  await expect(page.locator(".composer-model-pill")).toContainText("Model B");
  await expect(page.locator(".composer-model-pill")).toContainText("LOW");
  await pickModel(page, "Model A");
  await expect(page.locator(".composer-model-pill")).toContainText("Model A");
  await pickModel(page, "Model B");
  await pickVariant(page, "High");
  await connectHostUI(page);
  await page.getByLabel("消息", { exact: true }).fill("draft model selection");
  await page.getByTitle("发送 (Enter)").click();
  await expect
    .poll(
      () =>
        backend.requests.filter(
          (r) => r.method === "POST" && r.path === "/api/v1/sessions",
        ).length,
    )
    .toBe(1);
  expect(
    backend.requests.find(
      (r) => r.method === "POST" && r.path === "/api/v1/sessions",
    )?.body.model_selection,
  ).toEqual({ provider_id: "provider-b", model: "shared", variant: "high" });
  expect(backend.updates).toHaveLength(0);
});

test("active selection uses PUT and canonical provider identity survives reload", async ({
  page,
}) => {
  const backend = await selectionBackend(page);
  await page.goto("/#session/s1");
  await expect(page.locator(".composer-model-pill")).toContainText("Model B");
  await pickModel(page, "Model A");
  await expect(page.locator(".composer-model-pill")).toContainText("Model A");
  expect(backend.updates).toEqual([
    {
      method: "PUT",
      body: {
        expected_revision: 1,
        provider_id: "provider-a",
        model: "shared",
        variant: null,
      },
    },
  ]);
  await page.reload();
  await expect(page.locator(".composer-model-pill")).toContainText("Model A");
  await page.locator(".composer-model-pill").click();
  await page.getByRole("button", { name: /^选择模型\.\.\./ }).click();
  await expect(
    page.locator('.model-item-row[data-selected="true"]'),
  ).toContainText("Model A");
  await expect(
    page.locator('.model-item-row[data-selected="true"]'),
  ).toHaveCount(1);
  expect(
    backend.requests.filter(
      (r) => r.method === "POST" && r.path === "/api/v1/sessions",
    ),
  ).toHaveLength(0);
});

test("active variant waits for the canonical response and rejected changes preserve selection", async ({
  page,
}) => {
  const backend = await selectionBackend(page);
  let held: Route | undefined;
  backend.setResponse(async (route) => {
    held = route;
  });
  await page.goto("/#session/s1");
  await expect(page.locator(".composer-model-pill")).toContainText("LOW");
  await pickVariant(page, "High");
  await expect.poll(() => backend.updates.length).toBe(1);
  await expect(page.locator(".composer-model-pill")).toContainText("LOW");
  await expect(page.locator(".composer-model-pill")).toBeDisabled();
  expect(backend.updates[0].body).toEqual({
    expected_revision: 1,
    provider_id: "provider-b",
    model: "shared",
    variant: "high",
  });
  await held!.fulfill({
    status: 409,
    json: {
      error: { code: "revision_conflict", message: "Selection rejected" },
    },
  });
  await expect(page.locator(".toast-body")).toContainText("Selection rejected");
  await expect(page.locator(".composer-model-pill")).toBeEnabled();
  await expect(page.locator(".composer-model-pill")).toContainText("LOW");
  backend.setResponse(async (route) => {
    // The server normalizes the requested value; the UI must use its canonical result.
    backend.snapshot().session.model_selection!.variant = "medium";
    backend.snapshot().session.revision++;
    await route.fulfill({ json: backend.snapshot() });
  });
  await pickVariant(page, "High");
  await expect(page.locator(".composer-model-pill")).toContainText("Medium");
  await page.reload();
  await expect(page.locator(".composer-model-pill")).toContainText("Medium");
});

test("a model response after leaving the session cannot replace the draft conversation", async ({
  page,
}) => {
  const backend = await selectionBackend(page);
  let held: Route | undefined;
  backend.setResponse(async (route) => {
    held = route;
  });
  await page.goto("/#session/s1");
  await expect(page.locator(".composer-model-pill")).toContainText("LOW");
  await pickVariant(page, "High");
  await expect.poll(() => backend.updates.length).toBe(1);
  await page.locator(".session-rail-new-btn").click();
  await held!.fulfill({ json: backend.snapshot() });
  await expect(page).not.toHaveURL(/#session\/s1$/);
  await expect(page.getByText("历史回答", { exact: true })).toHaveCount(0);
  await expect(page.locator(".composer-model-pill")).toBeEnabled();
});

test("busy configuration acknowledges a new choice without changing active route or losing live content", async ({
  page,
}) => {
  const backend = await selectionBackend(page);
  const pinned = { provider_id: "provider-a", model: "shared", variant: null };
  Object.assign(backend.snapshot().session, {
    status: "running",
    model_selection: pinned,
    applied_model_selection: pinned,
    turn_model_selection: pinned,
    pending_model_change: false,
  });
  // The generic fixture's runtime-open response normally resets status to idle.
  // Preserve the held Turn here so this case exercises actual busy controls.
  await page.route("**/api/v1/sessions/s1/runtime", (route) =>
    route.fulfill({ json: backend.snapshot() }),
  );
  let held: Route | undefined;
  backend.setResponse(async (route) => {
    held = route;
  });
  await page.goto("/#session/s1");
  await expect(page.getByTestId("composer-model-pill")).toContainText(
    "Model A",
  );
  await expect(page.getByTestId("composer-stop")).toBeVisible();
  await expect(page.getByTestId("composer-model-pill")).toBeEnabled();
  await pickModel(page, "Model B");
  await expect.poll(() => backend.updates.length).toBe(1);
  const response = structuredClone(backend.snapshot());
  response.session.model_selection = {
    provider_id: "provider-b",
    model: "shared",
    variant: null,
  };
  response.session.pending_model_change = true;
  response.session.revision++;
  backend.snapshot().messages.push({
    id: "later-live",
    role: "assistant",
    text: "Live content after configuration capture",
    parts: [],
    tool_calls: [],
  });
  backend.publish(backend.snapshot());
  await expect(
    page.getByText("Live content after configuration capture", { exact: true }),
  ).toBeVisible();
  // A configuration receipt is sufficient; its old canonical window has no authority.
  await held!.fulfill({ json: { session: response.session } });
  await expect(page.getByTestId("composer-model-pill")).toContainText(
    "Model B",
  );
  await expect(page.getByTestId("composer-model-pill")).toHaveAttribute(
    "title",
    /provider-a\/shared/,
  );
  await expect(page.getByTestId("composer-model-pill")).toHaveAttribute(
    "title",
    /Model B/,
  );
  await expect(page.getByTestId("composer-stop")).toBeVisible();
  await expect(
    page.getByText("Live content after configuration capture", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("composer-model-pill")).toBeEnabled();
  expect(backend.updates[0].body).toMatchObject({
    provider_id: "provider-b",
    model: "shared",
  });
  expect(
    backend.commands.filter(
      (command) =>
        command.method === "turn.retry" || command.method === "turn.submit",
    ),
  ).toHaveLength(0);
});

for (const applied of ["configured", "unknown"] as const) {
  test(`equal-revision late configuration receipt preserves ordered null route facts (${applied})`, async ({
    page,
  }) => {
    const backend = await selectionBackend(page);
    await page.goto("/");
    const result = await page.evaluate(
      async ({ base, applied }) => {
        const { AppStore } = await import("/src/state/store.ts");
        const store: any = new AppStore();
        const a = { provider_id: "provider-a", model: "shared", variant: null };
        const b = { provider_id: "provider-b", model: "shared", variant: null };
        const initial = {
          ...base,
          session: {
            ...base.session,
            status: "running",
            model_selection: a,
            applied_model_selection: a,
            turn_model_selection: a,
            pending_model_change: false,
            revision: 1,
          },
        };
        const subscription = {
          subscription_id: "configuration-sub",
          generation: "configuration-generation",
          sequence: 0,
          snapshot: initial,
        };
        store.subscription = subscription;
        store.update({
          sessionId: "s1",
          connection: "ws",
          authSession: { authenticated: true },
          capabilities: {
            methods: ["session.set_model"],
            features: {},
            limits: {},
          },
          availableModels: [
            {
              id: "shared",
              name: "Model A",
              providerId: "provider-a",
              variants: [],
            },
            {
              id: "shared",
              name: "Model B",
              providerId: "provider-b",
              variants: [],
            },
          ],
        });
        store.snapshot(initial);
        let release!: (value: unknown) => void;
        const calls: unknown[] = [];
        store.call = (method: string, params: unknown, id: string) => {
          calls.push({ method, params, id });
          return new Promise((resolve) => {
            release = resolve;
          });
        };
        const pending = store.dispatch({
          type: "SelectDraftModel",
          value: { id: "shared", providerId: "provider-b" },
        });
        const staleReceipt = {
          session: {
            ...initial.session,
            revision: 2,
            model_selection: b,
            pending_model_change: true,
          },
        };
        const later = {
          id: "later-config-content",
          role: "assistant",
          text: "Content received after configuration capture",
          parts: [],
          tool_calls: [],
        };
        const frame = (sequence: number, event: string, data: unknown) => ({
          v: 1,
          type: "event",
          subscription_id: subscription.subscription_id,
          generation: subscription.generation,
          sequence,
          session_id: "s1",
          event,
          data,
        });
        store.receive(
          frame(1, "blocks.upsert", {
            ids: [...initial.messages.map((message) => message.id), later.id],
            messages: [later],
          }),
        );
        const currentSession = {
          ...staleReceipt.session,
          status: "idle",
          applied_model_selection: applied === "configured" ? b : null,
          turn_model_selection: null,
          pending_model_change: false,
          updated_at_ms: 99,
        };
        store.receive(frame(2, "session.meta", { session: currentSession }));
        const before = structuredClone(
          store.state.sessions.find((item: any) => item.id === "s1"),
        );
        // The response captured A's old unfinished Turn; ordered metadata with the
        // same committed configuration revision has already cleared that binding.
        release(staleReceipt);
        await pending;
        const after = structuredClone(
          store.state.sessions.find((item: any) => item.id === "s1"),
        );
        const result = {
          calls,
          before,
          after,
          native: store.subscription.snapshot.session,
          pending: store.state.modelSelectionPending,
          text: store.state.transcript.blocks
            .map((block: any) => block.payload.text)
            .join("\n"),
          messages: store.subscription.snapshot.messages.map(
            (message: any) => message.id,
          ),
        };
        store.stop();
        return result;
      },
      { base: backend.snapshot(), applied },
    );
    const expectedApplied =
      applied === "configured"
        ? { provider_id: "provider-b", model: "shared", variant: null }
        : null;
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({
      method: "session.set_model",
      id: "s1",
      params: { expected_revision: 1, provider_id: "provider-b" },
    });
    expect(result.before).toMatchObject({
      model: { providerId: "provider-b" },
      turnModelSelection: null,
      appliedModelSelection: expectedApplied,
      pendingModelChange: false,
    });
    expect(result.after).toEqual(result.before);
    expect(result.native).toMatchObject({
      revision: 2,
      turn_model_selection: null,
      applied_model_selection: expectedApplied,
      pending_model_change: false,
      updated_at_ms: 99,
    });
    expect(result.pending).toBe(false);
    expect(result.messages).toContain("later-config-content");
    expect(result.text).toContain(
      "Content received after configuration capture",
    );
  });
}
