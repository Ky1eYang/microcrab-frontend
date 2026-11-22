import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const id = "microcrab.output-translator";
const endpoint = "https://translator-resource.example.test/v1/chat/completions";
const componentPath = () =>
  process.env.MICROCRAB_TEST_TRANSLATOR_COMPONENT
    ? resolve(process.env.MICROCRAB_TEST_TRANSLATOR_COMPONENT)
    : resolve(
        import.meta.dirname,
        "../../../microcrab-frontend-plugins/zig-out/bin/output_translator.component.wasm",
      );
test.setTimeout(90_000);

type Remote = {
  calls: { url: string; body: any; authorization?: string }[];
  output: string;
  status: number;
  hold: boolean;
  releases: (() => void)[];
};
async function remote(page: Page): Promise<Remote> {
  const state: Remote = {
    calls: [],
    output:
      "# Translation\n\n**Safe** <img src=x onerror=alert(1)>\n\n```js\nconst value = 1;\n```",
    status: 200,
    hold: false,
    releases: [],
  };
  await page.route(
    /https:\/\/(translate\.googleapis\.com|api\.mymemory\.translated\.net|translator-resource\.example\.test)\//,
    async (route) => {
      const headers = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "authorization,content-type",
        "content-type": "application/json",
      };
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers });
        return;
      }
      const url = route.request().url(),
        body = route.request().postData();
      state.calls.push({
        url,
        body: body ? JSON.parse(body) : null,
        authorization: route.request().headers().authorization,
      });
      const output = state.output,
        status = state.status,
        held = state.hold;
      if (held) await new Promise<void>((done) => state.releases.push(done));
      const response = url.includes("googleapis")
        ? [[[output, "original", null, null]], null, "en"]
        : url.includes("mymemory")
          ? { responseStatus: status, responseData: { translatedText: output } }
          : { choices: [{ message: { content: output } }] };
      try {
        await route.fulfill({
          status,
          headers,
          body: JSON.stringify(response),
        });
      } catch (error) {
        if (!held) throw error;
      }
    },
  );
  return state;
}

async function setup(
  page: Page,
  options: { httpTimeoutMs?: number; locale?: string; automatic?: boolean } = {},
) {
  page.on("pageerror", (error) => {
    throw error;
  });
  // A dependency junction resolves import.meta URLs outside Vite's source root.
  // Serve only the four real installed compiler assets; never mock the inspector.
  for (const name of [
    "js-component-bindgen-component.core.wasm",
    "js-component-bindgen-component.core2.wasm",
    "wasm-tools.core.wasm",
    "wasm-tools.core2.wasm",
  ]) {
    const compiler = readFileSync(
      resolve(
        import.meta.dirname,
        "../node_modules/@bytecodealliance/jco-transpile/vendor",
        name,
      ),
    );
    await page.route(`**/${name}`, (route) =>
      route.fulfill({ contentType: "application/wasm", body: compiler }),
    );
  }
  const bytes = readFileSync(componentPath());
  expect([...bytes.subarray(0, 8)]).toEqual([0, 97, 115, 109, 13, 0, 1, 0]);
  const sha256 = createHash("sha256").update(bytes).digest("hex"),
    file = `${id}/${sha256}/plugin.wasm`;
  test
    .info()
    .annotations.push({ type: "translator-sha256", description: sha256 });
  await page.route("**/plugins/current.json", (route) =>
    route.fulfill({
      json: {
        version: 1,
        plugins: [{ id, file, sha256, default_enabled: true }],
      },
    }),
  );
  await page.route(`**/plugins/${file}`, (route) =>
    route.fulfill({ contentType: "application/wasm", body: bytes }),
  );
  await page.route("**/translator-acceptance", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const {default:React}=await import('/node_modules/.vite/deps/react.js');const {default:ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');
const {PluginRenderer}=await import('/src/plugins/renderer.tsx');const {PluginRegistry}=await import('/src/plugins/registry.ts');await import('/src/styles/tokens.css');
document.documentElement.dataset.theme='light';
const id='${id}',ownerId='translator-'+crypto.randomUUID(),session='translator-session';
const observed={errors:[],secretLeak:false,actions:[],network:[]};
const actualFetch=window.fetch.bind(window);window.fetch=(input,init)=>{const url=String(input);if(['translate.googleapis.com','api.mymemory.translated.net','translator-resource.example.test'].includes(new URL(url,location.href).hostname)){const call={url,aborted:false,reason:''};observed.network.push(call);init?.signal?.addEventListener('abort',()=>{call.aborted=true;call.reason=String(init.signal.reason);},{once:true});}return actualFetch(input,init);};
const registry=new PluginRegistry({serverOrigin:location.origin,ownerId});await registry.initialize();await registry.setSession(session);${options.httpTimeoutMs === undefined ? "" : `await registry.setHttpRequestTimeout(id,${options.httpTimeoutMs});`}registry.setEnvironment({locale:${JSON.stringify(options.locale ?? "en")}});
let target='sidebar',surface={surface_id:'translator-sidebar',target},sequence=0,variantSurface=false;
const root=ReactDOM.createRoot(document.getElementById('fixture'));
const view=()=>registry.view(id,target,surface);
const blockVariants=(block)=>registry.getBlockVariants(block);
function draw(){const current=view();if(JSON.stringify({vars:current.vars,projection:current.viewState,html:current.content,variants:surface.block_id?blockVariants(surface.block_id):[]}).includes('PRIVATE-TRANSLATOR-SECRET'))observed.secretLeak=true;
// Exercise canonical native Markdown with actual Worker text. Generic variant
// selection/action-bar UI has separate real-app coverage in the UI worktree.
const variant=surface.block_id?blockVariants(surface.block_id).find(v=>v.pluginId===id&&v.variant_id==='translation'):undefined;
const rendered=variantSurface?(variant?.status==='completed'?{...current,mode:'native-json',content:undefined,viewState:undefined,tree:{type:'markdown',props:{text:variant.text}}}:null):current;
root.render(rendered?React.createElement(PluginRenderer,{view:rendered,visible:true,webviewScope:{ownerId,sessionId:session,instanceGeneration:current.instanceGeneration||0,historyGeneration:current.historyGeneration||0,surfaceId:surface.surface_id},onAction:(name,payload)=>{observed.actions.push({name,payload,surface});registry.action(id,name,payload,surface).catch(error=>observed.errors.push(String(error)));},onVariable:()=>{throw Error('HTML must not mutate Vars');}}):null);}
registry.subscribe(draw);
async function mount(next,block){registry.releaseSurface(id,surface);variantSurface=false;target=next;surface={surface_id:'translator-'+next+'-'+(++sequence),target:next,...(block?{block_id:block,slot_id:'translation'}:{})};await registry.render(id,target,false,surface);draw();}
function mountVariant(block){registry.releaseSurface(id,surface);variantSurface=true;target='block-slot';surface={surface_id:JSON.stringify(['block-variant',id,block,'translation']),target:'block-slot',block_id:block,slot_id:'translation'};registry.setSurfaceVisible(id,surface,true);draw();}
async function settled(blocks){return Promise.all(blocks.map(async block=>({...block,source_digest:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(block.text))),n=>n.toString(16).padStart(2,'0')).join('')})));}
window.translator={registry,view,mount,mountVariant,blockVariants,observed,
  action:(name,payload={})=>registry.action(id,name,payload,surface),
  settle:async(blocks)=>{const exact=await settled(blocks);registry.observe('settled-blocks',{blocks:exact});try{const sidebar={surface_id:'translator-admission',target:'sidebar'};await registry.render(id,'sidebar',true,sidebar);registry.releaseSurface(id,sidebar);}catch(error){const p=registry.getSnapshot().find(p=>p.manifest.id===id);throw Error('Translator admission: '+p.status+' '+p.error+' '+String(error));}draw();return exact;},
  phase:(name,payload)=>registry.observe(name,payload),
  historyReset:async()=>{registry.observe('history-reset',{});await mount(target==='block-slot'?'sidebar':target);},
  vars:()=>registry.view(id,target,surface).vars,
  status:()=>registry.getSnapshot().find(p=>p.manifest.id===id),
  disable:()=>registry.setEnabled(id,session,false),
  dispose:()=>registry.dispose()
};await registry.render(id,target,false,surface);draw();window.translatorReady=true;
</script>`,
    }),
  );
  await page.goto("/translator-acceptance");
  await page.waitForFunction(() => (window as any).translatorReady);
  if (options.automatic !== false) await control(page, { auto_translate: true });
  await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
    "data-status",
    "ready",
  );
  expect(
    await page.evaluate(
      () => (window as any).translator.status().manifest.targets,
    ),
  ).toEqual(expect.arrayContaining(["sidebar", "setting-page", "block-slot"]));
}
const frame = (page: Page) => page.getByTestId("plugin-webview").contentFrame();
const block = (
  block_id: string,
  text = "Hello world",
  extra: Record<string, unknown> = {},
) => ({
  block_id,
  history_revision: "h1",
  kind: "text",
  role: "assistant",
  stream: "complete",
  text,
  ...extra,
});
async function settle(page: Page, blocks: unknown[]) {
  await page.evaluate(
    (blocks) => (window as any).translator.settle(blocks),
    blocks,
  );
}
async function mount(page: Page, target: string, block?: string) {
  await page.evaluate(
    ({ target, block }) => (window as any).translator.mount(target, block),
    { target, block },
  );
  await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
    "data-status",
    "ready",
  );
}
async function config(page: Page) {
  return page.evaluate(() => (window as any).translator.vars().sidebar.config);
}
async function control(page: Page, patch: Record<string, unknown>) {
  const previous = await config(page);
  await mount(page, "sidebar");
  await page.evaluate(
    (config) => (window as any).translator.action("control", config),
    { ...previous, ...patch },
  );
}
async function blockVariants(page: Page, blockId: string) {
  return page.evaluate(
    (blockId) => (window as any).translator.blockVariants(blockId),
    blockId,
  );
}
async function state(page: Page, blockId: string) {
  return (await blockVariants(page, blockId)).find(
    (entry: any) => entry.pluginId === id && entry.variant_id === "translation",
  );
}
async function mountVariant(page: Page, blockId: string) {
  await page.evaluate(
    (blockId) => (window as any).translator.mountVariant(blockId),
    blockId,
  );
  await expect(page.getByTestId("plugin-webview")).toHaveCount(0);
}
async function variantAction(page: Page, name: string, blockId: string) {
  await mountVariant(page, blockId);
  await page.evaluate(
    ({ name, blockId }) =>
      (window as any).translator.action(name, { block_id: blockId }),
    { name, blockId },
  );
}

test("actual Worker publishes one exact-source variant and canonical native Markdown preserves full GFM", async ({
  page,
}) => {
  const http = await remote(page);
  http.hold = true;
  const source = [
    "# Original heading",
    "",
    "A **complete** paragraph with `API.call()`.",
    "",
    "| Name | Value |",
    "| --- | --- |",
    "| Original | 42 |",
    "",
    "- [x] Finished task",
    "- [ ] Pending task",
    "",
    "> Quoted prose",
    "",
    "[Reference](https://example.test/path?q=1)",
    "",
    "```js",
    "const value = 'raw <>&';",
    "```",
  ].join("\n");
  http.output = source.replace("Original", "Translated");
  await setup(page);
  await settle(page, [
    block("reasoning", "secret thought", { kind: "reasoning" }),
    block("tool", "tool secret", { kind: "tool" }),
    block("user", "user input", { role: "user" }),
    block("streaming", "not ready", { stream: "streaming" }),
  ]);
  expect(http.calls).toHaveLength(0);
  for (const excluded of ["reasoning", "tool", "user", "streaming"])
    expect(await blockVariants(page, excluded)).toEqual([]);
  await settle(page, [
    block("answer", source, { history_revision: "exact-history" }),
  ]);
  await expect.poll(() => http.calls.length).toBe(1);
  expect(new URL(http.calls[0]!.url).searchParams.get("q")).toBe(source);
  const digest = createHash("sha256").update(source, "utf8").digest("hex");
  expect(await blockVariants(page, "answer")).toEqual([
    expect.objectContaining({
      pluginId: id,
      block_id: "answer",
      variant_id: "translation",
      source_digest: digest,
      history_revision: "exact-history",
      label: "Translation",
      status: "pending",
      text: "",
      default_display: "inline",
      retry_action: "block.retry",
      force_action: "block.force",
    }),
  ]);
  await mountVariant(page, "answer");
  http.hold = false;
  http.releases.splice(0).forEach((done) => done());
  await expect
    .poll(async () => (await state(page, "answer"))?.status)
    .toBe("completed");
  expect((await state(page, "answer")).text).toBe(http.output);
  const markdown = page.locator(".plugin-node-markdown");
  await expect(markdown.locator("h1")).toHaveText("Translated heading");
  await expect(markdown.locator("strong")).toHaveText("complete");
  await expect(markdown.locator("table tbody tr")).toHaveCount(1);
  await expect(markdown.locator("table")).toContainText("Original");
  await expect(markdown.locator('input[type="checkbox"]')).toHaveCount(2);
  await expect(markdown.locator("blockquote")).toContainText("Quoted prose");
  await expect(
    markdown.getByRole("link", { name: "Reference" }),
  ).toHaveAttribute("href", "https://example.test/path?q=1");
  await expect(markdown.locator("pre code")).toHaveText(
    "const value = 'raw <>&';\n",
  );
  expect(await blockVariants(page, "answer")).toHaveLength(1);
  expect(
    await page.evaluate(() =>
      (window as any).translator.registry.getBlockSlots("answer"),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(() => (window as any).translator.vars().blocks),
  ).toBeUndefined();
  await settle(page, [
    block("answer", source, { history_revision: "exact-history" }),
  ]);
  expect(http.calls).toHaveLength(1);
});

test("defaults to manual and translates only the explicitly requested block", async ({ page }) => {
  const http = await remote(page);
  await setup(page, { automatic: false });
  await expect(frame(page).locator("#auto_translate")).not.toBeChecked();
  await settle(page, [block("chosen"), block("untouched")]);
  expect(http.calls).toHaveLength(0);
  expect((await state(page, "chosen"))?.status).toBe("cancelled");
  await variantAction(page, "block.retry", "chosen");
  await expect.poll(async () => (await state(page, "chosen"))?.status).toBe("completed");
  expect((await state(page, "untouched"))?.status).toBe("cancelled");
  expect(http.calls).toHaveLength(1);
  await mount(page, "setting-page");
  await expect(frame(page).locator("#auto_translate")).not.toBeChecked();
});

test("same-language prose with API terms skips without HTTP; exact visible force requests once", async ({
  page,
}) => {
  const http = await remote(page);
  await setup(page);
  const source =
    "这个设置会将网络请求处理为完整的消息，并且保留原来的内容。我们应该先检查传入的数据，然后再进行翻译和显示，让所有用户都能够了解当前处理结果。API HTTP";
  await settle(page, [block("same-language", source)]);
  await expect
    .poll(async () => (await state(page, "same-language"))?.status)
    .toBe("skipped");
  expect(await state(page, "same-language")).toMatchObject({
    reason: "same_language",
    text: "",
  });
  expect(http.calls).toHaveLength(0);
  await variantAction(page, "block.force", "same-language");
  await expect
    .poll(async () => (await state(page, "same-language"))?.status)
    .toBe("completed");
  expect(http.calls).toHaveLength(1);
  expect(new URL(http.calls[0]!.url).searchParams.get("q")).toBe(source);
});

test("unknown mixed prose translates; display control emits after; unsafe output stays in native Markdown", async ({
  page,
}) => {
  const http = await remote(page);
  await setup(page);
  await frame(page).locator("#display_mode").selectOption("after");
  await frame(page).locator("#apply").click();
  await expect
    .poll(async () => (await config(page)).display_mode)
    .toBe("after");
  await settle(page, [block("mixed", "Hello 世界 API répond русский")]);
  await expect
    .poll(async () => (await state(page, "mixed"))?.status)
    .toBe("completed");
  expect(await state(page, "mixed")).toMatchObject({
    default_display: "after",
    text: http.output,
  });
  expect(http.calls).toHaveLength(1);
  await mountVariant(page, "mixed");
  const markdown = page.locator(".plugin-node-markdown");
  await expect(markdown.locator("h1")).toHaveText("Translation");
  await expect(markdown.locator("img, script, [onerror]")).toHaveCount(0);
  await expect(markdown.locator("pre code")).toHaveText("const value = 1;\n");
});

test("HTTP errors are explicit, Retry is one request, MyMemory and input bounds are enforced", async ({
  page,
}) => {
  const http = await remote(page);
  http.status = 503;
  await setup(page);
  await settle(page, [block("error")]);
  await expect
    .poll(async () => (await state(page, "error"))?.status)
    .toBe("error");
  expect((await state(page, "error")).error).toBeTruthy();
  expect(http.calls).toHaveLength(1);
  http.status = 200;
  http.output = "Recovered";
  await variantAction(page, "block.retry", "error");
  await expect
    .poll(async () => (await state(page, "error"))?.status)
    .toBe("completed");
  expect(http.calls).toHaveLength(2);
  await page.evaluate(() => (window as any).translator.historyReset());
  await control(page, { provider: "mymemory", source: "en", target: "zh-CN" });
  await settle(page, [block("memory", "short text")]);
  await expect
    .poll(async () => (await state(page, "memory"))?.text)
    .toBe("Recovered");
  expect(http.calls.at(-1)!.url).toContain("api.mymemory.translated.net");
  const calls = http.calls.length;
  await settle(page, [
    block("too-long-memory", "x".repeat(501)),
    block("too-long", "x".repeat(16385)),
  ]);
  await expect
    .poll(async () => (await state(page, "too-long-memory"))?.error)
    .toContain("500Bytes");
  expect((await state(page, "too-long")).error).toContain("16 KiB");
  expect(http.calls).toHaveLength(calls);
  await settle(page, [
    block("truncated", "partial text", { text_truncated: true }),
  ]);
  expect(await blockVariants(page, "truncated")).toEqual([]);
  expect(
    await page.evaluate(() => (window as any).translator.vars().sidebar.status),
  ).toContain("truncated");
  expect(http.calls).toHaveLength(calls);
  http.output = "x".repeat(32769);
  await settle(page, [block("too-long-output", "short input")]);
  await expect
    .poll(async () => (await state(page, "too-long-output"))?.error)
    .toContain("32KiB");
});

test("empty assistant text does not fault the actual Worker or block the next prompt", async ({
  page,
}) => {
  const http = await remote(page);
  await setup(page, { automatic: false });
  await settle(page, [block("image-only", ""), block("full", "Original prose")]);
  expect(await blockVariants(page, "image-only")).toEqual([]);
  expect((await state(page, "full"))?.status).toBe("cancelled");
  expect(
    await page.evaluate(() => {
      const t = (window as any).translator;
      return t.registry.beforeSubmit("Keep this exact draft");
    }),
  ).toEqual({ input: "Keep this exact draft" });
  expect(http.calls).toHaveLength(0);
});

test("before-submit never republishes a cached historical variant whose source became truncated", async ({
  page,
}) => {
  const http = await remote(page);
  await setup(page, { automatic: false });
  await settle(page, [block("prior", "Original full source")]);
  expect((await state(page, "prior"))?.status).toBe("cancelled");
  const text = "Original";
  const observed = await page.evaluate(
    async (replacement) => {
      const t = (window as any).translator;
      const input = t.registry.beforeSubmit("New prompt");
      // The Host knows the replacement immediately, before the serialized
      // settlement callback can tell the guest to drop its old source.
      t.phase("settled-blocks", { blocks: [replacement] });
      const result = await input;
      await t.registry.render(t.status().manifest.id, "sidebar", true);
      return { result, variants: t.blockVariants("prior"), status: t.status().status };
    },
    block("prior", text, {
      source_digest: createHash("sha256").update(text).digest("hex"),
      text_truncated: true,
    }),
  );
  expect(observed).toEqual({
    result: { input: "New prompt" },
    variants: [],
    status: "ready",
  });
  expect(http.calls).toHaveLength(0);
});

test("explicit settings Save keeps secret Host-owned, exact ACK clears draft, and test uses saved configuration", async ({
  page,
}) => {
  const http = await remote(page);
  await setup(page);
  await mount(page, "setting-page");
  await frame(page).locator("#provider").selectOption("custom");
  const model = '自定义 model / : @ < > & " 🚀';
  await expect(frame(page).locator("#model")).toHaveValue(
    "tencent/Hunyuan-MT-7B",
  );
  await expect(frame(page).locator("#model")).toHaveAttribute("type", "text");
  await expect(frame(page).locator("#model")).toHaveAttribute(
    "maxlength",
    "256",
  );
  await expect(frame(page).locator("#model")).not.toHaveAttribute("list");
  await expect(frame(page).locator("datalist")).toHaveCount(0);
  await frame(page).locator("#endpoint").fill(endpoint);
  await frame(page).locator("#model").fill(model);
  await frame(page).locator("#api-key").fill("PRIVATE-TRANSLATOR-SECRET");
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await expect(frame(page).locator("#model")).toHaveValue(model);
  await expect(frame(page).locator("html")).toHaveAttribute(
    "data-theme",
    "dark",
  );
  expect(http.calls).toHaveLength(0);
  await frame(page).locator("#save").click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).translator.observed.actions.some(
          (action: any) => action.name === "settings.save",
        ),
      ),
    )
    .toBe(true);
  const operation = await page.evaluate(
    () =>
      (window as any).translator.observed.actions.find(
        (action: any) => action.name === "settings.save",
      )?.payload.operation_id,
  );
  expect(operation).toEqual(expect.any(String));
  expect(operation.length).toBeGreaterThan(0);
  await expect(frame(page).locator("#api-key")).toHaveValue("");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).translator.view().viewState.save.status,
      ),
    )
    .toBe("applied");
  expect(
    await page.evaluate(
      () => (window as any).translator.view().viewState.save.operation_id,
    ),
  ).toBe(operation);
  await expect(frame(page).locator("#draft-status")).toHaveText("");
  expect(
    await page.evaluate(() => (window as any).translator.observed.secretLeak),
  ).toBe(false);
  await frame(page).locator("#test").click();
  await expect(frame(page).locator("#test-status")).toContainText(
    "Connection test completed",
  );
  expect(http.calls).toHaveLength(1);
  expect(http.calls[0]!.authorization).toBe("Bearer PRIVATE-TRANSLATOR-SECRET");
  expect(http.calls[0]!.body).toMatchObject({
    model,
    stream: false,
    messages: [
      { role: "system", content: expect.any(String) },
      { role: "user", content: "Hello, world." },
    ],
  });
  await mount(page, "sidebar");
  expect((await config(page)).model).toBe(model);
  await mount(page, "setting-page");
  await expect(frame(page).locator("#model")).toHaveValue(model);
  await expect(frame(page).locator("#api-key")).toHaveValue("");
  const editedModel = `${model} / edited`;
  await frame(page).locator("#model").fill(editedModel);
  await frame(page).locator("#save").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).translator.observed.actions.filter(
            (action: any) => action.name === "settings.save",
          ).length,
      ),
    )
    .toBe(2);
  const saves = await page.evaluate(() =>
    (window as any).translator.observed.actions.filter(
      (action: any) => action.name === "settings.save",
    ),
  );
  expect(saves).toHaveLength(2);
  expect(saves[1].payload.operation_id).not.toBe(operation);
  expect(saves[1].payload.config.model).toBe(editedModel);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).translator.view().viewState.save),
    )
    .toMatchObject({
      operation_id: saves[1].payload.operation_id,
      status: "applied",
    });
  const source = 'Exact UTF-8 source: 你好 🚀 <>& "\r\n\tsecond line';
  await settle(page, [block("custom-model-source", source)]);
  await expect
    .poll(async () => (await state(page, "custom-model-source"))?.status)
    .toBe("completed");
  expect(http.calls).toHaveLength(2);
  expect(http.calls[1]!.authorization).toBe("Bearer PRIVATE-TRANSLATOR-SECRET");
  expect(http.calls[1]!.body.model).toBe(editedModel);
  expect(http.calls[1]!.body.messages.at(-1).content).toBe(source);
  expect((await state(page, "custom-model-source")).source_digest).toBe(
    createHash("sha256").update(source, "utf8").digest("hex"),
  );
  expect(
    JSON.stringify(
      await page.evaluate(() => (window as any).translator.vars()),
    ),
  ).not.toContain("PRIVATE-TRANSLATOR-SECRET");
});

test("configuration changes and disable retire old translation completions without stale projection or replay", async ({
  page,
}) => {
  const http = await remote(page);
  http.hold = true;
  http.output = "Old configuration output";
  await setup(page);
  await settle(page, [block("config-fence", "Changing config")]);
  await expect.poll(() => http.calls.length).toBe(1);
  http.hold = false;
  http.output = "Current configuration output";
  await control(page, { provider: "mymemory", source: "en", target: "zh-CN" });
  await expect
    .poll(async () => (await state(page, "config-fence"))?.text)
    .toBe("Current configuration output");
  http.releases.splice(0).forEach((done) => done());
  // A second settled admission provides a queue fence after the old receipt.
  await settle(page, [block("config-fence", "Changing config")]);
  expect((await state(page, "config-fence")).text).toBe(
    "Current configuration output",
  );
  expect(http.calls).toHaveLength(2);
  http.hold = true;
  await settle(page, [block("disabled", "Disable in flight")]);
  await expect.poll(() => http.calls.length).toBe(3);
  await page.evaluate(() => (window as any).translator.disable());
  await expect(page.getByTestId("plugin-webview")).toHaveCount(0);
  http.releases.splice(0).forEach((done) => done());
  expect(
    await page.evaluate(() => (window as any).translator.status().status),
  ).toBe("disabled");
  expect(
    await page.evaluate(() =>
      (window as any).translator.registry.getBlockVariants("disabled"),
    ),
  ).toEqual([]);
  expect(http.calls).toHaveLength(3);
});

test("terminal LRU eviction removes the mounted variant at 129 actual blocks under the Host byte budget", async ({
  page,
}) => {
  const http = await remote(page);
  http.output = "short translation";
  await setup(page);
  await page.clock.install();
  // Keep the real Host 1 MiB retained budget and guest 128-entry bound. Advance
  // only the declared event-rate window between settled batches.
  for (let start = 0; start < 128; start += 16) {
    const blocks = Array.from({ length: 16 }, (_, offset) =>
      block(`lru-${start + offset}`, `Text ${start + offset}`),
    );
    await settle(page, blocks);
    await expect
      .poll(async () => {
        const entries = await Promise.all(
          Array.from({ length: start + 16 }, (_, index) =>
            state(page, `lru-${index}`),
          ),
        );
        return entries.filter((entry) => entry?.status === "completed").length;
      })
      .toBe(start + 16);
    await page.clock.runFor(1001);
  }
  await mountVariant(page, "lru-0");
  await expect(page.locator(".plugin-node-markdown")).toHaveText(
    "short translation",
  );
  await settle(page, [block("lru-128", "New terminal variant")]);
  await expect
    .poll(async () => (await blockVariants(page, "lru-0")).length)
    .toBe(0);
  await expect(page.locator(".plugin-node-markdown")).toHaveCount(0);
  await expect
    .poll(async () => (await state(page, "lru-128"))?.status)
    .toBe("completed");
  const retained = await page.evaluate(() =>
    Array.from({ length: 129 }, (_, index) =>
      (window as any).translator.blockVariants(`lru-${index}`),
    ).flat(),
  );
  expect(retained).toHaveLength(128);
  expect(
    new TextEncoder().encode(JSON.stringify(retained)).byteLength,
  ).toBeLessThan(1024 * 1024);
  await mountVariant(page, "lru-128");
  await expect(page.locator(".plugin-node-markdown")).toHaveText(
    "short translation",
  );
  expect(http.calls).toHaveLength(129);
});

test("actual Worker holds at four concurrent requests and drains queued variants once", async ({
  page,
}) => {
  const http = await remote(page);
  http.hold = true;
  await setup(page);
  const blocks = Array.from({ length: 6 }, (_, index) =>
    block(`concurrent-${index}`, `Concurrent input ${index}`),
  );
  await settle(page, blocks);
  await expect.poll(() => http.calls.length).toBe(4);
  for (const entry of blocks)
    expect(await state(page, entry.block_id)).toMatchObject({
      status: "pending",
      text: "",
    });
  // A completed admission round fences the queue while all four receipts are held.
  await settle(page, blocks);
  expect(http.calls).toHaveLength(4);
  http.hold = false;
  http.releases.splice(0).forEach((done) => done());
  await expect
    .poll(async () => {
      const entries = await Promise.all(
        blocks.map((entry) => state(page, entry.block_id)),
      );
      return entries.filter((entry) => entry?.status === "completed").length;
    })
    .toBe(6);
  expect(http.calls).toHaveLength(6);
});

test("replacement source and history revision fence old HTTP completions on the same block", async ({
  page,
}) => {
  const http = await remote(page);
  http.hold = true;
  http.output = "Stale source output";
  await setup(page);
  await settle(page, [block("source-fence", "Old original source")]);
  await expect.poll(() => http.calls.length).toBe(1);
  http.hold = false;
  http.output = "Current source output";
  const current = block("source-fence", "New original source", {
    history_revision: "h2",
  });
  await settle(page, [current]);
  await expect
    .poll(async () => (await state(page, "source-fence"))?.text)
    .toBe("Current source output");
  http.releases.splice(0).forEach((done) => done());
  await settle(page, [current]);
  expect(await blockVariants(page, "source-fence")).toEqual([
    expect.objectContaining({
      history_revision: "h2",
      source_digest: createHash("sha256").update(current.text).digest("hex"),
      status: "completed",
      text: "Current source output",
    }),
  ]);
  expect(http.calls).toHaveLength(2);
});

test("optional user translation retains its after-slot HTML, trusted Copy and denied clipboard fallback", async ({
  page,
  context,
}) => {
  const http = await remote(page);
  http.output = "# User translation\n\n**Safe** text";
  await page.clock.install();
  await setup(page);
  await control(page, { assistant_only: false });
  await settle(page, [
    block("optional-tool", "Tool output must stay original", { kind: "tool" }),
    block("optional-reasoning", "Reasoning must stay original", {
      kind: "reasoning",
    }),
  ]);
  expect(http.calls).toHaveLength(0);
  expect(await blockVariants(page, "optional-tool")).toEqual([]);
  expect(await blockVariants(page, "optional-reasoning")).toEqual([]);
  await settle(page, [
    block("user-compatible", "User prose", { role: "user" }),
  ]);
  await expect.poll(() => http.calls.length).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).translator.registry.getBlockSlots("user-compatible")
            .length,
      ),
    )
    .toBe(1);
  expect(await blockVariants(page, "user-compatible")).toEqual([]);
  await mount(page, "block-slot", "user-compatible");
  await expect(frame(page).locator("#status")).toHaveText(
    "Translation completed",
  );
  await expect(frame(page).locator("#markdown h1")).toHaveText(
    "User translation",
  );
  await context.grantPermissions(["clipboard-write", "clipboard-read"]);
  await frame(page).locator("#copy").click();
  await expect(frame(page).locator("#copy-status")).toHaveText(
    "Translation copied",
  );
  expect(
    (await page.evaluate(() => navigator.clipboard.readText())).replace(
      /\r\n/g,
      "\n",
    ),
  ).toBe(http.output);
  // The Host permits one clipboard write per second. Advance its real rate
  // window before checking the independent browser-denial fallback.
  await page.clock.runFor(1001);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async () => {
        throw new DOMException("Fixture clipboard denied", "NotAllowedError");
      },
    });
  });
  await frame(page).locator("#copy").click();
  await expect(frame(page).locator("#raw-fallback")).toBeVisible();
  await expect(frame(page).locator("#raw")).toHaveValue(http.output);
  await expect(frame(page).locator("#copy-status")).toContainText(
    "Direct copying is unavailable",
  );
  await expect(frame(page).locator("#copy-status")).toContainText(
    "Fixture clipboard denied",
  );
  expect(http.calls).toHaveLength(1);
});

test("same Worker history replacement aborts stale paid work and retains current artifact resource grants", async ({
  page,
}) => {
  const http = await remote(page);
  await setup(page);
  await mount(page, "setting-page");
  const previous = await config(page);
  await page.evaluate(
    ({ config, endpoint }) =>
      (window as any).translator.action("settings.save", {
        operation_id: "paid-save",
        config: { ...config, provider: "custom" },
        endpoint,
        authorization: "Bearer PRIVATE-TRANSLATOR-SECRET",
        clear_authorization: false,
      }),
    { config: previous, endpoint },
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).translator.view().viewState.save.status,
      ),
    )
    .toBe("applied");
  const generation = await page.evaluate(
    () => (window as any).translator.view().instanceGeneration,
  );
  http.hold = true;
  await settle(page, [block("old-paid")]);
  await expect.poll(() => http.calls.length).toBe(1);
  await page.evaluate(() => (window as any).translator.historyReset());
  expect(
    await page.evaluate(
      () => (window as any).translator.view().instanceGeneration,
    ),
  ).toBe(generation);
  http.hold = false;
  http.releases.splice(0).forEach((done) => done());
  http.output = "New history translation";
  await settle(page, [block("new-paid", "new history")]);
  await expect
    .poll(async () => (await state(page, "new-paid"))?.text)
    .toBe("New history translation");
  expect(await state(page, "old-paid")).toBeUndefined();
  expect(http.calls).toHaveLength(2);
  expect(http.calls[1]!.authorization).toBe("Bearer PRIVATE-TRANSLATOR-SECRET");
  await page.evaluate(
    ({ config, endpoint }) =>
      (window as any).translator.action("settings.save", {
        operation_id: "after-history-save",
        config: { ...config, provider: "custom", model: "after-history" },
        endpoint,
        authorization: "",
        clear_authorization: false,
      }),
    { config: previous, endpoint },
  );
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).translator.view().viewState.save),
    )
    .toMatchObject({ operation_id: "after-history-save", status: "applied" });
  expect(
    await page.evaluate(() => (window as any).translator.observed.errors),
  ).toEqual([]);
});

async function installTaskClock(page: Page) {
  const time = new Date("2030-01-01T00:00:00Z");
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
}

async function networkObservations(page: Page) {
  return page.evaluate(
    () =>
      (window as any).translator.observed.network as {
        url: string;
        aborted: boolean;
        reason: string;
      }[],
  );
}

async function setHttpTimeout(page: Page, timeoutMs: number) {
  await page.evaluate(
    ({ id, timeoutMs }) =>
      (window as any).translator.registry.setHttpRequestTimeout(id, timeoutMs),
    { id, timeoutMs },
  );
}

// Run due timers and yield to the actual Worker through a completed registry
// invocation. This also asks the guest to reap orphaned requests at the new time.
async function advanceTaskClock(page: Page, milliseconds: number) {
  await page.clock.runFor(milliseconds);
  await page.evaluate(
    (id) =>
      (window as any).translator.registry.render(id, "sidebar", true, {
        surface_id: "translator-clock-fence",
        target: "sidebar",
      }),
    id,
  );
  await page.evaluate(
    (id) =>
      (window as any).translator.registry.releaseSurface(id, {
        surface_id: "translator-clock-fence",
        target: "sidebar",
      }),
    id,
  );
}

test("actual HTML exposes consistent display controls below automation on both surfaces", async ({
  page,
}) => {
  await setup(page, { locale: "zh-CN" });
  for (const target of ["sidebar", "setting-page"]) {
    await mount(page, target);
    const html = frame(page);
    await expect(html.locator("#auto_translate")).toBeChecked();
    await expect(html.locator("#display_mode")).toHaveValue("inline");
    await expect(html.locator("label:has(#display_mode) > span")).toHaveText(
      "显示格式",
    );
    await expect(html.locator("#display_mode option")).toHaveText([
      "译文",
      "原文+译文",
    ]);
    expect(
      await html
        .locator("#display_mode option")
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value),
        ),
    ).toEqual(["inline", "after"]);
    expect(
      await html
        .locator("#display_mode")
        .evaluate(
          (select) =>
            select
              .closest("label")
              ?.previousElementSibling?.querySelector("input")?.id,
        ),
    ).toBe("auto_translate");
    await expect(html.locator("body")).not.toContainText("默认译文位置");
    await expect(html.locator("#assistant-hint")).toContainText(
      "在原文后追加译文卡片",
    );
    await expect(html.locator("#assistant-hint")).toContainText(
      "工具和推理内容仍不翻译",
    );
  }
  await frame(page).locator("#display_mode").selectOption("after");
  await frame(page).locator("#save").click();
  await expect
    .poll(async () => (await config(page)).display_mode)
    .toBe("after");
  await mount(page, "sidebar");
  await expect(frame(page).locator("#display_mode")).toHaveValue("after");
  await frame(page).locator("#display_mode").selectOption("inline");
  await frame(page).locator("#apply").click();
  await expect
    .poll(async () => (await config(page)).display_mode)
    .toBe("inline");
  await mount(page, "setting-page");
  await expect(frame(page).locator("#display_mode")).toHaveValue("inline");
});

test("120-second Host preference keeps a real request alive through 20 seconds and guest orphan checks", async ({
  page,
}) => {
  await installTaskClock(page);
  const http = await remote(page);
  http.hold = true;
  await setup(page, { httpTimeoutMs: 120_000 });
  await settle(page, [block("long-request")]);
  await expect.poll(() => http.calls.length).toBe(1);
  await advanceTaskClock(page, 20_000);
  expect(await state(page, "long-request")).toMatchObject({
    status: "pending",
    text: "",
  });
  expect(await networkObservations(page)).toEqual([
    expect.objectContaining({ aborted: false }),
  ]);
  http.releases.splice(0).forEach((done) => done());
  await expect
    .poll(async () => (await state(page, "long-request"))?.status)
    .toBe("completed");
  expect((await state(page, "long-request")).text).toBe(http.output);
  expect(http.calls).toHaveLength(1);
});

test("changing the timeout from 20 to 10 seconds preserves the in-flight capture and applies to the next request", async ({
  page,
}) => {
  await installTaskClock(page);
  const http = await remote(page);
  http.hold = true;
  await setup(page, { httpTimeoutMs: 20_000 });
  await settle(page, [block("captured-timeout")]);
  await expect.poll(() => http.calls.length).toBe(1);
  await advanceTaskClock(page, 5_000);
  await setHttpTimeout(page, 10_000);
  await advanceTaskClock(page, 10_001);
  expect((await state(page, "captured-timeout")).status).toBe("pending");
  expect((await networkObservations(page))[0]!.aborted).toBe(false);
  http.releases.splice(0).forEach((done) => done());
  await expect
    .poll(async () => (await state(page, "captured-timeout"))?.status)
    .toBe("completed");
  await settle(page, [block("new-timeout")]);
  await expect.poll(() => http.calls.length).toBe(2);
  await advanceTaskClock(page, 10_001);
  await expect
    .poll(async () => (await state(page, "new-timeout"))?.status)
    .toBe("error");
  expect((await networkObservations(page))[1]).toMatchObject({
    aborted: true,
    reason: "Error: plugin host effect exceeded 10000ms deadline",
  });
  http.releases.splice(0).forEach((done) => done());
  expect(http.calls).toHaveLength(2);
});

test("the default 10-second deadline aborts actual HTTP with the concrete Host reason", async ({
  page,
}) => {
  await installTaskClock(page);
  const http = await remote(page);
  http.hold = true;
  await setup(page);
  expect(
    await page.evaluate(
      (id) => (window as any).translator.registry.getHttpRequestTimeout(id),
      id,
    ),
  ).toBe(10_000);
  await settle(page, [block("default-timeout")]);
  await expect.poll(() => http.calls.length).toBe(1);
  await advanceTaskClock(page, 9_999);
  expect((await state(page, "default-timeout")).status).toBe("pending");
  expect((await networkObservations(page))[0]!.aborted).toBe(false);
  await advanceTaskClock(page, 2);
  await expect
    .poll(async () => (await state(page, "default-timeout"))?.status)
    .toBe("error");
  expect((await state(page, "default-timeout")).error).toBeTruthy();
  expect((await networkObservations(page))[0]).toMatchObject({
    aborted: true,
    reason: "Error: plugin host effect exceeded 10000ms deadline",
  });
  http.releases.splice(0).forEach((done) => done());
  expect(http.calls).toHaveLength(1);
});

test("owner teardown before the deadline aborts held HTTP without publishing or redispatching", async ({
  page,
}) => {
  await installTaskClock(page);
  const http = await remote(page);
  http.hold = true;
  await setup(page, { httpTimeoutMs: 120_000 });
  await settle(page, [block("owner-retired")]);
  await expect.poll(() => http.calls.length).toBe(1);
  await advanceTaskClock(page, 5_000);
  await page.evaluate(() => (window as any).translator.dispose());
  await expect
    .poll(async () => (await networkObservations(page))[0]?.aborted)
    .toBe(true);
  expect((await networkObservations(page))[0]!.reason).not.toContain(
    "deadline",
  );
  http.releases.splice(0).forEach((done) => done());
  await page.clock.runFor(20_000);
  expect(await blockVariants(page, "owner-retired")).toEqual([]);
  expect(http.calls).toHaveLength(1);
});

for (const retirement of ["history", "disable"] as const) {
  test(`actual ${retirement} before the deadline aborts held HTTP without automatic redispatch`, async ({
    page,
  }) => {
    await installTaskClock(page);
    const http = await remote(page);
    http.hold = true;
    await setup(page, { httpTimeoutMs: 120_000 });
    const source = block("retired-request");
    await settle(page, [source]);
    await expect.poll(() => http.calls.length).toBe(1);
    await advanceTaskClock(page, 5_000);
    if (retirement === "history")
      await page.evaluate(() => (window as any).translator.historyReset());
    else await page.evaluate(() => (window as any).translator.disable());
    await expect
      .poll(async () => (await networkObservations(page))[0]?.aborted)
      .toBe(true);
    http.releases.splice(0).forEach((done) => done());
    if (retirement === "disable") await page.clock.runFor(20_000);
    else await advanceTaskClock(page, 20_000);
    expect(await blockVariants(page, "retired-request")).toEqual([]);
    expect(http.calls).toHaveLength(1);
    expect((await networkObservations(page))[0]!.reason).not.toContain(
      "deadline",
    );
  });
}
