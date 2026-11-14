// Existing real native fixture only. This driver starts no HTTP service and
// installs no request routes: browser, OAuth, socket and Host traffic are real.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";

const readyPath = process.argv[2];
if (!readyPath)
  throw Error(
    "Usage: node tests/browser-host-server.mjs <public-fixture-ready.json>",
  );
const ready = JSON.parse(await readFile(readyPath, "utf8"));
const origin = new URL(ready.url).origin;
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname))
  throw Error("Acceptance fixture must be loopback");
const expectedHash =
  "fc869b0eb85a508de58df28b8cd46359cc3964787680640973fe7b64666afd02";
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const commands = [],
    browserMethods = new Set(),
    hostRequests = new Map(),
    missingWorkspaces = new Set(),
    deferredSnapshots = new Set();
  let virtualPidObserved = false;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/v1/sessions") {
      const body = request.postDataJSON();
      commands.push({
        method: "session.create",
        projectId: body.project_id,
        conversationId: body.conversation_id,
      });
    }
    const match = path.match(/^\/api\/v1\/sessions\/([^/]+)\/(runtime|fork)$/);
    if (match && request.method() === "PUT")
      commands.push({
        method: "session.open",
        sessionId: decodeURIComponent(match[1]),
      });
    if (match && request.method() === "POST" && match[2] === "fork")
      commands.push({
        method: "session.fork",
        sessionId: decodeURIComponent(match[1]),
        conversationId: request.postDataJSON().conversation_id,
      });
  });
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      let value;
      try {
        value = JSON.parse(String(payload));
      } catch {
        return;
      }
      if (value.type === "command")
        commands.push({
          method: value.method,
          sessionId: value.session_id,
          projectId: value.params?.project_id,
          conversationId: value.params?.conversation_id,
          workspaceId: value.params?.descriptor?.workspace_id,
        });
      if (
        value.lane === "conversation_host" &&
        value.frame?.kind === "response"
      ) {
        const result = value.frame.result?.Ok;
        const request = hostRequests.get(value.frame.request_id);
        if (request?.method === "shell_launch") {
          assert.ok(result, "Actual browser shell launch must return success");
          assert.ok(
            Number.isSafeInteger(result.handle) && result.handle > 0,
            "Virtual process handle must follow the numeric Host protocol",
          );
          assert.equal(
            result.pid,
            null,
            "Browser shell must explicitly report no native PID",
          );
          virtualPidObserved = true;
        }
        if (
          value.frame.result?.Err?.code === "not_found" &&
          /^(?:\/workspace\/)?browser-created\.txt$/.test(request?.path ?? "")
        )
          missingWorkspaces.add(request.conversationId);
      }
    });
    socket.on("framereceived", ({ payload }) => {
      let value;
      try {
        value = JSON.parse(String(payload));
      } catch {
        return;
      }
      const session = value.data?.snapshot?.session;
      if (session?.agent_initialization_deferred === true)
        deferredSnapshots.add(session.id);
      if (
        value.lane === "conversation_host" &&
        value.frame?.kind === "request"
      ) {
        browserMethods.add(value.frame.method?.method);
        hostRequests.set(value.frame.request_id, {
          conversationId: value.conversation_id,
          method: value.frame.method?.method,
          path: value.frame.method?.params?.path,
        });
      }
    });
  });
  const login = new URL(ready.login_url ?? "/api/auth/login", origin);
  if (login.origin !== origin)
    throw Error("Fixture login must use the existing application listener");
  login.searchParams.set("login_hint", "alice");
  await page.goto(login.href, { waitUntil: "domcontentloaded" });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("消息", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  const installed = await page.evaluate(async () => {
    const response = await fetch("/browser-host/current.json");
    if (!response.ok) throw Error("Browser Host artifact is not installed");
    return response.json();
  });
  assert.equal(
    installed.hash,
    expectedHash,
    "Backend fixture must serve the runtime artifact that passed credential-isolation acceptance",
  );
  await page.getByTitle("选择项目工作区").click();
  await page
    .getByTestId("home-project-picker")
    .getByRole("button", { name: "浏览器工作区", exact: true })
    .click();
  const agent = page.getByTestId("composer-agent-pill");
  await expect(agent).toBeEnabled({ timeout: 90000 });
  await agent.click();
  await page.getByRole("menuitemradio", { name: "build", exact: true }).click();
  await page.getByLabel("消息", { exact: true }).fill("after-restart");
  await page.getByTitle("发送 (Enter)").click();
  await expect(
    page.getByText("canonical:after-restart", { exact: true }),
  ).toBeVisible({ timeout: 90000 });
  const sessionId = new URL(page.url()).hash.match(/^#session\/([^/]+)$/)?.[1];
  assert.ok(
    sessionId,
    "Fresh Conversation must have a committed Session route",
  );
  const created = commands.find(
    (command) =>
      command.method === "session.create" &&
      command.conversationId === sessionId,
  );
  assert.ok(
    created,
    "Conversation must be created through the real authenticated socket",
  );
  assert.equal(
    created.projectId,
    null,
    "Conversation must not acquire a hidden Project",
  );
  assert.ok(
    deferredSnapshots.has(sessionId),
    "Server must announce fresh Agent initialization as deferred",
  );
  const binding = commands.findIndex(
    (command) =>
      command.method === "client_tools.bind" && command.sessionId === sessionId,
  );
  const opened = commands.findIndex(
    (command) =>
      command.method === "session.open" && command.sessionId === sessionId,
  );
  assert.ok(
    binding >= 0 && opened > binding,
    "Client executor must bind before deferred Agent initialization opens",
  );
  const getSnapshot = async (targetId = sessionId) =>
    page.evaluate(async (id) => {
      const response = await fetch(
        "/api/v1/sessions/" + encodeURIComponent(id),
      );
      if (!response.ok)
        throw Error(
          "Authenticated Session snapshot failed with status " +
            response.status,
        );
      return response.json();
    }, targetId);
  const initial = await getSnapshot();
  assert.equal(initial.session.project_id, null);
  assert.notEqual(initial.session.agent_initialization_deferred, true);
  assert.notEqual(initial.session.agent_init_retry_required, true);
  await page.getByLabel("消息", { exact: true }).fill("browser-shell");
  await page.getByTitle("发送 (Enter)").click();
  const waitForAnswer = async (phase) => {
    const completed = page.getByText("canonical:" + phase, { exact: true });
    const submitted = new Set();
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (await completed.isVisible()) return;
      const cards = page.getByTestId("permission-request");
      for (const card of await cards.all()) {
        const requestId = await card.getAttribute("data-request-id");
        if (!requestId || submitted.has(requestId)) continue;
        const approval = card.getByRole("button", {
          name: "允许本次",
          exact: true,
        });
        if (!(await approval.isVisible()) || !(await approval.isEnabled()))
          continue;
        submitted.add(requestId);
        // Mark before clicking: a lost acknowledgement must never replay this
        // permission mutation. A disappearing card is resolved by later facts.
        try {
          await approval.click({ timeout: 1000 });
        } catch (error) {
          if (error.name !== "TimeoutError") throw error;
        }
        if (submitted.size > 8)
          throw Error("Unexpected permission interaction count");
      }
      await page.waitForTimeout(100);
    }
    const snapshot = await getSnapshot(
      new URL(page.url()).hash.slice("#session/".length),
    );
    const permissions = await page.evaluate(async (id) => {
      const response = await fetch(
        "/api/v1/sessions/" + encodeURIComponent(id) + "/permission/requests",
      );
      const value = await response.json();
      return {
        status: response.status,
        count: value.requests?.length,
        executor: value.executor_connected,
      };
    }, snapshot.session.id);
    throw Error(
      "Answer wait expired: " +
        JSON.stringify({
          phase,
          status: snapshot.session.status,
          deferred: snapshot.session.agent_initialization_deferred,
          initRetry: snapshot.session.agent_init_retry_required,
          permissions,
          operations: snapshot.operations.map((operation) => ({
            method: operation.method,
            status: operation.status,
          })),
          messages: snapshot.messages.map((message) => ({
            role: message.role,
            tool: message.tool_name,
            length: message.text?.length,
          })),
        }),
    );
  };
  await waitForAnswer("browser-shell");
  const executed = await getSnapshot();
  const readResults = executed.messages.filter(
    (message) => message.role === "tool" && message.tool_name === "read",
  );
  assert.ok(
    readResults.some((message) =>
      String(message.text).includes("browser-durable"),
    ),
    "Actual guest read must return the shell-created workspace content",
  );
  assert.ok(
    browserMethods.has("shell_launch"),
    "Actual guest shell must route to the browser Host",
  );
  assert.ok(
    browserMethods.has("read") || browserMethods.has("read_file"),
    "Actual guest filesystem read must route to the browser Host",
  );
  assert.equal(
    virtualPidObserved,
    true,
    "Virtual shell launch must carry no native PID",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("消息", { exact: true })).toBeEnabled({
    timeout: 90000,
  });
  await expect(
    page.getByText("canonical:browser-shell", { exact: true }),
  ).toBeVisible({ timeout: 90000 });
  const reopened = await getSnapshot();
  assert.equal(reopened.session.id, sessionId);
  assert.equal(reopened.session.project_id, null);
  assert.notEqual(reopened.session.agent_init_retry_required, true);
  const sourceRow = page.locator(
    '[data-testid="session-item"][data-active="true"]',
  );
  await sourceRow.hover();
  await sourceRow.getByTitle("更多操作").click();
  const forkButton = page.getByRole("button", {
    name: "分叉会话",
    exact: true,
  });
  await expect(forkButton).toBeEnabled({ timeout: 30000 });
  await forkButton.click();
  await expect
    .poll(() => new URL(page.url()).hash, { timeout: 90000 })
    .not.toBe("#session/" + sessionId);
  const forkId = new URL(page.url()).hash.match(/^#session\/([^/]+)$/)?.[1];
  assert.ok(forkId && forkId !== sessionId);
  const forkCommand = commands.find(
    (command) =>
      command.method === "session.fork" && command.sessionId === sessionId,
  );
  assert.equal(forkCommand?.conversationId, forkId);
  const sourceWorkspace = commands.find(
    (command) =>
      command.method === "conversation.attach" &&
      command.conversationId === sessionId,
  )?.workspaceId;
  const forkWorkspace = commands.find(
    (command) =>
      command.method === "conversation.attach" &&
      command.conversationId === forkId,
  )?.workspaceId;
  assert.ok(
    sourceWorkspace && forkWorkspace && sourceWorkspace !== forkWorkspace,
    "Fork must attach a separately allocated browser workspace",
  );
  await expect(page.getByLabel("消息", { exact: true })).toBeEnabled({
    timeout: 90000,
  });
  await expect
    .poll(
      async () =>
        (await getSnapshot(forkId)).session.agent_initialization_deferred ===
        true,
      { timeout: 90000 },
    )
    .toBe(false);
  assert.ok(
    deferredSnapshots.has(forkId),
    "Fork must announce deferred initialization before binding its executor",
  );
  const forkBind = commands.findIndex(
    (command) =>
      command.method === "client_tools.bind" && command.sessionId === forkId,
  );
  const forkOpen = commands.findIndex(
    (command) =>
      command.method === "session.open" && command.sessionId === forkId,
  );
  assert.ok(forkBind >= 0 && forkOpen > forkBind);
  const forked = await getSnapshot(forkId);
  assert.equal(forked.session.project_id, null);
  const histories = await page.evaluate(
    async (ids) =>
      Promise.all(
        ids.map(async (id) => {
          const response = await fetch(
            "/api/v1/sessions/" + encodeURIComponent(id) + "/history",
          );
          if (!response.ok) throw Error("History cursor query failed");
          return response.json();
        }),
      ),
    [sessionId, forkId],
  );
  assert.equal(histories[0].cursor.session_id, sessionId);
  assert.equal(histories[1].cursor.session_id, forkId);
  assert.notEqual(
    histories[0].cursor.checkpoint_id,
    histories[1].cursor.checkpoint_id,
  );
  const journalProof = spawnSync(
    "python",
    [
      "-c",
      `
import json, pathlib, sqlite3, sys
root, source, fork = sys.argv[1:]
database = pathlib.Path(root) / '.microcrab' / 'storage.sqlite'
connection = sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)
source_ids = {row[0] for row in connection.execute('SELECT id FROM journal_nodes WHERE session_id=?', (source,))}
fork_nodes = {row[0]: json.loads(row[1]) for row in connection.execute('SELECT id,body FROM journal_nodes WHERE session_id=?', (fork,))}
assert source_ids and fork_nodes, 'Source and fork must each own Journal nodes'
assert source_ids.isdisjoint(fork_nodes), 'Fork must not inherit source Journal checkpoints'
assert sum(node['parent'] is None for node in fork_nodes.values()) == 1, 'Fork must have exactly one fresh Journal root'
for node in fork_nodes.values():
    assert node['checkpoint']['session_id'] == fork, 'Every fork checkpoint must bind the destination identity'
    assert node['parent'] is None or node['parent'] in fork_nodes, 'Fork ancestry must remain entirely in its own Journal'
print(json.dumps({'forkJournalFreshRoot': True, 'sourceCheckpointsExcluded': True}))
`,
      ready.root,
      sessionId,
      forkId,
    ],
    { stdio: "inherit" },
  );
  if (journalProof.error) throw journalProof.error;
  assert.equal(
    journalProof.status,
    0,
    "Read-only synthetic Journal ancestry proof must pass",
  );
  assert.ok(
    forked.messages.some(
      (message) => message.text === "canonical:browser-shell",
    ),
    "Fork must copy the materialized conversation",
  );
  await page.getByLabel("消息", { exact: true }).fill("browser-fork-read");
  await page.getByTitle("发送 (Enter)").click();
  await waitForAnswer("browser-fork-read");
  assert.equal(
    missingWorkspaces.has(forkId),
    true,
    "Source-only workspace file must be absent in the fork Host",
  );
  assert.equal(
    missingWorkspaces.has(sessionId),
    false,
    "Source read must have succeeded in its own workspace",
  );
  const sourceAfterFork = await getSnapshot();
  assert.deepEqual(
    sourceAfterFork.messages.map((message) => message.id),
    reopened.messages.map((message) => message.id),
    "Fork execution must not advance source conversation messages",
  );
  console.log(
    JSON.stringify(
      {
        result: "passed",
        artifactHash: installed.hash,
        projectless: true,
        initialized: true,
        executorBoundBeforeOpen: true,
        browserShellAndPython: true,
        guestReadAfterShellWrite: true,
        virtualPid: true,
        reloadSameConversation: true,
        forkDistinctWorkspace: true,
        forkCopiedContext: true,
        forkSourceFileAbsent: true,
        hostMethods: [...browserMethods].sort(),
      },
      null,
      2,
    ),
  );
  await context.close();
} finally {
  await browser.close();
}
