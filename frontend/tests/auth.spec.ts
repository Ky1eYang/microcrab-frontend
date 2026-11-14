import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";
test("startup unauthenticated probe navigates once without a second auth request", async ({
  page,
}) => {
  const paths: string[] = [];
  let navigations = 0;
  await page.route("**/api/auth/session", (route) => {
    paths.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      status: 401,
      json: { error: { code: "unauthenticated" } },
    });
  });
  await page.route("**/api/auth/login", (route) => {
    navigations++;
    return route.fulfill({
      contentType: "text/html",
      body: "<h1>Fixture identity provider</h1>",
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Fixture identity provider" }),
  ).toBeVisible();
  expect(navigations).toBe(1);
  expect(paths).toEqual(["/api/auth/session", "/api/auth/session"]);
  await page.goto("/");
  await expect(page.getByTestId("auth-login-submit")).toBeEnabled();
  await expect(page).toHaveURL(/\/login$/);
  expect(paths).toEqual(Array(4).fill("/api/auth/session"));
  expect(navigations).toBe(1);
});
test("credentials are absent from query and localStorage; logout uses the auth POST exception", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/");
  await expect
    .poll(() =>
      backend.requests.some(
        (request) =>
          request.method === "GET" && request.path === "/api/v1/capabilities",
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Test User", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByText(/HttpOnly Cookie/)).toBeVisible();
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.some((key) => /apiKey|token/i.test(key))).toBe(false);
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect.poll(() => backend.http.includes("/api/auth/logout")).toBe(true);
  expect(backend.nativeUrls.length).toBeGreaterThan(0);
  expect(backend.nativeUrls.every((url) => !new URL(url).search)).toBe(true);
});

test("logout from a conversation POSTs auth logout and returns to the sign-in home", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const methods: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/logout")
      methods.push(request.method());
  });
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await page.locator(".user-card-btn").first().click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByTestId("auth-login-submit")).toBeEnabled();
  await expect(page.locator(".user-card-name")).toHaveCount(0);
  await expect(page.getByText("历史回答", { exact: true })).toHaveCount(0);
  await expect.poll(() => backend.http.includes("/api/auth/logout")).toBe(true);
  expect(methods).toEqual(["POST"]);
  await expect(page).toHaveURL(/\/login\?signed_out=1$/);
});

test("logout follows the AuthPortal end-session redirect from the server", async ({
  page,
  baseURL,
}) => {
  const target = new URL("/login?signed_out=1", baseURL).toString();
  await nativeBackend(page, { logoutRedirect: target });
  await page.goto("/");
  await page.getByRole("button", { name: "Test User", exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page).toHaveURL(target);
});

test("session deadline alone shows sign-in feedback without replaying mutations", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const start = new Date("2030-01-01T00:00:00Z");
  await page.clock.install({ time: start });
  let expired = false;
  let checks = 0;
  await page.route("**/api/auth/session", (route) => {
    checks++;
    return route.fulfill(
      expired
        ? {
            status: 401,
            json: { error: { code: "unauthenticated", message: "Sign in" } },
          }
        : {
            json: {
              authenticated: true,
              principal: {
                owner: "u1",
                subject: "sub1",
                display_name: "Test User",
                expires_at: start.getTime() / 1000 + 60,
              },
            },
          },
    );
  });
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await connectHostUI(page);
  const composer = page.locator('[data-testid="composer"] textarea');
  await composer.fill("deadline draft");
  const mutations = () =>
    backend.requests.filter((request) => request.method !== "GET");
  const before = mutations().length;
  const sent = backend.commands.length;
  const checked = checks;
  expired = true;
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Fixture identity provider</h1>",
    }),
  );
  await page.clock.fastForward(61000);
  await expect(
    page.getByRole("heading", { name: "Fixture identity provider" }),
  ).toBeVisible();
  const saved = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("microcrab.auth-return.v1")!),
  );
  expect(saved).toMatchObject({
    owner: "u1",
    route: "/#session/s1",
    composer: "deadline draft",
  });
  expect(checks).toBeGreaterThan(checked);
  expect(mutations()).toHaveLength(before);
  expect(backend.commands).toHaveLength(sent);
});

test("foreground expiry preserves the conversation and draft with immediate sign-in feedback", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await connectHostUI(page);
  const composer = page.locator('[data-testid="composer"] textarea');
  await composer.fill("keep my unsent draft");
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "unauthenticated", message: "Sign in" } },
    }),
  );
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Fixture identity provider</h1>",
    }),
  );
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(
    page.getByRole("heading", { name: "Fixture identity provider" }),
  ).toBeVisible();
  const saved = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("microcrab.auth-return.v1")!),
  );
  expect(saved).toMatchObject({
    owner: "u1",
    route: "/#session/s1",
    composer: "keep my unsent draft",
  });
  await page.unroute("**/api/auth/session");
  await page.goto("/");
  await expect(page).toHaveURL(/#session\/s1$/);
  await expect(page.locator('[data-testid="composer"] textarea')).toHaveValue(
    "keep my unsent draft",
  );
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("microcrab.auth-return.v1"),
    ),
  ).toBeNull();
});

test("HTTP 401 publishes authentication failure even when the body is unreadable", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  const value = await page.evaluate(async () => {
    const path = "/src/client/api.ts";
    const { ApiClient } = await import(path);
    const client = new ApiClient(location.origin);
    let required = 0;
    client.connect({ authRequired: () => required++ });
    const original = window.fetch;
    window.fetch = async () => new Response("not-json", { status: 401 });
    try {
      await client.request("server.capabilities");
      return { required, code: "unexpected_success" };
    } catch (error: any) {
      return { required, code: error.code, unknown: error.outcomeUnknown };
    } finally {
      window.fetch = original;
      client.stop();
    }
  });
  expect(value).toEqual({
    required: 1,
    code: "unauthenticated",
    unknown: false,
  });
});

test("HTTP 401 keeps an admitted mutation receipt while auth suspension stops the client", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  let sent = 0;
  await page.route("**/api/v1/sessions", (route) => {
    sent++;
    return route.fulfill({
      status: 401,
      json: {
        error: {
          code: "outcome_unknown",
          message: "Authentication revoked after admission",
          details: { operation_id: "retained-operation" },
        },
      },
    });
  });
  const result = await page.evaluate(async () => {
    const path = "/src/client/api.ts";
    const { ApiClient } = await import(path);
    const client = new ApiClient(location.origin);
    let required = 0;
    client.connect({
      authRequired: () => {
        required++;
        client.stop();
      },
    });
    try {
      await client.request("session.create", {
        operation_id: "retained-operation",
      });
      return { code: "unexpected_success", required };
    } catch (error: any) {
      return {
        code: error.code,
        unknown: error.outcomeUnknown,
        details: error.details,
        required,
      };
    } finally {
      client.stop();
    }
  });
  expect(result).toEqual({
    code: "outcome_unknown",
    unknown: true,
    details: { operation_id: "retained-operation" },
    required: 1,
  });
  expect(sent).toBe(1);
});

test("login return context is one-use and isolated by verified owner", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/client/auth.ts";
    const { rememberAuthReturn, takeAuthReturn } = await import(path);
    rememberAuthReturn("owner-a", "#session/s1", "unsent");
    const foreign = takeAuthReturn("owner-b");
    const consumed = takeAuthReturn("owner-a");
    rememberAuthReturn("owner-a", "#session/s1", "unsent");
    const own = takeAuthReturn("owner-a");
    return {
      foreign,
      consumed,
      route: own?.route,
      composer: own?.composer,
      replay: takeAuthReturn("owner-a"),
    };
  });
  expect(result).toEqual({
    foreign: null,
    consumed: null,
    route: "/#session/s1",
    composer: "unsent",
    replay: null,
  });
});

test("login return preserves bounded drafts after worst-case JSON escaping", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/client/auth.ts";
    const { rememberAuthReturn, takeAuthReturn } = await import(path);
    const drafts = ['"\\'.repeat(131072), "\u0000".repeat(262144)];
    return drafts.map((draft) => {
      rememberAuthReturn("owner-a", "#/session/s1", draft + "overflow");
      const raw = sessionStorage.getItem("microcrab.auth-return.v1")!;
      const own = takeAuthReturn("owner-a");
      return {
        encoded: raw.length,
        exact: own?.composer === draft,
        route: own?.route,
        replay: takeAuthReturn("owner-a"),
      };
    });
  });
  for (const item of result) {
    expect(item.encoded).toBeGreaterThan(300000);
    expect(item.exact).toBe(true);
    expect(item.route).toBe("/#/session/s1");
    expect(item.replay).toBeNull();
  }
});

test("login page explains an identity-provider error", async ({ page }) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "unauthenticated", message: "Sign in" } },
    }),
  );
  await page.goto("/login?auth_error=access_denied");
  await expect(page.locator("body")).toContainText(/拒绝|取消/);
  const messages = await page.evaluate(async () => {
    const localePath = "/src/i18n/index.ts";
    const loginPath = "/src/login.tsx";
    const { setActiveLocale } = await import(localePath);
    const { authErrorMessage } = await import(loginPath);
    setActiveLocale("en");
    try {
      return {
        denied: authErrorMessage("?auth_error=access_denied"),
        unknown: authErrorMessage(
          "?auth_error=provider-secret&error_description=private-details",
        ),
        absent: authErrorMessage("?error_description=private-details"),
      };
    } finally {
      setActiveLocale("zh-CN");
    }
  });
  expect(messages).toEqual({
    denied: "Sign-in was cancelled or denied.",
    unknown: "Sign-in failed. Try again.",
    absent: "",
  });
});

test("auth navigation barrier waits for the complete received401 operation receipt", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { ApiClient } = await import("/src/client/api.ts");
    const client = new ApiClient(location.origin);
    const original = window.fetch;
    const caller = new AbortController();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    let notified!: () => void;
    const required = new Promise<void>((resolve) => {
      notified = resolve;
    });
    let navigationReady = false;
    let barrier: Promise<void> | undefined;
    client.connect({
      authRequired: () => {
        caller.abort(new DOMException("Owner revoked", "AbortError"));
        client.stop();
        barrier = client.finishAuthReceipts().then(() => {
          navigationReady = true;
        });
        notified();
      },
    });
    window.fetch = async (_input, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(init.signal?.reason),
              { once: true },
            );
          },
        }),
        { status: 401 },
      );
    try {
      const receipt = client
        .request(
          "session.create",
          { operation_id: "delayed-receipt" },
          undefined,
          10000,
          undefined,
          caller.signal,
        )
        .catch((error: any) => ({
          code: error.code,
          unknown: error.outcomeUnknown,
          details: error.details,
        }));
      await required;
      await Promise.resolve();
      const beforeBody = navigationReady;
      body.enqueue(
        new TextEncoder().encode(
          JSON.stringify({
            error: {
              code: "outcome_unknown",
              message: "Authentication revoked after admission",
              details: { operation_id: "delayed-receipt" },
            },
          }),
        ),
      );
      body.close();
      const outcome = await receipt;
      await barrier;
      return { beforeBody, navigationReady, outcome };
    } finally {
      window.fetch = original;
      client.stop();
    }
  });
  expect(result).toEqual({
    beforeBody: false,
    navigationReady: true,
    outcome: {
      code: "outcome_unknown",
      unknown: true,
      details: { operation_id: "delayed-receipt" },
    },
  });
});

test("return context permits existing local routes and rejects external or auth destinations", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { validAuthReturnRoute, rememberAuthReturn, takeAuthReturn } =
      await import("/src/client/auth.ts");
    const valid = [
      "/",
      "/#dashboard",
      "/dashboard",
      "/session/s1",
      "/#session/s1/sub/c1",
      "/plugins",
      "/#plugins/state",
      "/#session/s1/plugins/state",
    ];
    const invalid = [
      "https://evil.example/",
      "//evil.example/",
      "/login",
      "/api/auth/callback",
      "/?return_to=evil",
      "/#session/s1#other",
      "/\\\\evil",
      "/#session/s1\n",
    ];
    rememberAuthReturn("u1", "/session/s1/plugins/state", "draft");
    const own = takeAuthReturn("u1");
    rememberAuthReturn("u1", "/#session/s1", "private draft");
    const foreign = takeAuthReturn("u2");
    return {
      valid: valid.map(validAuthReturnRoute),
      invalid: invalid.map(validAuthReturnRoute),
      route: own?.route,
      foreign,
      replay: takeAuthReturn("u1"),
    };
  });
  expect(result).toEqual({
    valid: Array(8).fill(true),
    invalid: Array(8).fill(false),
    route: "/session/s1/plugins/state",
    foreign: null,
    replay: null,
  });
});

test("cancelled auth leave retains read-only dirty text after editor teardown; discard resumes login", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const reactPath = "/node_modules/.vite/deps/react.js";
    const domPath = "/node_modules/.vite/deps/react-dom_client.js";
    const viewerPath = "/src/features/content-inspection/ContentViewer.tsx";
    const { default: React } = await import(reactPath);
    const { default: ReactDOM } = await import(domPath);
    const { ContentViewer } = await import(viewerPath);
    const element = document.createElement("div");
    element.dataset.testid = "revoked-editor";
    document.body.append(element);
    const fixture = { root: ReactDOM.createRoot(element), saves: 0 };
    (window as any).__revokedEditor = fixture;
    fixture.root.render(
      React.createElement(ContentViewer, {
        source: "original",
        title: "Document draft",
        onEdit: async () => {
          fixture.saves++;
        },
      }),
    );
    window.addEventListener("beforeunload", () => fixture.root.unmount(), {
      once: true,
    });
  });
  const editor = page.getByTestId("revoked-editor");
  await editor.getByTestId("content-viewer-edit").click();
  await editor
    .getByTestId("content-viewer-editor")
    .fill("unsaved text must remain recoverable");
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Fixture identity provider</h1>",
    }),
  );
  const warning = page.waitForEvent("dialog");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const dialog = await warning;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  const recovery = page.getByTestId("recovered-document-drafts");
  await expect(recovery).toContainText("unsaved text must remain recoverable");
  await expect(editor.getByTestId("content-viewer-editor")).toHaveCount(0);
  await expect(recovery.getByTestId("content-viewer-edit")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__revokedEditor.saves)).toBe(
    0,
  );
  const snapshot = await page.evaluate(async () => {
    const path = "/src/client/document-leave.ts";
    const { recoveredDraftsSnapshot } = await import(path);
    return recoveredDraftsSnapshot();
  });
  expect(snapshot).toEqual({
    owner: "u1",
    drafts: [
      { label: "Document draft", text: "unsaved text must remain recoverable" },
    ],
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await recovery.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Fixture identity provider" }),
  ).toBeVisible();
});

test("foreground verified owner change discards old recovery without capturing drafts or invoking its leave", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Test User", exact: true }),
  ).toBeVisible();
  const result = await page.evaluate(async () => {
    const storePath = "/src/state/store.ts";
    const leavePath = "/src/client/document-leave.ts";
    const authPath = "/src/client/auth.ts";
    const { AppStore } = await import(storePath);
    const {
      registerDocumentLeave,
      retainDocumentDrafts,
      recoveredDraftsSnapshot,
      discardRecoveredDrafts,
    } = await import(leavePath);
    const { rememberAuthReturn } = await import(authPath);
    const root = document.createElement("div");
    document.body.append(root);
    let captures = 0;
    let oldLeave = 0;
    const unregister = registerDocumentLeave(
      () => root,
      () => false,
      () => {
        captures++;
        return { label: "Old owner's document", text: "private unsaved text" };
      },
    );
    retainDocumentDrafts("u1", () => {
      oldLeave++;
    });
    rememberAuthReturn("u1", "/#session/s1", "private composer");
    captures = 0;
    const store: any = new AppStore();
    store.started = true;
    store.state = {
      ...store.state,
      authSession: {
        authenticated: true,
        principal: {
          owner: "u1",
          subject: "old",
          display_name: "Old owner",
          expires_at: 9999999999,
        },
      },
      composer: "private composer",
    };
    store.api.browserSession = async () => ({
      authenticated: true,
      principal: {
        owner: "u2",
        subject: "new",
        display_name: "New owner",
        expires_at: 9999999999,
      },
    });
    // Hold document navigation so it cannot hide an incorrect recovery snapshot.
    store.api.finishAuthReceipts = () => new Promise<void>(() => {});
    let stopped = 0;
    const stop = store.api.stop.bind(store.api);
    store.api.stop = () => {
      stopped++;
      stop();
    };
    try {
      store.foregroundAuth();
      await store.authCheck;
      const leave = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(leave);
      return {
        captures,
        oldLeave,
        recovery: recoveredDraftsSnapshot(),
        oldReturn: sessionStorage.getItem("microcrab.auth-return.v1"),
        protectedLeave: leave.defaultPrevented,
        authRequired: store.state.authRequired,
        authenticated: store.state.authSession.authenticated,
        stopped,
      };
    } finally {
      unregister();
      root.remove();
      discardRecoveredDrafts(false);
      store.stop();
    }
  });
  expect(result).toEqual({
    captures: 0,
    oldLeave: 0,
    recovery: null,
    oldReturn: null,
    protectedLeave: false,
    authRequired: true,
    authenticated: false,
    stopped: 1,
  });
});

test("HTTP diagnostics are bounded sanitized snapshots with status and no raw body or live error references", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/#session/s1");
  const result = await page.evaluate(async () => {
    const { ApiClient } = await import("/src/client/api.ts");
    const {
      diagnosticText,
      diagnosticMessage,
      reportDiagnostic,
      silenceDiagnostic,
    } = await import("/src/client/diagnostics.ts");
    const client = new ApiClient(location.origin);
    const originalFetch = window.fetch,
      originalConsole = console.error;
    const logs: unknown[][] = [];
    console.error = (...args) => {
      logs.push(args);
    };
    window.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "provider",
            message: "DNS lookup failed api_key=secret-key",
            details: {
              provider_status: 502,
              raw_os_error: -3,
              reason: "Could not connect",
              body: "secret-body",
              diagnostic: {
                reason: "invalid field",
                json_line: 3,
                tool_args: "secret-args",
              },
            },
          },
        }),
        { status: 502 },
      );
    try {
      await client.request("model.list").catch(() => {});
      const error = Object.assign(
        new Error("TLS handshake failed token=secret-token"),
        { details: { line: 7, prompt: "secret-prompt" } },
      );
      reportDiagnostic("fixture", "local", error);
      error.message = "mutated after reporting";
      error.details.line = 99;
      reportDiagnostic("fixture", "duplicate", error);
      const cancelled = new Error("intentional shutdown");
      silenceDiagnostic(cancelled);
      reportDiagnostic("fixture", "cancelled", cancelled);
      const encoder = new TextEncoder();
      const inputs = ["ab中🙂tail", "中🙂abtail", "é🙂中tail", "🙂中éabcdef"];
      const bounded = inputs.flatMap((input) =>
        Array.from({ length: 9 }, (_, maximum) => {
          const output = diagnosticText(input, maximum);
          return {
            input,
            maximum,
            output,
            bytes: encoder.encode(output).length,
          };
        }),
      );
      const long = "中🙂 ".repeat(2000);
      return {
        logs,
        scanned: diagnosticText("x".repeat(20000), 32768),
        syntax: diagnosticMessage(
          new SyntaxError(
            'Unexpected token in "secret-json-body" at position 7',
          ),
        ),
        retainedError: logs.some((args) => args.includes(error)),
        bounded,
        tiny: [
          diagnosticText("ab中tail", 0),
          diagnosticText("ab中tail", 1),
          diagnosticText("ab中tail", 2),
          diagnosticText("é🙂tail", 1),
          diagnosticText("é🙂tail", 2),
        ],
        invalidCaps: [NaN, Infinity, -Infinity, -1, -0.5].map((maximum) =>
          diagnosticText(long, maximum),
        ),
        fractional: diagnosticText("ab中tail", 2.9),
        ordinary: [
          encoder.encode(diagnosticText(long)).length,
          encoder.encode(diagnosticText(long, 4096)).length,
        ],
      };
    } finally {
      console.error = originalConsole;
      window.fetch = originalFetch;
      client.stop();
    }
  });
  expect(result.logs).toHaveLength(2);
  expect(result.logs[0][1]).toMatchObject({
    source: "http",
    method: "GET",
    status: 502,
    code: "provider",
    details: { raw_os_error: -3, provider_status: 502 },
  });
  expect(result.logs[1][1]).toMatchObject({
    message: "TLS handshake failed token=[redacted]",
    details: { line: 7 },
  });
  expect(result.retainedError).toBe(false);
  expect(result.scanned.endsWith("…")).toBe(true);
  expect(new TextEncoder().encode(result.scanned).length).toBeLessThanOrEqual(
    16387,
  );
  expect(result.syntax).toContain("position 7");
  expect(result.syntax).not.toContain("secret-json-body");
  for (const row of result.bounded) {
    expect(row.bytes).toBeLessThanOrEqual(row.maximum);
    expect(row.output).not.toContain("\uFFFD");
    expect(row.input.startsWith(row.output.replace(/…$/u, ""))).toBe(true);
  }
  expect(result.tiny).toEqual(["", "a", "ab", "", "é"]);
  expect(result.invalidCaps).toEqual(["", "", "", "", ""]);
  expect(result.fractional).toBe("ab");
  expect(result.ordinary[0]).toBeLessThanOrEqual(2048);
  expect(result.ordinary[1]).toBeLessThanOrEqual(4096);
  for (const secret of [
    "secret-key",
    "secret-body",
    "secret-args",
    "secret-token",
    "secret-prompt",
    "mutated after reporting",
  ])
    expect(JSON.stringify(result.logs)).not.toContain(secret);
});
