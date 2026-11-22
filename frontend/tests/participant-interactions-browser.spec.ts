import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { CLIENT_TOOL_DEFINITIONS } from "../src/client/client-tools";
import type {
  ClientBinding,
  ClientInvocation,
} from "../src/client/client-tool-controller";

// Never capture Secret inputs, even though this suite uses synthetic values.
test.use({ trace: "off", screenshot: "off", video: "off" });
// Playwright can also collect an automatic failure ARIA snapshot during teardown.
test.afterEach(async ({ page }) => {
  if (!page.isClosed()) {
    await page
      .getByTestId("secret-request")
      .locator("input")
      .evaluateAll((inputs) => {
        for (const input of inputs) (input as HTMLInputElement).value = "";
      });
  }
});

function interaction(tool = "request_secret"): ClientInvocation {
  return {
    invocation_id: "human-request",
    parent_session_id: "s1",
    session_id: "s1",
    call_id: "human-call",
    tool,
    arguments:
      tool === "request_secret"
        ? {
            reason: "Authenticate the selected service",
            secrets: [
              {
                key: "TOKEN",
                label: "Service token",
                description: "Token for the selected service",
              },
              { key: "CODE", label: "Verification code" },
            ],
          }
        : {
            questions: [
              {
                id: "q",
                question: "![Scoped preview](picture.png)",
                options: [{ id: "yes", label: "Accept" }],
              },
            ],
            blocking_mode: "deferred",
          },
    epoch: 0,
    turn_id: 1,
    round_id: 1,
    catalog_digest: "human-catalog",
    status: "pending",
    interaction: true,
    blocking_mode: tool === "request_secret" ? "blocking" : "deferred",
    prepared: true,
    created_at_ms: 1,
    deadline_ms: 0,
  };
}
function binding(record: ClientInvocation): ClientBinding {
  return {
    role: "participant",
    can_interact: true,
    participation_id: "exact-pending-reader-capability",
    catalog_digest: record.catalog_digest,
    definitions: CLIENT_TOOL_DEFINITIONS,
    calls: [record],
    pending: [record],
  };
}

test("participant Secret input is uncontrolled, cleared before settlement and never persisted in browser storage", async ({
  page,
}) => {
  const record = interaction();
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend = await nativeBackend(page, {
    clientTools: binding(record),
    extraMethods: [
      "client_tools.secret",
      "client_tools.secret_operation",
      "client_tools.arguments",
      "client_tools.takeover",
    ],
    sessionCommand: async (command) => {
      if (command.method === "client_tools.secret") {
        await held;
        return {
          data: {
            ...record,
            status: "completed",
            result: {
              status: "provided",
              secrets: [
                { key: "TOKEN", placeholder: "{{secret:TOKEN}}" },
                { key: "CODE", placeholder: "{{secret:CODE}}" },
              ],
            },
          },
        };
      }
      return undefined;
    },
  });
  await page.goto("/#session/s1");
  const input = page.getByLabel("Service token", { exact: true });
  const code = page.getByLabel("Verification code", { exact: true });
  const reveal = page.getByRole("button", {
    name: "显示：Service token",
    exact: true,
  });
  const remask = page.getByRole("button", {
    name: "隐藏：Service token",
    exact: true,
  });
  await expect(input).toBeEnabled();
  await expect(input).toHaveAttribute("type", "password");
  await expect(code).toHaveAttribute("type", "password");
  await expect(input).toHaveAccessibleDescription(
    "Token for the selected service",
  );
  await code.fill("SYNTHETIC_CODE");
  await input.fill("PRIVATE_BROWSER_SENTINEL");
  await input.evaluate((node) => node.setSelectionRange(1, 5, "backward"));
  await reveal.click();
  await expect(input).toHaveAttribute("type", "text");
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((node) => [
      node.selectionStart,
      node.selectionEnd,
      node.selectionDirection,
    ]),
  ).toEqual([1, 5, "backward"]);
  await expect(code).toHaveAttribute("type", "password");
  await page.keyboard.press("Tab");
  await expect(remask).toBeFocused();
  await page.keyboard.press("Space");
  await expect(input).toHaveAttribute("type", "password");
  await expect(reveal).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(input).toHaveAttribute("type", "text");
  await expect(remask).toBeFocused();
  expect(
    await input.evaluate((node) => {
      const propsKey = Object.keys(node).find((key) =>
        key.startsWith("__reactProps$"),
      );
      return propsKey ? Object.hasOwn((node as any)[propsKey], "value") : false;
    }),
  ).toBe(false);
  expect(
    await page.evaluate(
      () =>
        !JSON.stringify({ ...localStorage, ...sessionStorage }).includes(
          "PRIVATE_BROWSER_SENTINEL",
        ),
    ),
  ).toBe(true);
  expect(
    backend.commands.some(
      (command) => command.method === "client_tools.secret",
    ),
  ).toBe(false);
  await input.press("Enter");
  await expect
    .poll(() => input.evaluate((node) => node.value === ""))
    .toBe(true);
  await expect(input).toBeDisabled();
  await expect(input).toHaveAttribute("type", "password");
  await expect(reveal).toBeDisabled();
  await expect
    .poll(
      () =>
        backend.commands.filter(
          (command) => command.method === "client_tools.secret",
        ).length,
    )
    .toBe(1);
  const sent = backend.commands.find(
    (command) => command.method === "client_tools.secret",
  );
  expect(sent?.params).not.toHaveProperty("lease_id");
  expect(
    sent?.params.values?.TOKEN === "PRIVATE_BROWSER_SENTINEL" &&
      sent?.params.values?.CODE === "SYNTHETIC_CODE",
  ).toBe(true);
  expect(
    (await page.locator("body").innerText()).includes(
      "PRIVATE_BROWSER_SENTINEL",
    ),
  ).toBe(false);
  release!();
  await expect(page.getByTestId("secret-request")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        !JSON.stringify({ ...localStorage, ...sessionStorage }).includes(
          "PRIVATE_BROWSER_SENTINEL",
        ),
    ),
  ).toBe(true);
});

test("participant Secret decline sends sanitized result without a secret sideband", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    clientTools: binding(interaction()),
  });
  await page.goto("/#session/s1");
  const input = page.getByLabel("Service token", { exact: true });
  await input.fill("UNSENT_PRIVATE_VALUE");
  await page
    .getByRole("button", { name: "显示：Service token", exact: true })
    .click();
  const originalInput = await input.elementHandle();
  await page.getByRole("button", { name: "拒绝提供", exact: true }).click();
  await expect
    .poll(
      () =>
        backend.commands.find(
          (command) => command.method === "client_tools.result",
        )?.params,
    )
    .toEqual({
      invocation_id: "human-request",
      result: { status: "declined" },
    });
  expect(
    backend.commands.some(
      (command) => command.method === "client_tools.secret",
    ),
  ).toBe(false);
  expect(
    JSON.stringify(backend.commands).includes("UNSENT_PRIVATE_VALUE"),
  ).toBe(false);
  await expect(page.getByTestId("secret-request")).toHaveCount(0);
  expect(
    await originalInput?.evaluate(
      (node) =>
        !node.isConnected && node.value === "" && node.type === "password",
    ),
  ).toBe(true);
});

test.describe("touch Secret visibility", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("a tap affects only its field and a settled request cannot reveal the next one", async ({
    page,
  }) => {
    const record = interaction();
    const backend = await nativeBackend(page, { clientTools: binding(record) });
    await page.goto("/#session/s1");
    const input = page.getByLabel("Service token", { exact: true });
    const code = page.getByLabel("Verification code", { exact: true });
    await input.fill("SYNTHETIC_TOUCH");
    const originalInput = await input.elementHandle();
    const reveal = page.getByRole("button", {
      name: "显示：Service token",
      exact: true,
    });
    await reveal.tap();
    await expect(input).toHaveAttribute("type", "text");
    await expect(code).toHaveAttribute("type", "password");
    await page
      .getByRole("button", { name: "隐藏：Service token", exact: true })
      .tap();
    await expect(input).toHaveAttribute("type", "password");
    expect(
      await input.evaluate((node) => node.value === "SYNTHETIC_TOUCH"),
    ).toBe(true);
    await reveal.tap();
    await expect(input).toHaveAttribute("type", "text");
    backend.event("client_tool.settled", {
      call: { ...record, status: "completed", result: { status: "declined" } },
    });
    await expect(page.getByTestId("secret-request")).toHaveCount(0);
    expect(
      await originalInput?.evaluate(
        (node) =>
          !node.isConnected && node.value === "" && node.type === "password",
      ),
    ).toBe(true);
    backend.event("client_tool.requested", {
      call: { ...record, invocation_id: "next-request", call_id: "next-call" },
    });
    await expect(input).toHaveAttribute("type", "password");
    await expect
      .poll(() => input.evaluate((node) => node.value === ""))
      .toBe(true);
    expect(
      backend.commands.some(
        (command) => command.method === "client_tools.secret",
      ),
    ).toBe(false);
  });
});

test("a mounted Secret field remasks and clears on scope, request, and eligibility changes", async ({
  page,
}) => {
  // Keep the input mounted to exercise the fences without a navigation-induced remount.
  await page.route("**/secret-lifecycle-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<div id="fixture"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { AppProvider, useAppStore } = await import('/src/state/index.ts');
      const { AppStore } = await import('/src/state/store.ts');
      const { SecretCard } = await import('/src/features/questions/SecretCard.tsx');
      const { setActiveLocale } = await import('/src/i18n/index.ts');
      AppStore.prototype.start = function () {};
      function Fixture() {
        const store = useAppStore();
        React.useLayoutEffect(() => setActiveLocale('en'), []);
        const [request, setRequest] = React.useState({ id: 'first', disabled: false, awaitingConfirmation: false,
          secret: { reason: 'Testing visibility', secrets: [{ key: 'TOKEN', label: 'Service token' }] } });
        window.changeSecretView = (patch) => setRequest((current) => ({ ...current, ...patch }));
        window.changeHistoryScope = () => {
          const transcript = store.getSnapshot().transcript;
          store.update({ transcript: { ...transcript, historyResetRevision: (transcript.historyResetRevision ?? 0) + 1 } });
        };
        return React.createElement(SecretCard, { value: request });
      }
      ReactDOM.createRoot(document.querySelector('#fixture')).render(React.createElement(AppProvider, null, React.createElement(Fixture)));
    </script>`,
    }),
  );
  await page.goto("/secret-lifecycle-fixture");
  const input = page.getByLabel("Service token", { exact: true });
  const reveal = page.getByRole("button", {
    name: "Reveal Service token",
    exact: true,
  });
  const remask = page.getByRole("button", {
    name: "Hide Service token",
    exact: true,
  });
  await expect(input).toBeEnabled();
  const originalInput = await input.elementHandle();
  for (const boundary of [
    "history",
    "request",
    "disabled",
    "awaitingConfirmation",
  ] as const) {
    await input.fill("SYNTHETIC_LIFECYCLE");
    await reveal.click();
    await expect(remask).toBeVisible();
    await expect(input).toHaveAttribute("type", "text");
    await page.evaluate((boundary) => {
      const fixture = window as typeof window & {
        changeHistoryScope: () => void;
        changeSecretView: (patch: Record<string, string | boolean>) => void;
      };
      if (boundary === "history") fixture.changeHistoryScope();
      else if (boundary === "request")
        fixture.changeSecretView({ id: "second" });
      else fixture.changeSecretView({ [boundary]: true });
    }, boundary);
    await expect(input).toHaveAttribute("type", "password");
    expect(
      await originalInput?.evaluate(
        (node) => node.isConnected && node.value === "",
      ),
    ).toBe(true);
    if (boundary === "disabled" || boundary === "awaitingConfirmation") {
      await expect(reveal).toBeDisabled();
      await page.evaluate((boundary) => {
        (
          window as unknown as {
            changeSecretView: (patch: Record<string, boolean>) => void;
          }
        ).changeSecretView({ [boundary]: false });
      }, boundary);
      await expect(reveal).toBeEnabled();
      await expect(input).toHaveAttribute("type", "password");
    }
  }
});

test("participant question images use exact pending resource capability and revoke on cancellation", async ({
  page,
}) => {
  const record = interaction("ask_user_question");
  const backend = await nativeBackend(page, { clientTools: binding(record) });
  backend.snapshot().history_view = {
    lineage: "participant-history",
    epoch: 0,
    message_count: 2,
    start_cursor: 0,
    end_cursor: 2,
    turns: [],
  };
  let reads = 0;
  await page.route(
    "**/api/v1/sessions/s1/questions/human-request/image?**",
    async (route) => {
      reads++;
      const url = new URL(route.request().url());
      expect(url.searchParams.get("target_session_id")).toBe("s1");
      expect(url.searchParams.get("history_lineage")).toBe(
        "participant-history",
      );
      expect(url.searchParams.get("href")).toBe("picture.png");
      expect(url.href).not.toContain("exact-pending-reader-capability");
      expect(route.request().headers()["x-microcrab-executor-lease"]).toBe(
        "exact-pending-reader-capability",
      );
      await route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7S8AAAAASUVORK5CYII=",
          "base64",
        ),
      });
    },
  );
  await page.goto("/#session/s1");
  await page.getByRole("button", { name: "加载图片：Scoped preview" }).click();
  await expect(page.locator(".question-body img")).toBeVisible();
  expect(reads).toBe(1);
  backend.event("client_tool.cancel_requested", { call: record });
  await expect(page.locator(".question-body img")).toHaveCount(0);
  expect(
    backend.commands.some(
      (command) => command.method === "client_tools.arguments",
    ),
  ).toBe(false);
});
