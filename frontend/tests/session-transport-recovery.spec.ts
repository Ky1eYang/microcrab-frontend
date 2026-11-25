import { readFileSync } from "node:fs";
import { expect, test, type WebSocketRoute } from "@playwright/test";

const frames: Record<string, unknown>[] = JSON.parse(
  readFileSync(
    new URL("./fixtures/session-subscription.json", import.meta.url),
    "utf8",
  ),
).fresh;

for (const finalFailure of ["busy", "forbidden"] as const) {
  test(`Session recovery deduplicates ${finalFailure} attempts and never resends commands`, async ({
    page,
  }) => {
    const sockets: WebSocketRoute[] = [];
    const commands: Record<string, any>[] = [];
    const diagnostics: Record<string, any>[] = [];
    page.on("console", async (message) => {
      if (
        message.args().length !== 2 ||
        (await message.args()[0].jsonValue()) !== "[microcrab diagnostic]"
      )
        return;
      diagnostics.push(await message.args()[1].jsonValue());
    });
    await page.route("**/transport-recovery-fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Session recovery</title>",
      }),
    );
    await page.routeWebSocket(/\/api\/v1\/sessions\/s1\/ws\?/, (socket) => {
      sockets.push(socket);
      socket.onMessage((raw) => commands.push(JSON.parse(String(raw))));
      if (sockets.length === 1)
        for (const frame of frames) socket.send(JSON.stringify(frame));
    });
    await page.clock.install();
    await page.goto("/transport-recovery-fixture");
    await page.evaluate(async () => {
      const { SessionSocket } = await import("/src/client/socket/session.ts");
      Math.random = () => 0;
      const socket = new SessionSocket(
        (path) => new URL(path, location.origin + "/").href,
        () => ({ history_lineage: "lineage", display_watermark: 8 }),
        () => ({ applied: 1, watermark: 8 }),
      );
      const tracked = {
        socket,
        statuses: [] as (string | null)[],
        receipts: [] as unknown[],
      };
      Object.assign(window, { tracked });
      await socket.open(
        "s1",
        { display_watermark: 0 },
        {
          event: () => {}, // The received frame below is deliberately not applied.
          recovery: (status) => tracked.statuses.push(status),
        },
      );
      const send = (request: string) =>
        socket
          .command(
            "turn.queue",
            { operation_id: "original-intent" },
            30000,
            request,
            true,
          )
          .catch((error) =>
            tracked.receipts.push({
              code: error.code,
              unknown: error.outcomeUnknown,
            }),
          );
      void send("original-attempt");
      Object.assign(tracked, { send });
    });
    await expect.poll(() => commands.length).toBe(1);
    const [snapshot] = frames;
    sockets[0].send(
      JSON.stringify({
        v: 1,
        type: "event",
        event: "session",
        sequence: 2,
        session_id: "s1",
        subscription_id: snapshot.subscription_id,
        generation: snapshot.generation,
        data: {},
      }),
    );
    sockets[0].close({
      code: 4001,
      reason: "PEER TEXT MUST NOT ENTER DIAGNOSTICS",
    });
    const state = () =>
      page.evaluate(() => {
        const { statuses, receipts } = (window as any).tracked;
        return { statuses, receipts };
      });
    await expect
      .poll(async () => (await state()).statuses)
      .toEqual(["recovering"]);
    await page.evaluate(() => (window as any).tracked.send("not-dispatched"));
    expect((await state()).receipts).toEqual([
      { code: "disconnected", unknown: true },
      { code: "disconnected", unknown: false },
    ]);
    await page.clock.runFor(500);
    await expect.poll(() => sockets.length).toBe(2);
    expect(Object.fromEntries(new URL(sockets[1].url()).searchParams)).toEqual({
      display_watermark: "8",
      history_lineage: "lineage",
    });
    await page.evaluate(() => {
      const { socket } = (window as any).tracked;
      socket.reconnect();
      const a = socket.refresh();
      const b = socket.refresh();
      if (a !== b) throw Error("refreshes did not coalesce");
      void a.catch(() => {});
    });
    expect(sockets).toHaveLength(2);
    const count = finalFailure === "busy" ? 6 : 1;
    for (let attempt = 1; attempt <= count; attempt++) {
      sockets[attempt].send(
        JSON.stringify({
          v: 1,
          type: "error",
          error: { code: finalFailure, message: "Not now" },
        }),
      );
      await expect
        .poll(() =>
          diagnostics.some(
            ({ code, details }) =>
              code === finalFailure && details.attempt === 1,
          ),
        )
        .toBe(true);
      if (attempt === count) break;
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as any).tracked.socket.retry !== undefined,
          ),
        )
        .toBe(true);
      const delay = Math.min(1000 * 2 ** attempt, 10000) / 2;
      await page.clock.runFor(delay);
      await expect.poll(() => sockets.length).toBe(attempt + 2);
    }
    await expect
      .poll(async () => (await state()).statuses)
      .toEqual([
        "recovering",
        finalFailure === "busy" ? "failed" : "forbidden",
      ]);
    await page.clock.runFor(60_000);
    expect(sockets).toHaveLength(count + 1);
    expect(
      commands.map(({ request_id, params }) => [
        request_id,
        params.operation_id,
      ]),
    ).toEqual([["original-attempt", "original-intent"]]);
    const close = diagnostics.find(
      ({ details }) => details?.close_code === 4001,
    );
    expect(close?.details).toMatchObject({
      phase: "subscribed",
      cause: "no_local_close_request",
      received_sequence: 2,
      applied_sequence: 1,
      display_watermark: 8,
      attempt: 0,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("PEER TEXT");
    if (finalFailure === "busy") {
      await page.evaluate(() => {
        void (window as any).tracked.socket.refresh();
      });
      await expect.poll(() => sockets.length).toBe(count + 2);
      for (const frame of frames) sockets.at(-1)!.send(JSON.stringify(frame));
      await expect.poll(async () => (await state()).statuses.at(-1)).toBeNull();
      await page.evaluate(() =>
        (window as any).tracked.socket.stop("selection_replaced"),
      );
      await expect
        .poll(() =>
          diagnostics.some(
            ({ details }) =>
              details?.cause === "selection_replaced" &&
              details.phase === "subscribed",
          ),
        )
        .toBe(true);
      expect(commands).toHaveLength(1);
    }
  });
}
