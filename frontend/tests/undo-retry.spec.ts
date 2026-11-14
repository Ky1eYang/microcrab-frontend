import { expect, test } from "@playwright/test";
import type { NativeSnapshot } from "../src/client/types";
import { nativeBackend, nativeSnapshot } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

const originalText = "  Exact original input\n\nwith trailing space  ";
const imageData = Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  ),
);
const parts: NonNullable<NativeSnapshot["restored_input"]>["parts"] = [
  { type: "text", text: originalText },
  {
    type: "image",
    source: { type: "data", media_type: "image/png", data: imageData },
  },
];
const selected: NativeSnapshot = {
  ...nativeSnapshot,
  history: { checkpoint_id: "head-before-undo" },
  history_available: { undo: true, redo: false },
  messages: [
    {
      id: "older-user",
      role: "user",
      text: "Older selected input",
      parts: [],
      tool_calls: [],
    },
    {
      id: "older-answer",
      role: "assistant",
      text: "Older answer",
      parts: [],
      tool_calls: [],
    },
    {
      id: "latest-user",
      role: "user",
      text: "Latest input",
      parts: [],
      tool_calls: [],
    },
    {
      id: "latest-answer",
      role: "assistant",
      text: "Latest answer",
      parts: [],
      tool_calls: [],
    },
  ],
};
const restored: NativeSnapshot = {
  ...selected,
  session: { ...selected.session, revision: 2 },
  messages: [],
  history: { checkpoint_id: "head-after-undo" },
  history_available: { undo: false, redo: true },
  restored_input: { message_id: "older-user", parts },
};

test("clicked older user action undoes that exact message and restores authoritative text and inline image", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  Object.assign(backend.snapshot(), structuredClone(selected));
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: unknown[] = [];
  await page.route("**/api/v1/sessions/s1/history/travel", async (route) => {
    requests.push(route.request().postDataJSON());
    await hold;
    Object.assign(backend.snapshot(), structuredClone(restored));
    await route.fulfill({ json: restored });
  });
  await page.goto("/#session/s1");
  await connectHostUI(page);
  const composer = page.getByTestId("composer").locator("textarea");
  await expect(composer).toBeEnabled();
  await composer.fill("Unsent draft");
  const older = page.locator(
    '[data-testid="undo-user-block"][data-message-id="older-user"]',
  );
  await page
    .locator(".message-turn-container.user-turn")
    .filter({ has: older })
    .hover();
  await older.click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({
    direction: "undo",
    message_id: "older-user",
    expected_checkpoint_id: "head-before-undo",
  });
  await expect(older).toBeDisabled();
  await expect(page.getByTitle("发送 (Enter)", { exact: true })).toBeDisabled();
  await expect(composer).toHaveValue("Unsent draft");
  await expect(page.getByTestId("composer-images")).toHaveCount(0);
  release();
  await expect(composer).toHaveValue(originalText);
  const image = page.getByTestId("composer-images").locator("img");
  await expect(image).toHaveAttribute(
    "src",
    `data:image/png;base64,${Buffer.from(imageData).toString("base64")}`,
  );
  await expect(page.getByTestId("undo-user-block")).toHaveCount(0);
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(0);
});

for (const outcome of [
  "success",
  "failure",
  "route",
  "draft",
  "images",
  "intake",
  "missing-input",
] as const) {
  test(`undo restoration respects ${outcome} while travel is pending`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(
      async ({ selected, restored, outcome }) => {
        const { AppStore } = await import("/src/state/store.ts");
        const store: any = new AppStore();
        store.update({
          sessionId: "s1",
          connection: "ws",
          authSession: { authenticated: true },
          capabilities: { methods: ["history.travel"] },
        });
        store.subscription = { snapshot: selected };
        store.snapshot(selected);
        const draftImage = {
          id: "unsent-image",
          name: "draft.png",
          mediaType: "image/png",
          data: [1, 2],
          previewUrl: "data:image/png;base64,AQI=",
        };
        store.update({
          composer: "Unsent draft",
          composerImages: [draftImage],
        });
        let resolve!: (snapshot: unknown) => void;
        let reject!: (error: Error) => void;
        const calls: unknown[] = [];
        store.api.request = (
          method: string,
          params: unknown,
          session: string,
        ) => {
          calls.push({ method, params, session });
          return new Promise((yes, no) => {
            resolve = yes;
            reject = no;
          });
        };
        const pending = store.dispatch({
          type: "RevertTurn",
          value: "older-user",
        });
        const during = {
          text: store.state.composer,
          images: store.state.composerImages.map((image: any) => image.id),
          pending: store.state.historyMutationPending,
        };
        // A second action during the original request must not mutate history again.
        await store.dispatch({ type: "RevertTurn", value: "latest-user" });
        if (outcome === "route") {
          store.composerRoute++;
          store.update({
            sessionId: "s2",
            composer: "Other route draft",
            historyMutationPending: false,
          });
        }
        if (outcome === "draft")
          await store.dispatch({
            type: "SetComposer",
            value: "Edited while waiting",
          });
        if (outcome === "images")
          await store.dispatch({
            type: "RemoveComposerImage",
            value: "unsent-image",
          });
        if (outcome === "intake") store.update({ imageIntakePending: true });
        if (outcome === "failure") reject(new Error("Travel rejected"));
        else
          resolve(
            outcome === "missing-input"
              ? { ...restored, restored_input: undefined }
              : restored,
          );
        await pending;
        const after = {
          text: store.state.composer,
          images: store.state.composerImages.map((image: any) => ({
            mediaType: image.mediaType,
            data: image.data,
            previewUrl: image.previewUrl,
          })),
          messageIds: store.state.transcript.blocks.map(
            (block: any) => block.messageId,
          ),
          session: store.state.sessionId,
          pending: store.state.historyMutationPending,
        };
        store.stop();
        return { calls, during, after };
      },
      { selected, restored, outcome },
    );
    expect(result.calls).toEqual([
      {
        method: "history.travel",
        params: {
          direction: "undo",
          message_id: "older-user",
          expected_checkpoint_id: "head-before-undo",
        },
        session: "s1",
      },
    ]);
    expect(result.during).toEqual({
      text: "Unsent draft",
      images: ["unsent-image"],
      pending: true,
    });
    expect(result.after.pending).toBe(false);
    if (outcome === "success") {
      expect(result.after.text).toBe(originalText);
      expect(result.after.images).toEqual([
        {
          mediaType: "image/png",
          data: imageData,
          previewUrl: `data:image/png;base64,${Buffer.from(imageData).toString("base64")}`,
        },
      ]);
      expect(result.after.messageIds).toEqual([]);
    } else {
      expect(result.after.text).toBe(
        outcome === "route"
          ? "Other route draft"
          : outcome === "draft"
            ? "Edited while waiting"
            : "Unsent draft",
      );
      expect(result.after.images).toHaveLength(outcome === "images" ? 0 : 1);
      if (outcome === "failure" || outcome === "route")
        expect(result.after.messageIds).toEqual(
          selected.messages.map((message) => message.id),
        );
      if (outcome === "route") expect(result.after.session).toBe("s2");
    }
  });
}

const failedSnapshot: NativeSnapshot = {
  ...selected,
  session: {
    ...selected.session,
    retry_ready: true,
    retry_operation_id: "failed-model",
  },
  messages: selected.messages.slice(0, 1),
  operations: [
    {
      version: 1,
      id: "failed-model",
      session_id: "s1",
      owner: "u1",
      method: "turn.submit",
      payload_hash: "fixture",
      status: "failed",
      revision: 1,
      created_at_ms: 1,
      updated_at_ms: 2,
      result: {
        error: { message: "Provider unavailable" },
        position: { epoch: 0, turn: 1, round: 1 },
        after_message_id: "older-user",
        retry_ready: true,
      },
    },
  ],
};

test("clicked retry sends one continuation without resubmitting input or changing composer", async ({
  page,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend = await nativeBackend(page, {
    extraMethods: ["turn.retry"],
    retryTurn: async (command) => {
      await hold;
      Object.assign(backend.snapshot().session, {
        status: "running",
        retry_ready: false,
        retry_operation_id: null,
      });
      return {
        ...failedSnapshot.operations[0],
        id: command.params.operation_id,
        method: "turn.retry",
        status: "accepted",
        result: null,
      };
    },
  });
  Object.assign(backend.snapshot(), structuredClone(failedSnapshot));
  await page.goto("/#session/s1");
  await connectHostUI(page);
  const composer = page.getByTestId("composer").locator("textarea");
  await expect(composer).toBeEnabled();
  await composer.fill("Keep my unrelated draft");
  const retry = page.getByTestId("retry-model-request");
  await expect(retry).toHaveAttribute("data-operation-id", "failed-model");
  await page
    .locator(".message-turn-container.assistant-turn")
    .filter({ has: retry })
    .hover();
  await retry.click();
  await expect(retry).toBeDisabled();
  await expect(page.getByTitle("发送 (Enter)", { exact: true })).toBeDisabled();
  await expect(page.getByTestId("undo-user-block")).toBeDisabled();
  // Dispatching another DOM click while pending must not emit another command.
  await retry.evaluate((button: HTMLButtonElement) => button.click());
  await expect
    .poll(
      () =>
        backend.commands.filter((command) => command.method === "turn.retry")
          .length,
    )
    .toBe(1);
  const command = backend.commands.find(
    (command) => command.method === "turn.retry",
  );
  expect(command).not.toHaveProperty("session_id");
  expect(command.sessionId).toBe("s1");
  expect(command.params).toEqual({
    failed_operation_id: "failed-model",
    operation_id: expect.any(String),
  });
  expect(command.params.operation_id).not.toBe("failed-model");
  await expect(composer).toHaveValue("Keep my unrelated draft");
  expect(backend.snapshot().messages.map((message) => message.id)).toEqual([
    "older-user",
  ]);
  release();
  await expect(retry).toHaveCount(0);
  await expect(composer).toHaveValue("Keep my unrelated draft");
  expect(
    backend.commands.filter((item) => item.method === "turn.queue"),
  ).toHaveLength(0);
  expect(
    backend.commands.filter((item) => item.method === "turn.retry"),
  ).toHaveLength(1);
});

for (const observation of ["unknown", "accepted", "unavailable"] as const) {
  test(`unknown retry outcome observes ${observation} once without mutation replay`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(
      async ({ snapshot, observation }) => {
        const { AppStore } = await import("/src/state/store.ts");
        const { CommandError } = await import("/src/client/api.ts");
        const store: any = new AppStore();
        store.update({
          sessionId: "s1",
          connection: "ws",
          authSession: { authenticated: true },
          capabilities: { methods: ["turn.retry", "turn.get"] },
        });
        store.subscription = { snapshot };
        store.snapshot(snapshot);
        const image = {
          id: "keep-image",
          name: "keep.png",
          mediaType: "image/png",
          data: [1],
          previewUrl: "data:image/png;base64,AQ==",
        };
        store.update({ composer: "Keep my draft", composerImages: [image] });
        const calls: { method: string; params: any; session: string }[] = [];
        // Retry no longer refreshes a snapshot; a gap resync calls sessionSocket.reconnect(), and this store never opens a socket.
        store.api.request = async (
          method: string,
          params: any,
          session: string,
        ) => {
          calls.push({ method, params, session });
          if (method === "turn.retry")
            throw new CommandError(
              "connection_lost",
              "Retry receipt lost",
              false,
              true,
            );
          if (method === "turn.get") {
            if (observation === "unavailable")
              throw Error("Receipt unavailable");
            return {
              ...snapshot.operations[0],
              id: params.operation_id,
              method: "turn.retry",
              status: observation,
              result: null,
            };
          }
          throw Error(`Unexpected request: ${method}`);
        };
        await store.dispatch({ type: "RetryTurn", value: "failed-model" });
        const after = {
          text: store.state.composer,
          imageIds: store.state.composerImages.map((item: any) => item.id),
          pending: store.state.retryPending,
        };
        // Unknown observation keeps the operation blocked until a canonical receipt.
        if (observation !== "accepted")
          await store.dispatch({ type: "RetryTurn", value: "failed-model" });
        const receiptId = calls[0].params.operation_id;
        store.stop();
        return { calls, after, receiptId };
      },
      { snapshot: failedSnapshot, observation },
    );
    expect(result.calls.map((call) => call.method)).toEqual([
      "turn.retry",
      "turn.get",
    ]);
    expect(result.calls[0].params).toEqual({
      operation_id: result.receiptId,
      failed_operation_id: "failed-model",
    });
    expect(result.calls[1]).toEqual({
      method: "turn.get",
      params: { operation_id: result.receiptId },
      session: "s1",
    });
    expect(result.after).toEqual({
      text: "Keep my draft",
      imageIds: ["keep-image"],
      pending: observation !== "accepted",
    });
  });
}

for (const guard of [
  {
    action: "RevertTurn",
    flag: "imageIntakePending",
    key: "conversation.undoUnavailable",
  },
  {
    action: "RevertTurn",
    flag: "retryPending",
    key: "conversation.undoUnavailable",
  },
  {
    action: "Submit",
    flag: "historyMutationPending",
    key: "composer.mode.unavailable",
  },
  { action: "Submit", flag: "retryPending", key: "composer.mode.unavailable" },
  {
    action: "RetryTurn",
    flag: "historyMutationPending",
    key: "conversation.retryUnavailable",
  },
] as const) {
  test(`${guard.action} rejects admission while ${guard.flag} is pending`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(
      async ({ snapshot, guard }) => {
        const { AppStore } = await import("/src/state/store.ts");
        const { t } = await import("/src/i18n/index.ts");
        const store: any = new AppStore();
        store.update({
          sessionId: "s1",
          connection: "ws",
          authSession: { authenticated: true },
          capabilities: {
            methods: ["history.travel", "turn.queue", "turn.retry"],
          },
        });
        store.subscription = { snapshot };
        store.snapshot(snapshot);
        store.update({ composer: "Keep this input", [guard.flag]: true });
        const calls: string[] = [];
        store.api.request = async (method: string) => {
          calls.push(method);
          throw Error("Unexpected admission");
        };
        await store.dispatch({
          type: guard.action,
          value: guard.action === "RevertTurn" ? "older-user" : "failed-model",
        });
        const after = {
          calls,
          text: store.state.composer,
          toast: store.state.toast?.text,
          expected: t(guard.key),
          ids: store.state.transcript.blocks.map(
            (block: any) => block.messageId,
          ),
        };
        store.stop();
        return after;
      },
      { snapshot: failedSnapshot, guard },
    );
    expect(result.calls).toEqual([]);
    expect(result.text).toBe("Keep this input");
    expect(result.toast).toBe(result.expected);
    expect(result.ids).toEqual(["older-user", "error-failed-model"]);
  });
}

test("generic undo and redo cannot travel while targeted history or retry is pending", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const results = await page.evaluate(async (snapshot) => {
    const { AppStore } = await import("/src/state/store.ts");
    const results = [];
    for (const action of ["HistoryUndo", "HistoryRedo"]) {
      for (const flag of ["historyMutationPending", "retryPending"]) {
        const store: any = new AppStore();
        store.update({
          sessionId: "s1",
          connection: "ws",
          authSession: { authenticated: true },
          capabilities: { methods: ["history.travel"] },
        });
        store.subscription = { snapshot };
        store.snapshot({
          ...snapshot,
          history_available: { undo: true, redo: true },
        });
        store.update({ composer: "Keep pending draft", [flag]: true });
        const calls: string[] = [];
        store.api.request = async (method: string) => {
          calls.push(method);
          return snapshot;
        };
        await store.dispatch({ type: action });
        results.push({
          action,
          flag,
          calls,
          text: store.state.composer,
          checkpoint: store.state.history.checkpoint_id,
          toast: store.state.toast?.text,
          pending: store.state[flag],
        });
        store.stop();
      }
    }
    return results;
  }, selected);
  expect(results).toHaveLength(4);
  for (const result of results) {
    expect(result.calls).toEqual([]);
    expect(result.text).toBe("Keep pending draft");
    expect(result.checkpoint).toBe("head-before-undo");
    expect(result.pending).toBe(true);
    expect(result.toast).toBe("当前历史位置无法执行此操作");
  }
});

for (const timing of ["before-response", "during-publication"] as const) {
  test(`same-route checkpoint change ${timing} prevents obsolete undo restoration`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(
      async ({ selected, restored, timing }) => {
        const { AppStore } = await import("/src/state/store.ts");
        const store: any = new AppStore();
        store.update({
          sessionId: "s1",
          connection: "ws",
          authSession: { authenticated: true },
          capabilities: { methods: ["history.travel"] },
        });
        store.subscription = { snapshot: selected };
        store.snapshot(selected);
        const image = {
          id: "keep-image",
          name: "keep.png",
          mediaType: "image/png",
          data: [1],
          previewUrl: "data:image/png;base64,AQ==",
        };
        store.update({
          composer: "Keep current draft",
          composerImages: [image],
        });
        let resolve!: (value: unknown) => void;
        const calls: unknown[] = [];
        store.api.request = (method: string, params: unknown) => {
          calls.push({ method, params });
          return new Promise((yes) => {
            resolve = yes;
          });
        };
        const pending = store.dispatch({
          type: "RevertTurn",
          value: "older-user",
        });
        const replacement = {
          ...selected,
          session: { ...selected.session, revision: 3 },
          history: { checkpoint_id: "concurrently-selected-head" },
          messages: [
            {
              id: "replacement-user",
              role: "user",
              text: "Current selected history",
              parts: [],
              tool_calls: [],
            },
          ],
        };
        if (timing === "before-response") store.snapshot(replacement);
        else {
          const listener = () => {
            if (store.state.history?.checkpoint_id !== "head-after-undo")
              return;
            store.listeners.delete(listener);
            store.snapshot(replacement);
          };
          store.listeners.add(listener);
        }
        resolve(restored);
        await pending;
        const after = {
          calls,
          session: store.state.sessionId,
          route: store.composerRoute,
          checkpoint: store.state.history?.checkpoint_id,
          text: store.state.composer,
          imageIds: store.state.composerImages.map((image: any) => image.id),
          ids: store.state.transcript.blocks.map(
            (block: any) => block.messageId,
          ),
          pending: store.state.historyMutationPending,
        };
        store.stop();
        return after;
      },
      { selected, restored, timing },
    );
    expect(result.calls).toEqual([
      {
        method: "history.travel",
        params: {
          direction: "undo",
          message_id: "older-user",
          expected_checkpoint_id: "head-before-undo",
        },
      },
    ]);
    expect(result.session).toBe("s1");
    expect(result.route).toBe(0);
    expect(result.checkpoint).toBe("concurrently-selected-head");
    expect(result.text).toBe("Keep current draft");
    expect(result.imageIds).toEqual(["keep-image"]);
    expect(result.ids).toEqual(["replacement-user"]);
    expect(result.pending).toBe(false);
  });
}

for (const response of ["accepted", "lost-receipt"] as const) {
  test(`${response} retry suppresses the current retry action while canonical refresh is pending`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(
      async ({ snapshot, response }) => {
        const { AppStore } = await import("/src/state/store.ts");
        const { CommandError } = await import("/src/client/api.ts");
        const store: any = new AppStore();
        store.update({
          sessionId: "s1",
          connection: "ws",
          authSession: { authenticated: true },
          capabilities: { methods: ["turn.retry", "turn.get"] },
        });
        store.subscription = { snapshot };
        store.snapshot(snapshot);
        store.update({ composer: "Unchanged draft" });
        const calls: string[] = [];
        store.api.request = async (method: string, params: any) => {
          calls.push(method);
          if (method === "turn.retry" && response === "lost-receipt")
            throw new CommandError(
              "connection_lost",
              "Receipt lost",
              false,
              true,
            );
          return {
            ...snapshot.operations[0],
            id: params.operation_id,
            method: "turn.retry",
            status: "accepted",
            result: null,
          };
        };
        const pending = store.dispatch({
          type: "RetryTurn",
          value: "failed-model",
        });
        await pending;
        const during = {
          retryOperationId: store.state.retryOperationId,
          composer: store.state.composer,
        };
        await store.dispatch({ type: "RetryTurn", value: "failed-model" });
        store.stop();
        return { calls, during };
      },
      { snapshot: failedSnapshot, response },
    );
    expect(result.calls).toEqual(
      response === "lost-receipt" ? ["turn.retry", "turn.get"] : ["turn.retry"],
    );
    expect(result.during).toEqual({
      retryOperationId: null,
      composer: "Unchanged draft",
    });
  });
}
