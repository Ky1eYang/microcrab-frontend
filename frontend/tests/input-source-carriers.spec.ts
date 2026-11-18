import { expect, test, type Page } from "@playwright/test";
import { messageBlocks } from "../src/client/native-message-blocks";
import {
  isDirectUserSource,
  validateNativeInputSource,
} from "../src/client/input-source";
import {
  applySnapshot,
  computeTurns,
  createBlock,
  createTranscript,
  sessionView,
} from "../src/client/projector";
import { latestUser } from "../src/features/shared";
import { hasVisibleContent } from "../src/client/conversation/definitions";
import type {
  NativeInputSource,
  NativeMessage,
  NativeSession,
  NativeSnapshot,
} from "../src/client/types";

const agent = {
  agent: {
    agent_id: "agt_0123456789abcdef",
    exchange: { exchange_id: "exchange_1", intent: "send" as const },
  },
};
const external = { external: { identity: "bridge_one" } };
const native = (id: string, source?: NativeInputSource): NativeMessage => ({
  id,
  role: "user",
  source,
  text: `Body ${id}`,
  parts: [],
  tool_calls: [],
  submission_operation_id: "same-operation",
});
const rootSession: NativeSession = {
  id: "s1",
  title: "Root session",
  project_id: "p1",
  status: "idle",
  agent: "coding",
  mode: "plan",
  model: "test",
  created_at_ms: 1,
  updated_at_ms: 2,
  revision: 1,
  archived: false,
};
const messages = [
  native("human1"),
  native("notice1", "framework"),
  native("agent1", agent),
  native("external1", external),
  native("external2", external),
  native("human2"),
];
const snapshot: NativeSnapshot = {
  session: rootSession,
  messages,
  permission: {
    revision: 1,
    config: { overrides: [], review: true, initialization: "ask" },
  },
  operations: [],
  history: null,
  usage: null,
};

test("closed transport sources preserve omitted user and frozen framework reads, reject malformed metadata", () => {
  for (const value of [
    undefined,
    "framework",
    agent,
    external,
    { agent: { agent_id: "agt_0" } },
    {
      agent: {
        agent_id: "agt_0",
        exchange: { exchange_id: "x", intent: "reply" },
      },
    },
  ])
    expect(() => validateNativeInputSource(value)).not.toThrow();
  for (const source of [
    null,
    "user",
    "external",
    {},
    { agent: { agent_id: 1 } },
    {
      agent: { agent_id: "a", exchange: { exchange_id: "x", intent: "other" } },
    },
    { external: { identity: "bridge", key: "secret" } },
    { agent: { agent_id: "a" }, external: { identity: "b" } },
    { external: { identity: "" } },
  ]) {
    expect(isDirectUserSource(source)).toBe(false);
    expect(() =>
      messageBlocks(
        "s1",
        { ...native("bad"), source } as NativeMessage,
        "http://localhost/",
      ),
    ).toThrow(/message.source/);
  }
  expect(isDirectUserSource(undefined)).toBe(true);
  const human = messageBlocks("s1", native("human"), "http://localhost/")[0];
  expect(human.payload).not.toHaveProperty("source");
  expect(human.operationId).toBe("same-operation");
  for (const source of ["framework" as const, agent, external]) {
    const block = messageBlocks(
      "s1",
      native("input", source),
      "http://localhost/",
    )[0];
    expect(block.payload.source).toEqual(source);
    expect(block.operationId).toBeUndefined();
    expect(hasVisibleContent(block)).toBe(true);
  }
});

test("carrier input boundaries remain model turns but only direct inputs count as user tasks or latest Undo", () => {
  const blocks = messages.flatMap((message) =>
    messageBlocks("s1", message, "http://localhost/"),
  );
  expect(computeTurns(blocks).map((turn) => turn.userIndex)).toEqual([
    0,
    null,
    null,
    null,
    null,
    5,
  ]);
  expect(latestUser({ blocks: blocks.slice(0, 5) })?.messageId).toBe("human1");
  expect(latestUser({ blocks })?.messageId).toBe("human2");
  expect(
    blocks.filter(
      (block) =>
        block.payload.source &&
        typeof block.payload.source === "object" &&
        "external" in block.payload.source,
    ),
  ).toHaveLength(2);
});

test("external source cannot consume a human optimistic input with equal text or forged admission identity", () => {
  let transcript = createTranscript();
  const optimistic = createBlock("s1", "local_input", "text", "text", "user");
  optimistic.temporary = true;
  optimistic.operationId = "same-operation";
  optimistic.payload.text = "same text";
  transcript.blocks = [optimistic];
  const remote = { ...native("remote", external), text: "same text" };
  transcript = applySnapshot(
    { ...snapshot, messages: [remote] },
    transcript,
    "http://localhost/",
  );
  expect(
    transcript.blocks.some(
      (block) => block.messageId === "local_input" && block.temporary,
    ),
  ).toBe(true);
  expect(
    transcript.blocks.find((block) => block.messageId === "remote")
      ?.operationId,
  ).toBeUndefined();
  const direct = { ...native("human_admitted"), text: "same text" };
  transcript = applySnapshot(
    { ...snapshot, messages: [remote, direct] },
    transcript,
    "http://localhost/",
  );
  expect(transcript.blocks.some((block) => block.temporary)).toBe(false);
  expect(
    transcript.blocks.find((block) => block.messageId === "human_admitted")
      ?.operationId,
  ).toBe("same-operation");
});

async function mount(page: Page, rail = false) {
  await page.route("**/carrier-source-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
const {default: React} = await import('/node_modules/.vite/deps/react.js');
const {default: ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
const {AppProvider, useAppStore} = await import('/src/state/index.ts');
const {AppStore} = await import('/src/state/store.ts');
const {Conversation} = await import('/src/features/conversation.tsx');
const {SessionRail} = await import('/src/shell/SessionRail.tsx');
const {BlockView} = await import('/src/features/views.tsx');
const {applySnapshot,createTranscript,sessionView} = await import('/src/client/projector.ts');
const {setActiveLocale} = await import('/src/i18n/index.ts');
setActiveLocale('en');
await import('/src/styles/tokens.css'); await import('/src/styles/components.css');
AppStore.prototype.start = function(){};
const transcript = applySnapshot(${JSON.stringify(snapshot)}, createTranscript(), location.origin);
window.__transcript = transcript;
function Fixture(){
 const store = useAppStore(); window.__store = store; setActiveLocale('en');
 if(!window.__configured){window.__configured=true;store.state={...store.state, resolvedLocale:'en', page:'conversation', sessionId:'s1', transcript, railCollapsed:false, capabilities:{methods:['history.travel']}, authSession:{authenticated:true,principal:{owner:'owner',expires_at:9999999999999}}, sessions:[sessionView(${JSON.stringify(rootSession)}),sessionView({...${JSON.stringify(rootSession)},id:'child-project',title:'Hidden project child',parent_session_id:'s1'}),sessionView({...${JSON.stringify(rootSession)},id:'child-chat',title:'Hidden chat child',project_id:null,parent_session_id:'s1'})]};}
 return ${rail ? "React.createElement(SessionRail)" : "React.createElement(Conversation,{transcript,sessionId:'s1',footer:React.createElement('div'),userLabel:'Parent direct input'})"};
}
window.__root=ReactDOM.createRoot(document.getElementById('fixture'));
window.__root.render(React.createElement(AppProvider,null,React.createElement(Fixture)));
</script></body></html>`,
    }),
  );
  await page.goto("/carrier-source-fixture");
  await page.waitForFunction(() => (window as any).__configured === true);
}

test("real conversation shows all carrier bodies with escaped source/exchange labels and direct-only Undo", async ({
  page,
}) => {
  await mount(page);
  await expect(page.getByTestId("chat-message")).toHaveCount(6);
  await expect(page.getByTestId("input-source-label")).toHaveCount(4);
  await expect(
    page
      .getByTestId("input-source-label")
      .filter({ hasText: "Framework notice" }),
  ).toHaveCount(1);
  await expect(
    page
      .getByTestId("input-source-label")
      .filter({ hasText: "Agent · agt_0123456789abcdef · Send · exchange_1" }),
  ).toHaveCount(1);
  await expect(
    page
      .getByTestId("input-source-label")
      .filter({ hasText: "External speaker · bridge_one" }),
  ).toHaveCount(2);
  await expect(page.getByTestId("undo-user-block")).toHaveCount(2);
  expect(
    await page
      .getByTestId("undo-user-block")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-message-id")),
      ),
  ).toEqual(["human1", "human2"]);
  await expect(page.getByTestId("parent-input-label")).toHaveCount(2);
  await expect(page.locator('[data-message-source="carrier"]')).toHaveCount(4);
  expect(await page.locator("body").innerText()).not.toContain("<state>");
  expect(await page.locator("body").innerText()).not.toContain(
    "same-operation",
  );
});

test("root rail uses native parent relation to hide project and projectless children", async ({
  page,
}) => {
  await mount(page, true);
  await expect(page.getByTestId("session-item")).toHaveCount(1);
  await expect(page.getByTestId("session-item")).toContainText("Root session");
  await expect(
    page.getByText("Hidden project child", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Hidden chat child", { exact: true }),
  ).toHaveCount(0);
});

test("source identities are escaped text and malformed projected sources show safe unknown labels", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const { BlockView } = await import("/src/features/views.tsx");
    const { AppProvider } = await import("/src/state/index.ts");
    const { setActiveLocale } = await import("/src/i18n/index.ts");
    const { createBlock } = await import("/src/client/create-block.ts");
    const first = createBlock("s1", "unsafe", "text", "text", "user");
    first.payload.text = "Body";
    first.payload.source = {
      external: { identity: '<img src=x onerror="window.__xss=1">' },
    };
    const second = createBlock("s1", "unknown", "text", "text", "user");
    second.payload.text = "Other body";
    second.payload.source = {
      external: { identity: "bridge", key: "secret-never-display" },
    };
    setActiveLocale("en");
    (window as any).__root.render(
      React.createElement(
        AppProvider,
        null,
        React.createElement(
          React.Fragment,
          null,
          React.createElement(BlockView, { block: first }),
          React.createElement(BlockView, { block: second }),
        ),
      ),
    );
  });
  await expect(page.getByTestId("input-source-label")).toHaveCount(2);
  await expect(page.getByTestId("input-source-label").first()).toContainText(
    '<img src=x onerror="window.__xss=1">',
  );
  await expect(page.getByTestId("input-source-label").last()).toHaveText(
    "Unrecognized input source",
  );
  await expect(page.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  expect(await page.locator("body").innerText()).not.toContain(
    "secret-never-display",
  );
});
