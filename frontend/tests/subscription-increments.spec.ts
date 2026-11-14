import { expect, test, type WebSocketRoute } from "@playwright/test";
import { attachEvents, nativeSnapshot, sendSubscribed } from "./native-fixture";

test("Session socket waits for the complete ordered initialization before publishing a subscription", async ({
  page,
}) => {
  await page.route("**/subscription-barrier-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Subscription barrier</title>",
    }),
  );
  let socket: WebSocketRoute | undefined;
  const view = structuredClone(nativeSnapshot);
  view.state = {};
  view.executions = [];
  view.executions_omitted = false;
  view.usage = { samples: 0 };
  view.statistics = { context: { bytes: 0 } } as any;
  await page.routeWebSocket(
    /\/api\/v1\/sessions\/s1\/ws(?:\?.*)?$/,
    (route) => {
      socket = route;
      sendSubscribed(route, view, "atomic", "generation", { initial: false });
    },
  );
  await page.goto("/subscription-barrier-fixture");
  await page.evaluate(async () => {
    const { SessionSocket } = await import("/src/client/socket/session.ts");
    const transport = new SessionSocket((path) =>
      new URL(path.replace(/^\//, ""), location.origin + "/").toString(),
    );
    const probe = ((window as any).barrier = {
      committed: false,
      events: [] as string[],
      subscription: null as any,
      transport,
    });
    void transport
      .open(
        "s1",
        { display_watermark: 0 },
        { event: (event) => probe.events.push(event.event) },
      )
      .then((subscription) => {
        probe.subscription = subscription;
        probe.committed = true;
      });
  });
  await expect.poll(() => !!socket).toBe(true);
  expect(await page.evaluate(() => (window as any).barrier.committed)).toBe(
    false,
  );
  const initial = attachEvents(view);
  const send = (index: number) => {
    const [event, data] = initial[index];
    socket!.send(
      JSON.stringify({
        v: 1,
        type: "event",
        subscription_id: "atomic",
        generation: "generation",
        sequence: index + 1,
        session_id: "s1",
        event,
        data,
      }),
    );
  };
  send(0);
  send(1);
  // A task round trip observes that a valid prefix cannot expose a partial view.
  expect(await page.evaluate(() => (window as any).barrier.committed)).toBe(
    false,
  );
  const blocked = await page.evaluate(async () => {
    try {
      await (window as any).barrier.transport.command(
        "turn.queue",
        {},
        100,
        "premature",
        true,
      );
      return "sent";
    } catch (error: any) {
      return error.code;
    }
  });
  expect(blocked).toBe("disconnected");
  send(2);
  await expect
    .poll(() => page.evaluate(() => (window as any).barrier.committed))
    .toBe(true);
  const result = await page.evaluate(() => {
    const probe = (window as any).barrier;
    probe.transport.stop();
    return {
      snapshot: probe.subscription.snapshot,
      sequence: probe.subscription.sequence,
      events: probe.events,
    };
  });
  expect(result.snapshot).toMatchObject({
    messages: view.messages,
    state: view.state,
    usage: view.usage,
    statistics: view.statistics,
  });
  expect(result.sequence).toBe(3);
  expect(result.events).toEqual([]);
});
