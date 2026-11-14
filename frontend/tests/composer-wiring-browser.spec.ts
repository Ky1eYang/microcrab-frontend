import { expect, test, type Page } from "@playwright/test";
import { sendSubscribed } from "./native-fixture";

// Source-only handoff: execute with the parent's unified frontend gate.
async function mount(page: Page, profileComposer = false) {
  page.on("pageerror", (error) =>
    console.error("Composer fixture runtime:", error.message),
  );
  // attach() opens a Session socket directly; command stubs below deliberately
  // stay in the page so deferred receipts and hydration retain their timing.
  let subscriptions = 0;
  await page.routeWebSocket(
    /\/api\/v1\/sessions\/[^/]+\/ws(?:\?.*)?$/,
    async (socket) => {
      const id = decodeURIComponent(
        new URL(socket.url()).pathname.split("/")[4],
      );
      const subscription = ++subscriptions;
      const snapshot = await page.evaluate(
        (id) => (window as any).h.snapshot(id),
        id,
      );
      sendSubscribed(
        socket,
        snapshot,
        `composer-sub-${subscription}`,
        `composer-generation-${subscription}`,
      );
    },
  );
  await page.route("**/composer-wiring-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><head><style>body{margin:0;min-height:100dvh;box-sizing:border-box;padding:var(--sp-4);display:flex;flex-direction:column;justify-content:flex-end}</style></head><body><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const {default: React} = await import('/node_modules/.vite/deps/react.js');
const {default: ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
const {AppStore} = await import('/src/state/store.ts');
const {AppProvider,useApp} = await import('/src/state/context.tsx');
const {SearchDialog} = await import('/src/features/popups/SearchDialog.tsx');
const SearchFixture = () => { const {state}=useApp(); return state.popup.type === 'search' ? React.createElement(SearchDialog) : null; };
const {Composer,ComposerStack} = await import('/src/features/composer.tsx');
const {CompactionCommand} = await import('/src/features/CompactionCommand.tsx');
const {CommandError} = await import('/src/client/api.ts');
const projector = await import('/src/client/projector.ts');
const {setActiveLocale} = await import('/src/i18n/index.ts');
setActiveLocale('en');
await import('/src/styles/tokens.css');
await import('/src/styles/components.css');
const methods = ['session.create','session.open','session.set_mode','turn.queue','turn.steer','session.interrupt','turn.get','session.compact','executions.content'];
const native = (id='s', overrides={}) => ({id,title:id,project_id:'p',status:'idle',agent:'alpha',mode:'default',model:'m',revision:7,archived:false,created_at_ms:1,updated_at_ms:1,...overrides});
const snapshot = (id='s', overrides={}) => ({session:native(id),messages:[],operations:[],permission:{revision:0,config:{overrides:[],review:false,initialization:"ask"}},history:null,state:{},executions:[],executions_omitted:false,...overrides});
const receipt = (id, method='turn.queue', status='completed') => ({id,session_id:'s',method,status,revision:1,result:null});
const calls=[], revoked=[];
const revoke=URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL=(url)=>{ revoked.push(url); revoke(url); };
const handlers={};
let composerCommits=0;
AppStore.prototype.start = function() {
  const store=this;
  window.h={store,calls,handlers,revoked,native,snapshot,receipt,CommandError,projector,
    get composerCommits() { return composerCommits; },
    async existing(id='s') { store.upsert(native(id)); await store.attach(id); },
    defer(method) { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b}); handlers[method]=()=>promise; return {resolve,reject}; },
    image() { return new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCwAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0))],'paste.png',{type:'image/png'}); }
  };
  store.api.uploadImage=async(id,file)=>{ calls.push({method:'attachment.upload',id,bytes:file.size}); return {attachment_id:'attachment-test',media_type:file.type,bytes:file.size,width:1,height:1}; };
  store.api.request=async(method,params={},id)=>{
    calls.push({method,params,id});
    if(handlers[method]) return handlers[method](params,id);
    if(method==='session.create') return native('s',{agent:params.agent,mode:params.mode});
    if(method==='turn.queue' || method==='turn.steer') return receipt(params.operation_id,method);
    if(method==='session.set_mode') return snapshot(id,{session:native(id,{mode:params.mode,revision:8})});
    if(method==='session.compact') return snapshot(id,{operations:[receipt(params.operation_id,'session.compact','running')]});
    return {};
  };
  store.update({connection:'ws',authSession:{authenticated:true},capabilities:{methods,features:{image_data:true},limits:{command_bytes:262144}},projects:[{id:'p',name:'Project',root:'.'}],draftWorkspace:{projectId:'p'},hostConnection:{projectId:'p',state:'ready',connected:true,transport:'grpc',catalogReady:true},agents:[{name:'alpha',component:'alpha.wasm',modes:[{name:'default',role:'main'},{name:'plan',role:'main'}]},{name:'beta',component:'beta.wasm',modes:[{name:'review',role:'main'},{name:'helper',role:'sub_agent'}]}],draftAgent:'alpha',draftMode:'default',transcript:{...store.state.transcript,sessionStatus:'idle'}});
};
const composer=${profileComposer} ? React.createElement(React.Profiler,{id:'composer',onRender:()=>composerCommits++},React.createElement(Composer)) : React.createElement(ComposerStack);
ReactDOM.createRoot(document.getElementById('fixture')).render(React.createElement(AppProvider,null,React.createElement(React.Fragment,null,React.createElement(CompactionCommand),composer,React.createElement(SearchFixture))));
</script></body></html>`,
    }),
  );
  await page.goto("/composer-wiring-fixture");
  await expect(page.getByTestId("composer-agent-pill")).toBeEnabled();
}

test("Composer ignores unrelated publications and observes fallback provider and variant changes", async ({
  page,
}) => {
  await mount(page, true);
  await page.evaluate(() => {
    const { store } = (window as any).h;
    store.update({
      sessionId: "s",
      sessions: [{ id: "s", projectID: "p", title: "s" }],
      composer: "Retain this draft and caret",
      availableModels: [
        {
          id: "same-model",
          providerId: "one",
          name: "Provider one",
          variants: ["low", "high"],
        },
        {
          id: "same-model",
          providerId: "two",
          name: "Provider two",
          variants: ["low", "high"],
        },
      ],
      transcript: {
        ...store.state.transcript,
        model: { id: "same-model", providerId: "one", variant: "low" },
      },
    });
  });
  const pill = page.getByTestId("composer-model-pill");
  await expect(pill).toContainText("Provider one");
  await expect(pill).toContainText("LOW");
  const input = page.getByTestId("composer").locator("textarea");
  await input.focus();
  await input.evaluate((node) =>
    (node as HTMLTextAreaElement).setSelectionRange(7, 17),
  );
  const commits = await page.evaluate(async () => {
    const h = (window as any).h;
    const paint = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    await paint();
    const before = h.composerCommits;
    h.store.update({
      auditRevision: 1,
      publicState: { executions: [] },
      statistics: { activity: { execution: { active: 1 } } },
      toast: { text: "Unrelated notice", kind: "warn", generation: 1 },
    });
    await paint();
    return { before, after: h.composerCommits };
  });
  expect(commits.before).toBeGreaterThan(0);
  expect(commits.after).toBe(commits.before);
  await expect(input).toHaveValue("Retain this draft and caret");
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((node) => {
      const textarea = node as HTMLTextAreaElement;
      return [textarea.selectionStart, textarea.selectionEnd];
    }),
  ).toEqual([7, 17]);
  await page.evaluate(() => {
    const { store } = (window as any).h;
    store.state.transcript.model.providerId = "two";
    store.update({ transcript: { ...store.state.transcript } });
  });
  await expect(pill).toContainText("Provider two");
  await expect(pill).toContainText("LOW");
  await page.evaluate(() => {
    const { store } = (window as any).h;
    store.state.transcript.model.variant = "high";
    store.update({ transcript: { ...store.state.transcript } });
  });
  await expect(pill).toContainText("High");
});

for (const busy of [false, true]) {
  test(`${busy ? "busy" : "idle"} Send and Enter always queue even with control modifiers`, async ({
    page,
  }) => {
    await mount(page);
    await page.evaluate(async () => {
      await (window as any).h.existing();
    });
    const input = page.getByRole("textbox", { name: "消息" });
    for (const gesture of [
      "click",
      "Control+click",
      "Enter",
      "Control+Enter",
      "Meta+Enter",
    ]) {
      await page.evaluate((busy) => {
        const h = (window as any).h;
        h.store.update({
          transcript: {
            ...h.store.state.transcript,
            sessionStatus: busy ? "busy" : "idle",
          },
        });
      }, busy);
      await input.fill(`queued ${gesture}`);
      if (gesture.endsWith("click")) {
        const button = busy
          ? page.getByTestId("queue-input")
          : page.getByRole("button", { name: "发送 (Enter)", exact: true });
        await button.click({
          modifiers: gesture === "Control+click" ? ["Control"] : [],
        });
      } else await input.press(gesture);
      await expect(input).toHaveValue("");
    }
    const calls = await page.evaluate(() =>
      (window as any).h.calls.filter((c: any) => c.method.startsWith("turn.")),
    );
    expect(calls.map((call: any) => call.method)).toEqual(
      Array(5).fill("turn.queue"),
    );
    expect(calls.map((call: any) => call.params.input.parts[0].text)).toEqual(
      ["click", "Control+click", "Enter", "Control+Enter", "Meta+Enter"].map(
        (gesture) => `queued ${gesture}`,
      ),
    );
  });
}

test("Insert has a distinct label and bent arrow and is the only steering action", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const h = (window as any).h;
    await h.existing();
    h.store.update({
      transcript: { ...h.store.state.transcript, sessionStatus: "busy" },
    });
  });
  const input = page.getByRole("textbox", { name: "消息" });
  await input.fill("insert this instruction");
  const insert = page.getByRole("button", {
    name: "插入本轮",
    exact: true,
  });
  const queue = page.getByRole("button", {
    name: "排队发送 (Enter)",
    exact: true,
  });
  await expect(insert).toHaveCount(1);
  await expect(insert).toHaveText("插入");
  await expect(queue).toHaveCount(1);
  await expect(page.getByTestId("composer-insert-icon")).toBeVisible();
  const icons = await Promise.all([
    insert.locator("svg").innerHTML(),
    queue.locator("svg").innerHTML(),
  ]);
  expect(icons[0]).not.toEqual(icons[1]);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(insert).toBeInViewport();
    await expect(queue).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await insert.click();
  await expect(input).toHaveValue("");
  const methods = await page.evaluate(() =>
    (window as any).h.calls
      .filter((c: any) => c.method.startsWith("turn."))
      .map((c: any) => c.method),
  );
  expect(methods).toEqual(["turn.steer"]);
});

test("agent and main mode are selected atomically before creation", async ({
  page,
}) => {
  await mount(page);
  await page.getByTestId("composer-agent-pill").click();
  await page
    .getByTestId("composer-agent-item")
    .filter({ hasText: "beta" })
    .click();
  expect(
    await page.evaluate(() => [
      (window as any).h.store.state.draftAgent,
      (window as any).h.store.state.draftMode,
    ]),
  ).toEqual(["alpha", "default"]);
  await expect(page.getByRole("menuitemradio", { name: "helper" })).toHaveCount(
    0,
  );
  await page.getByRole("menuitemradio", { name: "review" }).click();
  await page.getByRole("textbox", { name: "消息" }).fill("hello");
  await page.getByRole("button", { name: "发送 (Enter)", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).h.calls.find(
            (c: any) => c.method === "session.create",
          )?.params,
      ),
    )
    .toMatchObject({ agent: "beta", mode: "review", component: "beta.wasm" });
});

test("existing pinned mode uses CAS and waits for backend confirmation across resync", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const h = (window as any).h;
    await h.existing();
    h.mode = h.defer("session.set_mode");
  });
  await page.getByTestId("composer-agent-pill").click();
  await expect(page.getByTestId("composer-agent-item")).toHaveCount(0);
  await page.getByRole("menuitemradio", { name: "plan" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).h.calls.find(
            (c: any) => c.method === "session.set_mode",
          )?.params,
      ),
    )
    .toEqual({ mode: "plan", expected_revision: 7 });
  expect(
    await page.evaluate(() => (window as any).h.store.state.draftMode),
  ).toBe("default");
  await page.evaluate(async () => {
    const h = (window as any).h;
    await h.store.attach("s");
    h.mode.resolve(
      h.snapshot("s", {
        session: h.native("s", { mode: "plan", revision: 8 }),
      }),
    );
  });
  await expect(page.getByTestId("composer-agent-pill")).toContainText("plan");
  await expect(page.getByTestId("composer-agent-pill")).toBeEnabled();
});

test("clipboard images retain text show removable thumbnails and revoke removed URLs", async ({
  page,
}) => {
  await mount(page);
  await page.getByRole("textbox", { name: "消息" }).evaluate((element) => {
    const data = new DataTransfer();
    data.items.add((window as any).h.image());
    data.setData("text/plain", "caption");
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(page.getByRole("textbox", { name: "消息" })).toHaveValue(
    "caption",
  );
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).h.store.state.composerImages.length),
    )
    .toBe(1);
  await expect(page.getByTestId("composer").locator("img")).toHaveCount(1);
  await page.evaluate(async () => {
    const h = (window as any).h;
    h.removed = h.store.state.composerImages[0].previewUrl;
    await h.store.dispatch({
      type: "RemoveComposerImage",
      value: h.store.state.composerImages[0].id,
    });
  });
  expect(
    await page.evaluate(() => {
      const h = (window as any).h;
      return h.revoked.includes(h.removed);
    }),
  ).toBe(true);
  await expect(page.getByTestId("composer").locator("img")).toHaveCount(0);
});

test("same-session resync cannot strand asynchronous image intake and route switch fences it", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const h = (window as any).h;
    await h.existing();
    const file = h.image();
    const bytes = await file.arrayBuffer();
    file.slice = () => ({
      arrayBuffer: () =>
        new Promise((resolve) => {
          h.readImage = resolve;
        }),
    });
    h.intake = h.store.dispatch({ type: "PasteComposerImages", files: [file] });
    await h.store.attach("s");
    h.readImage(bytes);
    await h.intake;
  });
  expect(
    await page.evaluate(() => [
      (window as any).h.store.state.imageIntakePending,
      (window as any).h.store.state.composerImages.length,
    ]),
  ).toEqual([false, 1]);
  await page.evaluate(async () => {
    const h = (window as any).h;
    const file = h.image();
    const bytes = await file.arrayBuffer();
    file.slice = () => ({
      arrayBuffer: () =>
        new Promise((resolve) => {
          h.readImage = resolve;
        }),
    });
    h.intake = h.store.dispatch({ type: "PasteComposerImages", files: [file] });
    await h.existing("other");
    h.readImage(bytes);
    await h.intake;
  });
  expect(
    await page.evaluate(() => [
      (window as any).h.store.state.imageIntakePending,
      (window as any).h.store.state.composerImages.length,
    ]),
  ).toEqual([false, 0]);
});

test("rejected image drafts remain empty and successful image-only submission uses structured parts", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const h = (window as any).h;
    await h.existing();
    await h.store.dispatch({
      type: "PasteComposerImages",
      files: [new File(["bad"], "bad.svg", { type: "image/svg+xml" })],
    });
  });
  expect(
    await page.evaluate(
      () => (window as any).h.store.state.composerImages.length,
    ),
  ).toBe(0);
  await page.evaluate(async () => {
    const h = (window as any).h;
    await h.store.dispatch({ type: "PasteComposerImages", files: [h.image()] });
    h.url = h.store.state.composerImages[0].previewUrl;
    await h.store.dispatch({ type: "Submit" });
  });
  const parts = await page.evaluate(
    () =>
      (window as any).h.calls.find((c: any) => c.method === "turn.queue").params
        .input.parts,
  );
  expect(parts).toHaveLength(1);
  expect(parts[0]).toMatchObject({
    type: "image",
    source: { type: "attachment", attachment_id: "attachment-test" },
  });
  expect(
    await page.evaluate(() => {
      const h = (window as any).h;
      return [
        h.store.state.isCreatingSession,
        h.store.state.composerImages.length,
        h.revoked.includes(h.url),
      ];
    }),
  ).toEqual([false, 0, true]);
});

test("unknown turn admission holds draft and reconciles receipt without mutation retry", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const h = (window as any).h;
    await h.existing();
    h.get = h.defer("turn.get");
    h.handlers["turn.queue"] = () => {
      throw new h.CommandError("timeout", "delivery unknown", false, true);
    };
    h.store.update({ composer: "do not duplicate" });
    h.submit = h.store.dispatch({ type: "Submit" });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).h.calls.filter((c: any) => c.method === "turn.get")
            .length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(() => [
      (window as any).h.store.state.isCreatingSession,
      (window as any).h.store.state.composer,
    ]),
  ).toEqual([true, "do not duplicate"]);
  await page.evaluate(async () => {
    const h = (window as any).h;
    await h.store.dispatch({ type: "Submit" });
    const call = h.calls.find((c: any) => c.method === "turn.queue");
    h.get.resolve(h.receipt(call.params.operation_id));
    await h.submit;
  });
  expect(
    await page.evaluate(() => {
      const h = (window as any).h;
      return [
        h.calls.filter((c: any) => c.method === "turn.queue").length,
        h.store.state.composer,
        h.store.state.isCreatingSession,
      ];
    }),
  ).toEqual([1, "", false]);
});

test("slash keyboard selection prepares the bare compact command before admission", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    await (window as any).h.existing();
  });
  const editor = page.getByRole("textbox", { name: "消息" });
  await editor.fill("/comp");
  await expect(page.locator("#composer-slash-palette")).toBeVisible();
  await editor.press("Tab");
  await expect(editor).toHaveValue("/compact ");
  expect(
    await page.evaluate(
      () =>
        (window as any).h.calls.filter(
          (call: any) => call.method === "session.compact",
        ).length,
    ),
  ).toBe(0);
  await editor.press("Enter");
  await expect(page.getByTestId("compact-lifecycle")).toHaveAttribute(
    "data-status",
    "running",
  );
  const admitted = await page.evaluate(() =>
    (window as any).h.calls.find(
      (call: any) => call.method === "session.compact",
    ),
  );
  expect(admitted.params.instruction).toBe("");
  expect(admitted.params.operation_id).toMatch(/^[0-9a-f-]{36}$/);
});

test("compact slash guards IME and reconciles terminal event before late unknown HTTP response", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const h = (window as any).h;
    await h.existing();
    h.compact = h.defer("session.compact");
  });
  const editor = page.getByRole("textbox", { name: "消息" });
  await editor.fill("/compact preserve decisions");
  await editor.evaluate((el) =>
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(
    await page.evaluate(
      () =>
        (window as any).h.calls.filter(
          (c: any) => c.method === "session.compact",
        ).length,
    ),
  ).toBe(0);
  await editor.press("Enter");
  await expect(page.getByTestId("compact-lifecycle")).toHaveAttribute(
    "data-status",
    "running",
  );
  await page.evaluate(() => {
    const h = (window as any).h;
    const call = h.calls.find((c: any) => c.method === "session.compact");
    h.store.compactLifecycle("s", {
      operation_id: call.params.operation_id,
      status: "completed",
    });
    h.compact.reject(new h.CommandError("timeout", "unknown", false, true));
  });
  await expect(page.getByTestId("compact-lifecycle")).toHaveCount(0);
  await expect(editor).toHaveValue("");
  expect(
    await page.evaluate(
      () =>
        (window as any).h.calls.filter((c: any) => c.method === "turn.queue")
          .length,
    ),
  ).toBe(0);
});

test("compact unknown receipt stays blocked and route switch cannot clear another draft", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const h = (window as any).h;
    await h.existing();
    h.get = h.defer("turn.get");
    h.handlers["session.compact"] = () => {
      throw new h.CommandError("timeout", "unknown", false, true);
    };
    h.store.update({ composer: "/compact" });
    await h.store.dispatch({ type: "Submit" });
  });
  await expect(page.getByTestId("compact-lifecycle")).toHaveAttribute(
    "data-status",
    "unknown",
  );
  await page.evaluate(async () => {
    const h = (window as any).h;
    const call = h.calls.find((c: any) => c.method === "session.compact");
    await h.existing("other");
    h.store.update({ composer: "other draft" });
    h.get.resolve(h.receipt(call.params.operation_id, "session.compact"));
  });
  await expect(page.getByRole("textbox", { name: "消息" })).toHaveValue(
    "other draft",
  );
  expect(
    await page.evaluate(() => (window as any).h.store.state.compactInflight),
  ).toBe(false);
});

test("operation elapsed uses whole-second minute and hour clocks", async ({
  page,
}) => {
  await mount(page);
  await page.clock.install();
  const clocks = await page.evaluate(async () => {
    const { elapsedClock } =
      await import("/src/features/composer/StatisticsDock.tsx");
    return [0, 999, 1000, 59999, 60000, 3599999, 3600000, 3661000].map(
      elapsedClock,
    );
  });
  expect(clocks).toEqual([
    "00:00",
    "00:00",
    "00:01",
    "00:59",
    "01:00",
    "59:59",
    "1:00:00",
    "1:01:01",
  ]);
  await page.evaluate(() =>
    (window as any).h.store.update({
      statistics: {
        activity: {
          turns: 1,
          steps: 1,
          tool_calls: 0,
          operation: {
            status: "running",
            started_at_ms: Date.now() - 61000,
            ended_at_ms: null,
          },
        },
        usage: { aggregate: {} },
        provider: {},
        model: {},
      },
    }),
  );
  await expect(page.locator(".running-timer-row")).toContainText("01:01");
  await page.clock.fastForward(1000);
  await expect(page.locator(".running-timer-row")).toContainText("01:02");
  await page.getByTestId("statistics-activity").click();
  const elapsed = page
    .locator("#statistics-activity-details .dock-stat-row")
    .filter({ hasText: "操作耗时" });
  await expect(elapsed).toContainText("01:02");
  await expect(elapsed).not.toContainText(".");
});

test("queued execution elapsed stays visible after queue admission, stops on completion and never leaks to another session", async ({
  page,
}) => {
  await mount(page);
  await page.clock.install();
  await page.evaluate(async () => {
    await (window as any).h.existing();
  });
  const input = page.getByRole("textbox", { name: "消息" });
  await input.fill("queued execution");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("operation-elapsed")).toHaveCount(0);
  await page.evaluate(() => {
    const h = (window as any).h;
    const queue = h.calls.find((call: any) => call.method === "turn.queue");
    if (!queue) throw Error("send must queue");
    h.store.update({
      transcript: { ...h.store.state.transcript, sessionStatus: "busy" },
      statistics: {
        activity: {
          turns: 1,
          steps: 1,
          tool_calls: 1,
          operation: {
            id: "queue-admission",
            kind: "turn.queue",
            status: "completed",
            started_at_ms: Date.now() - 62000,
            ended_at_ms: Date.now() - 61000,
            elapsed_ms: 1000,
          },
          execution: {
            active: true,
            started_at_ms: Date.now() - 61000,
            ended_at_ms: null,
            elapsed_ms: null,
          },
        },
        usage: { aggregate: {} },
        provider: {},
        model: {},
      },
    });
  });
  const timer = page.getByTestId("operation-elapsed");
  await expect(timer).toBeVisible();
  await expect(timer).toContainText("01:01");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(timer).toBeInViewport();
  }
  await page.clock.fastForward(2000);
  await expect(timer).toContainText("01:03");
  await page.evaluate(() => {
    const store = (window as any).h.store;
    const statistics = structuredClone(store.state.statistics);
    statistics.activity.operation.status = "running";
    statistics.activity.operation.ended_at_ms = null;
    statistics.activity.execution = {
      ...statistics.activity.execution,
      active: false,
      ended_at_ms: Date.now(),
      elapsed_ms: 63000,
    };
    store.update({
      statistics,
      transcript: { ...store.state.transcript, sessionStatus: "idle" },
    });
  });
  await expect(timer).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).h.store.update({
      sessionId: "other-session",
      statistics: null,
    }),
  );
  await expect(timer).toHaveCount(0);
});

test("compaction keeps its independent command clock while the inbox is idle", async ({
  page,
}) => {
  await mount(page);
  await page.clock.install();
  await page.evaluate(() => {
    (window as any).h.store.update({
      statistics: {
        activity: {
          turns: 0,
          steps: 0,
          tool_calls: 0,
          execution: {
            active: false,
            started_at_ms: null,
            ended_at_ms: null,
            elapsed_ms: null,
          },
          operation: {
            id: "compact",
            kind: "session.compact",
            status: "running",
            started_at_ms: Date.now() - 10000,
            ended_at_ms: null,
            elapsed_ms: null,
          },
        },
        usage: { aggregate: {} },
        provider: {},
        model: {},
      },
    });
  });
  await expect(page.getByTestId("operation-elapsed")).toContainText("00:10");
  await page.clock.fastForward(1000);
  await expect(page.getByTestId("operation-elapsed")).toContainText("00:11");
});

test("statistics distinguish unknown token occupancy from real measured bytes", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    const h = (window as any).h;
    h.store.update({
      statistics: {
        context: {
          bytes: 123,
          limit_bytes: 1000,
          remaining_bytes: 877,
          epoch: 2,
          pending_epoch: true,
          categories: {},
          counts: {},
          fingerprint: "f",
          provenance: "context_budget_json_v1",
        },
        activity: { turns: null, steps: 3, tool_calls: 2, operation: null },
        usage: {
          main: { input_tokens: null, output_tokens: 0 },
          aggregate: {},
          main_cache_hit_rate: null,
          aggregate_cache_hit_rate: null,
        },
        provider: {
          latest_prompt: {
            input_tokens: 900,
            freshness: "stale",
            freshness_reason: "context_changed",
          },
          timing: null,
        },
        model: {
          context_window_tokens: null,
          measured_headroom_tokens: null,
          headroom_reason: "missing_window",
        },
      },
    });
  });
  await expect(page.getByTestId("statistics-usage")).toContainText("上下文 —");
  await page.getByTestId("statistics-usage").click();
  await expect(page.locator("#statistics-usage-details")).toContainText(
    "123 B / 1,000 B",
  );
  await expect(page.locator("#statistics-usage-details")).toContainText(
    "900 tok",
  );
  await expect(page.locator("#statistics-usage-details")).not.toContainText(
    "计量范围",
  );
  await expect(page.locator("#statistics-usage-details")).not.toContainText(
    "上次请求实测",
  );
  await expect(
    page.locator("#statistics-usage-details .statistics-help").last(),
  ).toHaveAttribute("title", /上次请求实测/);
  await expect(page.locator("#statistics-usage-details")).not.toContainText(
    "context_changed",
  );
  await expect(page.locator("#statistics-usage-details")).not.toContainText(
    "missing_window",
  );
  await expect(page.locator("#statistics-usage-details")).not.toContainText(
    "NaN",
  );
});

test("Context percentage uses current measured tokens and never byte ratios", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() =>
    (window as any).h.store.update({
      statistics: {
        context: { bytes: 900, limit_bytes: 1000, categories: {} },
        activity: { turns: 1, steps: 1, tool_calls: 0 },
        usage: { aggregate: {} },
        provider: {
          latest_prompt: { input_tokens: 200, freshness: "current" },
        },
        model: { context_window_tokens: 1000, measured_headroom_tokens: 800 },
      },
    }),
  );
  await expect(page.getByTestId("statistics-usage")).toContainText(
    "上下文 20.0%",
  );
  await expect(page.getByTestId("statistics-usage")).not.toContainText(
    "缓存命中率",
  );
  await expect(page.getByTestId("statistics-usage")).not.toContainText("90.0%");
  await page.evaluate(() => {
    const h = (window as any).h;
    h.store.update({
      statistics: {
        ...h.store.state.statistics,
        provider: {
          latest_prompt: {
            input_tokens: 200,
            freshness: "stale",
            freshness_reason: "context_changed_since_request",
          },
        },
      },
    });
  });
  await expect(page.getByTestId("statistics-usage")).toContainText(
    "上下文占用率 20.0%",
  );
  await expect(
    page.getByTestId("statistics-usage").locator(".dock-pill-label"),
  ).toHaveAttribute("title", "上次请求实测，当前内容已变化或尚未验证");
  for (const reason of [
    "model_selection_changed",
    "epoch_changed",
    "request_provenance_unavailable",
  ]) {
    await page.evaluate((freshness_reason) => {
      const h = (window as any).h;
      h.store.update({
        statistics: {
          ...h.store.state.statistics,
          provider: {
            latest_prompt: {
              input_tokens: 200,
              freshness: "stale",
              freshness_reason,
            },
          },
        },
      });
    }, reason);
    await expect(page.getByTestId("statistics-usage")).toContainText(
      "上下文 —",
    );
    await expect(page.getByTestId("statistics-usage")).not.toContainText(
      "20.0%",
    );
  }
  await page.getByTestId("statistics-usage").click();
  await expect(page.locator("#statistics-usage-details")).toContainText(
    "请求输入 token",
  );
  await page.evaluate(() => {
    const h = (window as any).h;
    h.store.update({
      statistics: {
        ...h.store.state.statistics,
        provider: { latest_prompt: { input_tokens: 200, freshness: "stale" } },
        model: { context_window_tokens: null },
      },
    });
  });
  await expect(page.getByTestId("statistics-usage")).toContainText("上下文 —");
  await expect(page.getByTestId("statistics-usage")).not.toContainText("%");
});

test("context overview keeps cache hit and exact consumption buckets together", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() =>
    (window as any).h.store.update({
      statistics: {
        context: { bytes: 900, limit_bytes: 1000, categories: {} },
        activity: { turns: 1, steps: 1, tool_calls: 0 },
        usage: {
          aggregate_cache_hit_rate: 0.75,
          aggregate: {
            input_tokens: 1000,
            uncached_input_tokens: 200,
            cache_read_tokens: 750,
            cache_write_tokens: 50,
            output_tokens: 123,
            total_tokens: 1123,
          },
        },
        provider: {
          latest_prompt: { input_tokens: 200, freshness: "current" },
        },
        model: { context_window_tokens: 1000 },
      },
    }),
  );
  const trigger = page.getByTestId("statistics-usage");
  await expect(trigger).toContainText("20.0%");
  await expect(trigger).toContainText("75.0%");
  await trigger.click();
  const overview = page.locator("#statistics-usage-details");
  await expect(overview).toHaveAttribute("role", "dialog");
  await expect(overview.locator(".dock-popover-header")).toContainText(
    "1,123 tok",
  );
  const row = (label: string) =>
    overview
      .locator(".dock-stat-row")
      .filter({ has: page.locator(".dock-stat-label", { hasText: label }) });
  await expect(row("缓存命中率")).toContainText("75.0%");
  await expect(row("非缓存输入 token")).toContainText("200");
  await expect(row("缓存读取")).toContainText("750");
  await expect(row("缓存写入")).toContainText("50");
  await expect(row("输出（含推理）")).toContainText("123");
  await page.keyboard.press("Escape");
  await expect(overview).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await expect(overview).toHaveCount(0);
});

test("Google-style usage without cache metadata still displays inclusive input and totals", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() =>
    (window as any).h.store.update({
      statistics: {
        context: { bytes: 900, limit_bytes: 1000, categories: {} },
        activity: { turns: 1, steps: 1, tool_calls: 0 },
        usage: {
          aggregate_cache_hit_rate: null,
          aggregate: {
            input_tokens: 3891,
            output_tokens: 311,
            total_tokens: 4202,
            cache_read_tokens: null,
            uncached_input_tokens: null,
          },
        },
        provider: { latest_prompt: { input_tokens: 3891, freshness: "stale" } },
        model: { context_window_tokens: null },
      },
    }),
  );
  const trigger = page.getByTestId("statistics-usage");
  await expect(trigger).toContainText("上下文 —");
  await trigger.click();
  const overview = page.locator("#statistics-usage-details");
  const row = (label: string) =>
    overview
      .locator(".dock-stat-row")
      .filter({ has: page.locator(".dock-stat-label", { hasText: label }) });
  await expect(row("输入（含缓存）")).toContainText("3,891");
  await expect(row("输出（含推理）")).toContainText("311");
  await expect(overview.locator(".dock-popover-header")).toContainText(
    "4,202 tok",
  );
  await expect(row("缓存命中率")).toContainText("-");
  await expect(row("非缓存输入 token")).toContainText("-");
  await expect(overview).not.toContainText("NaN");
});

test("compact lifecycle is a conversation row and completed commands leave the input area clear", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const h = (window as any).h;
    await h.existing();
    h.store.update({
      compactOperation: {
        sessionId: "s",
        operation_id: "compact",
        status: "failed",
        instruction: "preserve decisions",
        error: { code: "failed", message: "synthetic failure" },
      },
    });
  });
  await expect(page.locator(".compaction-command")).toContainText(
    "/compact preserve decisions",
  );
  await expect(page.locator(".compaction-command")).toContainText(
    "synthetic failure",
  );
  await expect(page.locator(".composer-compact-status")).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).h.store.compactLifecycle("s", {
      operation_id: "compact",
      status: "completed",
    }),
  );
  await expect(page.getByTestId("compact-lifecycle")).toHaveCount(0);
});

test("activity renders actual generation measurements and Context shows only main byte categories", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() =>
    (window as any).h.store.update({
      statistics: {
        context: {
          bytes: 500,
          limit_bytes: 1000,
          categories: {
            system: 100,
            tools: 100,
            state: 40,
            user: 80,
            assistant: 100,
            tool_result: 30,
            framing: 50,
          },
        },
        activity: { turns: 2, steps: 3, tool_calls: 1, operation: null },
        usage: {
          main: {},
          aggregate: { input_tokens: 200, output_tokens: 20 },
          aggregate_cache_hit_rate: 0.5,
        },
        provider: {
          timing: {
            first_token_ms: 250,
            generation_ms: 2000,
            tokens_per_second: 10,
            rate_basis: "generation_interval",
          },
        },
        model: { context_window_tokens: null, measured_headroom_tokens: null },
      },
    }),
  );
  await page.getByTestId("statistics-activity").click();
  const activity = page.locator("#statistics-activity-details");
  await expect(activity).toContainText("10.0 tok/s");
  await expect(activity).toContainText("0.25 s");
  await expect(activity).toContainText("2.00 s");
  await expect(activity).not.toContainText("Not provided");
  await page.keyboard.press("Escape");
  await page.getByTestId("statistics-usage").click();
  const context = page.locator("#statistics-usage-details");
  await expect(context).toContainText("250 B");
  await expect(context).toContainText("缓存命中率");
  await expect(context).toContainText("50.0%");
  await expect(context).not.toContainText("fingerprint");
  await expect(context).not.toContainText("Not provided");
});

test("activity keeps its last measured snapshot and rate through refresh gaps within one session", async ({
  page,
}) => {
  await mount(page);
  const pill = page.getByTestId("statistics-activity");
  await expect(pill).not.toContainText("tok/s");
  await page.evaluate(() => {
    const h = (window as any).h;
    h.store.update({
      statistics: {
        context: { bytes: 500, limit_bytes: 1000, categories: {} },
        activity: { turns: 1, steps: 2, tool_calls: 1, operation: null },
        usage: { aggregate: { input_tokens: 200, output_tokens: 20 } },
        provider: {
          timing: {
            rate_basis: "generation_interval",
            tokens_per_second: 62.8,
            first_token_ms: 250,
            generation_ms: 2000,
          },
        },
        model: { context_window_tokens: 1000 },
      },
    });
  });
  await expect(pill).toContainText("1 · 62.8 tok/s");
  await page.evaluate(() => {
    const h = (window as any).h;
    h.measuredStatistics = h.store.state.statistics;
    h.store.update({ statistics: null });
  });
  await expect(pill).toContainText("1 · 62.8 tok/s");
  await pill.click();
  await expect(page.locator("#statistics-activity-details")).toContainText(
    "62.8 tok/s",
  );
  await expect(page.locator("#statistics-activity-details")).toContainText(
    "0.25 s",
  );
  await page.keyboard.press("Escape");
  for (const timing of [
    null,
    { rate_basis: "request_average", tokens_per_second: 4 },
    { rate_basis: "generation_interval", tokens_per_second: -1 },
  ]) {
    await page.evaluate((timing) => {
      const h = (window as any).h;
      h.store.update({
        statistics: {
          ...h.measuredStatistics,
          activity: { ...h.measuredStatistics.activity, turns: 2 },
          provider: { timing },
        },
      });
    }, timing);
    await expect(pill).toContainText("2 · 62.8 tok/s");
  }
  await page.evaluate(() => {
    const h = (window as any).h;
    h.store.update({
      statistics: {
        ...h.store.state.statistics,
        provider: {
          timing: { rate_basis: "generation_interval", tokens_per_second: 0 },
        },
      },
    });
  });
  await expect(pill).toContainText("2 · 0.0 tok/s");
  await page.evaluate(() => {
    const h = (window as any).h;
    h.store.update({ sessionId: "different-session", statistics: null });
  });
  await expect(pill).not.toContainText("tok/s");
  await expect(pill).not.toContainText("0.0 tok/s");
  await expect(pill).not.toContainText("62.8 tok/s");
});

test("reused call ids cannot inherit another invocation or replace canonical bodies with cached prefixes", async ({
  page,
}) => {
  await mount(page);
  const cases = await page.evaluate(() => {
    const h = (window as any).h,
      p = h.projector;
    return [false, true].map((sameInvocation) => {
      const prior = p.createTranscript();
      const old = p.createBlock(
        "s",
        "old-message",
        "call",
        "tool",
        "assistant",
      );
      Object.assign(old, {
        callId: "call",
        executionId: 41,
        position: { epoch: 1, turn: 1, round: 1 },
        tool: { name: "read", input: { old: true }, status: "completed" },
        canonicalContent: {
          result: {
            available: true,
            content: "prefix",
            cursor: 0,
            next_cursor: 6,
            end_cursor: 999,
          },
        },
      });
      old.payload.text = "prefix";
      prior.blocks = [old];
      const position = { epoch: sameInvocation ? 1 : 2, turn: 1, round: 1 };
      const snap = h.snapshot("s", {
        messages: [
          {
            id: sameInvocation ? "old-message" : "new-message",
            role: "assistant",
            text: null,
            parts: [],
            tool_calls: [
              { id: "call", name: "read", arguments: { fresh: true } },
            ],
            position,
          },
          {
            id: "result-message",
            role: "tool",
            text: "complete canonical 中文🙂 result",
            parts: [],
            tool_calls: [],
            call_id: "call",
            position,
          },
        ],
      });
      const block = p
        .applySnapshot(snap, prior)
        .blocks.find((item: any) => item.callId === "call");
      return {
        executionId: block.executionId ?? null,
        text: block.payload.text,
        input: block.tool.input,
      };
    });
  });
  expect(cases).toEqual([
    {
      executionId: null,
      text: "complete canonical 中文🙂 result",
      input: { fresh: true },
    },
    {
      executionId: 41,
      text: "complete canonical 中文🙂 result",
      input: { fresh: true },
    },
  ]);
});

test("live canonical Unicode results hydrate across pages before the model turn completes", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const h = (window as any).h;
    await h.existing();
    const text = "中文🙂".repeat(20000),
      bytes = new TextEncoder().encode(text);
    const block = h.projector.createBlock(
      "s",
      "live-message",
      "unicode",
      "tool",
      "assistant",
    );
    Object.assign(block, {
      callId: "unicode",
      executionId: 9,
      temporary: true,
      position: { epoch: 1, turn: 1, round: 1 },
      tool: { name: "read", input: {}, status: "completed" },
    });
    h.store.update({
      transcript: {
        ...h.store.state.transcript,
        sessionStatus: "busy",
        blocks: [block],
      },
    });
    h.handlers["executions.content"] = (params: any) => {
      const args = params.field === "arguments";
      const source = args ? new TextEncoder().encode("{}") : bytes;
      // One repeated unit is ten UTF-8 bytes; pages do not split codepoints.
      const end = Math.min(
        source.length,
        params.cursor + Math.floor(params.max_bytes / 10) * 10,
      );
      return {
        session_id: "s",
        execution_id: 9,
        call_id: "unicode",
        field: params.field,
        source_hash: args ? "arguments-source" : "unicode-source",
        content: new TextDecoder().decode(source.subarray(params.cursor, end)),
        cursor: params.cursor,
        next_cursor: end,
        end_cursor: source.length,
        revision: params.cursor + 1,
        available: true,
      };
    };
    await h.store.hydrateExecution({
      session_id: "s",
      data: {
        execution_id: 9,
        call_id: "unicode",
        phase: "completed",
        epoch: 1,
        turn: 1,
        round: 1,
      },
    });
    const hydrated = h.store.state.transcript.blocks[0];
    return {
      complete: hydrated.payload.text === text,
      bytes: new TextEncoder().encode(hydrated.payload.text).length,
      status: h.store.state.transcript.sessionStatus,
      pages: h.calls.filter(
        (call: any) =>
          call.method === "executions.content" &&
          call.params.field === "result",
      ).length,
    };
  });
  expect(result.complete).toBe(true);
  expect(result.bytes).toBe(200000);
  expect(result.status).toBe("busy");
  expect(result.pages).toBeGreaterThan(1);
});

test("late canonical content cannot overwrite a replacement route", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const h = (window as any).h;
    await h.existing();
    const block = h.projector.createBlock(
      "s",
      "old-live",
      "reused",
      "tool",
      "assistant",
    );
    Object.assign(block, {
      callId: "reused",
      executionId: 9,
      temporary: true,
      position: { epoch: 1, turn: 1, round: 1 },
      tool: { name: "read", input: {}, status: "completed" },
    });
    h.store.update({
      transcript: { ...h.store.state.transcript, blocks: [block] },
    });
    h.handlers["executions.content"] = (params: any) =>
      params.field === "result"
        ? new Promise((resolve) => {
            h.resolveContent = resolve;
          })
        : {
            session_id: "s",
            execution_id: 9,
            call_id: "reused",
            field: "arguments",
            source_hash: "args",
            content: "{}",
            cursor: 0,
            next_cursor: 2,
            end_cursor: 2,
            revision: 1,
            available: true,
          };
    const pending = h.store.hydrateExecution({
      session_id: "s",
      data: {
        execution_id: 9,
        call_id: "reused",
        phase: "completed",
        epoch: 1,
        turn: 1,
        round: 1,
      },
    });
    await h.existing("other");
    const replacement = h.projector.createBlock(
      "other",
      "replacement",
      "reused",
      "tool",
      "assistant",
    );
    Object.assign(replacement, {
      callId: "reused",
      executionId: 9,
      position: { epoch: 1, turn: 1, round: 1 },
      tool: { name: "read", input: {}, status: "completed" },
    });
    replacement.payload.text = "new route content";
    h.store.update({
      transcript: { ...h.store.state.transcript, blocks: [replacement] },
    });
    h.resolveContent({
      session_id: "s",
      execution_id: 9,
      call_id: "reused",
      field: "result",
      source_hash: "old",
      content: "old route content",
      cursor: 0,
      next_cursor: 17,
      end_cursor: 17,
      revision: 1,
      available: true,
    });
    await pending;
    return {
      session: h.store.state.sessionId,
      text: h.store.state.transcript.blocks[0].payload.text,
    };
  });
  expect(result).toEqual({ session: "other", text: "new route content" });
});

test("authentication owner change clears cached views and memory drafts including image URLs", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const h = (window as any).h,
      store = h.store;
    store.update({
      authSession: { authenticated: true, principal: { owner: "owner-a" } },
    });
    await h.existing("private-a");
    store.update({ composer: "OWNER_A_PRIVATE_DRAFT" });
    await store.dispatch({ type: "PasteComposerImages", files: [h.image()] });
    const preview = store.state.composerImages[0].previewUrl;
    await h.existing("private-b");
    const before = {
      cache: store.sessionCache.size,
      drafts: store.drafts.size,
    };
    store.update({ composer: "OWNER_A_ACTIVE_DRAFT" });
    store.started = true;
    store.api.browserSession = async () => ({
      authenticated: true,
      principal: { owner: "owner-b" },
    });
    store.api.connect = () => {};
    await store.connect();
    return {
      before,
      cache: store.sessionCache.size,
      drafts: store.drafts.size,
      composer: store.state.composer,
      images: store.state.composerImages.length,
      sessionId: store.state.sessionId,
      blocks: store.state.transcript.blocks.length,
      revoked: h.revoked.includes(preview),
      owner: store.state.authSession.principal.owner,
    };
  });
  expect(result.before.cache).toBeGreaterThan(0);
  expect(result.before.drafts).toBeGreaterThan(0);
  expect(result).toMatchObject({
    cache: 0,
    drafts: 0,
    composer: "",
    images: 0,
    sessionId: null,
    blocks: 0,
    revoked: true,
    owner: "owner-b",
  });
});

test("visited Session cache evicts the least recent view at eight entries", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const h = (window as any).h,
      store = h.store;
    await h.existing("lru-0");
    for (let index = 1; index <= 9; index++) await h.existing("lru-" + index);
    const initial = [...store.sessionCache.keys()];
    await h.existing("lru-2");
    await h.existing("lru-10");
    await h.existing("lru-11");
    return { initial, final: [...store.sessionCache.keys()] };
  });
  expect(result.initial).toEqual([
    "lru-1",
    "lru-2",
    "lru-3",
    "lru-4",
    "lru-5",
    "lru-6",
    "lru-7",
    "lru-8",
  ]);
  expect(result.final).toHaveLength(8);
  expect(result.final).toContain("lru-2");
  expect(result.final).not.toContain("lru-1");
  expect(result.final).not.toContain("lru-3");
});

test("mode CAS remains available during foreground work and manual compaction", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const h = (window as any).h;
    await h.existing();
    h.store.update({
      compactInflight: true,
      transcript: { ...h.store.state.transcript, sessionStatus: "busy" },
    });
  });
  await expect(page.getByTestId("composer-agent-pill")).toBeEnabled();
  await page.getByTestId("composer-agent-pill").click();
  await expect(page.getByTestId("composer-agent-item")).toHaveCount(0);
  await page
    .getByTestId("composer-mode-item")
    .filter({ hasText: "plan" })
    .click();
  await expect(page.getByTestId("composer-agent-pill")).toContainText("plan");
  expect(
    await page.evaluate(() => {
      const h = (window as any).h;
      return {
        busy: h.store.state.transcript.sessionStatus,
        compact: h.store.state.compactInflight,
        calls: h.calls
          .filter((call: any) => call.method === "session.set_mode")
          .map((call: any) => call.params),
      };
    }),
  ).toEqual({
    busy: "busy",
    compact: true,
    calls: [{ mode: "plan", expected_revision: 7 }],
  });
});

test("Search distinguishes loading, empty and concrete preview failure and ignores an obsolete selection", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    const h = (window as any).h;
    const dispatch = h.store.dispatch.bind(h.store);
    h.previewReads = [];
    h.store.dispatch = (action: any) =>
      action.type === "GetSessionSnapshot"
        ? new Promise((resolve, reject) =>
            h.previewReads.push({ id: action.value, resolve, reject }),
          )
        : dispatch(action);
    h.store.update({
      sessions: [
        h.projector.sessionView(h.native("first")),
        h.projector.sessionView(h.native("second")),
      ],
      popup: { type: "search", query: "", selectedId: "first" },
    });
  });
  await expect(page.locator(".preview-loading-hint")).toBeVisible();
  // A row click intentionally opens that Session. Change only the preview
  // selection to exercise its live-request guard without changing navigation.
  await page.evaluate(() => {
    const store = (window as any).h.store;
    store.update({ popup: { ...store.state.popup, selectedId: "second" } });
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).h.previewReads.map((read: any) => read.id),
      ),
    )
    .toEqual(["first", "second"]);
  await page.evaluate(() => {
    const h = (window as any).h;
    h.previewReads
      .find((read: any) => read.id === "first")
      .reject(Error("obsolete preview failure"));
    h.previewReads
      .find((read: any) => read.id === "second")
      .resolve(h.snapshot("second"));
  });
  await expect(page.locator(".preview-response-empty")).toBeVisible();
  await expect(page.locator(".search-dialog").getByRole("alert")).toHaveCount(
    0,
  );
  await page.evaluate(() => {
    const store = (window as any).h.store;
    store.update({ popup: { ...store.state.popup, selectedId: "first" } });
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).h.previewReads.map((read: any) => read.id),
      ),
    )
    .toEqual(["first", "second", "first"]);
  await expect(page.locator(".preview-loading-hint")).toBeVisible();
  await page.evaluate(() =>
    (window as any).h.previewReads
      .at(-1)
      .reject(Error("History unavailable: cache directory is read-only")),
  );
  await expect(page.locator(".search-dialog").getByRole("alert")).toContainText(
    "cache directory is read-only",
  );
  await expect(page.locator(".preview-response-empty")).toHaveCount(0);
});
