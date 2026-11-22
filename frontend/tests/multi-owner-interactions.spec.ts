import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { CLIENT_TOOL_DEFINITIONS } from "../src/client/client-tools";
import type { ClientBinding, ClientInvocation } from "../src/client/client-tool-controller";
import type { PermissionRequest, RoundLimitRequest } from "../src/client/types";

type Backend = Awaited<ReturnType<typeof nativeBackend>>;
const fixturePath = "/multi-owner-interactions";
/** Test-only observation hook. The complete application, its real AppStore/start,
 * Session socket and incremental projections remain unchanged. */
async function mount(page: Page) {
  await page.route(`**${fixturePath}`, (route) => route.fulfill({ contentType: "text/html", body: `<html><body><div id="main"></div><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const {AppStore}=await import('/src/state/store.ts');const start=AppStore.prototype.start;
AppStore.prototype.start=function(){window.__interactionStore=this;return start.call(this)};
await import('/src/main.tsx');
</script></body></html>` }));
  await page.goto(`${fixturePath}#session/s1`);
}
function call(secret = false): ClientInvocation {
  return { invocation_id: "shared-human", parent_session_id: "s1", session_id: "s1", call_id: "shared-call",
    tool: secret ? "request_secret" : "ask_user_question",
    arguments: secret
      ? { reason: "Authenticate the selected service", secrets: [{ key: "TOKEN", label: "Service token" }] }
      : { questions: [{ id: "q", question: "Choose together", options: [
        { id: "first", label: "First page answer" }, { id: "second", label: "Second page answer" }] }] },
    epoch: 0, turn_id: 1, round_id: 1, catalog_digest: "shared-catalog", status: "pending",
    interaction: true, blocking_mode: "blocking", prepared: true, created_at_ms: 1, deadline_ms: 0 };
}
function binding(calls: ClientInvocation[] = []): ClientBinding {
  return { role: "participant", can_interact: true, participation_id: "participant-resource-cap",
    catalog_digest: "shared-catalog", definitions: CLIENT_TOOL_DEFINITIONS, calls,
    pending: calls.filter((item) => ["pending", "paused"].includes(item.status)) };
}
async function contexts(browser: Browser, baseURL: string | undefined) {
  const first = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL });
  return { first, second, pages: [await first.newPage(), await second.newPage()] };
}
async function closeAll(...items: BrowserContext[]) {
  await Promise.all(items.map((context) => context.close()));
}
async function state(page: Page) {
  return page.evaluate(() => (window as any).__interactionStore.getSnapshot());
}

for (const secret of [false, true]) {
  test(`two isolated owner contexts observe one ${secret ? "Secret" : "question"} winner without replay`, async ({ browser, baseURL }) => {
    const { first, second, pages: [a, b] } = await contexts(browser, baseURL);
    try {
      let authoritative = call(secret);
      const backends: Backend[] = [];
      let mutations = 0;
      const method = secret ? "client_tools.secret" : "client_tools.result";
      const handler = (command: any) => {
        if (command.method !== method) return undefined;
        expect(command.params.invocation_id).toBe(authoritative.invocation_id);
        expect(command.params).not.toHaveProperty("lease_id");
        if (["pending", "paused"].includes(authoritative.status)) {
          mutations++;
          if (secret) expect(command.params.values).toEqual({ TOKEN: "FIRST_WINNER_SECRET_SENTINEL" });
          // Fixture public state models the Server's sanitized winner receipt.
          // This is UI broadcast coverage, not a Server authorization/race proof.
          authoritative = { ...authoritative, status: "completed", result: secret
            ? { status: "provided", secrets: [{ key: "TOKEN", placeholder: "{{secret:TOKEN}}" }] }
            : command.params.result };
          for (const backend of backends) backend.event("client_tool.settled", { call: authoritative });
        }
        return { data: authoritative };
      };
      for (const page of [a, b]) backends.push(await nativeBackend(page, {
        owner: "same-owner", clientTools: binding([structuredClone(authoritative)]),
        extraMethods: ["client_tools.secret", "client_tools.secret_operation"], sessionCommand: handler,
      }));
      await Promise.all([mount(a), mount(b)]);
      if (secret) {
        const firstInput = a.getByLabel("Service token", { exact: true });
        const secondInput = b.getByLabel("Service token", { exact: true });
        await expect(firstInput).toBeEnabled(); await expect(secondInput).toBeEnabled();
        await firstInput.fill("UNSENT_OTHER_PAGE_SENTINEL");
        const detachedFirstInput = await firstInput.elementHandle();
        // Store notifications must not replace/reset an unrelated native input.
        await a.evaluate(() => (window as any).__interactionStore.update({ composer: "Unrelated draft update" }));
        await expect(firstInput).toHaveValue("UNSENT_OTHER_PAGE_SENTINEL");
        await secondInput.fill("FIRST_WINNER_SECRET_SENTINEL");
        for (const page of [a, b]) {
          expect(JSON.stringify(await state(page))).not.toMatch(/FIRST_WINNER_SECRET_SENTINEL|UNSENT_OTHER_PAGE_SENTINEL/);
          expect(await page.locator("body").innerText()).not.toMatch(/FIRST_WINNER_SECRET_SENTINEL|UNSENT_OTHER_PAGE_SENTINEL/);
        }
        await b.getByTestId("secret-request").locator('button[type="submit"]').click();
        await expect(a.getByTestId("secret-request")).toHaveCount(0);
        await expect(b.getByTestId("secret-request")).toHaveCount(0);
        expect(await detachedFirstInput!.evaluate((input) => (input as HTMLInputElement).value)).toBe("");
        for (const page of [a, b]) {
          expect(JSON.stringify(await state(page))).not.toMatch(/FIRST_WINNER_SECRET_SENTINEL|UNSENT_OTHER_PAGE_SENTINEL/);
          expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })))
            .not.toMatch(/FIRST_WINNER_SECRET_SENTINEL|UNSENT_OTHER_PAGE_SENTINEL/);
        }
        expect(JSON.stringify(backends[0].commands)).not.toContain("FIRST_WINNER_SECRET_SENTINEL");
      } else {
        for (const page of [a, b]) await expect(page.getByRole("button", { name: "Second page answer", exact: true })).toBeEnabled();
        await a.getByRole("button", { name: "First page answer", exact: true }).click();
        await b.getByRole("button", { name: "Second page answer", exact: true }).click();
        await b.getByRole("button", { name: "提交", exact: true }).click();
        for (const page of [a, b]) await expect(page.getByRole("button", { name: "提交", exact: true })).toHaveCount(0);
        expect(authoritative.result).toEqual({ dismissed: false, answers: [{ id: "q", option_ids: ["second"] }] });
      }
      expect(mutations).toBe(1);
      expect(backends[0].commands.filter((command) => command.method === method)).toHaveLength(0);
      expect(backends[1].commands.filter((command) => command.method === method)).toHaveLength(1);
      for (const page of [a, b]) {
        await expect.poll(async () => (await state(page)).transcript.pendingQuestions.length).toBe(0);
        expect((await state(page)).clientTools.calls.find((item: ClientInvocation) => item.invocation_id === "shared-human").result)
          .toEqual(authoritative.result);
      }
    } finally { await closeAll(first, second); }
  });
}

for (const kind of ["permission", "round_limit"] as const) {
  test(`two isolated owner contexts retire the same ${kind} approval after the second page replies`, async ({ browser, baseURL }) => {
    const { first, second, pages: [a, b] } = await contexts(browser, baseURL);
    try {
      const permission: PermissionRequest = { request_id: "shared-approval", parent_session_id: "s1", session_id: "s1",
        call_id: "approve-call", agent: "coding", mode: "execute", tool: "shell", arguments: { command: "approved preview" },
        revision: 4, created_at_ms: Date.now(), expires_at_ms: Date.now() + 300000 };
      const round: RoundLimitRequest = { request_id: "shared-approval", parent_session_id: "s1", session_id: "s1",
        epoch: 1, turn_id: "turn-1", kind: "rounds", used: 64, block: 64, created_at_ms: Date.now() };
      const backends: Backend[] = [];
      let winner: any = null;
      let mutations = 0;
      const handler = (command: any) => {
        if (command.method !== `${kind}.reply`) return undefined;
        expect(command.params).not.toHaveProperty("lease_id");
        if (!winner) {
          mutations++;
          winner = { request_id: "shared-approval", parent_session_id: "s1", decision: command.params.decision,
            ...(kind === "permission" ? { remembered: false, source: "user", tool: "shell", revision: 4 } : {}) };
          for (const backend of backends) backend.event(`${kind}.settled`, winner);
        }
        return { data: winner };
      };
      for (const page of [a, b]) backends.push(await nativeBackend(page, {
        owner: "same-owner", clientTools: binding(), sessionCommand: handler,
        ...(kind === "permission" ? { permissionRequests: [permission] } : { roundLimitRequests: [round] }),
      }));
      await Promise.all([mount(a), mount(b)]);
      const testid = kind === "permission" ? "permission-request" : "round-limit-request";
      for (const page of [a, b]) await expect(page.getByTestId(testid).locator("button.primary-btn")).toBeEnabled();
      await b.getByTestId(testid).locator("button.primary-btn").click();
      for (const page of [a, b]) await expect(page.getByTestId(testid)).toHaveCount(0);
      expect(mutations).toBe(1);
      expect(backends[0].commands.filter((command) => command.method === `${kind}.reply`)).toHaveLength(0);
      expect(backends[1].commands.filter((command) => command.method === `${kind}.reply`)).toHaveLength(1);
    } finally { await closeAll(first, second); }
  });
}

test("vacancy elects this participant with one rebind and never replays a recovered plugin invocation", async ({ page }) => {
  const human = call();
  const recovered: ClientInvocation = { ...human, invocation_id: "recovered-plugin", call_id: "plugin-call", tool: "plugin",
    arguments: { plugin: "opaque", artifact: "a".repeat(16), action: "list" }, interaction: false };
  const active = binding([human, recovered]);
  let binds = 0;
  const backend = await nativeBackend(page, { owner: "same-owner", clientTools: active,
    sessionCommand: (command) => {
      if (command.method !== "client_tools.bind") return undefined;
      binds++;
      return { data: structuredClone(active) };
    },
  });
  await mount(page);
  await expect(page.getByRole("button", { name: "First page answer", exact: true })).toBeEnabled();
  await expect.poll(() => binds).toBe(1);
  active.role = "executor"; active.lease_id = "elected-lease";
  backend.event("client_tools.lease_changed", { executor_connected: false });
  await expect.poll(() => binds).toBe(2);
  await expect.poll(async () => (await state(page)).clientTools.role).toBe("executor");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(binds).toBe(2);
  expect(backend.commands.some((command) => ["client_tools.arguments", "client_tools.result"].includes(command.method))).toBe(false);
  expect((await state(page)).clientTools.pending.find((item: ClientInvocation) => item.invocation_id === recovered.invocation_id)?.status).toBe("pending");
});

test("an owner participant can answer without a plugin-executor takeover control", async ({ page }) => {
  const backend = await nativeBackend(page, {
    owner: "same-owner",
    clientTools: binding([call()]),
    extraMethods: ["client_tools.takeover"],
  });
  await mount(page);
  const option = page.getByRole("button", { name: "First page answer", exact: true });
  await expect(option).toBeEnabled();
  await option.click();
  await expect(option).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "接管插件执行端" })).toHaveCount(0);
  await expect(page.getByText(/插件执行权与浏览器工作区归属/)).toHaveCount(0);
  expect((await state(page)).clientTools.role).toBe("participant");
  expect((await state(page)).clientTools.lease_id).toBeUndefined();
  expect(backend.commands.some((command) => ["client_tools.takeover", "client_tools.arguments", "client_tools.result"].includes(command.method))).toBe(false);
});
