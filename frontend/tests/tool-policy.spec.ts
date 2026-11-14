import {
  isUnavailableSessionChange,
  validateSessionList,
} from "../src/client/session-availability";
import { expect, test } from "@playwright/test";
import {
  validateCompiledPolicy,
  validatePermission,
  validatePolicySnapshot,
} from "../src/client/permissions";
import { CLIENT_TOOL_DEFINITIONS } from "../src/client/client-tools";
import {
  parsePermissionDraft,
  setSimpleToolRule,
} from "../src/features/popups/SessionPermissionsDialog/rules";
import type { CompiledToolPolicyRow } from "../src/client/types";

for (const field of [
  "capability",
  "resource",
  "resources",
  "arguments",
  "operation_arguments",
  "conditions",
]) {
  test(`live rules reject obsolete ${field} even when null`, () => {
    expect(() =>
      validatePermission({
        tool: { kind: "exact", value: "read" },
        action: "allow",
        [field]: null,
      }),
    ).toThrow(`${field}: unknown field`);
  });
}

test("advanced drafts preserve ordered conjunctive args and explicit disabled review", () => {
  const rule = {
    tool: { kind: "glob", value: "file_*" },
    args: [
      {
        pointer: "/path~1name/~0key",
        matcher: { kind: "glob", value: "docs/**" },
      },
    ],
    action: "ask",
  };
  const draft = parsePermissionDraft(
    JSON.stringify({ overrides: [rule], review: false }),
  );
  expect(draft).toEqual({
    overrides: [rule],
    review: false,
    initialization: "allow",
  });
  expect(
    setSimpleToolRule(draft, "coding", "plan", "read", "deny").overrides[0],
  ).toEqual(rule);
  expect(() =>
    parsePermissionDraft(JSON.stringify({ ...draft, accidental: true })),
  ).toThrow("config.accidental: unknown field");
  expect(() => validatePermission({ ...rule, action: "conditional" })).toThrow(
    "expected allow, ask or deny",
  );
  expect(() =>
    validatePermission({
      ...rule,
      args: [
        { pointer: "/bad~2escape", matcher: { kind: "exact", value: "x" } },
      ],
    }),
  ).toThrow("RFC 6901");
  expect(() =>
    validatePermission({
      ...rule,
      args: [{ pointer: "path", matcher: { kind: "exact", value: "x" } }],
    }),
  ).toThrow("RFC 6901");
  expect(() =>
    validatePermission({
      ...rule,
      args: [{ pointer: "/path", matcher: { kind: "exact", value: false } }],
    }),
  ).toThrow("expected a string");
  expect(() =>
    validatePermission({
      ...rule,
      args: Array.from({ length: 17 }, () => rule.args[0]),
    }),
  ).toThrow("predicate count budget");
  expect(() =>
    validatePermission({
      ...rule,
      tool: { kind: "glob", value: "x".repeat(4097) },
    }),
  ).toThrow("byte budget");
  expect(() =>
    validatePermission({
      agent: null,
      mode: null,
      tool: null,
      args: [],
      action: "deny",
    }),
  ).not.toThrow();
});

test("compiled facts retain parent ceilings and ordered conditional branches independently of a draft", () => {
  const policy: CompiledToolPolicyRow = {
    tool: { kind: "exact", value: "shell" },
    kind: "all_of",
    policies: [
      { kind: "static", action: "allow" },
      {
        kind: "conditional",
        branches: [
          {
            args: [
              {
                pointer: "/command",
                matcher: { kind: "glob", value: "git status*" },
              },
            ],
            action: "ask",
            source: "override:0",
          },
        ],
        default_action: "deny",
      },
    ],
  };
  validateCompiledPolicy(policy);
  const original = structuredClone(policy);
  const draft = setSimpleToolRule(
    { overrides: [], review: false, initialization: "ask" },
    "coding",
    "plan",
    "shell",
    "allow",
  );
  expect(draft.overrides).toEqual([
    {
      agent: "coding",
      mode: "plan",
      tool: { kind: "exact", value: "shell" },
      action: "allow",
    },
  ]);
  expect(policy).toEqual(original);
  expect(() =>
    validateCompiledPolicy({ kind: "all_of", policies: [] }),
  ).toThrow();
  expect(() =>
    validateCompiledPolicy({
      kind: "static",
      action: "allow",
      capability: null,
    }),
  ).toThrow("unknown field");
});

test("inventories require exact compiled facts for every registered tool", () => {
  const config = { overrides: [], review: true, initialization: "ask" };
  const mode = {
    name: "plan",
    current: true,
    tools: [{ name: "read", description: "Read" }],
    policy: config,
    compiled: [
      {
        tool: { kind: "exact", value: "read" },
        kind: "static",
        action: "allow",
      },
    ],
  };
  const snapshot = {
    revision: 1,
    config,
    tool_inventory: { agent: "coding", modes: [mode] },
  };
  expect(() => validatePolicySnapshot(snapshot)).not.toThrow();
  expect(() =>
    validatePolicySnapshot({
      ...snapshot,
      tool_inventory: { agent: "coding", modes: [{ ...mode, compiled: [] }] },
    }),
  ).toThrow("missing facts for read");
  expect(() =>
    validatePolicySnapshot({
      ...snapshot,
      tool_inventory: {
        agent: "coding",
        modes: [{ ...mode, compiled: [...mode.compiled, ...mode.compiled] }],
      },
    }),
  ).toThrow("duplicate tool read");
});

test("unavailable Session records require explicit completeness and concrete causes", () => {
  expect(() =>
    validateSessionList({ items: [], unavailable: [], complete: true }),
  ).not.toThrow();
  expect(() =>
    validateSessionList({
      items: [],
      unavailable: [
        { id: "broken", reason: "overrides[0].capability: unknown field" },
      ],
      complete: false,
    }),
  ).not.toThrow();
  expect(() =>
    validateSessionList({
      items: [],
      unavailable: [{ id: "broken", reason: "invalid" }],
      complete: true,
    }),
  ).toThrow("inconsistent");
  expect(() => validateSessionList({ items: [] })).toThrow(
    "unavailable and complete",
  );
  expect(
    isUnavailableSessionChange({
      op: "unavailable",
      session_id: "broken",
      error: {
        code: "session_configuration_unavailable",
        message: "initialization: invalid action",
      },
    }),
  ).toBe(true);
  expect(
    isUnavailableSessionChange({
      op: "unavailable",
      session_id: "broken",
      error: { code: "session_configuration_unavailable", message: "" },
    }),
  ).toBe(false);
});

test("browser client tool defaults emit strict tool permissions", () => {
  for (const definition of CLIENT_TOOL_DEFINITIONS)
    for (const permission of definition.permissions) {
      expect(() => validatePermission(permission)).not.toThrow();
      expect(permission).toEqual({
        tool: { kind: "exact", value: definition.name },
        action: "allow",
      });
    }
});
