import { expect, test } from "@playwright/test";
import {
  inCurrentWorkspace,
  recentSessions,
  shortRelativeTime,
} from "../src/features/home/RecentSessions/recent";
import type { DraftWorkspace, SessionView } from "../src/client/types";

const session = (
  id: string,
  updated: number,
  extra: Partial<SessionView> = {},
): SessionView =>
  ({
    id,
    title: id,
    status: "idle",
    archived: false,
    time: { created: updated - 1, updated },
    ...extra,
  }) as SessionView;

const project: DraftWorkspace = {
  kind: "local",
  projectId: "p1",
} as DraftWorkspace;

test("recent sessions: current project, top level, unarchived, newest first, max six", () => {
  const sessions = [
    session("old", 1, { projectID: "p1" }),
    session("archived", 50, { projectID: "p1", archived: true }),
    session("child", 60, { projectID: "p1", parentID: "old" }),
    session("other", 70, { projectID: "p2" }),
    ...Array.from({ length: 7 }, (_, i) =>
      session(`n${i}`, 10 + i, { projectID: "p1" }),
    ),
  ];
  const current = recentSessions(sessions, "current", project).map((s) => s.id);
  expect(current).toEqual(["n6", "n5", "n4", "n3", "n2", "n1"]);
  const all = recentSessions(sessions, "all", project).map((s) => s.id);
  expect(all[0]).toBe("other");
  expect(all).toHaveLength(6);
  expect(all).not.toContain("archived");
  expect(all).not.toContain("child");
});

test("recent sessions: non-project workspaces match unassigned sessions of that flavor", () => {
  const chat = { kind: "chat_only" } as DraftWorkspace;
  const sandbox = { kind: "browser_sandbox" } as DraftWorkspace;
  expect(inCurrentWorkspace(session("a", 1), chat)).toBe(true);
  expect(inCurrentWorkspace(session("b", 1, { projectID: "p1" }), chat)).toBe(
    false,
  );
  expect(
    inCurrentWorkspace(
      session("c", 1, { hostFlavor: "browser_sandbox" } as any),
      sandbox,
    ),
  ).toBe(true);
  expect(
    inCurrentWorkspace(
      session("c", 1, { hostFlavor: "browser_sandbox" } as any),
      chat,
    ),
  ).toBe(false);
});

test("recent sessions: compact relative time", () => {
  const now = 10 * 86_400_000;
  expect(shortRelativeTime(now - 5_000, now)).toBe("now");
  expect(shortRelativeTime(now - 5 * 60_000, now)).toBe("5m");
  expect(shortRelativeTime(now - 3 * 3_600_000, now)).toBe("3h");
  expect(shortRelativeTime(now - 2 * 86_400_000, now)).toBe("2d");
});

import { isSandboxSupportedByBuild } from "../src/client/browser-sandbox-availability";

test("sandbox build switch and JSPI capability", () => {
  const jspi = { Suspending: function () {}, promising: function () {} };
  expect(isSandboxSupportedByBuild(undefined, jspi)).toBe(true);
  expect(isSandboxSupportedByBuild("1", jspi)).toBe(true);
  expect(isSandboxSupportedByBuild("0", jspi)).toBe(false);
  expect(isSandboxSupportedByBuild("false", jspi)).toBe(false);
  expect(isSandboxSupportedByBuild(" FALSE ", jspi)).toBe(false);
  expect(isSandboxSupportedByBuild(undefined, {})).toBe(false);
  expect(isSandboxSupportedByBuild(undefined, { Suspending() {} })).toBe(false);
  expect(isSandboxSupportedByBuild(undefined, null)).toBe(false);
});
