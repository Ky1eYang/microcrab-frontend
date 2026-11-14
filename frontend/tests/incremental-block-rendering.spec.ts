import { expect, test } from "@playwright/test";

// Isolate BlockView from app startup so the probe observes React's block
// boundary rather than incidental store or authentication renders.
test("an in-place delta renders its block without replacing a selected sibling", async ({
  page,
}) => {
  await page.route("**/incremental-block-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><div id='probe'></div>",
    }),
  );
  await page.goto("/incremental-block-fixture");
  const result = await page.evaluate(async () => {
    const { default: RefreshRuntime } = await import("/@react-refresh");
    RefreshRuntime.injectIntoGlobalHook(window);
    (window as any).$RefreshReg$ = () => {};
    (window as any).$RefreshSig$ = () => (type: unknown) => type;
    (window as any).__vite_plugin_react_preamble_installed__ = true;
    const { default: React } =
      await import("/node_modules/.vite/deps/react.js");
    const { default: ReactDOM } =
      await import("/node_modules/.vite/deps/react-dom_client.js");
    const { default: ReactDOMCore } =
      await import("/node_modules/.vite/deps/react-dom.js");
    const { createRoot } = ReactDOM;
    const { flushSync } = ReactDOMCore;
    const { BlockView, blockRenderKey } =
      await import("/src/features/views.tsx");
    const { createBlock } = await import("/src/client/create-block.ts");
    const { setActiveLocale } = await import("/src/i18n/index.ts");
    const left = createBlock("s1", "left", "text", "text", "assistant");
    const right = createBlock("s1", "right", "text", "text", "assistant");
    left.payload.text = "Selected earlier reply";
    right.payload.text = "Current";
    const root = createRoot(document.getElementById("probe")!);
    let locale = "zh-CN";
    const render = () =>
      flushSync(() =>
        root.render(
          React.createElement(
            React.Fragment,
            null,
            ...[left, right].map((block) =>
              React.createElement(BlockView, {
                key: block.id,
                block,
                contentKey: blockRenderKey(block, locale),
              }),
            ),
          ),
        ),
      );
    render();
    const earlier = document.querySelectorAll("[data-testid=chat-message]")[0];
    const text = earlier.querySelector("p")!.firstChild!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 8);
    selection.removeAllRanges();
    selection.addRange(range);
    right.payload.text += " delta";
    render();
    const delta = document.querySelectorAll("[data-testid=chat-message]")[1]
      .textContent;
    const retained =
      earlier === document.querySelectorAll("[data-testid=chat-message]")[0] &&
      text === earlier.querySelector("p")!.firstChild;
    const selected = selection.toString();
    // The block object is still the same: translated chrome must invalidate
    // independently when the active locale changes.
    right.stream = "stopped";
    right.preview = { canonicalMessageId: undefined, truncated: false } as any;
    render();
    const chinese = document.querySelector(
      "[data-testid=incomplete-output]",
    )!.textContent;
    locale = "en";
    setActiveLocale("en");
    render();
    const english = document.querySelector(
      "[data-testid=incomplete-output]",
    )!.textContent;
    root.unmount();
    return { delta, retained, selected, chinese, english };
  });
  expect(result.delta).toBe("Current delta");
  expect(result.retained).toBe(true);
  expect(result.selected).toBe("Selected");
  expect(result.chinese).toBeTruthy();
  expect(result.english).toBeTruthy();
  expect(result.english).not.toBe(result.chinese);
});

test("registry content publication renders one node and leaves the structural list subscribed only to structure", async ({
  page,
}) => {
  await page.route("**/registry-render-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><div id='probe'></div>",
    }),
  );
  await page.goto("/registry-render-fixture");
  const result = await page.evaluate(async () => {
    const { default: RefreshRuntime } = await import("/@react-refresh");
    RefreshRuntime.injectIntoGlobalHook(window);
    (window as any).$RefreshReg$ = () => {};
    (window as any).$RefreshSig$ = () => (type: unknown) => type;
    (window as any).__vite_plugin_react_preamble_installed__ = true;
    const { default: React } =
      await import("/node_modules/.vite/deps/react.js");
    const { default: ReactDOM } =
      await import("/node_modules/.vite/deps/react-dom_client.js");
    const { default: ReactDOMCore } =
      await import("/node_modules/.vite/deps/react-dom.js");
    const { BlockView } = await import("/src/features/views.tsx");
    const { ConversationRegistryProvider, useConversationStructure } =
      await import("/src/features/conversation/registry-context.tsx");
    const { createConversationRegistry } =
      await import("/src/client/conversation/registry.ts");
    const { publishTranscript } =
      await import("/src/client/conversation/assembler.ts");
    const { createBlock } = await import("/src/client/create-block.ts");
    const { createTranscript } = await import("/src/client/projector.ts");
    const left = createBlock("s1", "left", "text");
    const right = createBlock("s1", "right", "text");
    left.payload.text = "Earlier selected reply";
    right.payload.text = "Current";
    const transcript = createTranscript();
    transcript.blocks = [left, right];
    const registry = createConversationRegistry();
    publishTranscript(registry, transcript);
    let listRenders = 0;
    const commits: Record<string, number> = {};
    function List() {
      useConversationStructure(registry);
      listRenders++;
      return React.createElement(
        React.Fragment,
        null,
        ...registry.blocks().map((block) =>
          React.createElement(
            React.Profiler,
            {
              key: block.id,
              id: block.id,
              onRender: (id: string) => {
                commits[id] = (commits[id] ?? 0) + 1;
              },
            },
            React.createElement(BlockView, { block }),
          ),
        ),
      );
    }
    const root = ReactDOM.createRoot(document.getElementById("probe")!);
    ReactDOMCore.flushSync(() =>
      root.render(
        React.createElement(
          ConversationRegistryProvider,
          { registry, locale: "zh-CN" },
          React.createElement(List),
        ),
      ),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    const first = document.querySelectorAll("[data-testid=chat-message]")[0];
    const text = first.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 7);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const before = {
      list: listRenders,
      left: commits[left.id],
      right: commits[right.id],
    };
    const committed = new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        if (
          document.querySelectorAll("[data-testid=chat-message]")[1]
            ?.textContent === "Current delta"
        ) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document.getElementById("probe")!, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    right.payload.text += " delta";
    const publication = publishTranscript(registry, transcript);
    await committed;
    const after = {
      list: listRenders,
      left: commits[left.id],
      right: commits[right.id],
    };
    const result = {
      before,
      after,
      publication,
      selected: selection.toString(),
      stable:
        first === document.querySelectorAll("[data-testid=chat-message]")[0] &&
        text === first.querySelector("p")!.firstChild,
      body: document.querySelectorAll("[data-testid=chat-message]")[1]
        .textContent,
    };
    root.unmount();
    registry.dispose();
    return result;
  });
  expect(result.publication).toBe("content");
  expect(result.after.list).toBe(result.before.list);
  expect(result.after.left).toBe(result.before.left);
  expect(result.after.right).toBe(result.before.right + 1);
  expect(result.body).toBe("Current delta");
  expect(result.selected).toBe("Earlier");
  expect(result.stable).toBe(true);
});
