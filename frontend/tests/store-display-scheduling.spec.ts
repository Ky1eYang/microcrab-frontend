import { expect, test } from "@playwright/test";
import { nativeBackend, nativeSnapshot } from "./native-fixture";

test("store does not publish conversations for unrelated patches and retires a gapped receive generation once", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async (snapshot) => {
    const { AppStore } = await import("/src/state/store.ts");
    const { applySnapshot } = await import("/src/client/projector.ts");
    const store = new AppStore();
    const internal = store as any;
    store.update({ transcript: applySnapshot(snapshot) });
    let publications = 0;
    const commit = store.conversation.commit.bind(store.conversation);
    store.conversation.commit = (...args: any[]) => {
      publications++;
      return commit(...args);
    };
    store.update({ toast: { text: "notice", kind: "warn", generation: 1 } });
    store.update({ auditRevision: 1 });
    const unrelated = publications;
    const subscription = {
      subscription_id: "sub",
      generation: "gen",
      sequence: 0,
      snapshot,
    };
    internal.subscription = subscription;
    let reconnects = 0;
    internal.sessionSocket = {
      reconnect: () => {
        reconnects++;
      },
    };
    const event = (sequence: number, name: string, data: unknown) => ({
      v: 1,
      type: "event",
      subscription_id: "sub",
      generation: "gen",
      sequence,
      session_id: snapshot.session.id,
      event: name,
      data,
    });
    // First complete page is accepted, then one gap must retire all remaining
    // old-generation work without falsely receiving the second page.
    internal.receive(
      event(1, "display.batch", {
        after: 0,
        scanned_through: 0,
        high_water: 0,
        next_cursor: null,
        history_lineage: store.state.transcript.historyView?.lineage,
        records: [],
        coverage: "available",
      }),
    );
    internal.receive(event(3, "audit.available", {}));
    internal.receive(event(4, "audit.available", {}));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const oldSequence = subscription.sequence;
    const remaining = internal.receiveQueue.length;
    // Old socket callbacks are also fenced until a NEW subscription commits.
    internal.receive(event(5, "audit.available", {}));
    const afterOldCallback = reconnects;
    internal.subscription = {
      ...subscription,
      generation: "next",
      sequence: 0,
    };
    internal.receive({
      ...event(1, "audit.available", {}),
      generation: "next",
    });
    return {
      unrelated,
      reconnects,
      afterOldCallback,
      oldSequence,
      remaining,
      auditRevision: store.state.auditRevision,
    };
  }, nativeSnapshot);
  expect(result).toMatchObject({
    unrelated: 0,
    reconnects: 1,
    afterOldCallback: 1,
    oldSequence: 1,
    remaining: 0,
    auditRevision: 2,
  });
});

test("reconnect diagnostic streak preserves first cause, suppresses repetition and reports recovery", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { TransportDiagnosticStreak } =
      await import("/src/client/transport-diagnostics.ts");
    const warnings: unknown[] = [],
      recoveries: unknown[] = [];
    const warn = console.warn,
      info = console.info;
    console.warn = (...args) => {
      warnings.push(args);
    };
    console.info = (...args) => {
      recoveries.push(args);
    };
    try {
      const streak = new TransportDiagnosticStreak("test_socket");
      for (let attempt = 0; attempt < 5; attempt++)
        streak.failure("close", {
          code: "disconnected",
          message:
            attempt === 0 ? "First socket failure" : "Later socket failure",
          details: {
            close_code: 1006,
            phase: "established",
            attempt,
            capability: "never-log",
          },
        });
      streak.recovered();
      return { warnings, recoveries };
    } finally {
      console.warn = warn;
      console.info = info;
    }
  });
  expect(result.warnings).toHaveLength(1);
  expect(result.recoveries).toHaveLength(1);
  expect(JSON.stringify(result.recoveries)).toContain('"suppressed_count":4');
  expect(JSON.stringify(result.recoveries)).toContain("First socket failure");
  expect(JSON.stringify(result)).not.toContain("Later socket failure");
  expect(JSON.stringify(result)).not.toContain("never-log");
});
