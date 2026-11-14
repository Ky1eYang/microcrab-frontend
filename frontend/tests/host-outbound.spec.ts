import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { outboundSignalUrl } from "../src/client/host-outbound";

test("only a plain trusted loopback bridge locator enables outbound signaling", () => {
  expect(outboundSignalUrl("ws://127.0.0.1:8788/host")).toBe(
    "ws://127.0.0.1:8788/host/signal",
  );
  expect(outboundSignalUrl("wss://localhost:8788/host")).toBe(
    "wss://localhost:8788/host/signal",
  );
  for (const locator of [
    "ws://public.example/host",
    "ws://127.0.0.1/host?token=x",
    "ws://user:secret@localhost/host",
    "http://localhost/host",
    "ws://localhost/other",
  ])
    expect(outboundSignalUrl(locator)).toBeNull();
});

for (const result of [
  "connected",
  "pre_auth",
  "auth_unknown",
  "lost_finish",
] as const) {
  test(`outbound Host ${result} preserves phase-based fallback and route ownership`, async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    await page.route("**/api/v1/capabilities", (route) =>
      route.fulfill({
        json: {
          methods: ["project.host_outbound_start"],
          limits: {},
        },
      }),
    );
    const lifecycle: string[] = [];
    await page.route(
      "**/api/v1/projects/project-1/host/outbound/*",
      async (route) => {
        const phase = new URL(route.request().url()).pathname
          .split("/")
          .at(-1)!;
        lifecycle.push(phase);
        if (phase === "start")
          return route.fulfill({
            json: {
              attempt_id: "attempt-1",
              capability: "ephemeral-offer-only",
              url: "wss://server.example/api/v1/host/outbound",
              expires_in_ms: 30000,
            },
          });
        if (phase === "cancel")
          return route.fulfill({ json: { cancelled: false } });
        if (result === "lost_finish") return route.abort("connectionreset");
        if (result !== "connected")
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code:
                  result === "pre_auth"
                    ? "host_outbound_unavailable"
                    : "host_pairing_outcome_unknown",
                message:
                  result === "pre_auth"
                    ? "Native connection failed before authentication"
                    : "Pair acknowledgement was lost; obtain a fresh pairing capability",
              },
            },
          });
        return route.fulfill({
          json: {
            descriptor: { host_id: "h1", workspace_id: "w1" },
            ready: true,
            connected: true,
          },
        });
      },
    );
    const offers: unknown[] = [];
    await page.routeWebSocket(/\/host\/signal$/, (socket) =>
      socket.onMessage((data) => {
        offers.push(JSON.parse(String(data)));
        socket.send(JSON.stringify({ status: "connecting" }));
      }),
    );
    await page.goto("/");
    const outcome = await page.evaluate(async () => {
      const { ApiClient } = await import("/src/client/api.ts");
      const api = new ApiClient(location.origin + "/");
      await api.request("server.capabilities");
      // Open the global socket only for the existing browser-relay fallback.
      // Its command methods remain the same fixture-backed authority.
      await new Promise<void>((resolve) => api.connect({ open: resolve }));
      try {
        await api.connectHost(
          "project-1",
          "ws://127.0.0.1:8788/host",
          "one-use-pair",
          () => {},
        );
        const transport = api.currentHostTransport();
        await api.releaseHostObservation("connect_error_cleanup");
        return { transport, code: null };
      } catch (error) {
        return {
          transport: api.currentHostTransport(),
          code: (error as { code: string }).code,
        };
      }
    });
    expect(offers).toHaveLength(1);
    expect(JSON.stringify(offers)).not.toContain("one-use-pair");
    expect(lifecycle).toContain("finish");
    const relays = backend.commands.filter(
      (command) => command.method === "host.relay_attach",
    );
    if (result === "connected") {
      expect(outcome).toEqual({ transport: "outbound", code: null });
      expect(relays).toHaveLength(0);
      expect(lifecycle).not.toContain("cancel");
    } else if (result === "pre_auth") {
      expect(relays).toHaveLength(1);
      expect(outcome.code).toBeNull();
    } else {
      expect(relays).toHaveLength(0);
      expect(outcome.code).not.toBeNull();
    }
  });
}
