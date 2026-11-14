import { expect, test } from "@playwright/test";
import { nativeBackend, nativeSnapshot } from "./native-fixture";

test("capability failure leaves an explicit disconnected state instead of connecting forever", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.route("**/api/v1/capabilities", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "capabilities_unavailable",
          message: "Capabilities unavailable",
        },
      },
    }),
  );
  await page.goto("/#session/s1");
  await expect(page.locator(".toast-body")).toContainText(
    "Capabilities unavailable",
  );
  await expect(page.locator(".status-chip")).toHaveAttribute(
    "data-state",
    "disconnected",
  );
});

test("a failed model catalog does not hide a successful session list or history", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.route("**/api/v1/models", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "catalog_unavailable",
          message: "Model metadata unavailable",
        },
      },
    }),
  );
  await page.goto("/#session/s1");
  await expect(page.getByTestId("session-item")).toHaveCount(1);
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(page.locator(".toast-body")).toContainText(
    "Model metadata unavailable",
  );
});

test("session history renders before an unrelated held model read finishes", async ({
  page,
}) => {
  await nativeBackend(page);
  let release: (() => Promise<void>) | undefined;
  await page.route("**/api/v1/models", (route) => {
    release = () => route.fulfill({ json: { items: [] } });
  });
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(page.getByTestId("session-item")).toHaveCount(1);
  await release!();
});

test("a failed session list preserves the routed session instead of creating a new chat", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.route("**/api/v1/sessions", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "list_unavailable",
          message: "Session listing unavailable",
        },
      },
    }),
  );
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#session\/s1$/);
  await expect(page.getByTestId("session-item")).toHaveCount(1);
  expect(
    backend.commands.filter((command) =>
      ["session.create", "turn.queue", "turn.submit"].includes(command.method),
    ),
  ).toHaveLength(0);
});

test("a disconnected pending Attach clears its spinner without clearing the conversation", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  // The attach opens a new session socket; holding it keeps the row pending.
  backend.holdNextSubscription();
  const row = page.getByTestId("session-item");
  await row.click();
  await expect(row).toHaveAttribute("data-loading", "true");
  backend.pendingSubscriptions[0].socket.close({
    code: 1012,
    reason: "test observation loss",
  });
  await expect(row).toHaveAttribute("data-loading", "false");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
});

test("malformed subscription results fail before replacing canonical conversation", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  // A subscribed frame naming a different session is rejected by the client,
  // which closes with application code 4002 and identifies the identity mismatch.
  backend.holdNextSubscription();
  await page.getByTestId("session-item").click();
  await expect.poll(() => backend.pendingSubscriptions.length).toBe(1);
  backend.releaseSubscription(0, undefined, { session_id: "other-session" });
  await expect(page.locator(".toast-body")).toContainText(
    "session_id: expected selected Session identity",
  );
  await expect(page.getByTestId("session-item")).toHaveAttribute(
    "data-loading",
    "false",
  );
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#session\/s1$/);
});

test("request traces correlate HTTP headers and remain bounded without content or credentials", async ({
  page,
}) => {
  await nativeBackend(page);
  const requestIds: string[] = [];
  await page.route("**/api/v1/models", (route) => {
    requestIds.push(route.request().headers()["x-request-id"]);
    return route.fulfill({
      status: 503,
      json: {
        error: { code: "catalog_unavailable", message: "SECRET_RESPONSE_BODY" },
      },
    });
  });
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(page.locator(".toast-body")).toContainText(
    "SECRET_RESPONSE_BODY",
  );
  const result = await page.evaluate(async () => {
    const path = "/src/client/trace.ts";
    const { diagnosticTrace, traceEvent } = await import(path);
    traceEvent("test.safe", {
      requestId: "safe-id",
      params: "SECRET_DRAFT",
      credential: "SECRET_TOKEN",
    } as any);
    const before = diagnosticTrace();
    for (let index = 0; index < 300; index++)
      traceEvent("test.bound", { requestId: `probe-${index}` });
    const exported = (window as any).__microcrabTrace();
    exported[0].stage = "external-mutation";
    return { before, after: (window as any).__microcrabTrace() };
  });
  expect(requestIds[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(result.before).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        stage: "api.request",
        method: "model.list",
        requestId: requestIds[0],
        outcome: "failed",
        code: "catalog_unavailable",
      }),
    ]),
  );
  expect(
    result.before.some(
      (entry: any) => entry.stage === "session.snapshot.applied",
    ),
  ).toBe(true);
  expect(JSON.stringify(result.before)).not.toContain("SECRET_RESPONSE_BODY");
  expect(JSON.stringify(result.before)).not.toMatch(
    /credential|pairing|authorization|cookie|params|https?:/i,
  );
  expect(result.after).toHaveLength(256);
  expect(result.after[0].stage).not.toBe("external-mutation");
});

test("loaded pages require identical selected history and ordered overlap", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async (base) => {
    const path = "/src/client/loaded-messages.ts";
    const { retainLoadedMessages } = await import(path);
    const message = (id: string) => ({
      id,
      role: "assistant",
      text: id,
      parts: [],
      tool_calls: [],
    });
    const history = { head: "checkpoint" };
    const previous = {
      ...base,
      history,
      messages: [message("a"), message("b"), message("c")],
      messages_truncated: true,
      next_cursor: 32,
    };
    const incoming = {
      ...base,
      history,
      messages: [message("b"), message("c"), message("d")],
      messages_truncated: true,
      next_cursor: 64,
    };
    const retained = retainLoadedMessages(incoming, previous);
    const branch = retainLoadedMessages(
      { ...incoming, history: { head: "other-checkpoint" } },
      previous,
    );
    const gap = retainLoadedMessages(
      { ...incoming, messages: [message("b"), message("different")] },
      previous,
    );
    return {
      ids: retained.messages.map((m: any) => m.id),
      cursor: retained.next_cursor,
      branch: branch.messages.map((m: any) => m.id),
      gap: gap.messages.map((m: any) => m.id),
    };
  }, nativeSnapshot);
  expect(result).toEqual({
    ids: ["a", "b", "c", "d"],
    cursor: 32,
    branch: ["b", "c", "d"],
    gap: ["b", "different"],
  });
});
