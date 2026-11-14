import { expect, test } from "@playwright/test";
import { applyEvent, applySnapshot } from "../src/client/projector";
import type { NativeInbox, NativeOperation } from "../src/client/types";
import { nativeBackend, nativeSnapshot } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

const inbox: NativeInbox = {
  inbox_id: "resume-incarnation",
  paused: true,
  active: false,
  items: [
    {
      id: 9,
      revision: 2,
      claimed: false,
      mode: "steer",
      input: { parts: [{ type: "text", text: "later steer" }] },
    },
    {
      id: 7,
      revision: 3,
      claimed: false,
      mode: "queue",
      input: { parts: [{ type: "text", text: " exact original bytes\n" }] },
    },
  ],
};

test("paused idle queue resumes only oldest row with exact witness and preserves composer", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend = await nativeBackend(page, {
    extraMethods: ["inbox.resume"],
    inboxTurn: async (command) => {
      await held;
      backend.snapshot().inbox!.items = [inbox.items[0]];
      backend.snapshot().inbox!.active = true;
      backend.snapshot().session.status = "running";
      backend.publish(backend.snapshot());
      return {
        id: command.params.operation_id,
        session_id: "s1",
        method: "inbox.resume",
        status: "accepted",
        result: null,
      };
    },
  });
  backend.snapshot().inbox = structuredClone(inbox);
  await page.goto("/#session/s1");
  const resume = page.getByTestId("inbox-resume");
  await expect(resume).toHaveCount(1);
  await expect(resume).toBeDisabled();
  await connectHostUI(page);
  const composer = page.getByTestId("composer").locator("textarea");
  await composer.fill("unrelated draft retained");
  await expect(
    page
      .locator('[data-testid="queue-item"][data-inbox-id="7"]')
      .getByTestId("inbox-resume"),
  ).toBeEnabled();
  await resume.click();
  await expect(resume).toBeDisabled();
  await expect
    .poll(
      () =>
        backend.commands.filter((command) => command.method === "inbox.resume")
          .length,
    )
    .toBe(1);
  expect(
    backend.commands.find((command) => command.method === "inbox.resume")
      .params,
  ).toEqual({
    operation_id: expect.any(String),
    expected_inbox_id: inbox.inbox_id,
    item_id: 7,
    expected_revision: 3,
  });
  await expect(composer).toHaveValue("unrelated draft retained");
  release();
  await expect(resume).toHaveCount(0);
  await expect(composer).toHaveValue("unrelated draft retained");
  expect(
    backend.commands.filter((command) =>
      ["turn.submit", "turn.queue", "turn.steer", "inbox.remove"].includes(
        command.method,
      ),
    ),
  ).toHaveLength(0);
});

for (const outcome of ["accepted", "running", "unknown"] as const)
  test(`resume ${outcome} blocks duplicate requests and never replays unknown delivery`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(
      async ({ source, inbox, outcome }) => {
        const { AppStore } = await import("/src/state/store.ts");
        const { CommandError } = await import("/src/client/api.ts");
        const store: any = new AppStore();
        store.state = {
          ...store.state,
          sessionId: "s1",
          page: "session",
          connection: "ws",
          authSession: { authenticated: true },
          composer: "kept draft",
          composerImages: [],
          capabilities: {
            methods: ["inbox.resume"],
            limits: { command_bytes: 262144 },
          },
          hostConnection: {
            state: "ready",
            connected: true,
            projectId: "project-1",
            catalogReady: true,
          },
        };
        store.snapshot({ ...source, inbox });
        const calls: any[] = [];
        store.call = async (method: string, params: any) => {
          calls.push({ method, params });
          if (method === "turn.get")
            return {
              id: params.operation_id,
              session_id: "s1",
              method: "inbox.resume",
              status: "unknown",
            };
          if (outcome === "unknown")
            throw new CommandError("disconnected", "unknown", false, true);
          return {
            id: params.operation_id,
            session_id: "s1",
            method: "inbox.resume",
            status: outcome,
          };
        };
        const action = {
          type: "ResumeInboxInput",
          itemId: "7",
          inboxId: inbox.inbox_id,
          expectedRevision: 3,
          input: { parts: [{ type: "text", text: "must never be sent" }] },
          mode: "steer",
        };
        await store.dispatch(action);
        await store.dispatch(action);
        const pending = Object.values(store.state.inboxMutations)[0] as any;
        return {
          calls,
          composer: store.state.composer,
          pending: pending.status,
          items: store.state.transcript.queue,
        };
      },
      { source: nativeSnapshot, inbox, outcome },
    );
    expect(
      result.calls.filter((call) => call.method === "inbox.resume"),
    ).toHaveLength(1);
    expect(result.calls[0].params).toEqual({
      operation_id: expect.any(String),
      expected_inbox_id: inbox.inbox_id,
      item_id: 7,
      expected_revision: 3,
    });
    expect(
      result.calls.filter((call) => call.method === "turn.get"),
    ).toHaveLength(outcome === "unknown" ? 1 : 0);
    expect(["pending", "unknown"]).toContain(result.pending);
    expect(result.composer).toBe("kept draft");
    expect(result.items[0].input).toEqual(inbox.items[1].input);
  });

test("resume admission rejects stale, non-oldest, Host, child and continuation witnesses", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const results = await page.evaluate(
    async ({ source, inbox }) => {
      const { AppStore } = await import("/src/state/store.ts");
      const cases = [
        "host",
        "auth",
        "child",
        "binding",
        "capability",
        "revision",
        "incarnation",
        "oldest",
        "claimed",
        "unpaused",
        "active",
        "busy",
        "retry",
        "mutation",
        "inboxPending",
      ];
      const results: Record<string, number> = {};
      for (const kind of cases) {
        const store: any = new AppStore();
        store.state = {
          ...store.state,
          sessionId: "s1",
          page: "session",
          connection: "ws",
          authSession: { authenticated: true },
          capabilities: {
            methods: ["inbox.resume"],
            limits: { command_bytes: 262144 },
          },
          hostConnection: {
            state: "ready",
            connected: true,
            projectId: "project-1",
            catalogReady: true,
          },
        };
        store.snapshot({ ...source, inbox: structuredClone(inbox) });
        const action: any = {
          type: "ResumeInboxInput",
          itemId: "7",
          inboxId: inbox.inbox_id,
          expectedRevision: 3,
        };
        if (kind === "host")
          store.state.hostConnection.projectId = "other-project";
        if (kind === "auth") store.state.authSession.authenticated = false;
        if (kind === "child") store.state.sessions[0].parentID = "parent";
        if (kind === "binding") store.state.sessionAttachingId = "s2";
        if (kind === "capability") store.state.capabilities.methods = [];
        if (kind === "revision") action.expectedRevision = 2;
        if (kind === "incarnation") action.inboxId = "old-incarnation";
        if (kind === "oldest") {
          action.itemId = "9";
          action.expectedRevision = 2;
        }
        if (kind === "claimed") store.state.transcript.queue[0].claimed = true;
        if (kind === "unpaused") store.state.transcript.inboxPaused = false;
        if (kind === "active") store.state.transcript.inboxActive = true;
        if (kind === "busy") store.state.transcript.sessionStatus = "busy";
        if (kind === "retry")
          store.state.retryOperationId = "retry-existing-answer";
        if (kind === "mutation")
          store.state.inboxMutations = {
            [JSON.stringify(["s1", inbox.inbox_id, "9"])]: {
              status: "unknown",
            },
          };
        if (kind === "inboxPending") store.state.inboxPending = true;
        let calls = 0;
        store.call = async () => {
          calls++;
        };
        await store.dispatch(action);
        results[kind] = calls;
      }
      return results;
    },
    { source: nativeSnapshot, inbox },
  );
  for (const [kind, calls] of Object.entries(results))
    expect(calls, kind).toBe(0);
});

test("failed resumed execution exposes answer retry without consuming the draft", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    extraMethods: ["inbox.resume", "turn.retry"],
    inboxTurn: async (command) => {
      const failure: NativeOperation = {
        version: 1,
        id: command.params.operation_id,
        session_id: "s1",
        owner: "owner",
        method: "inbox.resume",
        payload_hash: "hash",
        status: "failed",
        revision: 1,
        created_at_ms: 1,
        updated_at_ms: 2,
        result: {
          error: { code: "transport", message: "Provider disconnected" },
          retry_ready: true,
          position: { epoch: 0, turn: 1, round: 1 },
        },
      };
      backend.snapshot().operations = [failure];
      backend.snapshot().inbox!.items = [];
      backend.snapshot().session.retry_ready = true;
      backend.snapshot().session.retry_operation_id = failure.id;
      backend.publish(backend.snapshot());
      return failure;
    },
  });
  backend.snapshot().inbox = structuredClone(inbox);
  await page.goto("/#session/s1");
  await connectHostUI(page);
  const composer = page.getByTestId("composer").locator("textarea");
  await composer.fill("retained draft");
  await page.getByTestId("inbox-resume").click();
  await expect(page.getByTestId("retry-model-request")).toBeEnabled();
  await expect(page.getByTestId("operation-failure")).toContainText(
    "Provider disconnected",
  );
  await expect(composer).toHaveValue("retained draft");
});

test("resume model failure stays in the answer lane for snapshot and live retry controls", () => {
  const failure = {
    version: 1,
    id: "resume-failed",
    session_id: "s1",
    owner: "owner",
    method: "inbox.resume",
    payload_hash: "hash",
    status: "failed",
    revision: 1,
    created_at_ms: 1,
    updated_at_ms: 2,
    result: {
      error: { code: "transport", message: "Provider disconnected" },
      retry_ready: true,
      position: { epoch: 0, turn: 1, round: 1 },
    },
  } satisfies NativeOperation;
  const snapshot = { ...nativeSnapshot, operations: [failure] };
  const loaded = applySnapshot(snapshot);
  expect(
    loaded.blocks.find((block) => block.operationId === failure.id)?.stream,
  ).toBe("error");
  const live = applySnapshot(nativeSnapshot);
  applyEvent(live, {
    v: 1,
    type: "event",
    subscription_id: "sub",
    generation: "g",
    sequence: 1,
    session_id: "s1",
    event: "turn",
    data: failure,
  });
  expect(
    live.blocks.find((block) => block.operationId === failure.id)?.stream,
  ).toBe("error");
});
