import { expect, test } from "@playwright/test";
import type { ApiClient } from "../src/client/api";
import { CommandError } from "../src/client/api";
import {
  CLIENT_TOOL_DEFINITIONS,
  parseSecretRequest,
} from "../src/client/client-tools";
import {
  ClientToolController,
  type ClientBinding,
  type ClientInvocation,
} from "../src/client/client-tool-controller";
import { failureText, wireFailure } from "../src/client/failure";

const secretArgs = {
  reason: "Authenticate the approved service",
  secrets: [{ key: "service.token-1", label: "Service token" }],
};
function call(
  tool = "request_secret",
  args: unknown = secretArgs,
): ClientInvocation {
  return {
    invocation_id: "i",
    parent_session_id: "root",
    session_id: "child",
    call_id: "c",
    tool,
    arguments: args,
    epoch: 2,
    turn_id: 3,
    round_id: 4,
    catalog_digest: "frozen",
    status: "pending",
    interaction: tool !== "plugin",
    blocking_mode: "blocking",
    prepared: true,
    created_at_ms: 1,
    deadline_ms: 0,
  };
}
function harness(
  record: ClientInvocation,
  role: ClientBinding["role"] = "participant",
  handler?: (method: string, params: any) => unknown,
  onBind?: () => ClientBinding | Promise<ClientBinding>,
) {
  const commands: { method: string; params: any; parent: string }[] = [];
  const binding: ClientBinding = {
    role,
    can_interact: role !== "observer",
    participation_id: "reader-cap",
    ...(role === "executor" ? { lease_id: "producer-lease" } : {}),
    catalog_digest: "frozen",
    definitions: CLIENT_TOOL_DEFINITIONS,
    calls: [record],
    pending: [record],
  };
  const api = {
    request: async (method: string, params: any, parent: string) => {
      commands.push({ method, params: structuredClone(params), parent });
      if (method === "client_tools.bind")
        return onBind ? onBind() : structuredClone(binding);
      if (handler) return handler(method, params);
      return { ...record, status: "completed", result: params.result };
    },
  } as unknown as ApiClient;
  const external: unknown[] = [];
  const errors: unknown[] = [];
  const controller = new ClientToolController(
    api,
    () => {},
    (error) => errors.push(error),
    async (_name, args) => {
      external.push(args);
      return { ok: true };
    },
  );
  return { controller, binding, commands, external, errors };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

test("Secret contract accepts exact bounded unique keys and never nullable/default values", () => {
  expect(parseSecretRequest(secretArgs)).toEqual(secretArgs);
  const definition = CLIENT_TOOL_DEFINITIONS.find(
    (tool) => tool.name === "request_secret",
  )!;
  expect(definition.interaction?.secret_writes).toEqual({
    keys_pointer: "/secrets",
    max_keys: 8,
  });
  for (const args of [
    { ...secretArgs, secrets: [] },
    { ...secretArgs, secrets: Array(9).fill(secretArgs.secrets[0]) },
    { ...secretArgs, secrets: [secretArgs.secrets[0], secretArgs.secrets[0]] },
    { ...secretArgs, secrets: [{ key: "bad key", label: "Bad" }] },
    { ...secretArgs, blocking_mode: "deferred" },
  ])
    expect(() => parseSecretRequest(args)).toThrow();
});

test("participant answers and prepares a human question without producer lease", async () => {
  const record = {
    ...call("ask_user_question", {
      questions: [
        { id: "q", question: "Choose", options: [{ id: "yes", label: "Yes" }] },
      ],
    }),
    prepared: false,
  };
  const h = harness(record, "participant", (method, params) => ({
    ...record,
    prepared: true,
    status: method === "client_tools.prepare" ? "pending" : "completed",
    result: params.result,
  }));
  await h.controller.bind("root", h.binding);
  expect(h.controller.questions[0].disabled).toBe(false);
  await h.controller.answer("i", [{ id: "q", option_ids: ["yes"] }], false);
  for (const command of h.commands.filter(
    (item) => item.method !== "client_tools.bind",
  )) {
    expect(command.parent).toBe("root");
    expect(command.params).not.toHaveProperty("lease_id");
  }
  expect(h.external).toHaveLength(0);
});

test("Secret first-winner receipt is sanitized and plaintext never enters binding", async () => {
  const record = call();
  const h = harness(record, "participant", (_method, _params) => ({
    ...record,
    status: "completed",
    result: {
      status: "provided",
      secrets: [
        { key: "service.token-1", placeholder: "{{secret:service.token-1}}" },
      ],
    },
  }));
  await h.controller.bind("root", h.binding);
  const values = { "service.token-1": "PRIVATE_LITERAL_SENTINEL" };
  await h.controller.submitSecret("i", values);
  expect(values).toEqual({});
  const sent = h.commands.find(
    (item) => item.method === "client_tools.secret",
  )!;
  expect(sent.params.values).toEqual({
    "service.token-1": "PRIVATE_LITERAL_SENTINEL",
  });
  expect(sent.params.operation_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(sent.params).not.toHaveProperty("lease_id");
  expect(JSON.stringify(h.controller.binding)).not.toContain(
    "PRIVATE_LITERAL_SENTINEL",
  );
  expect(h.controller.questions).toHaveLength(0);
  await expect(
    h.controller.submitSecret("i", { "service.token-1": "SECOND" }),
  ).rejects.toThrow();
  expect(
    h.commands.filter((item) => item.method === "client_tools.secret"),
  ).toHaveLength(1);
});

test("uncertain Secret write observes its exact operation and never resubmits plaintext", async () => {
  const record = call();
  const h = harness(record, "participant", (method, params) => {
    if (method === "client_tools.secret")
      throw new CommandError("closed", "not public", false, true);
    return {
      operation_id: params.operation_id,
      invocation_id: "i",
      status: "committing",
    };
  });
  await h.controller.bind("root", h.binding);
  const values = { "service.token-1": "PRIVATE_UNKNOWN" };
  await expect(h.controller.submitSecret("i", values)).rejects.toThrow(
    "reconciliation",
  );
  expect(values).toEqual({});
  expect(h.controller.questions[0].awaitingConfirmation).toBe(true);
  await h.controller.observeSecret("i");
  expect(
    h.commands.filter((item) => item.method === "client_tools.secret"),
  ).toHaveLength(1);
  const observations = h.commands.filter(
    (item) => item.method === "client_tools.secret_operation",
  );
  expect(observations).toHaveLength(2);
  expect(observations[0].params).toEqual(observations[1].params);
  expect(JSON.stringify(h.controller.binding)).not.toContain("PRIVATE_UNKNOWN");
});

test("Secret decline uses public result and observer cannot submit private values", async () => {
  const h = harness(call());
  await h.controller.bind("root", h.binding);
  await h.controller.declineSecret("i");
  expect(h.commands.at(-1)?.params).toEqual({
    invocation_id: "i",
    result: { status: "declined" },
  });
  const observer = harness(call(), "observer");
  await observer.controller.bind("root", observer.binding);
  await expect(
    observer.controller.submitSecret("i", { "service.token-1": "PRIVATE" }),
  ).rejects.toThrow();
  expect(observer.commands).toHaveLength(1);
});

test("only executor privately fetches dispatch arguments and public binding stays masked", async () => {
  const record = call("plugin", { arguments: { token: "{{secret:KEY}}" } });
  const h = harness(record, "executor", (method) =>
    method === "client_tools.arguments"
      ? { invocation_id: "i", arguments: { token: "PRIVATE_DISPATCH" } }
      : { ...record, status: "completed", result: { ok: true } },
  );
  h.binding.calls = [];
  h.binding.pending = [];
  await h.controller.bind("root", h.binding);
  h.controller.receive("client_tool.requested", record);
  await expect.poll(() => h.external.length).toBe(1);
  expect(h.external[0]).toEqual({ token: "PRIVATE_DISPATCH" });
  expect(JSON.stringify(h.controller.binding)).not.toContain(
    "PRIVATE_DISPATCH",
  );
  const participant = harness(record);
  participant.binding.calls = [];
  participant.binding.pending = [];
  await participant.controller.bind("root", participant.binding);
  participant.controller.receive("client_tool.requested", record);
  expect(participant.external).toHaveLength(0);
  expect(
    participant.commands.some(
      (item) => item.method === "client_tools.arguments",
    ),
  ).toBe(false);
});

test("failed lease refresh releases events and revokes the old executor without replay", async () => {
  const pending = deferred<ClientBinding>();
  let binds = 0;
  const h = harness(call(), "executor", undefined, () =>
    ++binds === 1 ? structuredClone(h.binding) : pending.promise,
  );
  await h.controller.bind("root", h.binding);
  h.controller.leaseChanged(false);
  expect(h.controller.binding?.role).toBe("observer");
  expect(h.controller.binding?.lease_id).toBeUndefined();
  expect(h.controller.canInteract).toBe(false);
  h.controller.receive("client_tool.settled", {
    ...call(),
    status: "completed",
  });
  pending.reject(Error("bind response unavailable"));
  await expect.poll(() => h.errors.length).toBe(1);
  expect(h.controller.binding?.pending).toHaveLength(0);
  expect(h.controller.binding?.calls[0].status).toBe("completed");
  const next = { ...call(), invocation_id: "next-human" };
  h.controller.receive("client_tool.requested", next);
  expect(h.controller.questions.map((question) => question.id)).toEqual([
    "next-human",
  ]);
  expect(h.controller.questions[0].disabled).toBe(true);
  expect(h.external).toHaveLength(0);
  expect(
    h.commands.some(({ method }) =>
      ["client_tools.arguments", "client_tools.result"].includes(method),
    ),
  ).toBe(false);
});

test("lease change during a captured bind snapshot uses one trailing refresh", async () => {
  const first = deferred<ClientBinding>();
  const trailing = deferred<ClientBinding>();
  let binds = 0;
  const h = harness(call(), "executor", undefined, () => {
    binds++;
    return binds === 1
      ? structuredClone(h.binding)
      : binds === 2
        ? first.promise
        : trailing.promise;
  });
  await h.controller.bind("root", h.binding);
  h.controller.leaseChanged(false);
  const recovered = { ...call("plugin", {}), invocation_id: "new-plugin" };
  h.controller.receive("client_tool.requested", recovered);
  h.controller.leaseChanged(true);
  first.resolve(structuredClone(h.binding));
  await expect.poll(() => binds).toBe(3);
  expect(h.controller.binding?.role).toBe("observer");
  trailing.resolve({
    ...structuredClone(h.binding),
    role: "participant",
    lease_id: undefined,
    calls: [recovered],
    pending: [recovered],
  });
  await expect.poll(() => h.controller.binding?.role).toBe("participant");
  expect(binds).toBe(3);
  expect(h.external).toHaveLength(0);
  expect(
    h.commands.some(({ method }) =>
      ["client_tools.arguments", "client_tools.result"].includes(method),
    ),
  ).toBe(false);
});

test("obsolete bind failure cannot release a newer bind's event buffer", async () => {
  const obsolete = deferred<ClientBinding>();
  const fresh = deferred<ClientBinding>();
  let binds = 0;
  const h = harness(call(), "executor", undefined, () => {
    binds++;
    return binds === 1
      ? structuredClone(h.binding)
      : binds === 2
        ? obsolete.promise
        : fresh.promise;
  });
  await h.controller.bind("root", h.binding);
  const oldBind = h.controller.bind("root", h.binding);
  const newBind = h.controller.bind("root", h.binding);
  obsolete.reject(Error("obsolete bind failed"));
  await oldBind;
  h.controller.receive("client_tool.settled", {
    ...call(),
    status: "completed",
  });
  expect(h.controller.binding?.pending).toHaveLength(1);
  fresh.resolve({
    ...structuredClone(h.binding),
    role: "participant",
    lease_id: undefined,
  });
  await newBind;
  expect(h.controller.binding?.pending).toHaveLength(0);
  expect(h.controller.binding?.calls[0].status).toBe("completed");
  expect(h.errors).toHaveLength(0);
  expect(h.external).toHaveLength(0);
});

test("typed empty response copy preserves historical fallback without promoting reasoning", () => {
  const error = {
    code: "provider",
    message: "safe remote failure",
    details: {
      provider_code: "empty_assistant_response",
      reasoning_present: true,
      finish_reason: "stop",
    },
  };
  expect(wireFailure(error).details?.reasoning_present).toBe(true);
  const body = failureText(error);
  expect(body).not.toBe(error.message);
  expect(body).not.toContain("safe remote failure");
  expect(
    failureText({
      code: "protocol",
      message: "historical empty assistant response",
    }),
  ).toContain("historical empty assistant response");
});
