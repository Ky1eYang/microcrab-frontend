import { expect, test } from "@playwright/test";

// These source-graph contract fixtures isolate the manager host from guest execution.
// Emitted application gates use client-plugin-manager-navigation instead.
for (const targets of [
  ["sidebar"],
  ["expanded-page"],
  ["sidebar", "expanded-page"],
  ["sidebar", "expanded-page", "setting-page"],
]) {
  test(`manager only mounts declared settings content for ${targets.join("+")}`, async ({
    page,
  }) => {
    const artifact = "0123456789abcdef".repeat(4);
    const imports = [
      "microcrab:client-plugin/session-state@0.4.0",
      "microcrab:client-plugin/resources@0.4.0",
    ];
    await page.route("**/manager-contract", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
      }),
    );
    await page.route("**/src/state/index.ts", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `export const useAppStore = () => ({ getSnapshot: () => ({ sessionId: "s1" }) });
        export const useAppFields = () => ({ state: { sessionId: "s1", resolvedLocale: "en", pluginWorkspace: null }, dispatch: async () => {} });
        export const useClientPlugins = () => ({ initializing: false, isReadyFor: id => id === "s1", error: null, registry: {
          getSnapshot: () => [window.managerPlugin], isEnabled: () => true, getHttpRequestTimeout: () => 10000
        }});`,
      }),
    );
    await page.route("**/src/plugins/PluginSidebar.tsx", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `import React from "/node_modules/.vite/deps/react.js";
        export const PluginSurface = ({ target }) => React.createElement("div", { "data-testid": "requested-target" }, target);`,
      }),
    );
    await page.goto("/manager-contract");
    // Transform the maintained entry without executing it, then wait for its
    // React DOM dependency. A cold dependency optimizer can otherwise race this
    // fixture's direct imports of the generated dependency modules.
    await page.request.get("/src/main.tsx");
    await expect
      .poll(async () =>
        (
          await page.request.get("/node_modules/.vite/deps/react-dom_client.js")
        ).status(),
      )
      .toBe(200);
    await page.evaluate(
      async ({ artifact, imports, targets }) => {
        (window as any).managerPlugin = {
          manifest: {
            id: "contract-plugin",
            name: "Contract plugin",
            version: "1.0.0",
            targets,
          },
          artifact,
          imports,
          enabledByDefault: true,
          priority: 0,
          status: "ready",
        };
        const refreshPath = "/@react-refresh";
        const refresh = await import(refreshPath);
        refresh.default.injectIntoGlobalHook(window);
        (window as any).$RefreshReg$ = () => {};
        (window as any).$RefreshSig$ = () => (type: unknown) => type;
        (window as any).__vite_plugin_react_preamble_installed__ = true;
        const reactPath = "/node_modules/.vite/deps/react.js";
        const domPath = "/node_modules/.vite/deps/react-dom_client.js";
        const managerPath = "/src/plugins/PluginsPage.tsx";
        const [
          { default: React },
          {
            default: { createRoot },
          },
          { PluginsPage },
        ] = await Promise.all([
          import(reactPath),
          import(domPath),
          import(managerPath),
        ]);
        createRoot(document.getElementById("root")!).render(
          React.createElement(PluginsPage),
        );
      },
      { artifact, imports, targets },
    );
    const manager = page.getByTestId("client-plugins-manager");
    await expect(manager).toBeVisible();
    await expect(
      manager.getByRole("button", { name: /^(Expand|展开)$/ }),
    ).toHaveCount(0);
    await expect(manager.getByTestId("plugins-restore-bundled")).toHaveCount(0);
    await expect(manager.locator(".client-plugin-nav-hash")).toHaveText(
      artifact,
    );
    await expect(manager.locator(".client-plugin-hash-value")).toHaveText(
      artifact,
    );
    await expect(manager.locator(".client-plugin-import-list > li")).toHaveText(
      imports,
    );
    if (targets.includes("setting-page")) {
      await expect(manager.getByTestId("requested-target")).toHaveText(
        "setting-page",
      );
    } else {
      await expect(manager.getByTestId("plugin-setting-page-card")).toHaveCount(
        0,
      );
      await expect(manager.getByTestId("requested-target")).toHaveCount(0);
    }
  });
}
