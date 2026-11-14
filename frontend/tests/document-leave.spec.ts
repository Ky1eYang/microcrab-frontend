import { expect, test } from "@playwright/test";
import { documentLeaveSelector } from "../src/client/document-leave-actions";
import type { AppState } from "../src/client/types";
import {
  registerDocumentLeave,
  requestDocumentLeave,
} from "../src/client/document-leave";

test("only destructive user intents consult their exact document surfaces", () => {
  const state = {
    rightRailCollapsed: false,
    rightOverlayOpen: true,
    sessionId: "s1",
    page: "conversation",
    sessionPluginTab: { sessionId: "s1", pluginId: "test" },
  } as AppState;
  expect(documentLeaveSelector({ type: "ToggleRightRail" }, state)).toBe(
    ".right-sidebar-shell",
  );
  expect(
    documentLeaveSelector({ type: "SetRightOverlay", value: true }, state),
  ).toBeUndefined();
  expect(
    documentLeaveSelector({ type: "Attach", value: "s1" }, state),
  ).toBeUndefined();
  expect(
    documentLeaveSelector({ type: "Attach", value: "s2" }, state),
  ).toBeNull();
  expect(
    documentLeaveSelector(
      { type: "SelectViewTab", value: "trajectory" },
      state,
    ),
  ).toContain("session-plugin-panel");
  expect(
    documentLeaveSelector({ type: "HistoryReset" }, state),
  ).toBeUndefined();
  expect(documentLeaveSelector({ type: "RequireAuth" }, state)).toBeUndefined();
});

function root(scope = ".test-surface") {
  return {
    isConnected: true,
    closest: (selector: string) => (selector === scope ? {} : null),
  } as unknown as HTMLElement;
}

test("document leave checks only its surface and resumes each exact discard once", () => {
  const first = root();
  const second = root();
  const unrelated = root(".other-surface");
  const requests: (() => void)[] = [];
  const dirty = [true, true];
  const cleanups = [
    registerDocumentLeave(
      () => first,
      (proceed) => {
        if (!dirty[0]) return true;
        requests.push(() => {
          dirty[0] = false;
          proceed!();
        });
        return false;
      },
    ),
    registerDocumentLeave(
      () => second,
      (proceed) => {
        if (!dirty[1]) return true;
        requests.push(() => {
          dirty[1] = false;
          proceed!();
        });
        return false;
      },
    ),
    registerDocumentLeave(
      () => unrelated,
      () => {
        throw new Error("unrelated editor was consulted");
      },
    ),
  ];
  try {
    let navigated = 0;
    expect(requestDocumentLeave(() => navigated++, ".test-surface")).toBe(
      false,
    );
    expect(requests).toHaveLength(1);
    expect(navigated).toBe(0);
    requests[0]();
    requests[0]();
    expect(requests).toHaveLength(2);
    requests[1]();
    requests[1]();
    expect(navigated).toBe(1);
  } finally {
    cleanups.forEach((cleanup) => cleanup());
  }
});

test("confirmation rechecks earlier documents and a newer leave supersedes the old intent", () => {
  const element = root();
  const dirty = [false, true];
  const requests: (() => void)[] = [];
  const cleanups = dirty.map((_, index) =>
    registerDocumentLeave(
      () => element,
      (proceed) => {
        if (!dirty[index]) return true;
        requests.push(() => {
          dirty[index] = false;
          proceed!();
        });
        return false;
      },
    ),
  );
  try {
    const navigation: string[] = [];
    requestDocumentLeave(() => navigation.push("old"));
    dirty[0] = true;
    requests[0]();
    expect(requests).toHaveLength(2);
    expect(navigation).toEqual([]);
    requestDocumentLeave(() => navigation.push("new"));
    requests[1]();
    expect(navigation).toEqual([]);
    requests[2]();
    expect(navigation).toEqual(["new"]);
  } finally {
    cleanups.forEach((cleanup) => cleanup());
  }
});

test("saving veto and revoked document never execute an old leave intent", () => {
  const element = root();
  let resumed: (() => void) | undefined;
  let navigated = 0;
  const removeSaving = registerDocumentLeave(
    () => element,
    () => false,
  );
  expect(requestDocumentLeave(() => navigated++)).toBe(false);
  expect(navigated).toBe(0);
  removeSaving();
  const revoke = registerDocumentLeave(
    () => element,
    (proceed) => {
      resumed = proceed;
      return false;
    },
  );
  expect(requestDocumentLeave(() => navigated++)).toBe(false);
  revoke();
  resumed!();
  expect(navigated).toBe(0);
  expect(requestDocumentLeave(() => navigated++)).toBe(true);
  expect(navigated).toBe(1);
});
