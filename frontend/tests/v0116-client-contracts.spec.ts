import { retainPermissionDecisions } from "../src/client/permission-decisions";
import { expect, test } from "@playwright/test";
import {
  validateCompiledPolicy,
  validatePermission,
  validatePolicySnapshot,
} from "../src/client/permissions";
import { validateExecutionHistory } from "../src/client/execution-history";
import {
  validateSettingsOverrides,
  validateProviderConfig,
  validatePublicProvider,
  validateReferences,
  LIMIT_FIELDS,
} from "../src/client/settings";
import { userTaskInputAllowed } from "../src/client/session-kind";
import { materialize } from "../src/client/increments";
import { nativeSnapshot } from "./native-fixture";

const owner = { controller: 7, revision: 11, agent: "coding", mode: "execute" };
const compiled = {
  kind: "static",
  action: "ask",
  tool: { kind: "exact", value: "shell" },
  owners: [owner],
};
const config = { overrides: [], initialization: "allow", review: true };
const provider = {
  name: "Mine",
  endpoint: "https://provider.example/v1",
  protocol: "openai-compatible",
  auth: "bearer",
  timeout_ms: 60000,
  max_response_bytes: 1048576,
  models: [
    {
      id: "manual",
      variants: ["fast"],
      context_window_tokens: 128000,
      auth: "native",
      endpoint: "https://provider.example/model",
    },
  ],
};

test("compiled inventory admits strict per-row owners and rejects malformed or nested witnesses", () => {
  const inventory = {
    revision: 1,
    config,
    tool_inventory: {
      agent: "coding",
      modes: [
        {
          name: "execute",
          current: true,
          tools: [{ name: "shell", description: "Shell" }],
          policy: config,
          compiled: [compiled],
        },
      ],
    },
  };
  expect(() => validatePolicySnapshot(inventory)).not.toThrow();
  expect(() =>
    validateCompiledPolicy({
      ...compiled,
      owners: [{ ...owner, revision: -1 }],
    }),
  ).toThrow("owners[0].revision");
  expect(() =>
    validateCompiledPolicy({
      ...compiled,
      owners: [{ ...owner, extra: true }],
    }),
  ).toThrow("owners[0].extra: unknown field");
  expect(() =>
    validateCompiledPolicy({ ...compiled, private_authority: true }),
  ).toThrow("unknown field");
  expect(() =>
    validateCompiledPolicy({ kind: "all_of", policies: [compiled] }),
  ).toThrow("tool: unknown field");
});

test("Regex is accepted only on bounded RFC6901 argument predicates", () => {
  expect(() =>
    validatePermission({
      tool: { kind: "exact", value: "read" },
      action: "allow",
      args: [
        {
          pointer: "/path~1name",
          matcher: { kind: "regex", value: "src/.*\\.rs" },
        },
      ],
    }),
  ).not.toThrow();
  expect(() =>
    validatePermission({
      tool: { kind: "regex", value: ".*" },
      action: "allow",
    }),
  ).toThrow("regex is only supported for argument predicates");
  expect(() =>
    validatePermission({
      action: "allow",
      args: [{ pointer: "/bad~2", matcher: { kind: "regex", value: ".*" } }],
    }),
  ).toThrow("RFC 6901");
  expect(() =>
    validatePermission({
      action: "allow",
      args: [
        {
          pointer: "/path",
          matcher: { kind: "regex", value: "x".repeat(4097) },
        },
      ],
    }),
  ).toThrow("byte budget");
});

test("dedicated history accepts released Final records independently of empty model State", () => {
  const row = {
    execution_id: 1,
    session_id: "s1",
    call_id: "c",
    tool: "read",
    agent: "coding",
    mode: null,
    status: "succeeded",
    capabilities: { input: false },
    output_availability: "released",
  };
  expect(() => validateExecutionHistory([row], "s1")).not.toThrow();
  expect(() => validateExecutionHistory([row, row], "s1")).toThrow(
    "unique positive",
  );
  expect(() =>
    validateExecutionHistory([{ ...row, session_id: "child" }], "s1"),
  ).toThrow("selected Session identity");
  const snapshot = {
    ...structuredClone(nativeSnapshot),
    state: {},
    executions: [row],
  } as typeof nativeSnapshot;
  const next = materialize(snapshot, "session.meta", {
    state: { mode: "plan" },
  });
  expect(next.view.executions).toEqual([row]);
  expect(next.view.state).not.toHaveProperty("executions");
});

test("limits keep independent capacities, allow reset by omission, and reject unsafe values", () => {
  expect(LIMIT_FIELDS).toEqual([
    "max_rounds",
    "max_tool_calls_per_round",
    "max_context_bytes",
    "max_tool_output_bytes",
    "max_tool_image_bytes",
    "max_output_tokens",
    "interaction_timeout_ms",
    "max_pending_executions",
    "max_retained_executions",
    "lifecycle_timeout_ms",
    "max_processes",
    "max_execution_buffers",
    "max_retained_processes",
    "output_buffer_bytes",
    "sleep_max_ms",
  ]);
  expect(() =>
    validateSettingsOverrides({
      limits: {
        max_processes: 2,
        max_execution_buffers: 7,
        max_retained_processes: 0,
      },
      review: false,
      review_model: null,
    }),
  ).not.toThrow();
  expect(() => validateSettingsOverrides({})).not.toThrow();
  expect(() =>
    validateSettingsOverrides({ limits: { max_processes: 0 } }),
  ).toThrow("max_processes");
  expect(() =>
    validateSettingsOverrides({ limits: { sleep_max_ms: 3600001 } }),
  ).toThrow("maximum");
  expect(() => validateSettingsOverrides({ limits: { max_jobs: 8 } })).toThrow(
    "unknown field",
  );
  expect(() =>
    validateSettingsOverrides({
      auto_compaction: {
        enabled: true,
        turn_threshold: 0.95,
        round_threshold: 0.8,
        headroom_tokens: 0,
      },
    }),
  ).toThrow("0 < turn_threshold");
});

test("public Provider validation never admits credentials and manual routes remain explicit", () => {
  expect(() => validateProviderConfig(provider)).not.toThrow();
  const safe = {
    ...provider,
    id: "user:mine",
    scope: "user",
    revision: 2,
    read_only: false,
    api_key_configured: true,
    discovered: [{ id: "discovered" }],
  };
  expect(() => validatePublicProvider(safe)).not.toThrow();
  expect(() =>
    validatePublicProvider({ ...safe, api_key: "must-never-roundtrip" }),
  ).toThrow("api_key: unknown field");
  expect(() =>
    validateProviderConfig({
      ...provider,
      endpoint: "https://name:password@provider.example",
    }),
  ).toThrow("without credentials");
  expect(() =>
    validateProviderConfig({ ...provider, models: [{ id: "a" }, { id: "a" }] }),
  ).toThrow("unique nonempty model");
});

test("reference mounts validate PersonalLibrary project contract and reject bad ref IDs", () => {
  expect(() =>
    validateReferences({
      project_id: "project-1",
      ref_ids: ["ref_0123456789abcdef"],
      items: [],
    }),
  ).not.toThrow();
  expect(() =>
    validateReferences({
      project_id: "project-1",
      ref_ids: ["bad-id"],
      items: [],
    }),
  ).toThrow("expected ref_* id");
  expect(() =>
    validateReferences({
      project_id: "project-1",
      ref_ids: [],
      items: [],
      extra: 1,
    }),
  ).toThrow("unknown field");
});

test("Session kind controls task input independently of parent permission visibility", () => {
  expect(userTaskInputAllowed({ kind: "interactive" })).toBe(true);
  expect(userTaskInputAllowed({ kind: "delegated" })).toBe(false);
  expect(userTaskInputAllowed({ kind: "one_shot" })).toBe(false);
  expect(
    userTaskInputAllowed({ parentID: "parent", kind: "interactive" }),
  ).toBe(false);
  expect(userTaskInputAllowed({}, { session: { kind: "delegated" } })).toBe(
    false,
  );
  expect(userTaskInputAllowed({})).toBe(true);
  expect(userTaskInputAllowed(null, { session: { kind: "delegated" } })).toBe(
    true,
  );
});

test("reconnected permission decisions retain exact review attribution and fence stale asks without carrying argument bodies", () => {
  const automatic = {
    request_id: "ask-a",
    parent_session_id: "s1",
    session_id: "child",
    owning_session_id: "child",
    call_id: "call-a",
    controller_id: 7,
    revision: 2,
    agent: "coding",
    mode: "execute",
    tool: "read",
    decision: "allow" as const,
    source: "review" as const,
    review_reason: "Only the selected file is read",
    reason: "review_auto",
    remembered: false,
  };
  const restored = retainPermissionDecisions([], [automatic], "s1");
  expect(restored).toEqual([automatic]);
  expect(retainPermissionDecisions(restored, [automatic], "s1")).toHaveLength(
    1,
  );
  const explicit = {
    ...automatic,
    request_id: "ask-b",
    source: "user" as const,
    decision: "deny" as const,
    review_reason: null,
  };
  expect(
    retainPermissionDecisions(restored, [explicit], "s1").map(
      (row) => row.source,
    ),
  ).toEqual(["review", "user"]);
  expect(retainPermissionDecisions(restored, [], "other")).toEqual([]);
  expect(() =>
    retainPermissionDecisions(
      [],
      [{ ...automatic, parent_session_id: "other" }],
      "s1",
    ),
  ).toThrow("selected parent Session");
  expect(() =>
    retainPermissionDecisions(
      [],
      [{ ...automatic, arguments: { secret: "body" } }],
      "s1",
    ),
  ).toThrow("arguments: unknown field");
  expect(() =>
    retainPermissionDecisions([], [{ ...automatic, controller_id: -1 }], "s1"),
  ).toThrow("controller_id");
});
