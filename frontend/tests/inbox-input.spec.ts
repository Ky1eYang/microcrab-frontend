import { expectedPluginVariables } from "./input-inventory-expectation";
import { expect, test } from "@playwright/test";
import { nativeBackend, nativeSnapshot } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

const image = {
  id: "draft-image",
  name: "draft.png",
  mediaType: "image/png",
  data: Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCwAAAABJRU5ErkJggg==",
      "base64",
    ),
  ),
  previewUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCwAAAABJRU5ErkJggg==",
};
const parts = [
  { type: "text", text: "  Preserve exact draft\n " },
  {
    type: "image",
    source: { type: "data", media_type: "image/png", data: image.data },
  },
];

for (const mode of ["queue", "steer"] as const) {
  test(`busy composer ${mode} submits exactly one inbox command while keeping the active stream`, async ({
    page,
  }) => {
    let release!: () => void;
    const held = new Promise<void>((yes) => {
      release = yes;
    });
    const backend = await nativeBackend(page, {
      extraMethods: ["turn.queue", "turn.steer"],
      inboxTurn: async (command) => {
        await held;
        backend.snapshot().inbox = {
          items: [{ id: 41, mode, input: command.params.input }],
          paused: false,
          active: true,
        };
        backend.publish(backend.snapshot());
        return {
          id: command.params.operation_id,
          session_id: "s1",
          method: command.method,
          status: "completed",
          revision: 1,
          result: { admitted: true },
        };
      },
    });
    backend.snapshot().session.status = "running";
    backend.snapshot().inbox = { items: [], paused: false, active: true };
    await page.goto("/#session/s1");
    await connectHostUI(page);
    const composer = page.getByTestId("composer").locator("textarea");
    await expect(composer).toBeEnabled();
    await composer.fill(`Later ${mode} input`);
    const button = page.getByTestId(`${mode}-input`);
    await expect(button).toBeEnabled();
    await button.click();
    await expect
      .poll(
        () =>
          backend.commands.filter(
            (command) => command.method === `turn.${mode}`,
          ).length,
      )
      .toBe(1);
    await expect(button).toBeDisabled();
    await expect(composer).toHaveValue(`Later ${mode} input`);
    const request = backend.commands.find(
      (command) => command.method === `turn.${mode}`,
    );
    expect(request.params).toEqual({
      operation_id: expect.any(String),
      input: {
        parts: [{ type: "text", text: `Later ${mode} input` }],
        variables: expectedPluginVariables(true),
      },
    });
    expect(
      backend.commands.filter((command) => command.method === "turn.submit"),
    ).toHaveLength(0);
    expect(backend.snapshot().messages).toEqual(nativeSnapshot.messages);
    release();
    await expect(composer).toHaveValue("");
    await expect(page.getByTestId("queue-dock")).toContainText(
      `Later ${mode} input`,
    );
    await expect(
      page.getByTitle("请求中断，等待实际终态", { exact: true }),
    ).toBeEnabled();
    backend.snapshot().inbox = { items: [], paused: false, active: true };
    backend.publish(backend.snapshot());
    await expect(page.getByTestId("queue-dock")).toHaveCount(0);
    await expect(
      page.getByTitle("请求中断，等待实际终态", { exact: true }),
    ).toBeEnabled();
  });
}

for (const mode of ["queue", "steer"] as const) {
  for (const outcome of [
    "completed",
    "rejected",
    "draft",
    "images",
    "intake",
    "route",
    "unknown",
    "observed",
    "accepted",
  ] as const) {
    test(`${mode} multipart admission preserves ${outcome} ownership and never replays`, async ({
      page,
    }) => {
      await nativeBackend(page);
      await page.goto("/");
      const result = await page.evaluate(
        async ({ mode, outcome, image, parts, snapshot }) => {
          const { AppStore } = await import("/src/state/store.ts");
          const { CommandError } = await import("/src/client/api.ts");
          const store: any = new AppStore();
          const selected = {
            ...snapshot,
            session: { ...snapshot.session, status: "running" },
            inbox: { items: [], paused: false, active: true },
          };
          store.update({
            sessionId: "s1",
            connection: "ws",
            authSession: { authenticated: true },
            capabilities: {
              methods: ["turn.queue", "turn.steer", "turn.get"],
              features: { image_data: true },
              limits: { command_bytes: 256 * 1024 },
            },
            hostConnection: {
              projectId: "project-1",
              state: "ready",
              catalogReady: true,
            },
          });
          store.subscription = { snapshot: selected };
          store.snapshot(selected);
          store.update({ composer: parts[0].text, composerImages: [image] });
          const calls: any[] = [];
          let resolve!: (receipt: any) => void;
          let reject!: (error: Error) => void;
          let commandDispatched!: () => void;
          const sent = new Promise<void>((resolveSent) => {
            commandDispatched = resolveSent;
          });
          store.api.request = (
            method: string,
            params: any,
            session: string,
          ) => {
            calls.push({ method, params, session });
            if (method === "turn.get")
              return Promise.resolve({
                id: params.operation_id,
                session_id: "s1",
                method: `turn.${mode}`,
                status: outcome === "observed" ? "completed" : "unknown",
              });
            return new Promise((yes, no) => {
              resolve = yes;
              reject = no;
              commandDispatched();
            });
          };
          const pending = store.dispatch({
            type: mode === "queue" ? "QueueInput" : "SteerInput",
          });
          await sent;
          const operationId = calls[0].params.operation_id;
          const during = {
            text: store.state.composer,
            images: store.state.composerImages.length,
            pending: store.state.inboxPending,
            blocks: store.state.transcript.blocks.map(
              (block: any) => block.messageId,
            ),
            busy: store.state.transcript.sessionStatus,
          };
          await store.dispatch({
            type: mode === "queue" ? "SteerInput" : "QueueInput",
          });
          if (outcome === "draft") store.update({ composer: "New draft" });
          if (outcome === "images") store.update({ composerImages: [] });
          if (outcome === "intake") store.update({ imageIntakePending: true });
          if (outcome === "route") {
            store.composerRoute++;
            store.update({
              sessionId: "s2",
              composer: "Other route",
              inboxPending: false,
            });
          }
          if (outcome === "rejected")
            reject(new CommandError("inbox_full", "Inbox is full"));
          else if (outcome === "unknown" || outcome === "observed")
            reject(
              new CommandError(
                "connection_lost",
                "Unknown result",
                false,
                true,
              ),
            );
          else
            resolve({
              id: operationId,
              session_id: "s1",
              method: `turn.${mode}`,
              status: outcome === "accepted" ? "accepted" : "completed",
            });
          await pending;
          const after = {
            text: store.state.composer,
            images: store.state.composerImages.map((item: any) => item.id),
            pending: store.state.inboxPending,
            busy: store.state.transcript.sessionStatus,
            queue: store.state.transcript.queue,
            steer: store.state.transcript.steer,
            blocks: store.state.transcript.blocks.map(
              (block: any) => block.messageId,
            ),
          };
          if (outcome === "unknown" || outcome === "accepted") {
            store.reconcileSubmission({
              id: operationId,
              session_id: "s1",
              method: `turn.${mode}`,
              status: "completed",
            });
          }
          const reconciled = {
            text: store.state.composer,
            pending: store.state.inboxPending,
          };
          store.stop();
          return { calls, during, after, reconciled };
        },
        { mode, outcome, image, parts, snapshot: nativeSnapshot },
      );
      expect(
        result.calls.filter((call) => call.method === `turn.${mode}`),
      ).toHaveLength(1);
      expect(result.calls[0]).toEqual({
        method: `turn.${mode}`,
        session: "s1",
        params: {
          operation_id: expect.any(String),
          input: {
            variables: expectedPluginVariables(),
            parts: [
              parts[0],
              {
                type: "image",
                source: { type: "attachment", attachment_id: "attachment-1" },
              },
            ],
          },
        },
      });
      expect(
        result.calls.filter((call) => call.method === "turn.submit"),
      ).toHaveLength(0);
      expect(result.during).toMatchObject({
        text: parts[0].text,
        images: 1,
        pending: true,
        busy: "busy",
      });
      expect(result.after.busy).toBe("busy");
      expect(result.after.blocks).toEqual(result.during.blocks);
      expect(result.after.queue).toEqual([]);
      expect(result.after.steer).toEqual([]);
      if (outcome === "completed" || outcome === "observed")
        expect(result.after).toMatchObject({
          text: "",
          images: [],
          pending: false,
        });
      if (outcome === "rejected")
        expect(result.after).toMatchObject({
          text: parts[0].text,
          images: [image.id],
          pending: false,
        });
      if (outcome === "draft")
        expect(result.after).toMatchObject({
          text: "New draft",
          images: [image.id],
          pending: false,
        });
      if (outcome === "images")
        expect(result.after).toMatchObject({
          text: parts[0].text,
          images: [],
          pending: false,
        });
      if (outcome === "intake")
        expect(result.after).toMatchObject({
          text: parts[0].text,
          images: [image.id],
          pending: false,
        });
      if (outcome === "route")
        expect(result.after).toMatchObject({
          text: "Other route",
          pending: false,
        });
      if (outcome === "unknown" || outcome === "accepted") {
        expect(result.after).toMatchObject({
          text: parts[0].text,
          images: [image.id],
          pending: true,
        });
        expect(result.reconciled).toEqual({ text: "", pending: false });
      }
      expect(
        result.calls.filter((call) => call.method === "turn.get"),
      ).toHaveLength(outcome === "unknown" || outcome === "observed" ? 1 : 0);
    });
  }
}

test("inbox snapshot reconciliation owns queue display without modifying streamed blocks", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(
    async ({ snapshot, parts }) => {
      const { applySnapshot, createTranscript } =
        await import("/src/client/projector.ts");
      const first = {
        ...snapshot,
        session: { ...snapshot.session, status: "running" },
        inbox: {
          items: [
            { id: 7, mode: "queue", input: { parts } },
            {
              id: 8,
              mode: "steer",
              input: { parts: [{ type: "text", text: "Steer" }] },
            },
          ],
          paused: true,
          active: true,
        },
      };
      const transcript = applySnapshot(first as any, createTranscript());
      const before = {
        queue: transcript.queue,
        steer: transcript.steer,
        paused: transcript.inboxPaused,
        blocks: transcript.blocks.map((block: any) => block.messageId),
      };
      const reconciled = applySnapshot(
        {
          ...first,
          inbox: { items: [], paused: false, active: true },
        } as any,
        transcript,
      );
      return {
        before,
        after: {
          queue: reconciled.queue,
          steer: reconciled.steer,
          paused: reconciled.inboxPaused,
          active: reconciled.inboxActive,
          blocks: reconciled.blocks.map((block: any) => block.messageId),
          busy: reconciled.sessionStatus,
        },
      };
    },
    { snapshot: nativeSnapshot, parts },
  );
  expect(result.before.queue[0]).toMatchObject({
    id: "7",
    parts,
    prompt: parts[0].text,
  });
  expect(result.before.steer[0]).toMatchObject({ id: "8", prompt: "Steer" });
  expect(result.before.paused).toBe(true);
  expect(result.after).toMatchObject({
    queue: [],
    steer: [],
    paused: false,
    active: true,
    busy: "busy",
  });
  expect(result.after.blocks).toEqual(result.before.blocks);
});

test("inbox admission enforces auth, Host, child, pending, image and wire-size limits", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(
    async ({ snapshot, image }) => {
      const { AppStore } = await import("/src/state/store.ts");
      const store: any = new AppStore();
      const calls: any[] = [];
      const failures: string[] = [];
      const base = () => {
        store.update({
          sessionId: "s1",
          connection: "ws",
          authSession: { authenticated: true },
          capabilities: {
            methods: ["turn.queue", "turn.steer", "turn.get"],
            features: { image_data: true },
            limits: { command_bytes: 256 * 1024 },
          },
          hostConnection: {
            projectId: "project-1",
            state: "ready",
            catalogReady: true,
          },
          inboxPending: false,
          retryPending: false,
          historyMutationPending: false,
          imageIntakePending: false,
          compactInflight: false,
          modeSelectionPending: false,
          modelSelectionPending: false,
          isCreatingSession: false,
        });
        store.snapshot(snapshot);
        store.update({ composer: "Guarded input", composerImages: [image] });
      };
      store.api.request = async (
        method: string,
        params: any,
        session: string,
      ) => {
        calls.push({ method, params, session });
        return {
          id: params.operation_id,
          session_id: session,
          method,
          status: "completed",
        };
      };
      for (const guard of [
        "auth",
        "socket",
        "host",
        "child",
        "archived",
        "capability",
        "history",
        "retry",
        "intake",
        "inbox",
        "compact",
        "budget",
        "image-capability",
        "missing-session",
      ]) {
        base();
        if (guard === "auth")
          store.update({ authSession: { authenticated: false } });
        if (guard === "socket") store.update({ connection: "http" });
        if (guard === "host")
          store.update({
            hostConnection: {
              projectId: "project-1",
              state: "detached",
              catalogReady: false,
            },
          });
        if (guard === "child")
          store.update({
            sessions: [{ ...store.state.sessions[0], parentID: "parent" }],
          });
        if (guard === "archived")
          store.update({
            sessions: [{ ...store.state.sessions[0], archived: true }],
          });
        if (guard === "capability")
          store.update({
            capabilities: { methods: [], features: {}, limits: {} },
          });
        if (guard === "budget")
          store.update({
            capabilities: {
              methods: ["turn.queue"],
              features: { image_data: true },
              limits: { command_bytes: 64 },
            },
          });
        if (guard === "image-capability")
          store.update({
            capabilities: {
              methods: ["turn.queue"],
              features: { image_data: false },
              limits: {},
            },
          });
        if (guard === "history") store.update({ historyMutationPending: true });
        if (guard === "retry") store.update({ retryPending: true });
        if (guard === "intake") store.update({ imageIntakePending: true });
        if (guard === "inbox") store.update({ inboxPending: true });
        if (guard === "compact") store.update({ compactInflight: true });
        if (guard === "missing-session") store.update({ sessionId: null });
        await store.dispatch({ type: "QueueInput" });
        if (
          store.state.composer !== "Guarded input" ||
          store.state.composerImages.length !== 1
        )
          failures.push(guard);
      }
      const blockedCalls = calls.length;
      base();
      store.update({ composer: "" });
      await store.dispatch({ type: "SteerInput" });
      const after = {
        text: store.state.composer,
        images: store.state.composerImages.length,
      };
      store.stop();
      return { calls, blockedCalls, failures, after };
    },
    { snapshot: nativeSnapshot, image },
  );
  expect(result.blockedCalls).toBe(0);
  expect(result.failures).toEqual([]);
  expect(result.calls).toEqual([
    {
      method: "turn.steer",
      session: "s1",
      params: {
        operation_id: expect.any(String),
        input: {
          variables: expectedPluginVariables(),
          parts: [
            {
              type: "image",
              source: { type: "attachment", attachment_id: "attachment-1" },
            },
          ],
        },
      },
    },
  ]);
  expect(result.after).toEqual({ text: "", images: 0 });
});

for (const mode of ["queue", "steer"] as const) {
  test(`busy composer keyboard ${mode} admits image-only input with exact source bytes`, async ({
    page,
  }) => {
    const bytes = Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ9kAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const backend = await nativeBackend(page, {
      extraMethods: ["turn.queue", "turn.steer"],
      inboxTurn: (command) => {
        backend.snapshot().inbox = {
          items: [{ id: 42, mode, input: command.params.input }],
          paused: false,
          active: true,
        };
        backend.publish(backend.snapshot());
        return {
          id: command.params.operation_id,
          session_id: "s1",
          method: command.method,
          status: "completed",
          result: { admitted: true },
        };
      },
    });
    backend.snapshot().session.status = "running";
    backend.snapshot().inbox = { items: [], paused: false, active: true };
    // The default native fixture deliberately advertises no inline-image support.
    // Enable the real capability for these multipart keyboard admissions.
    await page.route("**/api/v1/capabilities", (route) =>
      route.fulfill({
        json: {
          protocol: 1,
          methods: [
            "server.capabilities",
            "identity.current",
            "project.list",
            "model.list",
            "agent.catalog",
            "session.list",
            "session.open",
            "turn.queue",
            "turn.steer",
            "turn.get",
            "session.interrupt",
          ],
          features: { image_data: true },
          limits: { command_bytes: 256 * 1024 },
        },
      }),
    );
    await page.goto("/#session/s1");
    await connectHostUI(page);
    const composer = page.getByTestId("composer").locator("textarea");
    await expect(composer).toBeEnabled();
    await composer.evaluate((element, bytes) => {
      const data = new DataTransfer();
      data.items.add(
        new File([new Uint8Array(bytes)], "pixel.png", { type: "image/png" }),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, bytes);
    await expect(
      page.getByTestId("composer-images").locator("img"),
    ).toHaveCount(1);
    await expect(composer).toHaveValue("");
    await expect(page.getByTestId("queue-input")).toBeVisible();
    await expect(page.getByTestId("queue-input")).toBeEnabled();
    await expect(page.getByTestId("steer-input")).toBeVisible();
    await expect(page.getByTestId("steer-input")).toBeEnabled();
    if (mode === "queue") await composer.press("Enter");
    else await page.getByTestId("steer-input").click();
    await expect
      .poll(
        () =>
          backend.commands.filter(
            (command) => command.method === `turn.${mode}`,
          ).length,
      )
      .toBe(1);
    const request = backend.commands.find(
      (command) => command.method === `turn.${mode}`,
    );
    expect(request.params).toEqual({
      operation_id: expect.any(String),
      input: {
        variables: expectedPluginVariables(true),
        parts: [
          {
            type: "image",
            source: { type: "attachment", attachment_id: expect.any(String) },
          },
        ],
      },
    });
    expect(
      backend.commands.filter(
        (command) =>
          command.method === "turn.submit" ||
          command.method === `turn.${mode === "queue" ? "steer" : "queue"}`,
      ),
    ).toHaveLength(0);
    await expect(page.getByTestId("composer-images")).toHaveCount(0);
    await expect(page.getByTestId("queue-dock")).toBeVisible();
    expect(backend.snapshot().messages).toEqual(nativeSnapshot.messages);
    await expect(
      page.getByTitle("请求中断，等待实际终态", { exact: true }),
    ).toBeEnabled();
  });
}

test("autonomous turn.inbox failure keeps its durable chronology and retry readiness while admission failures stay out of the transcript", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async (snapshot) => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    store.update({ sessionId: "s1" });
    const receipt = (
      id: string,
      method: string,
      after: string,
      updated: number,
    ) => ({
      id,
      session_id: "s1",
      method,
      status: "failed",
      updated_at_ms: updated,
      result: {
        error: { message: `${method} failure` },
        after_message_id: after,
        position: { epoch: 0, turn: 1, round: 1 },
      },
    });
    const selected = {
      ...snapshot,
      session: {
        ...snapshot.session,
        retry_ready: true,
        retry_operation_id: "autonomous-failure",
      },
      inbox: { items: [], paused: true, active: false },
      messages: [
        ...snapshot.messages,
        {
          id: "later-user",
          role: "user",
          text: "A later canonical input",
          parts: [],
          tool_calls: [],
        },
        {
          id: "later-answer",
          role: "assistant",
          text: "A later answer",
          parts: [],
          tool_calls: [],
        },
      ],
      operations: [
        receipt("queue-rejected", "turn.queue", "m2", 1),
        receipt("autonomous-failure", "turn.inbox", "m2", 2),
        receipt("steer-rejected", "turn.steer", "later-answer", 3),
      ],
    };
    store.snapshot(selected);
    const project = () => ({
      blocks: store.state.transcript.blocks.map((block: any) => ({
        message: block.messageId,
        operation: block.operationId,
        stream: block.stream,
        text: block.payload.text,
      })),
      retry: store.state.retryOperationId,
      paused: store.state.transcript.inboxPaused,
    });
    const before = project();
    store.snapshot({
      ...selected,
      session: {
        ...selected.session,
        revision: 2,
        retry_ready: false,
        retry_operation_id: undefined,
      },
      operations: [...selected.operations].reverse(),
    });
    const after = project();
    store.stop();
    return { before, after };
  }, nativeSnapshot);
  const errors = result.before.blocks.filter(
    (block) => block.stream === "error",
  );
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    operation: "autonomous-failure",
    text: expect.stringContaining("turn.inbox failure"),
  });
  const order = result.before.blocks.map((block) => block.message);
  expect(order.indexOf("m2")).toBeLessThan(
    order.indexOf("error-autonomous-failure"),
  );
  expect(order.indexOf("error-autonomous-failure")).toBeLessThan(
    order.indexOf("later-user"),
  );
  expect(result.before).toMatchObject({
    retry: "autonomous-failure",
    paused: true,
  });
  expect(result.after.retry).toBeNull();
  expect(result.after.blocks).toEqual(result.before.blocks);
});
