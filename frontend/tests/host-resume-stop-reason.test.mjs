import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { replayDisplayObservations } from "../src/client/projector.ts";
import { timedTrajectoryBlocks } from "../src/features/trajectoryTiming.ts";
import { ApiClient } from "../src/client/api.ts";
import { AppStore } from "../src/state/store.ts";
import { LIMIT_FIELDS } from "../src/client/settings.ts";
import { wireFailure, failureText } from "../src/client/failure.ts";
import { terminalSummary } from "../src/features/trajectoryStopReason.ts";
import {
  applySnapshot,
  applyEvent,
  createBlock,
} from "../src/client/projector.ts";
import { graphTranscript, snapshot } from "./display-graph-inputs.ts";

const descriptor = {
  host_id: "host",
  workspace_id: "workspace",
  workspace_root: "/work",
};
const relayWitness = {
  relay_id: "f2cb2b12-5608-4634-95ac-9296e604ccfb",
  relay_generation: "18446744073709551615",
};
const relayResult = () => ({
  descriptor,
  ready: true,
  connected: true,
  relay_release: { ...relayWitness },
});
const response = () =>
  new Response(JSON.stringify({ descriptor, ready: true, connected: true }));
const calls = [];
let fail = false;
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  if (fail) throw Error("network unavailable");
  if (new URL(String(url)).pathname.endsWith("/settings")) {
    const limits = Object.fromEntries(
      LIMIT_FIELDS.map((field) => [field, 1048576]),
    );
    const effective = { limits };
    return new Response(
      JSON.stringify({
        revision: 0,
        applied_revision: 0,
        overrides: {},
        effective,
        desired_effective: effective,
        sources: {},
        constraints: { limits },
        application: "defaults_saved",
        reason: null,
      }),
    );
  }
  return response();
};
class RelaySocket {
  static OPEN = 1;
  static CLOSING = 2;
  static sockets = [];
  readyState = 0;
  listeners = new Map();
  constructor() {
    RelaySocket.sockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  addEventListener(name, callback) {
    const rows = this.listeners.get(name) ?? [];
    rows.push(callback);
    this.listeners.set(name, rows);
  }
  close() {
    this.readyState = 3;
    this.fireClose();
  }
  fireClose() {
    for (const callback of this.listeners.get("close") ?? []) callback();
  }
}
globalThis.WebSocket = RelaySocket;

function readyStore(api) {
  const store = Object.create(AppStore.prototype);
  Object.assign(store, {
    api,
    hostAttempt: 0,
    defaultsRead: 0,
    approvedDocumentLeaves: new WeakSet(),
    lifecycle: 1,
    state: {
      agents: [{ name: "agent" }],
      projects: [{ id: "p1", root: "/work" }],
      authSession: { authenticated: true, principal: { owner: "owner" } },
      hostConnection: {
        projectId: "p1",
        state: "ready",
        connected: true,
        transport: "grpc",
      },
      draftWorkspace: { projectId: "p1" },
    },
    update(patch) {
      Object.assign(this.state, patch);
    },
    newChat() {},
    clearComposer() {},
  });
  return store;
}

test("actual HTTP fetches carry a stable per-Api UUID and closed lifecycle trigger", async () => {
  calls.length = 0;
  const api = new ApiClient("http://localhost/");
  await api.connectHost("p1", "http://localhost:5000", undefined, () => {}, {
    trigger: "resume_project:bootstrap",
  });
  await api.health();
  assert.match(
    api.tabId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  for (const { options } of calls)
    assert.equal(options.headers["x-client-tab-id"], api.tabId);
  assert.equal(
    calls[0].options.headers["x-client-trigger"],
    "resume_project:bootstrap",
  );
  assert.notEqual(new ApiClient("http://localhost/").tabId, api.tabId);
});

test("same-ready resume/select/create send no Host lifecycle HTTP request", async () => {
  const api = new ApiClient("http://localhost/");
  const store = readyStore(api);
  calls.length = 0;
  await store.resumeProject("p1", "resume_project:bootstrap");
  await store.dispatch({ type: "SelectKnownProject", value: "p1" });
  await store.dispatch({ type: "CreateSessionInProject", value: "p1" });
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    [
      "/api/v1/settings",
      "/api/v1/projects/p1/settings",
      "/api/v1/settings",
      "/api/v1/projects/p1/settings",
    ],
  );
  assert.ok(calls.every((call) => call.options.method === "GET"));
});

test("grpc observation, network failure and project switch never disconnect previous route", async () => {
  calls.length = 0;
  const api = new ApiClient("http://localhost/");
  await api.connectHost("p1", "http://localhost:5000", undefined, () => {});
  await api.connectHost("p1", "http://localhost:5000", undefined, () => {}, {
    trigger: "resume_project:attach",
  });
  fail = true;
  try {
    await assert.rejects(
      api.connectHost("p1", "http://localhost:5000", undefined, () => {}),
    );
  } finally {
    fail = false;
  }
  assert.equal(api.currentHostProject(), "p1");
  assert.equal(api.currentHostTransport(), "grpc");
  await api.connectHost("p2", "http://localhost:5000", undefined, () => {});
  await api.releaseHostObservation("resume_project:select_project");
  assert.equal(
    calls.filter((call) => call.url.includes("/host/disconnect")).length,
    0,
  );
});

test("relay to grpc releases only captured old project before connecting new project", async () => {
  const api = new ApiClient("http://localhost/");
  api.command = async () => relayResult();
  await api.connectHost("old", "ws://localhost:5001", undefined, () => {});
  const old = RelaySocket.sockets.at(-1);
  calls.length = 0;
  await api.connectHost("new", "http://localhost:5000", undefined, () => {}, {
    trigger: "resume_project:select_project",
  });
  assert.equal(old.readyState, 3);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    revoke: false,
    relay_release: relayWitness,
  });
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    [
      "/api/v1/projects/old/host/disconnect",
      "/api/v1/projects/new/host/connect",
    ],
  );
  assert.equal(
    calls[0].options.headers["x-client-trigger"],
    "resume_project:select_project",
  );
  assert.equal(api.currentHostProject(), "new");
});

test("cancellation categories retain only closed cause details and no cause is invented", () => {
  const failure = wireFailure({
    code: "cancelled",
    message: "Specific backend stop",
    details: {
      cancel_reason: "host_detached",
      token: "secret",
      body: "private",
    },
  });
  assert.deepEqual(failure.details, { cancel_reason: "host_detached" });
  assert.match(failureText(failure), /Host/);
  assert.equal(
    failureText({ code: "cancelled", message: "Specific backend stop" }),
    "Specific backend stop",
  );
  assert.equal(
    terminalSummary({ payload: { text: "", auditStatus: "cancelled" } }),
    "操作已取消",
  );
  assert.equal(
    terminalSummary({ payload: { text: "", auditStatus: "failed" } }),
    "请求失败",
  );
});

test("live and snapshot cancelled receipts retain concrete cause beside the operation output", () => {
  const transcript = graphTranscript();
  const own = createBlock("s1", "own", "text", "text", "assistant");
  own.operationId = "op1";
  own.payload.text = "partial";
  const later = createBlock("s1", "later", "text", "text", "assistant");
  later.operationId = "op2";
  later.payload.text = "later turn";
  transcript.blocks = [own, later];
  const operation = {
    id: "op1",
    session_id: "s1",
    method: "turn.inbox",
    status: "cancelled",
    updated_at_ms: 2,
    result: {
      error: {
        code: "cancelled",
        message: "Stopped by user",
        details: { cancel_reason: "user_requested" },
      },
    },
  };
  applyEvent(transcript, { event: "turn", session_id: "s1", data: operation });
  assert.deepEqual(
    transcript.blocks.map((block) => block.operationId),
    ["op1", "op1", "op2"],
  );
  assert.equal(transcript.blocks[1].stream, "cancelled");
  assert.equal(
    transcript.blocks[1].payload.failure.details.cancel_reason,
    "user_requested",
  );
  const snap = snapshot();
  snap.operations = [operation];
  const projected = applySnapshot(snap, transcript);
  const notice = projected.blocks.find(
    (block) => block.operationId === "op1" && block.payload.failure,
  );
  assert.equal(notice.stream, "cancelled");
  assert.equal(notice.payload.failure.details.cancel_reason, "user_requested");
});

test("grpc to relay preserves grpc, stale old relay close cannot disconnect new generation", async () => {
  const api = new ApiClient("http://localhost/");
  api.command = async () => relayResult();
  calls.length = 0;
  await api.connectHost("grpc", "http://localhost:5000", undefined, () => {});
  await api.connectHost("relay1", "ws://localhost:5001", undefined, () => {});
  const old = RelaySocket.sockets.at(-1);
  await api.connectHost("relay2", "ws://localhost:5002", undefined, () => {});
  const current = RelaySocket.sockets.at(-1);
  old.fireClose();
  assert.equal(api.hasOpenRelayFor("relay2"), true);
  assert.equal(current.readyState, 1);
  assert.equal(
    calls.filter((call) => call.url.includes("/host/disconnect")).length,
    0,
  );
});

test("new connect waits for old relay release and superseded grpc observation never attaches", async () => {
  const api = new ApiClient("http://localhost/");
  api.command = async () => relayResult();
  await api.connectHost("old", "ws://localhost:5001", undefined, () => {});
  let release;
  const savedFetch = globalThis.fetch;
  calls.length = 0;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/host/disconnect"))
      return new Promise((resolve) => {
        release = () => resolve(response());
      });
    return response();
  };
  try {
    const first = api.connectHost(
      "first",
      "http://localhost:5000",
      undefined,
      () => {},
    );
    const rejected = assert.rejects(first, /replaced/);
    await new Promise((resolve) => setImmediate(resolve));
    const latest = api.connectHost(
      "latest",
      "http://localhost:5000",
      undefined,
      () => {},
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    release();
    await Promise.all([rejected, latest]);
    assert.deepEqual(
      calls.map((call) => new URL(call.url).pathname),
      [
        "/api/v1/projects/old/host/disconnect",
        "/api/v1/projects/latest/host/connect",
      ],
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("native recorder graph invalidation retains reason across snapshot and exact-call trajectory", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/display-block-graph.json", import.meta.url),
      "utf8",
    ),
  );
  const transcript = graphTranscript();
  const records = structuredClone(fixture.frames);
  const terminal = [...records]
    .reverse()
    .find((row) => row.event.phase === "invalidated");
  assert.ok(terminal, "native fixture has a real terminal DTO");
  terminal.event.phase = "invalidated";
  terminal.event.reason = "cancelled";
  terminal.event.detail = "Host route detached";
  replayDisplayObservations(transcript, "s1", records);
  const stopped = transcript.blocks.filter(
    (block) => block.payload.stopReason?.reason === "cancelled",
  );
  assert.ok(stopped.length);
  const prior = JSON.stringify(transcript);
  const restored = applySnapshot(snapshot(), transcript);
  assert.equal(JSON.stringify(transcript), prior);
  assert.ok(
    restored.blocks.some(
      (block) => block.payload.stopReason?.detail === "Host route detached",
    ),
  );
  const row = stopped.find((block) => block.callId === terminal.event.call_id);
  assert.ok(row);
  const timeline = [
    {
      sequence: 1,
      request_hash: "request",
      call_id: terminal.event.call_id,
      epoch: terminal.event.epoch,
      turn: terminal.event.turn,
      round: terminal.event.round,
      completion: "cancelled",
      cancel_reason: "cancelled",
    },
  ];
  const timed = timedTrajectoryBlocks([row], timeline, []);
  const request = timed.find((block) => block.kind === "model-request");
  assert.equal(terminalSummary(request), "Host route detached");
});

test("actual server Host replacement receipt retains the distinct closed cause", () => {
  const error = {
    code: "cancelled",
    message: "Interrupted: Host connection replaced",
    details: {
      cancel_reason: "host_detached",
      host_detach_code: "replaced",
      detail: "Interrupted: Host connection replaced",
    },
  };
  assert.deepEqual(wireFailure(error).details, {
    cancel_reason: "host_detached",
    host_detach_code: "replaced",
  });
  assert.match(failureText(error), /Host 连接被替换/);
  assert.match(failureText(error), /Interrupted: Host connection replaced/);
  assert.equal(
    wireFailure({ ...error, details: { host_detach_code: "untrusted-value" } })
      .details.host_detach_code,
    undefined,
  );
});

test("relay loss, local release and acquired-relay failure send only captured release witness", async () => {
  for (const cleanup of ["lost", "local", "failed"]) {
    const api = new ApiClient("http://localhost/");
    api.command = async () =>
      cleanup === "failed"
        ? { ...relayResult(), ready: false, connected: false }
        : relayResult();
    calls.length = 0;
    if (cleanup === "failed")
      await assert.rejects(
        api.connectHost("owned", "ws://localhost:5001", undefined, () => {}),
      );
    else {
      await api.connectHost(
        "owned",
        "ws://localhost:5001",
        undefined,
        () => {},
      );
      if (cleanup === "local")
        await api.releaseHostObservation("resume_project:select_project");
      else RelaySocket.sockets.at(-1).close();
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(
      new URL(calls[0].url).pathname,
      "/api/v1/projects/owned/host/disconnect",
    );
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      revoke: false,
      relay_release: relayWitness,
    });
    assert.equal(api.hostRelayRelease, null);
  }
});

test("invalid or missing relay release witnesses never authorize implicit project disconnect", async () => {
  for (const relay_release of [
    undefined,
    { ...relayWitness, relay_id: "not-uuid" },
    { ...relayWitness, relay_generation: "18446744073709551616" },
    { ...relayWitness, relay_generation: 1 },
  ]) {
    const api = new ApiClient("http://localhost/");
    api.command = async () => ({ ...relayResult(), relay_release });
    await api.connectHost("owned", "ws://localhost:5001", undefined, () => {});
    calls.length = 0;
    await api.releaseHostObservation("resume_project:select_project");
    assert.equal(calls.length, 0);
  }
});

test("explicit disconnect and logout omit relay release conditions", async () => {
  for (const trigger of ["action:disconnect_host", "action:logout"]) {
    const api = new ApiClient("http://localhost/");
    api.command = async () => relayResult();
    await api.connectHost("owned", "ws://localhost:5001", undefined, () => {});
    calls.length = 0;
    const revoke = trigger === "action:logout";
    await api.disconnectHost(revoke, { trigger });
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].options.body), { revoke });
    assert.equal(calls[0].options.headers["x-client-trigger"], trigger);
  }
});
