import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { validateExecutionHistory } from "../src/client/execution-history";

const contract = JSON.parse(
  readFileSync(
    new URL("./fixtures/session-subscription.json", import.meta.url),
    "utf8",
  ),
);

// These rows are also checked against Rust ExecutionSnapshot::metadata serde.
test("initialization subjects preserve empty tool names without accepting malformed tool history", () => {
  const init = structuredClone(contract.agent_init_fresh[0].meta.executions[0]);
  expect(() => validateExecutionHistory([init], "s1")).not.toThrow();
  for (const subject of [
    undefined,
    { kind: "tool" },
    { kind: "unknown" },
    null,
    { kind: "agent_init" },
    { ...init.subject, component: "" },
    { ...init.subject, generation: -1 },
    { ...init.subject, attempt: "1" },
  ]) {
    expect(() =>
      validateExecutionHistory([{ ...init, subject }], "s1"),
    ).toThrow();
  }
  expect(() =>
    validateExecutionHistory(
      [{ ...init, subject: undefined, tool: "read" }],
      "s1",
    ),
  ).not.toThrow();
});

for (const owner of ["session", "global"] as const) {
  for (const failure of [
    "malformed_json",
    "invalid_envelope",
    "oversized",
  ] as const) {
    test(`${owner} socket closes ${failure} using browser-valid application codes`, async ({
      page,
    }) => {
      await page.route("**/socket-error-contract", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Socket errors</title>",
        }),
      );
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const closes: number[] = [];
      const raw =
        failure === "malformed_json"
          ? "{bad"
          : failure === "oversized"
            ? JSON.stringify({ text: "x".repeat(8 * 1024 * 1024) })
            : JSON.stringify({ v: 1, type: "unexpected" });
      await page.routeWebSocket(
        owner === "session"
          ? /\/api\/v1\/sessions\/s1\/ws(?:\?.*)?$/
          : /\/api\/v1\/ws$/,
        (socket) => {
          socket.onClose((code) => closes.push(code));
          socket.send(raw);
        },
      );
      await page.goto("/socket-error-contract");
      await page.evaluate(async (owner) => {
        if (owner === "session") {
          const { SessionSocket } =
            await import("/src/client/socket/session.ts");
          const socket = new SessionSocket((path) =>
            new URL(path, location.origin + "/").toString(),
          );
          (window as any).testSocket = socket;
          void socket
            .open("s1", { display_watermark: 0 }, { event() {} })
            .catch(() => {});
        } else {
          const { ApiClient } = await import("/src/client/api.ts");
          const socket = new ApiClient(location.origin + "/");
          (window as any).testSocket = socket;
          socket.connect({});
        }
      }, owner);
      await expect.poll(() => closes.length).toBe(1);
      expect(closes).toEqual([failure === "oversized" ? 4009 : 4002]);
      await page.evaluate(() => (window as any).testSocket.stop());
      expect(errors).toEqual([]);
    });
  }
}

test("subscription rejection identifies the field without exposing frame values", async ({
  page,
}) => {
  await page.route("**/socket-error-contract", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Subscription error</title>",
    }),
  );
  const frames = structuredClone(contract.fresh);
  frames[0].meta.executions = [{ tool: "private-body-secret" }];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.routeWebSocket(/\/api\/v1\/sessions\/s1\/ws(?:\?.*)?$/, (socket) =>
    socket.send(JSON.stringify(frames[0])),
  );
  await page.goto("/socket-error-contract");
  const failure = await page.evaluate(async () => {
    const { SessionSocket } = await import("/src/client/socket/session.ts");
    const socket = new SessionSocket((path) =>
      new URL(path, location.origin + "/").toString(),
    );
    try {
      await socket.open("s1", { display_watermark: 0 }, { event() {} });
      return null;
    } catch (error: any) {
      return {
        code: error.code,
        message: error.message,
        details: error.details,
      };
    } finally {
      socket.stop();
    }
  });
  expect(failure?.code).toBe("invalid_result");
  expect(failure?.message).toContain("meta.executions[0].session_id");
  expect(failure?.details.reason).toContain(
    "expected selected Session identity",
  );
  expect(JSON.stringify(failure)).not.toContain("private-body-secret");
  expect(errors).toEqual([]);
});
