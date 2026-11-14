import { expect, test } from "@playwright/test";
import { nativeBackend, nativeSnapshot } from "./native-fixture";

for (const mode of [
  "event-first",
  "snapshot-first",
  "changed-draft",
  "changed-route",
  "failed-event",
  "accepted-event",
  "unknown",
] as const) {
  test(`submit admission reconciles ${mode} before a lost WS result without replay`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(
      async ({ snapshot, mode }) => {
        const { AppStore } = await import("/src/state/store.ts");
        const { CommandError } = await import("/src/client/api.ts");
        const store: any = new AppStore();
        store.update({
          sessionId: "s1",
          connection: "ws",
          authSession: { authenticated: true },
          capabilities: {
            methods: ["turn.queue", "turn.get"],
            features: {},
            limits: { command_bytes: 262144 },
          },
          hostConnection: {
            projectId: "project-1",
            state: "ready",
            catalogReady: true,
          },
        });
        store.subscription = { snapshot: structuredClone(snapshot) };
        store.snapshot(structuredClone(snapshot));
        store.update({ composer: "exact admission witness" });
        const calls: string[] = [];
        let reject!: (error: Error) => void;
        let sent!: () => void;
        const dispatched = new Promise<void>((yes) => {
          sent = yes;
        });
        let operationId = "";
        store.api.request = (method: string, params: any) => {
          calls.push(method);
          if (method === "turn.get")
            return Promise.resolve({
              id: operationId,
              session_id: "s1",
              method: "turn.queue",
              status: "unknown",
            });
          operationId = params.operation_id;
          sent();
          return new Promise((_yes, no) => {
            reject = no;
          });
        };
        const pending = store.dispatch({ type: "Submit" });
        await dispatched;
        if (mode === "changed-draft")
          store.update({ composer: "new unrelated draft" });
        if (mode === "changed-route") {
          store.composerRoute++;
          store.update({ sessionId: "s2", composer: "other session draft" });
        }
        const receipt = {
          id: operationId,
          session_id: "s1",
          method: "turn.queue",
          status:
            mode === "failed-event"
              ? "failed"
              : mode === "accepted-event"
                ? "accepted"
                : "completed",
          result:
            mode === "failed-event"
              ? { error: { message: "fixture admission rejected" } }
              : { admitted: true },
          revision: 1,
        };
        if (mode === "snapshot-first")
          store.snapshot({
            ...structuredClone(snapshot),
            operations: [receipt],
          });
        else if (mode !== "unknown") store.reconcileSubmission(receipt);
        const afterReceipt = {
          text: store.state.composer,
          pending: store.state.isCreatingSession,
        };
        reject(
          new CommandError("timed_out", "fixture lost result", true, true),
        );
        await pending;
        const final = {
          text: store.state.composer,
          pending: store.state.isCreatingSession,
          toast: store.state.toast,
          tracked: store.unknownSubmissions.size,
        };
        store.stop();
        return { calls, afterReceipt, final };
      },
      { snapshot: nativeSnapshot, mode },
    );
    expect(result.calls).toEqual(
      ["unknown", "accepted-event"].includes(mode)
        ? ["turn.queue", "turn.get"]
        : ["turn.queue"],
    );
    expect(result.final.text).toBe(
      mode === "changed-draft"
        ? "new unrelated draft"
        : mode === "changed-route"
          ? "other session draft"
          : ["unknown", "accepted-event", "failed-event"].includes(mode)
            ? "exact admission witness"
            : "",
    );
    expect(result.final.tracked).toBe(
      ["unknown", "accepted-event"].includes(mode) ? 1 : 0,
    );
    if (!["unknown", "accepted-event"].includes(mode))
      expect(JSON.stringify(result.final.toast)).not.toContain(
        "发送接纳结果未知",
      );
    if (["event-first", "snapshot-first"].includes(mode))
      expect(result.final.pending).toBe(false);
    if (["unknown", "accepted-event"].includes(mode))
      expect(result.final.pending).toBe(true);
    if (mode === "failed-event") {
      expect(result.final.pending).toBe(false);
      expect(result.final.toast.text).toContain("fixture admission rejected");
    }
  });
}

test("a known submit receipt cannot become unknown because later snapshot observation fails", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async (snapshot) => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    store.update({
      sessionId: "s1",
      connection: "ws",
      authSession: { authenticated: true },
      capabilities: {
        methods: ["turn.queue", "turn.get"],
        features: {},
        limits: {},
      },
      hostConnection: {
        projectId: "project-1",
        state: "ready",
        catalogReady: true,
      },
    });
    store.subscription = { snapshot: structuredClone(snapshot) };
    store.snapshot(structuredClone(snapshot));
    store.update({ composer: "admitted once" });
    const calls: string[] = [];
    store.api.request = async (method: string, params: any) => {
      calls.push(method);
      return {
        id: params.operation_id,
        session_id: "s1",
        method: "turn.queue",
        status: "completed",
        result: { admitted: true },
        revision: 1,
      };
    };
    await store.dispatch({ type: "Submit" });
    const final = {
      calls,
      text: store.state.composer,
      tracked: store.unknownSubmissions.size,
      pending: store.state.isCreatingSession,
      toast: store.state.toast,
    };
    store.stop();
    return final;
  }, nativeSnapshot);
  expect(result.calls).toEqual(["turn.queue"]);
  expect(result.text).toBe("");
  expect(result.tracked).toBe(0);
  expect(result.pending).toBe(false);
  expect(JSON.stringify(result.toast)).not.toContain("发送接纳结果未知");
});
