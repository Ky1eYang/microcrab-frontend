import { expect, test, type Page } from "@playwright/test";

const original =
  "Original paragraph.\n\n| Name | Value |\n| --- | --- |\n| A | 1 |\n\n- nested\n  - code\n\n    ```js\n    const original = true;\n    ```";
const translated =
  "译文段落。\n\n| 名称 | 值 |\n| --- | --- |\n| A | 1 |\n\n- 嵌套\n  - 代码\n\n    ```js\n    const translated = true;\n    ```\n\n<img src=x onerror=alert(1)>";

async function setup(page: Page, width = 1440) {
  page.on("pageerror", (error) =>
    console.error("Variant fixture:", error.message),
  );
  await page.setViewportSize({ width, height: 1000 });
  await page.route("**/variant-ui-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/variant-ui-entry.js"></script></body></html>',
    }),
  );
  await page.route("**/variant-ui-entry.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$=()=>{};
window.$RefreshSig$=()=>type=>type;
window.__vite_plugin_react_preamble_installed__=true;
const {default:React} = await import('/node_modules/.vite/deps/react.js');
const {default:ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
const {createRoot} = ReactDOM;
const {AppProvider,useAppStore} = await import('/src/state/context.tsx');
const {AppStore} = await import('/src/state/store.ts');
const {PluginAnswerVariants,useAnswerVariantActions} = await import('/src/features/plugin-block-variants.tsx');
const {BlockView,ActionBar} = await import('/src/features/views.tsx');
const {interleavedMarkdownText} = await import('/src/features/markdown-interleaved.tsx');
const {PluginBlockSlots} = await import('/src/plugins/PluginSidebar.tsx');
await import('/src/features/action-menu.css');
await import('/src/features/plugin-block-variants.css');
await import('/src/styles/tokens.css');
await import('/src/styles/chrome.css');
await import('/src/styles/components.css');
AppStore.prototype.start = function() {};
AppStore.prototype.stop = function() {};
const blocks = [
 {id:'b1',messageId:'m1',sessionId:'s1',role:'assistant',kind:'text',stream:'complete',payload:{text:${JSON.stringify(original)},attachments:[{id:'attachment',name:'Original attachment',sourceOmitted:true}]}},
 {id:'b2',messageId:'m2',sessionId:'s1',role:'assistant',kind:'text',stream:'complete',payload:{text:'Second original.',attachments:[]}},
 {id:'reason',messageId:'r',sessionId:'s1',role:'assistant',kind:'reasoning',stream:'complete',payload:{text:'Reasoning remains original.'}},
 {id:'tool',messageId:'t',sessionId:'s1',role:'tool',kind:'tool',stream:'complete',payload:{text:'Tool remains original.',toolName:'shell',toolInput:'{}'}}
];
const inputHistory = JSON.stringify(blocks);
let fixture, renderFixture;
function Bar() { const actions = useAnswerVariantActions(blocks.slice(0,2)); return React.createElement(ActionBar,{text:actions.text,pluginActions:actions.pluginActions,pluginActionScope:actions.actionScope,timestamp:1000}); }
function Fixture() {
 const store = useAppStore();
 const [revision, render] = React.useState(0); renderFixture=()=>render(x=>x+1);
 if(!fixture) {
  const entries = ['plugin.a','plugin.b'].map((id,i)=>({manifest:{id,name:i?'Other source':'Primary source',targets:['block-slot']},status:'ready'}));
  const variants = new Map(), certifiedSources = new Map();
  const registry = {view:()=>({vars:{},instanceGeneration:fixture?.generation??1}),releaseSurface:()=>{},getSnapshot:()=>entries,isEnabled:id=>!fixture?.disabled.has(id),getBlockVariants:(id,source)=>source===certifiedSources.get(id)?variants.get(id)||[]:[],getBlockSlots:id=>id==='b1'?[{pluginId:'plugin.a',block_id:id,slot_id:'legacy',placement:'after',tree:{type:'text',props:{text:'Legacy slot retained'}}}]:[],setSurfaceVisible:(id,d,v)=>fixture.mounts.push({id,d,v}),action:async(id,a,p,d)=>{fixture.actions.push({id,a,p,d});await fixture.actionPromise;},render:async()=>null};
  store.state={...store.state,page:'conversation',viewMode:'chat',sessionId:'s1',popup:{type:'none'},transcript:{...store.state.transcript,historyView:{lineage:'history-a',epoch:1}}};
  store.plugins.registry=registry;
  store.plugins.settle=()=>{};
  store.dispatch=async action=>{if(action.type==='CopyText')fixture.copies.push(action.value);};
  fixture=window.variantFixture={store,blocks,variants,registry,entries,disabled:new Set(),generation:1,mounts:[],actions:[],copies:[],bothText:interleavedMarkdownText,inputHistory,readonly:false,
    variant(block='b1',patch={}) {return {block_id:block,variant_id:'translation',source_digest:'host-certified',history_revision:'history-a',label:'译文',status:'completed',text:${JSON.stringify(translated)},default_display:'inline',pluginId:'plugin.a',...patch};},
    set(block,values){certifiedSources.set(block,blocks.find(item=>item.id===block)?.payload.text);variants.set(block,values);store.plugins.publish();renderFixture();},
    refresh(){store.plugins.publish();for(const listener of store.listeners)listener();renderFixture();}
  };
 }
 return React.createElement('main',{style:{maxWidth:'800px',margin:'auto'}},React.createElement('div',{className:'message-turn-container assistant-turn', 'data-testid':'stable-answer'},React.createElement(PluginAnswerVariants,{blocks:[...blocks],readOnly:fixture.readonly},
  ...blocks.map(block=>React.createElement('div',{key:block.id,'data-block':block.id},React.createElement(BlockView,{block,readOnly:fixture.readonly}),React.createElement(PluginBlockSlots,{blocks:[block],readOnly:fixture.readonly}))),React.createElement(Bar))));
}
createRoot(document.getElementById('root')).render(React.createElement(AppProvider,null,React.createElement(Fixture)));
`,
    }),
  );
  await page.goto("/variant-ui-fixture");
  await expect(page.locator('[data-block="b1"]')).toContainText(
    "Original paragraph.",
  );
  await page.getByTestId("stable-answer").hover({ position: { x: 10, y: 10 } });
  await page.evaluate(() => {
    (window as any).stableAnswer = document.querySelector(
      '[data-testid="stable-answer"]',
    );
  });
}

async function openMore(page: Page) {
  await page.getByTestId("stable-answer").hover({ position: { x: 10, y: 10 } });
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
}

async function choose(page: Page, label: string, provider = "Primary source") {
  await openMore(page);
  await page.getByRole("menuitem", { name: provider, exact: true }).click();
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
}
async function invokeAction(
  page: Page,
  label: string,
  provider = "Primary source",
) {
  await openMore(page);
  await page.getByRole("menuitem", { name: provider, exact: true }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

async function setVariant(page: Page, patch: Record<string, unknown> = {}) {
  await page.evaluate((patch) => {
    const f = (window as any).variantFixture;
    f.set("b1", [f.variant("b1", patch)]);
  }, patch);
}

for (const width of [390, 1440])
  test(`three display choices, Markdown, copy and stable canonical DOM at ${width}`, async ({
    page,
  }) => {
    await setup(page, width);
    await setVariant(page);
    const first = page.locator('[data-block="b1"]');
    await expect(first).toContainText("译文段落。");
    await expect(first).not.toContainText("Original paragraph.");
    await expect(first.locator("table")).toHaveCount(1);
    await expect(first.locator("pre")).toContainText(
      "const translated = true;",
    );
    await expect(first.locator("img,iframe")).toHaveCount(0);
    await expect(first.getByTestId("image-unavailable")).toHaveAttribute(
      "aria-label",
      /Original attachment/,
    );
    await expect(page.locator('[data-block="b2"]')).toContainText(
      "Second original.",
    );
    await page.locator('[data-block="reason"]').getByRole("button").click();
    await expect(page.locator('[data-block="reason"]')).toContainText(
      "Reasoning",
    );
    await expect(first).toContainText("Legacy slot retained");
    await page.locator('[data-block="tool"]').getByTestId("tool-row").click();
    await expect(page.locator('[data-block="tool"]')).toContainText(
      "Tool remains original.",
    );
    await page.getByRole("button", { name: "复制回答", exact: true }).click();
    expect(
      await page.evaluate(() => (window as any).variantFixture.copies.at(-1)),
    ).toBe(`${translated}\n\nSecond original.`);
    await choose(page, "原文 + 译文");
    await expect(first).toContainText("Original paragraph.");
    await expect(first.locator(".markdown-interleaved")).toContainText(
      "译文段落。",
    );
    await page.waitForTimeout(1100);
    await page.getByRole("button", { name: "复制回答", exact: true }).focus();
    await page.getByRole("button", { name: "复制回答", exact: true }).click();
    expect(
      await page.evaluate(() => (window as any).variantFixture.copies.at(-1)),
    ).toBe(
      await page.evaluate(
        ({ original, translated }) =>
          (window as any).variantFixture.bothText(
            original,
            translated,
            "译文",
          ) + "\n\nSecond original.",
        { original, translated },
      ),
    );
    await expect(
      page.getByRole("button", { name: "复制原文", exact: true }),
    ).toHaveCount(0);
    await choose(page, "原文");
    await page.waitForTimeout(1100);
    await page.getByRole("button", { name: "复制回答", exact: true }).click();
    expect(
      await page.evaluate(() => (window as any).variantFixture.copies.at(-1)),
    ).toBe(`${original}\n\nSecond original.`);
    await choose(page, "原文");
    await expect(first).not.toContainText("译文段落。");
    expect(
      await page.evaluate(
        () =>
          document.querySelector('[data-testid="stable-answer"]') ===
          (window as any).stableAnswer,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () =>
          JSON.stringify((window as any).variantFixture.blocks) ===
          (window as any).variantFixture.inputHistory,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

test("selecting a deferred translation starts it once and retains the chosen display", async ({ page }) => {
  await setup(page);
  await setVariant(page, { status: "cancelled", text: "", retry_action: "start" });
  await choose(page, "原文");
  const actions = () => page.evaluate(() => (window as any).variantFixture.actions.map(({ a }: any) => a));
  expect(await actions()).toEqual([]);
  await choose(page, "译文");
  expect(await actions()).toEqual(["start"]);
  await setVariant(page, { status: "pending", text: "" });
  await expect(page.locator('[data-block="b1"]')).toContainText("Original paragraph.");
  await choose(page, "译文");
  expect(await actions()).toEqual(["start"]);
  await setVariant(page);
  await expect(page.locator('[data-block="b1"]')).toContainText("译文段落。");
  await choose(page, "译文");
  expect(await actions()).toEqual(["start"]);
});

test("pending preference survives completion; skipped force and error retry are explicit fenced actions", async ({
  page,
}) => {
  await setup(page);
  await setVariant(page, {
    status: "pending",
    text: "",
    force_action: "forbidden-force",
  });
  await expect(page.getByTestId("block-variant-status")).toContainText(
    "正在生成",
  );
  await expect(page.getByRole("button", { name: "仍然翻译" })).toHaveCount(0);
  await choose(page, "原文");
  await setVariant(page);
  await expect(page.locator('[data-block="b1"]')).toContainText(
    "Original paragraph.",
  );
  await expect(page.locator('[data-block="b1"]')).not.toContainText(
    "译文段落。",
  );
  for (const reason of ["same_language", "no_prose", "unchanged"]) {
    await setVariant(page, {
      status: "skipped",
      reason,
      text: "",
      force_action: "force",
    });
    await expect(page.getByTestId("block-variant-status")).toHaveAttribute(
      "data-status",
      "skipped",
    );
    await invokeAction(page, "强制生成译文");
  }
  await setVariant(page, {
    status: "error",
    text: "",
    error: "Provider failure",
    retry_action: "retry",
  });
  await invokeAction(page, "重试译文");
  await setVariant(page, { retry_action: "again" });
  await invokeAction(page, "重新生成译文");
  await setVariant(page, {
    status: "cancelled",
    text: "",
    retry_action: "resume",
  });
  await invokeAction(page, "重试译文");
  const actions = await page.evaluate(
    () => (window as any).variantFixture.actions,
  );
  expect(actions.map((x: any) => x.a)).toEqual([
    "force",
    "force",
    "force",
    "retry",
    "again",
    "resume",
  ]);
  expect(
    actions.every(
      (x: any) =>
        x.id === "plugin.a" &&
        x.p.block_id === "b1" &&
        x.d.target === "block-slot" &&
        x.d.slot_id === "translation" &&
        /^[0-9a-f-]{36}$/.test(x.d.surface_id),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() =>
      (window as any).variantFixture.mounts
        .filter((mount: any) => mount.d.slot_id === "translation")
        .map((mount: any) => mount.v),
    ),
  ).toEqual([true]);
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.store.state = { ...f.store.state, page: "plugins" };
    f.refresh();
  });
  await openMore(page);
  await page
    .getByRole("menuitem", { name: "Primary source", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "重试译文", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => (window as any).variantFixture.mounts.at(-1).v),
  ).toBe(false);
});

test("after default, multiple sources, partial failure, source/history retirement and read-only isolation", async ({
  page,
}) => {
  await setup(page);
  await setVariant(page, { default_display: "after" });
  await expect(page.locator(".markdown-interleaved")).toBeVisible();
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.set("b1", [
      f.variant(),
      f.variant("b1", {
        pluginId: "plugin.b",
        label: "改写",
        text: "Other translation.",
      }),
    ]);
    f.set("b2", [
      f.variant("b2", { status: "error", text: "", error: "Partial failure" }),
    ]);
  });
  await expect(
    page.getByRole("button", { name: "更多操作", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-block="b1"]')).toContainText(
    "Original paragraph.",
  );
  await choose(page, "译文");
  await expect(page.locator('[data-block="b1"]')).toContainText("译文段落。");
  await expect(page.locator('[data-block="b2"]')).toContainText(
    "Second original.",
  );
  await expect(
    page.locator('[data-block="b2"]').getByTestId("block-variant-status"),
  ).toContainText("Partial failure");
  await choose(page, "改写", "Other source");
  await expect(page.locator('[data-block="b1"]')).toContainText(
    "Other translation.",
  );
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.blocks[0] = {
      ...f.blocks[0],
      payload: { ...f.blocks[0].payload, text: "Changed source." },
    };
    f.variants.delete("b2");
    f.refresh();
  });
  await expect(page.locator('[data-block="b1"]')).toContainText(
    "Changed source.",
  );
  await expect(
    page.getByRole("button", { name: "更多操作", exact: true }),
  ).toHaveCount(0);
  await setVariant(page);
  await expect(page.locator('[data-block="b1"]')).toContainText("译文段落。");
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.variants.clear();
    f.store.plugins.decorationGeneration++;
    f.refresh();
  });
  await expect(page.locator('[data-block="b1"]')).toContainText(
    "Changed source.",
  );
  await setVariant(page);
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.variants.clear();
    f.refresh();
  });
  await expect(page.locator('[data-block="b1"]')).toContainText(
    "Changed source.",
  );
  await setVariant(page);
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.readonly = true;
    f.refresh();
  });
  await expect(page.locator('[data-block="b1"]')).toContainText(
    "Changed source.",
  );
  await expect(
    page.getByRole("button", { name: "更多操作", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("block-variant-status")).toHaveCount(0);
});

test("keyboard, checked state, outside click and popup scope changes", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.set("b1", [
      f.variant(),
      f.variant("b1", {
        pluginId: "plugin.b",
        label: "摘要",
        text: "Summary.",
      }),
    ]);
  });
  const more = page.getByRole("button", { name: "更多操作", exact: true });
  await expect(more).toHaveCount(1);
  await expect(page.locator(".message-action-bar button")).toHaveCount(2);
  await more.focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Primary source", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("menuitem", { name: "Other source", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("menuitemradio", { name: "原文", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitemradio", { name: "译文", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await expect(
    page.getByRole("menuitemradio", { name: "原文 + 译文", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("menuitem", { name: "Primary source", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await openMore(page);
  await page
    .getByRole("menuitem", { name: "Primary source", exact: true })
    .click();
  await expect(
    page.getByRole("menuitemradio", { name: "译文", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await more.press("ArrowUp");
  await expect(
    page.getByRole("menuitem", { name: "Other source", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await openMore(page);
  await page.mouse.click(1, 1);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await openMore(page);
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.blocks[0] = {
      ...f.blocks[0],
      payload: { ...f.blocks[0].payload, text: "New canonical source." },
    };
    f.set("b1", [f.variant()]);
  });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(more).toHaveAttribute("aria-expanded", "false");
});

test("long authority identities use stable bounded surface IDs without truncating block or slot IDs", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    const plugin = "p".repeat(128),
      block = "b".repeat(256),
      slot = "v".repeat(128);
    f.entries[0].manifest.id = plugin;
    f.blocks[0].id = block;
    f.store.state.apiBase = location.origin + "/long-path".repeat(64) + "/";
    f.store.state.transcript.historyView.lineage = "h".repeat(64);
    f.registry.setSurfaceVisible = (id: string, d: any, v: boolean) => {
      if (d.surface_id.length > 512)
        throw Error("Plugin surface identity is too long");
      f.mounts.push({ id, d, v });
    };
    f.set(block, [
      f.variant(block, {
        pluginId: plugin,
        variant_id: slot,
        source_digest: "a".repeat(64),
        retry_action: "again",
      }),
    ]);
    f.refresh();
  });
  await invokeAction(page, "重新生成译文");
  const evidence = await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.refresh();
    return {
      action: f.actions.at(-1),
      mounts: f.mounts.filter(
        (m: any) => m.v && m.d.slot_id === "v".repeat(128),
      ),
    };
  });
  expect(evidence.action.d.surface_id.length).toBeLessThanOrEqual(512);
  expect(evidence.action.d.block_id).toBe("b".repeat(256));
  expect(evidence.action.d.slot_id).toBe("v".repeat(128));
  expect(evidence.mounts).toHaveLength(1);
  expect(evidence.action.d).toEqual(evidence.mounts[0].d);
});

test("all provider surfaces survive unrelated publications and actions stay per-block", async ({
  page,
}) => {
  await setup(page);
  await setVariant(page, { retry_action: "again-a" });
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.actionPromise = new Promise((resolve) => (f.finishAction = resolve));
  });
  await invokeAction(page, "重新生成译文");
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.set("b1", [
      f.variant("b1", { status: "pending", text: "" }),
      f.variant("b1", {
        pluginId: "plugin.b",
        label: "摘要",
        text: "Summary.",
        retry_action: "again-b",
      }),
    ]);
  });
  await invokeAction(page, "重新生成摘要", "Other source");
  const evidence = await page.evaluate(() => {
    const f = (window as any).variantFixture;
    return {
      mounts: f.mounts.filter((m: any) => m.d.slot_id === "translation"),
      actions: f.actions,
    };
  });
  expect(evidence.mounts.map((m: any) => [m.id, m.v])).toEqual([
    ["plugin.a", true],
    ["plugin.b", true],
  ]);
  expect(evidence.actions.map((a: any) => [a.id, a.a])).toEqual([
    ["plugin.a", "again-a"],
    ["plugin.b", "again-b"],
  ]);
  for (const action of evidence.actions)
    expect(action.d).toEqual(
      evidence.mounts.find((mount: any) => mount.id === action.id).d,
    );
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.finishAction();
    f.actionPromise = undefined;
  });
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.registry.action = async () => {
      throw new Error("Concrete provider failure");
    };
  });
  await invokeAction(page, "重新生成摘要", "Other source");
  await expect(page.locator('[data-block="b1"]').getByRole("alert")).toHaveText(
    "Error: Concrete provider failure",
  );
  await expect(page.locator('[data-block="b1"]')).toContainText(
    "Original paragraph.",
  );
  await choose(page, "摘要", "Other source");
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.disabled.add("plugin.b");
    f.refresh();
  });
  await expect(page.locator('[data-block="b1"]')).toContainText(
    "Original paragraph.",
  );
  await openMore(page);
  await expect(
    page.getByRole("menuitem", { name: "Other source", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.disabled.add("plugin.a");
    f.refresh();
  });
  await expect(
    page.getByRole("button", { name: "更多操作", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.disabled.clear();
    f.refresh();
  });
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("immediate store visibility and generation changes fence stale menu actions", async ({
  page,
}) => {
  await setup(page);
  await setVariant(page, { retry_action: "again" });
  for (const mutation of [
    "workspace",
    "page",
    "owner",
    "api",
    "session",
    "history",
    "generation",
    "disabled",
    "source",
    "metadata",
    "role",
    "status",
  ]) {
    await openMore(page);
    await page
      .getByRole("menuitem", { name: "Primary source", exact: true })
      .click();
    const calls = await page.evaluate((mutation) => {
      const f = (window as any).variantFixture;
      const saved = f.store.state,
        variant = f.variants.get("b1")[0],
        block = f.blocks[0];
      if (mutation === "workspace")
        f.store.state = {
          ...saved,
          pluginWorkspace: { type: "view", pluginId: "plugin.a" },
        };
      if (mutation === "page") f.store.state = { ...saved, page: "plugins" };
      if (mutation === "owner")
        f.store.state = {
          ...saved,
          authSession: { principal: { owner: "other" } },
        };
      if (mutation === "api")
        f.store.state = { ...saved, apiBase: "/other-api" };
      if (mutation === "session")
        f.store.state = { ...saved, sessionId: "other-session" };
      if (mutation === "history") f.store.plugins.decorationGeneration++;
      if (mutation === "generation") f.generation++;
      if (mutation === "disabled") f.disabled.add("plugin.a");
      if (mutation === "source") f.variants.delete("b1");
      if (mutation === "metadata")
        f.variants.set("b1", [
          { ...variant, source_digest: "different-digest" },
        ]);
      if (mutation === "role") block.role = "user";
      if (mutation === "status") f.entries[0].status = "faulted";
      const action = [
        ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      ].find((button) => button.textContent?.includes("重新生成译文"));
      action!.click();
      f.store.state = saved;
      if (mutation === "history") f.store.plugins.decorationGeneration--;
      f.generation = 1;
      f.disabled.clear();
      f.entries[0].status = "ready";
      block.role = "assistant";
      f.variants.set("b1", [variant]);
      f.refresh();
      return f.actions.length;
    }, mutation);
    expect(calls, mutation).toBe(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
  expect(
    await page.evaluate(() => (window as any).variantFixture.actions),
  ).toEqual([]);
  await openMore(page);
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.store.state = {
      ...f.store.state,
      pluginWorkspace: { type: "view", pluginId: "plugin.a" },
    };
    f.refresh();
  });
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as any).variantFixture.mounts
          .filter((m: any) => m.d.slot_id === "translation")
          .at(-1).v,
    ),
  ).toBe(false);
  await page.evaluate(() => {
    const f = (window as any).variantFixture;
    f.store.state = { ...f.store.state, pluginWorkspace: null };
    f.refresh();
  });
  await invokeAction(page, "重新生成译文");
  expect(
    await page.evaluate(() => (window as any).variantFixture.actions.length),
  ).toBe(1);
});

for (const width of [390, 1440])
  test(`three cascading levels fit bottom-right and menu scrolling stays open at ${width}`, async ({
    page,
  }) => {
    await setup(page, width);
    await page.setViewportSize({ width, height: 320 });
    await page.evaluate(() => {
      const f = (window as any).variantFixture;
      f.set(
        "b1",
        Array.from({ length: 40 }, (_, i) =>
          f.variant("b1", {
            variant_id: `variant-${i}`,
            label: `Result ${i}`,
            text: `Content ${i}`,
          }),
        ),
      );
      const bar = document.querySelector<HTMLElement>(".message-action-bar")!;
      Object.assign(bar.style, {
        position: "fixed",
        right: "0",
        bottom: "0",
        opacity: "1",
        pointerEvents: "auto",
        transform: "none",
      });
    });
    await openMore(page);
    await page
      .getByRole("menuitem", { name: "Primary source", exact: true })
      .click();
    const list = page.getByRole("menu", {
      name: "Primary source",
      exact: true,
    });
    await list.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(list).toBeVisible();
    await page
      .getByRole("menuitem", { name: "Result 39", exact: true })
      .click();
    await expect(page.getByRole("menuitemradio")).toHaveCount(3);
    const bounds = await page.getByRole("menu").evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }),
    );
    for (const rect of bounds) {
      expect(rect.left).toBeGreaterThanOrEqual(8);
      expect(rect.right).toBeLessThanOrEqual(width - 8);
      expect(rect.top).toBeGreaterThanOrEqual(8);
      expect(rect.bottom).toBeLessThanOrEqual(312);
    }
    await page
      .getByRole("menuitemradio", { name: "Result 39", exact: true })
      .click();
    await expect(page.locator('[data-block="b1"]')).toContainText("Content 39");
    await expect(page.locator('[data-block="b1"] button')).toHaveCount(0);
  });

test.describe("touch menu", () => {
  test.use({ hasTouch: true });
  test("tap opens cascades and selects the plugin label", async ({ page }) => {
    await setup(page, 390);
    await setVariant(page);
    await page.getByRole("button", { name: "更多操作", exact: true }).tap();
    await page
      .getByRole("menuitem", { name: "Primary source", exact: true })
      .tap();
    await page
      .getByRole("menuitemradio", { name: "原文 + 译文", exact: true })
      .tap();
    await expect(
      page.locator('[data-block="b1"] .markdown-interleaved'),
    ).toContainText("Original paragraph.");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
});
