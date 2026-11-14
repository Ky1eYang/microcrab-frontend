import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

for (const outcome of ["success", "failure"] as const) {
  test(`obsolete delete ${outcome} cannot change the replacement owner or popup`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(async (outcome) => {
      const { AppStore } = await import("/src/state/store.ts");
      const store: any = new AppStore();
      let resolve!: (value: any) => void;
      let reject!: (error: Error) => void;
      store.call = () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        });
      store.update({
        popup: { type: "archive", sessionId: "old", title: "Old", revision: 1 },
      });
      const pending = store.dispatch({ type: "ConfirmPopup" });
      store.lifecycle++;
      const replacement = {
        type: "archive",
        sessionId: "new",
        title: "New",
        pending: true,
      };
      store.update({
        sessionId: "new",
        popup: replacement,
        sessions: [],
        toast: null,
      });
      if (outcome === "success") resolve({ id: "old", archived: true });
      else reject(new Error("old owner's request failed"));
      await pending;
      const result = {
        popup: store.state.popup,
        selected: store.state.sessionId,
        toast: store.state.toast,
      };
      store.stop();
      return result;
    }, outcome);
    expect(result).toEqual({
      popup: { type: "archive", sessionId: "new", title: "New", pending: true },
      selected: "new",
      toast: null,
    });
  });
}

test("project delete closes confirmation and removes children before slow relay teardown settles", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    const calls: string[] = [];
    let release!: () => void;
    const teardown = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.call = async (method: string) => {
      calls.push(method);
      return { deleted: true };
    };
    store.api.disconnectHost = () => {
      calls.push("teardown");
      return teardown;
    };
    const project = { id: "p", name: "Project", root: "/workspace" };
    store.update({
      sessionId: "child",
      projects: [project],
      knownProjects: [project],
      sessions: [
        { id: "child", projectID: "p" },
        { id: "other", projectID: "other" },
      ],
      draftWorkspace: { kind: "local", projectId: "p", path: "/workspace" },
      hostConnection: { projectId: "p", state: "ready" },
      popup: { type: "deleteProject", projectId: "p", title: "Project" },
    });
    await store.dispatch({ type: "ConfirmPopup" });
    const result = {
      calls,
      popup: store.state.popup.type,
      selected: store.state.sessionId,
      sessions: store.state.sessions.map((session: any) => session.id),
      projects: store.state.projects.length,
      workspace: store.state.draftWorkspace.kind,
      host: store.state.hostConnection.state,
    };
    release();
    store.stop();
    return result;
  });
  expect(result).toEqual({
    calls: ["project.delete", "teardown"],
    popup: "none",
    selected: null,
    sessions: ["other"],
    projects: 0,
    workspace: "none",
    host: "detached",
  });
});

test("successful conversation delete stays closed when later view cleanup fails", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    store.call = async () => ({ id: "child", archived: true, revision: 2 });
    store.newChat = () => {
      throw Error("view cleanup failed");
    };
    store.update({
      sessionId: "child",
      sessions: [{ id: "child" }],
      popup: {
        type: "archive",
        sessionId: "child",
        title: "Child",
        revision: 1,
      },
    });
    await store.dispatch({ type: "ConfirmPopup" });
    const result = {
      popup: store.state.popup.type,
      sessions: store.state.sessions.length,
    };
    store.stop();
    return result;
  });
  expect(result).toEqual({ popup: "none", sessions: 0 });
});

test("failed conversation delete keeps a retryable confirmation and never retries automatically", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    let calls = 0;
    store.call = async () => {
      calls++;
      throw Error("revision changed");
    };
    store.update({
      popup: {
        type: "archive",
        sessionId: "child",
        title: "Child",
        revision: 1,
      },
    });
    await store.dispatch({ type: "ConfirmPopup" });
    const result = {
      calls,
      popup: store.state.popup.type,
      pending: store.state.popup.pending,
    };
    store.stop();
    return result;
  });
  expect(result).toEqual({ calls: 1, popup: "archive", pending: false });
});

for (const loss of ["timeout", "network"] as const) {
  for (const selected of [true, false]) {
    test(`committed archive with ${loss} reconciles its ${selected ? "selected" : "unselected"} target by idempotent replay`, async ({
      page,
    }) => {
      const backend = await nativeBackend(page);
      await page.goto("/");
      const requests: string[] = [];
      await page.route("**/api/v1/sessions/s1**", async (route) => {
        requests.push(route.request().method());
        if (route.request().method() !== "POST" || requests.length > 1)
          return route.fallback();
        // The server commits, but the browser never receives its acknowledgement.
        backend.snapshot().session.archived = true;
        backend.snapshot().session.revision++;
        if (loss === "network") return route.abort("connectionreset");
      });
      const result = await page.evaluate(
        async ({ selected }) => {
          const { AppStore } = await import("/src/state/store.ts");
          const store: any = new AppStore();
          const calls: string[] = [];
          store.call = (method: string, params: any, id: string) => {
            calls.push(`${method}:${id}`);
            if (method === "session.archive") {
              // Only the lost-ACK request uses the injected short timeout. The
              // normal replay must use the client's ordinary request budget.
              return calls.length === 1
                ? store.api.request(method, params, id, 100)
                : store.api.request(method, params, id);
            }
            throw Error(`unexpected mutation or subscription: ${method}`);
          };
          store.update({
            sessionId: selected ? "s1" : "other",
            sessions: [{ id: "s1" }, { id: "other" }],
            toast: null,
            popup: {
              type: "archive",
              sessionId: "s1",
              title: "Target",
              revision: 1,
            },
          });
          await store.dispatch({ type: "ConfirmPopup" });
          const result = {
            calls,
            popup: store.state.popup.type,
            selected: store.state.sessionId,
            sessions: store.state.sessions.map((session: any) => session.id),
            toast: store.state.toast,
          };
          store.stop();
          return result;
        },
        { selected },
      );
      expect(result).toEqual({
        calls: ["session.archive:s1", "session.archive:s1"],
        popup: "none",
        selected: selected ? null : "other",
        sessions: ["other"],
        toast: null,
      });
      // The replay is answered from the archived target state.
      expect(requests).toEqual(["POST", "POST"]);
    });
  }
}

for (const observation of ["failed", "not-archived", "wrong-target"] as const) {
  test(`unknown archive with ${observation} replay remains uncertain without resubscribe`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(async (observation) => {
      const { AppStore } = await import("/src/state/store.ts");
      const { CommandError } = await import("/src/client/api.ts");
      const store: any = new AppStore();
      const calls: string[] = [];
      store.call = async (method: string, _params: any, id: string) => {
        calls.push(`${method}:${id}`);
        if (method !== "session.archive")
          throw Error("unexpected resubscription");
        if (calls.length === 1)
          throw new CommandError(
            "timed_out",
            "Original archive outcome unknown",
            true,
            true,
          );
        if (observation === "failed") throw Error("archive replay failed");
        return {
          id: observation === "wrong-target" ? "other" : "target",
          archived: observation === "wrong-target",
        };
      };
      store.update({
        sessionId: "target",
        sessions: [{ id: "target" }],
        toast: null,
        popup: {
          type: "archive",
          sessionId: "target",
          title: "Target",
          revision: 1,
        },
      });
      await store.dispatch({ type: "ConfirmPopup" });
      const result = {
        calls,
        popup: store.state.popup.type,
        pending: store.state.popup.pending,
        selected: store.state.sessionId,
        sessions: store.state.sessions.length,
        toast: store.state.toast?.text,
      };
      store.stop();
      return result;
    }, observation);
    expect(result).toEqual({
      calls: ["session.archive:target", "session.archive:target"],
      popup: "archive",
      pending: false,
      selected: "target",
      sessions: 1,
      toast: "Original archive outcome unknown",
    });
  });
}

for (const replacement of ["owner", "popup"] as const) {
  test(`archive reconciliation cannot change a replacement ${replacement}`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(async (replacement) => {
      const { AppStore } = await import("/src/state/store.ts");
      const { CommandError } = await import("/src/client/api.ts");
      const store: any = new AppStore();
      let release!: (value: any) => void;
      let queried!: () => void;
      const queryStarted = new Promise<void>((resolve) => {
        queried = resolve;
      });
      let archives = 0;
      store.call = async (method: string) => {
        if (method !== "session.archive") throw Error("unexpected call");
        if (++archives === 1)
          throw new CommandError("timed_out", "unknown", true, true);
        queried();
        return new Promise((resolve) => {
          release = resolve;
        });
      };
      store.update({
        sessionId: "old",
        sessions: [{ id: "old" }],
        popup: { type: "archive", sessionId: "old" },
      });
      const pending = store.dispatch({ type: "ConfirmPopup" });
      await queryStarted;
      if (replacement === "owner") store.lifecycle++;
      const popup = { type: "archive", sessionId: "new", pending: true };
      store.update({
        sessionId: "new",
        sessions: [{ id: "new" }],
        popup,
        toast: null,
      });
      release({ id: "old", archived: true });
      await pending;
      const result = {
        popup: store.state.popup,
        selected: store.state.sessionId,
        sessions: store.state.sessions.map((session: any) => session.id),
        toast: store.state.toast,
      };
      store.stop();
      return result;
    }, replacement);
    expect(result).toEqual({
      popup: { type: "archive", sessionId: "new", pending: true },
      selected: "new",
      sessions: ["new"],
      toast: null,
    });
  });
}

test("confirmed delete calls session.delete once and removes the conversation", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    const calls: string[] = [];
    store.call = async (method: string) => {
      calls.push(method);
      return {
        deleted: true,
        session_id: "gone",
        removed_operation_receipts: 1,
      };
    };
    store.newChat = () => {
      store.update({ sessionId: null });
    };
    store.update({
      sessionId: "gone",
      sessions: [{ id: "gone" }, { id: "kept" }],
      popup: { type: "delete", sessionId: "gone", title: "Gone", revision: 4 },
    });
    await store.dispatch({ type: "ConfirmPopup" });
    const result = {
      calls,
      popup: store.state.popup.type,
      selected: store.state.sessionId,
      sessions: store.state.sessions.map((session: any) => session.id),
    };
    store.stop();
    return result;
  });
  expect(result).toEqual({
    calls: ["session.delete"],
    popup: "none",
    selected: null,
    sessions: ["kept"],
  });
});

for (const locale of ["en", "zh-CN"] as const) {
  for (const subtype of ["sticky", "nonsticky", "legacy"] as const) {
    test(`quarantined ${subtype} delete retains data and confirmation with ${locale} diagnostics`, async ({
      page,
    }) => {
      await nativeBackend(page);
      await page.goto("/");
      const requests: string[] = [];
      const details = {
        quarantined: true,
        ...(subtype === "legacy"
          ? {}
          : {
              sticky_failure: subtype === "sticky",
              session_cleanup_unresolved: true,
              session_cleanup_failure: {
                code: "session_cleanup_pending",
                message: "Safe session cleanup pending detail.",
              },
              reconciliation_failure: {
                code: "reconciliation_failed",
                message: "Safe reconciliation detail.",
              },
              cleanup_failures: [
                {
                  stage: "session",
                  code: "cleanup_failed",
                  message: "Safe exact cleanup result: worker did not finish.",
                  private_field: "must not be rendered",
                },
                {
                  stage: "future_stage",
                  code: "future_code",
                  message: "Safe future stage detail.",
                },
                null,
                { stage: "ledger", code: 42, message: "invalid entry" },
              ],
            }),
      };
      await page.route("**/api/v1/sessions/s1**", async (route) => {
        requests.push(route.request().method());
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "operation_failed",
              message: "Deletion rejected: exact safe error body.",
              retryable: false,
              details,
            },
          }),
        });
      });
      const result = await page.evaluate(async (locale) => {
        const { AppStore } = await import("/src/state/store.ts");
        const { setActiveLocale } = await import("/src/i18n/index.ts");
        const store: any = new AppStore();
        setActiveLocale(locale);
        const calls: string[] = [];
        const actions: string[] = [];
        const dispatch = store.dispatch.bind(store);
        store.dispatch = async (action: any) => {
          actions.push(action.type);
          return dispatch(action);
        };
        store.call = (method: string, params: any, id: string) => {
          calls.push(`${method}:${id}`);
          if (method === "session.delete")
            return store.api.request(method, params, id);
          throw Error(`unexpected open, refresh or replay: ${method}`);
        };
        store.newChat = () => {
          calls.push("newChat");
        };
        store.update({
          sessionId: "s1",
          sessions: [{ id: "s1" }, { id: "other" }],
          toast: null,
          popup: {
            type: "delete",
            sessionId: "s1",
            title: "Target",
            revision: 1,
          },
        });
        const pending = store.dispatch({ type: "ConfirmPopup" });
        await store.dispatch({ type: "ConfirmPopup" });
        await pending;
        const result = {
          calls,
          actions,
          popup: store.state.popup,
          selected: store.state.sessionId,
          sessions: store.state.sessions.map((session: any) => session.id),
          toast: store.state.toast?.text,
        };
        store.stop();
        return result;
      }, locale);
      const explanation =
        locale === "en"
          ? subtype === "sticky"
            ? "Deletion blocked. Session data is retained. A cleanup failure requires investigation."
            : "Deletion blocked. Cleanup has not completed; session data is retained."
          : subtype === "sticky"
            ? "删除受阻，会话数据已保留。清理失败需要进一步排查。"
            : "删除受阻，清理尚未完成，会话数据已保留。";
      const lines = [explanation, "Deletion rejected: exact safe error body."];
      if (subtype !== "legacy") {
        lines.push(
          locale === "en"
            ? "Session close [session_cleanup_pending]: Safe session cleanup pending detail."
            : "会话关闭 [session_cleanup_pending]：Safe session cleanup pending detail.",
          locale === "en"
            ? "Host reconciliation [reconciliation_failed]: Safe reconciliation detail."
            : "Host 对账 [reconciliation_failed]：Safe reconciliation detail.",
          locale === "en"
            ? "Session [cleanup_failed]: Safe exact cleanup result: worker did not finish."
            : "会话 [cleanup_failed]：Safe exact cleanup result: worker did not finish.",
          locale === "en"
            ? "future_stage [future_code]: Safe future stage detail."
            : "future_stage [future_code]：Safe future stage detail.",
        );
      }
      expect(result).toEqual({
        calls: ["session.delete:s1"],
        actions: ["ConfirmPopup", "ConfirmPopup"],
        popup: {
          type: "delete",
          sessionId: "s1",
          title: "Target",
          revision: 1,
          pending: false,
        },
        selected: "s1",
        sessions: ["s1", "other"],
        toast: lines.join("\n"),
      });
      expect(requests).toEqual(["DELETE"]);
    });
  }
}

for (const replacement of ["owner", "popup"] as const) {
  test(`quarantined delete rejection cannot change a replacement ${replacement}`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(async (replacement) => {
      const { AppStore } = await import("/src/state/store.ts");
      const { CommandError } = await import("/src/client/api.ts");
      const store: any = new AppStore();
      const calls: string[] = [];
      let reject!: (error: Error) => void;
      store.call = (method: string) => {
        calls.push(method);
        return new Promise((_resolve, no) => {
          reject = no;
        });
      };
      store.update({
        sessionId: "old",
        sessions: [{ id: "old" }],
        popup: { type: "delete", sessionId: "old", revision: 1 },
      });
      const pending = store.dispatch({ type: "ConfirmPopup" });
      if (replacement === "owner") store.lifecycle++;
      store.update({
        sessionId: "new",
        sessions: [{ id: "new" }],
        popup:
          replacement === "owner"
            ? store.state.popup
            : { type: "delete", sessionId: "new", pending: true },
        toast: null,
      });
      reject(
        new CommandError(
          "operation_failed",
          "Old owner's cleanup failed",
          false,
          false,
          {
            quarantined: true,
            sticky_failure: true,
            cleanup_failures: [
              { stage: "session", code: "failed", message: "Old detail" },
            ],
          },
        ),
      );
      await pending;
      const result = {
        calls,
        popup: store.state.popup,
        selected: store.state.sessionId,
        sessions: store.state.sessions.map((session: any) => session.id),
        toast: store.state.toast,
      };
      store.stop();
      return result;
    }, replacement);
    expect(result).toEqual({
      calls: ["session.delete"],
      popup:
        replacement === "owner"
          ? { type: "delete", sessionId: "old", revision: 1, pending: true }
          : { type: "delete", sessionId: "new", pending: true },
      selected: "new",
      sessions: ["new"],
      toast: null,
    });
  });
}

for (const diagnostics of ["pending-only", "bounded"] as const) {
  test(`quarantined delete renders ${diagnostics} allowlisted diagnostics`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(async (diagnostics) => {
      const { AppStore } = await import("/src/state/store.ts");
      const { CommandError } = await import("/src/client/api.ts");
      const { setActiveLocale } = await import("/src/i18n/index.ts");
      const store: any = new AppStore();
      setActiveLocale("en");
      const calls: string[] = [];
      store.call = async (method: string) => {
        calls.push(method);
        throw new CommandError(
          "operation_failed",
          "Exact safe rejection.",
          false,
          false,
          {
            quarantined: true,
            sticky_failure: false,
            session_cleanup_unresolved: true,
            session_cleanup_failure: {
              code: "cleanup_pending",
              message: "Close still pending.",
              private_field: "must not be rendered",
            },
            cleanup_failures:
              diagnostics === "bounded"
                ? Array.from({ length: 15 }, (_, index) => ({
                    stage: "ledger",
                    code: `failure_${index}`,
                    message: `Safe detail ${index}`,
                  }))
                : [],
            arbitrary_body: "must not be rendered",
          },
        );
      };
      store.update({
        sessionId: "kept",
        sessions: [{ id: "kept" }],
        popup: { type: "delete", sessionId: "kept" },
      });
      await store.dispatch({ type: "ConfirmPopup" });
      const result = {
        calls,
        popup: store.state.popup,
        selected: store.state.sessionId,
        sessions: store.state.sessions.map((session: any) => session.id),
        toast: store.state.toast?.text,
      };
      store.stop();
      return result;
    }, diagnostics);
    const lines = [
      "Deletion blocked. Cleanup has not completed; session data is retained.",
      "Exact safe rejection.",
      "Session close [cleanup_pending]: Close still pending.",
    ];
    if (diagnostics === "bounded")
      for (let index = 0; index < 11; index++)
        lines.push(`Ledger [failure_${index}]: Safe detail ${index}`);
    expect(result).toEqual({
      calls: ["session.delete"],
      popup: { type: "delete", sessionId: "kept", pending: false },
      selected: "kept",
      sessions: ["kept"],
      toast: lines.join("\n"),
    });
  });
}

test("unknown delete outcome replays once against the tombstone and refreshes the list when that fails too", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const { CommandError } = await import("/src/client/api.ts");
    const store: any = new AppStore();
    const calls: string[] = [];
    let refreshed = 0;
    const dispatch = store.dispatch.bind(store);
    store.call = async (method: string) => {
      calls.push(method);
      throw new CommandError("outcome_unknown", "unknown", true, true);
    };
    store.dispatch = async (action: any) => {
      if (action.type === "RefreshSessions") {
        refreshed++;
        return undefined;
      }
      return dispatch(action);
    };
    store.update({
      sessionId: "gone",
      sessions: [{ id: "gone" }],
      popup: { type: "delete", sessionId: "gone", title: "Gone", revision: 4 },
    });
    await store.dispatch({ type: "ConfirmPopup" });
    store.stop();
    return { calls, refreshed, popup: store.state.popup.type };
  });
  // Deletion is idempotent, so the only replay is answered by the tombstone.
  expect(result).toEqual({
    calls: ["session.delete", "session.delete"],
    refreshed: 1,
    popup: "none",
  });
});
