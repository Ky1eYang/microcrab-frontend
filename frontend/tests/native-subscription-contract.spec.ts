import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// The native route::socket tests compare actual ServerFrame serde output with
// this same fixture. Do not replace it with native-fixture.ts: that independent
// mock previously hid the Rust string / browser object mismatch for resume.
const contract = JSON.parse(
  readFileSync(
    new URL("./fixtures/session-subscription.json", import.meta.url),
    "utf8",
  ),
) as Record<string, Record<string, any>[]>;

for (const variant of [
  "fresh",
  "reset",
  "agent_init_fresh",
  "agent_init_reset",
] as const) {
  const mode = contract[variant][0].resume.mode;
  for (const legacy of [false, true]) {
    test(`native subscription contract ${variant}: ${legacy ? "rejects legacy string resume" : "opens SessionSocket with serialized frames"}`, async ({
      page,
    }) => {
      await page.route("**/native-subscription-contract", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Native subscription contract</title>",
        }),
      );
      const frames = structuredClone(contract[variant]);
      if (legacy) frames[0].resume = mode;
      let connections = 0;
      const commands: string[] = [];
      await page.routeWebSocket(
        /\/api\/v1\/sessions\/s1\/ws(?:\?.*)?$/,
        (socket) => {
          connections++;
          socket.onMessage((raw) => commands.push(String(raw)));
          // Send the shared serde contract as wire JSON, through the production
          // decoder and subscription barrier. No frontend fixture synthesizer.
          for (const frame of frames) socket.send(JSON.stringify(frame));
        },
      );
      await page.goto("/native-subscription-contract");
      const result = await page.evaluate(async () => {
        const { SessionSocket } = await import("/src/client/socket/session.ts");
        const socket = new SessionSocket((path) =>
          new URL(path, location.origin + "/").toString(),
        );
        const events: string[] = [];
        try {
          const subscription = await socket.open(
            "s1",
            { display_watermark: 0 },
            { event: (event) => events.push(event.event) },
          );
          return {
            accepted: true,
            sessionId: socket.sessionId,
            subscription,
            events,
          };
        } catch (error: any) {
          return {
            accepted: false,
            sessionId: socket.sessionId,
            code: error.code,
            message: error.message,
          };
        } finally {
          socket.stop();
        }
      });
      if (legacy) {
        expect(result).toEqual({
          accepted: false,
          sessionId: null,
          code: "invalid_result",
          message:
            "Invalid Session subscription: resume.mode: expected fresh or reset; retry loading the session",
        });
      } else {
        expect(result).toEqual({
          accepted: true,
          sessionId: "s1",
          subscription: {
            subscription_id: "contract-subscription",
            generation: "contract-generation",
            sequence: 1,
            snapshot: {
              session: { id: "s1" },
              operations: [],
              executions: frames[0].meta.executions,
              executions_omitted: false,
              messages: [],
              messages_truncated: undefined,
              next_cursor: undefined,
              history_view: undefined,
            },
            pending: { permissions: null, round_limits: null },
            resume: { mode },
          },
          events: [],
        });
      }
      expect(connections).toBe(1);
      expect(commands).toEqual([]);
    });
  }
}
