import { expect, test } from "@playwright/test";
import { nativeBackend, nativeSnapshot } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

const input = {
  variables: { set: {}, remove: [] },
  parts: [
    { type: "text", text: " exact pending input\n" },
    {
      type: "image",
      source: {
        type: "data",
        media_type: "image/png",
        data: Array.from(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
            "base64",
          ),
        ),
      },
    },
  ],
};
const item = { id: 7, revision: 3, claimed: false, mode: "queue", input };
const inbox = {
  inbox_id: "incarnation-one",
  items: [item],
  paused: true,
  active: true,
};

for (const action of ["take", "remove"] as const)
  test(`pending ${action} waits for CAS receipt and preserves active Stop`, async ({
    page,
  }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = await nativeBackend(page, {
      extraMethods: ["inbox.update", "inbox.remove"],
      inboxTurn: async (command) => {
        await held;
        backend.snapshot().inbox.items = [];
        backend.publish(backend.snapshot());
        return {
          id: command.params.operation_id,
          session_id: "s1",
          method: "inbox.remove",
          status: "completed",
          result: { removed: true, item_id: 7, inbox_id: inbox.inbox_id, item },
        };
      },
    });
    backend.snapshot().session.status = "running";
    backend.snapshot().inbox = structuredClone(inbox);
    await page.goto("/#session/s1");
    await connectHostUI(page);
    const composer = page.getByTestId("composer").locator("textarea");
    await page.getByTestId(`inbox-${action}`).click();
    await expect
      .poll(
        () =>
          backend.commands.filter((entry) => entry.method === "inbox.remove")
            .length,
      )
      .toBe(1);
    expect(
      backend.commands.find((entry) => entry.method === "inbox.remove").params,
    ).toEqual({
      operation_id: expect.any(String),
      expected_inbox_id: inbox.inbox_id,
      item_id: 7,
      expected_revision: 3,
    });
    await expect(page.getByTestId("queue-item")).toHaveCount(1);
    await expect(composer).toHaveValue("");
    await expect(
      page.getByTitle("请求中断，等待实际终态", { exact: true }),
    ).toBeEnabled();
    release();
    await expect(page.getByTestId("queue-item")).toHaveCount(0);
    await expect(composer).toHaveValue(
      action === "take" ? input.parts[0].text! : "",
    );
    expect(
      backend.commands.filter((entry) => entry.method === "turn.queue"),
    ).toHaveLength(0);
    if (action === "take") {
      await expect(composer).toBeFocused();
      await expect(
        page.getByTestId("composer-images").locator("img"),
      ).toHaveCount(1);
    }
  });

for (const outcome of [
  "completed",
  "draft",
  "route",
  "unknown",
  "unknown-completed",
  "unknown-accepted-stripped",
  "stripped",
  "rejected",
  "terminal-before-unknown",
  "refresh-failed",
] as const)
  test(`retrieval ${outcome} never overwrites a changed main draft or replays removal`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(
      async ({ snapshot, inbox, outcome }) => {
        const { AppStore } = await import("/src/state/store.ts");
        const { CommandError } = await import("/src/client/api.ts");
        const store: any = new AppStore();
        store.state = {
          ...store.state,
          connection: "ws",
          authSession: { authenticated: true },
          sessionId: "s1",
          page: "session",
          sessions: [
            { ...snapshot.session, projectId: "project-1", parentID: null },
          ],
          composer: "",
          composerImages: [],
          capabilities: {
            methods: ["inbox.remove", "inbox.update"],
            limits: { command_bytes: 262144 },
          },
          hostConnection: {
            state: "ready",
            connected: true,
            projectId: "project-1",
            catalogReady: true,
          },
          projects: [{ id: "project-1", name: "project", root: "/work" }],
        };
        store.snapshot({
          ...snapshot,
          inbox,
          session: { ...snapshot.session, status: "running" },
        });
        const requests: any[] = [];
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const receipt = (id: string) => ({
          id,
          session_id: "s1",
          method: "inbox.remove",
          status: "completed",
          result: {
            item: inbox.items[0],
            inbox_id: inbox.inbox_id,
            removed: true,
          },
        });
        store.call = async (method: string, params: any) => {
          requests.push({ method, params });
          if (
            method === "turn.get" &&
            outcome === "unknown-accepted-stripped" &&
            requests.filter((request) => request.method === "turn.get")
              .length === 1
          )
            return {
              id: params.operation_id,
              session_id: "s1",
              method: "inbox.remove",
              status: "accepted",
            };
          if (method === "turn.get")
            return outcome === "unknown"
              ? {
                  id: params.operation_id,
                  session_id: "s1",
                  method: "inbox.remove",
                  status: "unknown",
                }
              : receipt(params.operation_id);
          await held;
          if (outcome === "rejected")
            throw new CommandError("inbox_revision_conflict", "changed");
          if (outcome === "terminal-before-unknown") {
            store.reconcileSubmission(receipt(params.operation_id));
            throw new CommandError("disconnected", "unknown", false, true);
          }
          if (outcome.startsWith("unknown"))
            throw new CommandError("disconnected", "unknown", false, true);
          return receipt(params.operation_id);
        };
        const waiting = store.dispatch({
          type: "TakeInboxInput",
          itemId: "7",
          inboxId: inbox.inbox_id,
          expectedRevision: 3,
        });
        await Promise.resolve();
        if (outcome === "draft")
          await store.dispatch({ type: "SetComposer", value: "new draft" });
        if (outcome === "route") {
          store.composerRoute++;
          store.state.sessionId = "s2";
          store.state.composer = "other session";
        }
        if (outcome === "stripped")
          store.reconcileSubmission({
            id: requests[0].params.operation_id,
            session_id: "s1",
            method: "inbox.remove",
            status: "completed",
            result: {},
          });
        release();
        await waiting;
        if (outcome === "unknown-accepted-stripped") {
          store.composerRoute += 2;
          store.state.composer = "new draft";
          const stripped = {
            id: requests[0].params.operation_id,
            session_id: "s1",
            method: "inbox.remove",
            status: "completed",
            result: {},
          };
          store.reconcileSubmission(stripped);
          store.reconcileSubmission(stripped);
          await Promise.resolve();
          await Promise.resolve();
          store.reconcileSubmission(stripped);
        }
        await Promise.resolve();
        const staged = store.state.inboxRetrieved?.s1;
        const first = {
          composer: store.state.composer,
          images: store.state.composerImages,
          staged,
          toast: store.state.toast,
          queue: store.state.transcript.queue.length,
        };
        if (staged) {
          store.state.sessionId = "s1";
          await store.dispatch({ type: "SetComposer", value: "" });
          await store.dispatch({ type: "RestoreInboxInput" });
        }
        return {
          requests,
          first,
          restored: store.state.composer,
          restoredImages: store.state.composerImages,
          stagedAfter: store.state.inboxRetrieved?.s1,
        };
      },
      { snapshot: nativeSnapshot, inbox, outcome },
    );
    expect(
      result.requests.filter((entry) => entry.method === "inbox.remove"),
    ).toHaveLength(1);
    expect(
      result.requests.filter((entry) => entry.method === "turn.get"),
    ).toHaveLength(
      outcome === "unknown-accepted-stripped"
        ? 2
        : outcome.startsWith("unknown") || outcome === "stripped"
          ? 1
          : 0,
    );
    expect(result.first.queue).toBe(1); // only authoritative snapshots consume the row
    if (outcome === "rejected" || outcome === "unknown") {
      expect(result.first.toast.kind).toBe("error");
      expect(result.first.toast.text).toContain(
        outcome === "rejected" ? "修改待处理输入失败" : "操作结果未知",
      );
    }
    if (outcome === "unknown-accepted-stripped") {
      expect(result.first.composer).toBe("new draft");
      expect(result.first.staged.input).toEqual(input);
      const reads = result.requests.filter(
        (entry) => entry.method === "turn.get",
      );
      expect(
        reads.every(
          (entry) =>
            entry.params.operation_id ===
            result.requests[0].params.operation_id,
        ),
      ).toBe(true);
    }
    if (["draft", "route"].includes(outcome)) {
      expect(result.first.composer).toBe(
        outcome === "draft" ? "new draft" : "other session",
      );
      expect(result.first.staged.input).toEqual(input);
    }
    if (!["unknown", "rejected"].includes(outcome)) {
      expect(result.restored).toBe(input.parts[0].text);
      expect(result.restoredImages[0].data).toEqual(
        input.parts[1].source!.data,
      );
      expect(result.stagedAfter).toBeUndefined();
    } else expect(result.first.composer).toBe("");
  });

for (const invalid of [
  "claimed",
  "consumed",
  "revision",
  "incarnation",
  "occupied",
  "variables",
  "capability",
  "child",
] as const)
  test(`retrieval refuses ${invalid} without a mutation`, async ({ page }) => {
    await nativeBackend(page);
    await page.goto("/");
    const calls = await page.evaluate(
      async ({ snapshot, inbox, invalid }) => {
        const { AppStore } = await import("/src/state/store.ts");
        const store: any = new AppStore();
        store.state = {
          ...store.state,
          connection: "ws",
          authSession: { authenticated: true },
          sessionId: "s1",
          sessions: [
            {
              ...snapshot.session,
              projectId: "project-1",
              parentID: invalid === "child" ? "parent" : null,
            },
          ],
          capabilities: {
            methods: invalid === "capability" ? [] : ["inbox.remove"],
            limits: { command_bytes: 262144 },
          },
          hostConnection: {
            state: "ready",
            connected: true,
            projectId: "project-1",
            catalogReady: true,
          },
          projects: [{ id: "project-1" }],
        };
        store.snapshot({ ...snapshot, inbox });
        if (invalid === "child")
          store.state.sessions.find(
            (session: any) => session.id === "s1",
          ).parentID = "parent";
        if (invalid === "claimed")
          store.state.transcript.queue[0].claimed = true;
        if (invalid === "consumed") store.state.transcript.queue = [];
        if (invalid === "occupied") store.state.composer = "existing";
        if (invalid === "variables")
          store.state.transcript.queue[0].input.variables = {
            set: { secret: 1 },
            remove: [],
          };
        let calls = 0;
        store.call = async () => {
          calls++;
        };
        await store.dispatch({
          type: "TakeInboxInput",
          itemId: "7",
          inboxId:
            invalid === "incarnation" ? "old-incarnation" : inbox.inbox_id,
          expectedRevision: invalid === "revision" ? 2 : 3,
        });
        return calls;
      },
      { snapshot: nativeSnapshot, inbox, invalid },
    );
    expect(calls).toBe(0);
  });

test("CAS update preserves all input fields and failed inbox receipts never create model feedback", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(
    async ({ snapshot, inbox }) => {
      const { AppStore } = await import("/src/state/store.ts");
      const { applySnapshot, createTranscript } =
        await import("/src/client/projector.ts");
      const store: any = new AppStore();
      store.state = {
        ...store.state,
        connection: "ws",
        authSession: { authenticated: true },
        sessionId: "s1",
        sessions: [{ ...snapshot.session, projectId: "project-1" }],
        capabilities: {
          methods: ["inbox.update"],
          limits: { command_bytes: 262144 },
        },
        hostConnection: {
          state: "ready",
          connected: true,
          projectId: "project-1",
          catalogReady: true,
        },
        projects: [{ id: "project-1" }],
      };
      store.snapshot({ ...snapshot, inbox });
      const calls: any[] = [];
      store.call = async (method: string, params: any) => {
        calls.push({ method, params });
        return {
          id: params.operation_id,
          session_id: "s1",
          method,
          status: "completed",
        };
      };
      await store.dispatch({
        type: "UpdateInboxInput",
        itemId: "7",
        inboxId: inbox.inbox_id,
        expectedRevision: 3,
        input: {
          ...inbox.items[0].input,
          variables: { set: { a: 1 }, remove: [] },
        },
        mode: "steer",
      });
      const projected = applySnapshot(
        {
          ...snapshot,
          operations: ["inbox.update", "inbox.remove"].map((method, index) => ({
            id: String(index),
            session_id: "s1",
            method,
            status: "failed",
            result: { error: { message: "CAS changed" } },
            updated_at_ms: 1,
          })),
        },
        createTranscript(),
      );
      return {
        calls,
        errors: projected.blocks.filter(
          (block: any) => block.stream === "error",
        ).length,
      };
    },
    { snapshot: nativeSnapshot, inbox },
  );
  expect(result.calls[0].method).toBe("inbox.update");
  expect(result.calls[0].params.input.variables).toEqual({
    set: { a: 1 },
    remove: [],
  });
  expect(result.calls[0].params.input.parts).toEqual([
    input.parts[0],
    {
      type: "image",
      source: { type: "attachment", attachment_id: "attachment-1" },
    },
  ]);
  expect(
    backend.requests.find((request) => request.path.endsWith("/attachments"))
      ?.body,
  ).toEqual({
    bytes: input.parts[1].source!.data!.length,
    mediaType: "image/png",
  });
  expect(result.errors).toBe(0);
});

test("retrieved input waits beside a changed main draft and restores only on explicit request", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend = await nativeBackend(page, {
    extraMethods: ["inbox.remove"],
    inboxTurn: async (command) => {
      await held;
      backend.snapshot().inbox.items = [];
      backend.publish(backend.snapshot());
      return {
        id: command.params.operation_id,
        session_id: "s1",
        method: "inbox.remove",
        status: "completed",
        result: { item, inbox_id: inbox.inbox_id, removed: true },
      };
    },
  });
  backend.snapshot().inbox = structuredClone(inbox);
  backend.snapshot().session.status = "running";
  await page.goto("/#session/s1");
  await connectHostUI(page);
  const composer = page.getByTestId("composer").locator("textarea");
  await page.getByTestId("inbox-take").click();
  await expect
    .poll(
      () =>
        backend.commands.filter((command) => command.method === "inbox.remove")
          .length,
    )
    .toBe(1);
  await composer.fill("new main draft");
  release();
  await expect(page.getByTestId("inbox-retrieved")).toBeVisible();
  await expect(composer).toHaveValue("new main draft");
  await expect(page.getByTestId("inbox-restore")).toBeDisabled();
  await composer.fill("");
  await page.getByTestId("inbox-restore").click();
  await expect(composer).toHaveValue(input.parts[0].text!);
  await expect(composer).toBeFocused();
  await expect(page.getByTestId("composer-images").locator("img")).toHaveCount(
    1,
  );
  await expect(page.getByTestId("inbox-retrieved")).toHaveCount(0);
  expect(
    backend.commands.filter((command) => command.method === "inbox.remove"),
  ).toHaveLength(1);
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(0);
});

test("consumed pending input failure stays visible after its queue row disappears", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    extraMethods: ["inbox.remove"],
    inboxTurn: async (command) => {
      backend.snapshot().inbox.items = [];
      const failure = {
        id: command.params.operation_id,
        session_id: "s1",
        method: "inbox.remove",
        status: "failed",
        updated_at_ms: 1,
        result: {
          error: {
            code: "inbox_item_not_found",
            message: "Input already consumed",
          },
        },
      };
      backend.snapshot().operations.push(failure);
      backend.publish(backend.snapshot());
      return failure;
    },
  });
  backend.snapshot().inbox = structuredClone(inbox);
  backend.snapshot().session.status = "running";
  await page.goto("/#session/s1");
  await connectHostUI(page);
  const composer = page.getByTestId("composer").locator("textarea");
  await page.getByTestId("inbox-take").click();
  await expect(page.getByTestId("queue-item")).toHaveCount(0);
  await expect(page.locator(".toast-body")).toContainText(
    "修改待处理输入失败：Input already consumed",
  );
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("inbox-retrieved")).toHaveCount(0);
  expect(
    backend.commands.filter((command) => command.method === "inbox.remove"),
  ).toHaveLength(1);
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(0);
});

test("queued force-send steers the existing row only while the turn is running", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    extraMethods: ["inbox.update", "inbox.remove"],
    inboxTurn: async (command) => {
      const current = backend.snapshot().inbox;
      current.items[0] = {
        ...current.items[0],
        revision: 4,
        mode: "steer",
      };
      backend.publish(backend.snapshot());
      return {
        id: command.params.operation_id,
        session_id: "s1",
        method: "inbox.update",
        status: "completed",
        result: { inbox_id: current.inbox_id, item: current.items[0] },
      };
    },
  });
  backend.snapshot().inbox = structuredClone(inbox);
  backend.snapshot().session.status = "running";
  await page.goto("/#session/s1");
  await connectHostUI(page);
  const forceSend = page.getByTestId("inbox-force-send");
  await expect(forceSend).toBeEnabled();
  await expect(forceSend).toHaveAttribute("title", "强制发出");
  await forceSend.click();
  await expect
    .poll(
      () =>
        backend.commands.filter((command) => command.method === "inbox.update")
          .length,
    )
    .toBe(1);
  expect(
    backend.commands.find((command) => command.method === "inbox.update")
      .params,
  ).toEqual({
    operation_id: expect.any(String),
    expected_inbox_id: inbox.inbox_id,
    item_id: 7,
    expected_revision: 3,
    mode: "steer",
  });
  await expect(page.getByTestId("inbox-force-send")).toHaveCount(0);
  await expect(page.getByTestId("queue-item")).toHaveAttribute(
    "data-mode",
    "steer",
  );
  expect(
    backend.commands.filter((command) => command.method === "turn.steer"),
  ).toHaveLength(0);
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(0);
});

test("queued force-send stays disabled while the turn is idle", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    extraMethods: ["inbox.update", "inbox.remove"],
  });
  backend.snapshot().inbox = { ...structuredClone(inbox), active: false };
  backend.snapshot().session.status = "idle";
  await page.goto("/#session/s1");
  await connectHostUI(page);
  const forceSend = page.getByTestId("inbox-force-send");
  await expect(forceSend).toBeDisabled();
  await expect(forceSend).toHaveAttribute("title", "仅运行中可强制发出");
  expect(
    backend.commands.filter((command) => command.method === "inbox.update"),
  ).toHaveLength(0);
});

test("idle force-send does not admit a steer update", async ({ page }) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(
    async ({ snapshot, inbox }) => {
      const { AppStore } = await import("/src/state/store.ts");
      const store: any = new AppStore();
      store.state = {
        ...store.state,
        connection: "ws",
        authSession: { authenticated: true },
        sessionId: "s1",
        page: "session",
        sessions: [{ ...snapshot.session, projectId: "project-1" }],
        capabilities: {
          methods: ["inbox.update"],
          limits: { command_bytes: 262144 },
        },
        hostConnection: {
          state: "ready",
          connected: true,
          projectId: "project-1",
          catalogReady: true,
        },
        projects: [{ id: "project-1" }],
      };
      store.snapshot({ ...snapshot, inbox: { ...inbox, active: false } });
      const calls: any[] = [];
      store.call = async (method: string, params: any) => {
        calls.push({ method, params });
        return {
          id: params.operation_id,
          session_id: "s1",
          method,
          status: "completed",
        };
      };
      await store.dispatch({
        type: "UpdateInboxInput",
        itemId: "7",
        inboxId: inbox.inbox_id,
        expectedRevision: 3,
        mode: "steer",
      });
      return { calls, toast: store.state.toast?.text };
    },
    { snapshot: nativeSnapshot, inbox },
  );
  expect(result.calls).toEqual([]);
  expect(result.toast).toBe("仅运行中可强制发出");
});
