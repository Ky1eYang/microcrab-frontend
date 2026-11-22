import { test, expect, type Page } from "@playwright/test";
import { nativeBackend, nativeSnapshot } from "./native-fixture";
import { connectHostUI } from "./host-fixture";
import { CLIENT_TOOL_DEFINITIONS } from "../src/client/client-tools";
import type { ClientBinding } from "../src/client/client-tool-controller";
import type { NativeSnapshot, PermissionRequest } from "../src/client/types";

test("NewChat clears a pending attach and permits reattaching the same session", async ({
  page,
}) => {
  const { backend, pending, succeed, row } = await heldSessionNavigation(page);
  const target = row("待打开会话");
  await target.click();
  await expect.poll(() => pending.length).toBe(1);
  await expect(target).toHaveAttribute("aria-busy", "true");
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(target).toHaveAttribute("aria-busy", "false");
  await expect(page).not.toHaveURL(/#session\//);
  // NewChat bumps the attach ticket and closes the committed socket. Closing
  // that socket is what releases the selection, and delivering its snapshot
  // afterwards must not reopen it.
  const abandoned = pending[0].socket;
  succeed(0);
  await expect.poll(() => backend.connection(abandoned)?.closed).toBe(true);
  await expect(page).not.toHaveURL(/#session\//);
  await expect(page.getByText("Opened s2", { exact: true })).toHaveCount(0);
  await target.click();
  await expect.poll(() => pending.length).toBe(1);
  await expect(target).toHaveAttribute("aria-busy", "true");
  succeed(0);
  await expect(page.getByText("Opened s2", { exact: true })).toBeVisible();
  await expect(target).toHaveAttribute("aria-busy", "false");
  await expect(page).toHaveURL(/#session\/s2$/);
});

test("NewChat during the initial list read does not resurrect its captured session route", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  let release: (() => Promise<void>) | undefined;
  await page.route("**/api/v1/sessions", (route) => {
    release = () =>
      route.fulfill({
        json: {
          items: [nativeSnapshot.session],
          unavailable: [],
          complete: true,
        },
      });
  });
  await page.goto("/#session/s1");
  await expect.poll(() => !!release).toBe(true);
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(page).not.toHaveURL(/#session\//);
  await release!();
  await expect(
    page.getByTestId("session-item").filter({ hasText: "原生会话" }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  // The completed list is still useful, but its old route is no longer intent.
  await expect(page.getByText("历史回答", { exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/#session\//);
  // A subscription is the session socket itself. The abandoned route never
  // opens one.
  expect(backend.sessionSockets).toHaveLength(0);
});

test("runtime open failure preserves observable history and a live Host", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.route("**/api/v1/sessions/s1/runtime", (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: "workspace_conflict",
          message: "Workspace differs; reconcile before execution",
        },
      },
    }),
  );
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await connectHostUI(page);
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#session\/s1$/);
  await expect(page.locator(".toast-body")).toContainText("Workspace differs");
  expect(
    backend.commands.filter((c) => c.method === "turn.queue"),
  ).toHaveLength(0);
});

test("failed subscription refresh retains conversation and can retry", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  // A resync closes the committed session socket and reopens it. Refusing that
  // next connection is the typed failure; the reopen catch only schedules a
  // silent retry (1s, 2s, 4s…), so it no longer surfaces a toast.
  const before = backend.sessionSockets.length;
  backend.failNextSubscription(
    "temporarily_unavailable",
    "History retry required",
  );
  backend.event("resync_required", {});
  await expect.poll(() => backend.sessionSockets.length).toBe(before + 1);
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#session\/s1$/);
});

/** A session subscription is the socket to `/api/v1/sessions/{id}/ws`. Holding
 * it defers the `subscribed` frame the same way a deferred command result used
 * to. `succeed` and `fail` address the live held list, which drops an entry as
 * it is settled. */
async function heldSessionNavigation(
  page: Page,
  options: Parameters<typeof nativeBackend>[1] = {},
) {
  const backend = await nativeBackend(page, options);
  await page.route("**/api/v1/sessions", (route) =>
    route.fulfill({
      json: {
        unavailable: [],
        complete: true,
        items: [
          nativeSnapshot.session,
          { ...nativeSnapshot.session, id: "s2", title: "待打开会话" },
          { ...nativeSnapshot.session, id: "s3", title: "另一个会话" },
        ],
      },
    }),
  );
  // Native navigation now checks the selected Session's activation even when
  // it shares the already-connected Project with the outgoing Session.
  await page.route(/\/api\/v1\/sessions\/s[23]\/runtime$/, (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    return route.fulfill({ json: { ...nativeSnapshot, session: { ...nativeSnapshot.session, id } } });
  });
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await connectHostUI(page);
  // Session commands (`client_tools.*`, `permission.reply`) travel on the
  // session socket, which the fixture already answers and records into
  // `backend.commands`. Nothing here replaces that handler.
  backend.holdSubscriptions(true);
  const pending = backend.pendingSubscriptions;
  const fail = (index: number, message: string) =>
    backend.refuseSubscription(index, "temporarily_unavailable", message);
  const succeed = (index: number, frame: Record<string, unknown> = {}) => {
    const sessionId = pending[index].sessionId;
    backend.releaseSubscription(
      index,
      {
        ...nativeSnapshot,
        ...(options.clientTools
          ? {
              client_tools: {
                ...options.clientTools,
                calls: [],
                pending: [],
              },
            }
          : {}),
        session: {
          ...nativeSnapshot.session,
          id: sessionId,
          title: sessionId === "s2" ? "待打开会话" : "另一个会话",
        },
        messages: [
          {
            id: "opened-answer",
            role: "assistant",
            text: `Opened ${sessionId}`,
            parts: [],
            tool_calls: [],
          },
        ],
      },
      frame,
    );
  };
  const row = (title: string) =>
    page.getByTestId("session-item").filter({ hasText: title });
  return { backend, pending, fail, succeed, row };
}

test("slow failed session navigation keeps history and permits a retry without deletion", async ({
  page,
}) => {
  const { backend, pending, fail, succeed, row } =
    await heldSessionNavigation(page);
  const target = row("待打开会话");
  await page.getByLabel("消息", { exact: true }).fill("preserved draft");
  await target.click();
  await expect.poll(() => pending.length).toBe(1);
  expect(pending[0].sessionId).toBe("s2");
  await expect(target).toHaveAttribute("aria-busy", "true");
  await expect(target).toHaveAttribute("data-loading", "true");
  await expect(target.getByTitle("正在打开会话…")).toBeVisible();
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#session\/s1$/);
  await target.click();
  fail(0, "History temporarily unavailable");
  await expect(page.locator(".toast-body")).toContainText(
    "History temporarily unavailable",
  );
  expect(pending).toHaveLength(0);
  await expect(target).toHaveAttribute("aria-busy", "false");
  await expect(target).toHaveAttribute("data-loading", "false");
  await expect(target.getByTitle("正在打开会话…")).toHaveCount(0);
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(page.getByLabel("消息", { exact: true })).toHaveValue(
    "preserved draft",
  );
  await target.click();
  await expect.poll(() => pending.length).toBe(1);
  await expect(target).toHaveAttribute("aria-busy", "true");
  succeed(0);
  await expect(page.getByText("Opened s2", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#session\/s2$/);
  await expect(target).toHaveAttribute("aria-busy", "false");
  expect(
    backend.requests.filter((request) => request.method === "DELETE"),
  ).toHaveLength(0);
});

test("stale session failure does not clear a newer navigation or show its error", async ({
  page,
}) => {
  const { pending, fail, succeed, row } = await heldSessionNavigation(page);
  const older = row("待打开会话");
  const newer = row("另一个会话");
  await older.click();
  await expect.poll(() => pending.length).toBe(1);
  await newer.click();
  await expect.poll(() => pending.length).toBe(2);
  await expect(newer).toHaveAttribute("aria-busy", "true");
  fail(0, "Obsolete navigation failure");
  // A duplicate click remains suppressed after the old rejection has settled.
  await newer.click();
  await expect(newer).toHaveAttribute("data-loading", "true");
  await expect(newer.getByTitle("正在打开会话…")).toBeVisible();
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(page.locator(".toast-body")).toHaveCount(0);
  succeed(0);
  await expect(page.getByText("Opened s3", { exact: true })).toBeVisible();
  expect(pending).toHaveLength(0);
  await expect(page).toHaveURL(/#session\/s3$/);
  await expect(newer).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".toast-body")).toHaveCount(0);
});

for (const trigger of ["gap", "resync", "terminal"] as const) {
  test(`old-session ${trigger} cannot supersede a deferred explicit navigation`, async ({
    page,
  }) => {
    const { backend, pending, succeed, row } =
      await heldSessionNavigation(page);
    const target = row("待打开会话");
    await target.click();
    await expect.poll(() => pending.length).toBe(1);
    if (trigger === "gap") backend.event("session", nativeSnapshot.session, 2);
    else if (trigger === "resync") backend.event("resync_required", {});
    else backend.event("turn", { id: "old-operation", status: "completed" });
    // A second real click exercises duplicate suppression after the event is delivered.
    await target.click();
    await expect(target).toHaveAttribute("aria-busy", "true");
    expect(pending.map((held) => held.sessionId)).toEqual(["s2"]);
    await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
    succeed(0);
    await expect(page.getByText("Opened s2", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/#session\/s2$/);
    expect(pending.map((held) => held.sessionId)).toEqual([]);
  });
}

test("an old Session gap waits for explicit navigation failure before recovering the retained view", async ({
  page,
}) => {
  const { backend, pending, fail, row } = await heldSessionNavigation(page);
  const before = backend.sessionSockets.length;
  await row("待打开会话").click();
  await expect.poll(() => pending.length).toBe(1);
  backend.event("resync_required", {});
  await expect(row("待打开会话")).toHaveAttribute("aria-busy", "true");
  expect(pending.map((held) => held.sessionId)).toEqual(["s2"]);
  fail(0, "Target unavailable");
  await expect(page.locator(".toast-body")).toContainText("Target unavailable");
  await expect.poll(() => pending.length).toBe(1);
  expect(pending[0].sessionId).toBe("s1");
  expect(backend.sessionSockets).toHaveLength(before + 2);
  backend.releaseSubscription(0);
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#session\/s1$/);
});

for (const targetFails of [false, true]) {
  test(`queued old resync cannot restart after explicit navigation ${targetFails ? "fails" : "starts"}`, async ({
    page,
  }) => {
    const { backend, pending, fail, succeed, row } =
      await heldSessionNavigation(page);
    // A resync closes the committed socket and opens exactly one replacement.
    // There is no command result left to queue: the closed socket accepts no
    // further frame, so a second resync cannot start another refresh.
    const first = await heldResync(backend, pending);
    expect(first.sessionId).toBe("s1");
    const target = row("待打开会话");
    await target.click();
    await expect.poll(() => pending.length).toBe(2);
    expect(pending.map((held) => held.sessionId)).toEqual(["s1", "s2"]);
    if (targetFails) {
      fail(1, "Target unavailable");
      await expect(page.locator(".toast-body")).toContainText(
        "Target unavailable",
      );
      await expect(target).toHaveAttribute("aria-busy", "false");
    }
    // s2 has not committed, so this held socket is still the current s1
    // subscription. A replacement snapshot would be adopted. Release the
    // original one instead: it must not open another s1 socket.
    const s1Before = backend.sessionSockets.filter(
      (socket) => sessionOf(socket) === "s1",
    ).length;
    backend.releaseSubscription(0);
    expect(pending.map((held) => held.sessionId)).toEqual(
      targetFails ? [] : ["s2"],
    );
    await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
    await expect(page.getByText("Opened s1", { exact: true })).toHaveCount(0);
    expect(
      backend.sessionSockets.filter((socket) => sessionOf(socket) === "s1"),
    ).toHaveLength(s1Before);
    if (targetFails) {
      await target.click();
      await expect.poll(() => pending.length).toBe(1);
      expect(pending[0].sessionId).toBe("s2");
    } else {
      await target.click();
      expect(pending).toHaveLength(1);
      await expect(target).toHaveAttribute("aria-busy", "true");
    }
    succeed(0);
    await expect(page.getByText("Opened s2", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/#session\/s2$/);
  });
}

test("new-session resync survives an outstanding old-session refresh", async ({
  page,
}) => {
  const { backend, pending, succeed, row } = await heldSessionNavigation(page);
  await heldResync(backend, pending);
  await row("待打开会话").click();
  await expect.poll(() => pending.length).toBe(2);
  expect(pending.map((held) => held.sessionId)).toEqual(["s1", "s2"]);
  succeed(1, {
    subscription_id: "navigation-1",
    generation: "navigation-generation",
  });
  await expect(page.getByText("Opened s2", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#session\/s2$/);
  // The fixture stamps a fresh identity on every connection and `backend.event`
  // addresses the first socket, so neither names the subscription s2 accepted.
  await sendResync(backend, pending, "s2");
  // The s2 reconnect is held behind the still-outstanding s1 refresh.
  await expect.poll(() => pending.length).toBe(2);
  expect(pending.map((held) => held.sessionId)).toEqual(["s1", "s2"]);
  // Committing s2 stops the previous socket, which also closes this held
  // reconnect. A closed route cannot accept another frame, so the observable
  // result is that the s2 view stays and no further s1 socket opens.
  const s1Before = backend.sessionSockets.filter(
    (socket) => sessionOf(socket) === "s1",
  ).length;
  await expect(page).toHaveURL(/#session\/s2$/);
  await expect(page.getByText("Opened s2", { exact: true })).toBeVisible();
  await expect(page.getByText("Opened s1", { exact: true })).toHaveCount(0);
  expect(
    backend.sessionSockets.filter((socket) => sessionOf(socket) === "s1"),
  ).toHaveLength(s1Before);
  expect(pending.map((held) => held.sessionId)).toEqual(["s1", "s2"]);
  const refresh = pending.findIndex((held) => held.sessionId === "s2");
  succeed(refresh);
  await expect(page).toHaveURL(/#session\/s2$/);
  await expect(page.getByText("Opened s2", { exact: true })).toBeVisible();
});

test("same-session resync still drains a queued canonical refresh", async ({
  page,
}) => {
  const { backend, pending, succeed } = await heldSessionNavigation(page);
  const before = backend.sessionSockets.filter(
    (socket) => sessionOf(socket) === "s1",
  ).length;
  // The first resync closes the committed socket, so it cannot carry a second
  // event. The canonical refresh it opened is the one a later resync drains.
  await heldResync(backend, pending);
  expect(pending.map((held) => held.sessionId)).toEqual(["s1"]);
  succeed(0);
  await heldResync(backend, pending);
  expect(pending.map((held) => held.sessionId)).toEqual(["s1"]);
  succeed(0);
  await expect(page.getByText("Opened s1", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#session\/s1$/);
  expect(
    backend.sessionSockets.filter((socket) => sessionOf(socket) === "s1"),
  ).toHaveLength(before + 2);
});

/** A `resync_required` closes the committed session socket and reopens it.
 * The fixture keeps each socket's accepted identity, so this names that
 * identity rather than the connection-global value. */
async function heldResync(
  backend: Awaited<ReturnType<typeof nativeBackend>>,
  pending: { socket: unknown }[],
  sessionId = "s1",
) {
  const before = pending.length;
  await sendResync(backend, pending, sessionId);
  await expect.poll(() => pending.length).toBe(before + 1);
  return pending[before];
}

async function sendResync(
  backend: Awaited<ReturnType<typeof nativeBackend>>,
  pending: { socket: unknown }[],
  sessionId: string,
) {
  const committed = [...backend.sessionSockets]
    .reverse()
    .find(
      (socket) =>
        sessionOf(socket) === sessionId &&
        !pending.some((held) => held.socket === socket),
    );
  const accepted = committed ? backend.connection(committed) : undefined;
  if (!committed || !accepted)
    throw Error(`No committed socket for ${sessionId}`);
  committed.send(
    JSON.stringify({
      v: 1,
      type: "event",
      subscription_id: accepted.subscription,
      generation: accepted.generation,
      sequence: accepted.sequence + 1,
      session_id: sessionId,
      event: "resync_required",
      data: {},
    }),
  );
}

function sessionOf(socket: { url: () => string }) {
  return decodeURIComponent(new URL(socket.url()).pathname.split("/")[4]);
}

function navigationExecutor(): ClientBinding {
  const question = {
    invocation_id: "navigation-question",
    parent_session_id: "s1",
    session_id: "s1",
    call_id: "navigation-question-call",
    tool: "ask_user_question",
    arguments: {
      questions: [{ id: "keep", question: "Keep this pending question?" }],
    },
    epoch: 0,
    turn_id: 1,
    round_id: 1,
    catalog_digest: "navigation-digest",
    status: "pending" as const,
    created_at_ms: Date.now(),
    deadline_ms: Date.now() + 300000,
  };
  return {
    role: "executor",
    lease_id: "navigation-lease",
    catalog_digest: "navigation-digest",
    definitions: CLIENT_TOOL_DEFINITIONS,
    calls: [question],
    pending: [question],
  };
}

function navigationPermission(): PermissionRequest {
  return {
    request_id: "navigation-permission",
    parent_session_id: "s1",
    session_id: "s1",
    call_id: "navigation-permission-call",
    agent: "coding",
    mode: "execute",
    tool: "shell",
    arguments: { command: "echo navigation" },
    revision: 4,
    created_at_ms: Date.now(),
    expires_at_ms: Date.now() + 300000,
  };
}

test("target subscription precedes old executor unbind and commits while unbind is deferred", async ({
  page,
}) => {
  const { backend, pending, succeed, row } = await heldSessionNavigation(page, {
    clientTools: navigationExecutor(),
  });
  const unbinds: { sessionId: string; params: unknown }[] = [];
  backend.handleSessionCommand((command, sessionId) => {
    if (command.method === "client_tools.unbind")
      unbinds.push({ sessionId, params: command.params });
  });
  await expect(
    page.getByText("Keep this pending question?", { exact: true }),
  ).toBeVisible();
  const target = row("待打开会话");
  const start = backend.commands.length;
  await target.click();
  await expect.poll(() => pending.length).toBe(1);
  // The visible conversation keeps its executor until the replacement snapshot
  // commits, so the unbind cannot precede that subscription.
  expect(
    backend.commands
      .slice(start)
      .filter((command) => command.method === "client_tools.unbind"),
  ).toHaveLength(0);
  await expect(
    page.getByText("Keep this pending question?", { exact: true }),
  ).toBeVisible();
  succeed(0);
  await expect(page.getByText("Opened s2", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#session\/s2$/);
  // The fixture answers the unbind itself; the observable ordering is that the
  // target snapshot committed before the old executor was released.
  await expect
    .poll(
      () =>
        backend.commands.filter(
          (command) => command.method === "client_tools.unbind",
        ).length,
    )
    .toBe(1);
  expect(unbinds).toEqual([
    { sessionId: "s1", params: { lease_id: "navigation-lease" } },
  ]);
  await expect(
    page.getByText("Keep this pending question?", { exact: true }),
  ).toHaveCount(0);
});

test("failed target retains old executor lease, pending question and actionable permission", async ({
  page,
}) => {
  const { backend, pending, fail, row } = await heldSessionNavigation(page, {
    clientTools: navigationExecutor(),
    permissionRequests: [navigationPermission()],
  });
  const permission = page.getByTestId("permission-request");
  const allow = permission.getByRole("button", {
    name: "允许本次",
    exact: true,
  });
  await expect(allow).toBeEnabled();
  await expect(
    page.getByText("Keep this pending question?", { exact: true }),
  ).toBeVisible();
  const start = backend.commands.length;
  await row("待打开会话").click();
  await expect.poll(() => pending.length).toBe(1);
  await expect(allow).toBeEnabled();
  await expect(
    page.getByText("Keep this pending question?", { exact: true }),
  ).toBeVisible();
  fail(0, "Target subscription failed");
  await expect(page.locator(".toast-body")).toContainText(
    "Target subscription failed",
  );
  await expect(page).toHaveURL(/#session\/s1$/);
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Keep this pending question?", { exact: true }),
  ).toBeVisible();
  await expect(allow).toBeEnabled();
  expect(
    backend.commands
      .slice(start)
      .filter((command) => command.method === "client_tools.unbind"),
  ).toHaveLength(0);
  await allow.click();
  await expect
    .poll(
      () =>
        backend.commands.filter(
          (command) => command.method === "permission.reply",
        ).length,
    )
    .toBe(1);
  const reply = backend.commands.find(
    (command) => command.method === "permission.reply",
  );
  expect(reply.params).toEqual({
    request_id: "navigation-permission",
    lease_id: "navigation-lease",
    decision: "allow",
  });
  await expect(permission).toHaveCount(0);
});

test("two completed turns settle idle and leave the composer ready for a third", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await connectHostUI(page);
  for (const [index, prompt] of ["first input", "second input"].entries()) {
    await page.getByLabel("消息", { exact: true }).fill(prompt);
    await page.getByTitle("发送 (Enter)").click();
    await expect
      .poll(
        () => backend.commands.filter((c) => c.method === "turn.queue").length,
      )
      .toBe(index + 1);
    // The fixture publishes the admitted turn as running. The observation uses
    // the operation id the queued command actually sent.
    const queued = backend.commands.filter((c) => c.method === "turn.queue");
    const operationId = String(queued[index].params.operation_id);
    await expect(page.locator(".composer-busy-actions")).toBeVisible();
    backend.event("model_observation", {
      operation_id: operationId,
      call_id: `call-${index}`,
      phase: "text_delta",
      text: `preview-${index}`,
    });
    await expect(
      page.getByText(`preview-${index}`, { exact: true }),
    ).toBeVisible();
    backend.finish(`canonical answer ${index}`);
    backend.event("turn", { id: operationId, status: "completed" });
    await expect(
      page.getByText(`canonical answer ${index}`, { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".composer-busy-actions")).toHaveCount(0);
    await expect(
      page.getByText(`preview-${index}`, { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel("消息", { exact: true })).toBeEnabled();
    await expect(page.locator('[data-busy="true"]')).toHaveCount(0);
  }
  await page
    .getByLabel("消息", { exact: true })
    .fill("third input remains editable");
  await expect(page.getByTitle("发送 (Enter)")).toBeEnabled();
  expect(
    backend.commands
      .filter((c) => c.method === "turn.queue")
      .map((c) => c.params.operation_id),
  ).toHaveLength(2);
  expect(
    backend.nativeUrls.every((url) => new URL(url).pathname === "/api/v1/ws"),
  ).toBe(true);
});
