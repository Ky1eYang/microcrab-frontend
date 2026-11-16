import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nativeBackend } from "./native-fixture";

// This suite uses the emitted application and its actual immutable plugin assets.
// No source imports, injected registry, guest mock or rewritten plugin index.
const pluginId = "microcrab.mcp-bridge";
const publicPlugins = resolve(import.meta.dirname, "../public/plugins");
test.setTimeout(120_000);

async function packagedSetup(page: Page) {
  await nativeBackend(page, { selectProject: false });
  await page.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem("microcrab.ui.rightRailCollapsed", "false");
    localStorage.setItem("microcrab.ui.theme", "light");
  });
  // Read lazily so test discovery is independent of final publication timing.
  const index = JSON.parse(
    readFileSync(resolve(publicPlugins, "current.json"), "utf8"),
  );
  const plugin = index.plugins.find((item: any) => item.id === pluginId);
  expect(
    plugin,
    "The assembled index must contain the real Zig MCP plugin",
  ).toBeTruthy();
  expect(plugin.file).toBe(`${pluginId}/${plugin.sha256}/plugin.wasm`);
  const servedIndex = await page.request.get("/plugins/current.json");
  expect(servedIndex.ok()).toBe(true);
  expect(await servedIndex.json()).toEqual(index);
  const disk = readFileSync(resolve(publicPlugins, plugin.file));
  const served = await page.request.get(`/plugins/${plugin.file}`);
  expect(served.ok()).toBe(true);
  const bytes = await served.body();
  expect(bytes.equals(disk)).toBe(true);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(plugin.sha256);
  expect([...bytes.subarray(0, 8)]).toEqual([0, 97, 115, 109, 13, 0, 1, 0]);
  expect(bytes.includes(Buffer.from("microcrab:client-plugin/net@0.4.0"))).toBe(
    true,
  );
  expect(
    bytes.includes(Buffer.from("microcrab:client-plugin/resources@0.4.0")),
  ).toBe(true);
  return plugin;
}

async function openManager(page: Page, session: boolean, hash: string) {
  if (session) {
    await page.goto("/#/session/s1");
    await expect(
      page.getByTestId("chat-message").filter({ hasText: "历史提问" }),
    ).toBeVisible();
    const sidebar = page.getByTestId("client-plugin-sidebar");
    await expect(sidebar).toBeVisible();
    await sidebar.locator('[id="plugin-tab-microcrab.mcp-bridge"]').click();
    const observation = sidebar.getByTestId("plugin-webview");
    await expect(observation).toHaveAttribute("data-status", "ready");
    await expect(
      observation.contentFrame().getByTestId("mcp-sidebar"),
    ).toBeVisible();
    await expect(
      observation.contentFrame().locator("#no-session"),
    ).toBeHidden();
  }
  await page.goto(session ? "/#/session/s1/plugins" : "/#/plugins");
  const manager = page.getByTestId("client-plugins-manager");
  await expect(manager).toBeVisible();
  await manager.locator(`[data-plugin-nav-id="${pluginId}"]`).click();
  const plugin = manager.locator(`article[data-plugin-id="${pluginId}"]`);
  await expect(plugin).toHaveAttribute("data-status", "ready");
  await expect(plugin.locator(".client-plugin-hash-value")).toHaveText(hash);
  const webview = plugin.getByTestId("plugin-webview");
  await expect(webview).toHaveAttribute("data-status", "ready");
  await expect(webview).toHaveAttribute("sandbox", "allow-scripts");
  const frame = webview.contentFrame();
  await expect(frame.getByTestId("mcp-settings")).toBeVisible();
  await expect(frame.getByTestId("mcp-sidebar")).toHaveCount(0);
  await expect(
    frame.locator(
      "[data-testid=clear-history],[data-testid=history-records],[data-testid=metric-total]",
    ),
  ).toHaveCount(0);
  await expect(manager.getByTestId("plugin-expand")).toHaveCount(0);
  return { manager, plugin, webview, frame };
}

async function remoteConnection(page: Page, credential: string) {
  const observed = { methods: [] as string[], authenticated: 0, anonymous: 0 };
  await page.route("**/packaged-mcp/service/endpoint", async (route) => {
    const rpc = route.request().postDataJSON();
    observed.methods.push(rpc.method);
    // Record only the comparison, never the actual Authorization header.
    if (route.request().headers().authorization === credential)
      observed.authenticated++;
    else observed.anonymous++;
    const headers = {
      "content-type": "application/json",
      "Mcp-Session-Id": "packaged-mcp-session",
    };
    if (rpc.method === "notifications/initialized") {
      await route.fulfill({ status: 204, headers, body: "" });
      return;
    }
    let result;
    if (rpc.method === "initialize")
      result = {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "Packaged acceptance", version: "1" },
      };
    else if (rpc.method === "tools/list")
      result = {
        tools: [
          { name: "read_example", inputSchema: { type: "object" } },
          { name: "inspect_example", inputSchema: { type: "object" } },
        ],
      };
    else if (rpc.method === "resources/list") result = { resources: [] };
    else throw Error(`Connection test unexpectedly invoked ${rpc.method}`);
    await route.fulfill({
      status: 200,
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }),
    });
  });
  return observed;
}

async function assertHostTheme(
  page: Page,
  frame: ReturnType<ReturnType<Page["getByTestId"]>["contentFrame"]>,
  scheme: "light" | "dark",
) {
  await page.evaluate((scheme) => {
    document.documentElement.dataset.theme = scheme;
  }, scheme);
  await expect(frame.locator("html")).toHaveAttribute("data-theme", scheme);
  const colors = await page.locator("html").evaluate((root) => {
    const sample = document.createElement("span");
    document.body.append(sample);
    sample.style.color = getComputedStyle(root).getPropertyValue("--bg");
    const background = getComputedStyle(sample).color;
    sample.style.color = getComputedStyle(root).getPropertyValue("--text");
    const text = getComputedStyle(sample).color;
    sample.remove();
    return { background, text };
  });
  await expect(frame.locator("body")).toHaveCSS(
    "background-color",
    colors.background,
  );
  await expect(frame.locator("body")).toHaveCSS("color", colors.text);
  await expect
    .poll(() =>
      frame
        .locator("html")
        .evaluate((root) => root.scrollWidth <= root.clientWidth),
    )
    .toBe(true);
}

test("packaged Zig MCP manager saves transient credentials once, tests its host grant and preserves the iframe across themes and reload", async ({
  page,
}, info) => {
  const logs: string[] = [];
  page.on("console", (entry) => logs.push(entry.text()));
  const artifact = await packagedSetup(page);
  const credential = "Bearer ZIG-PACKAGED-TRANSIENT-private";
  const remote = await remoteConnection(page, credential);
  const { webview, frame } = await openManager(page, true, artifact.sha256);
  await frame.getByTestId("add-server").click();
  await frame.getByTestId("server-id").fill("packaged-one");
  const endpoint = new URL("/packaged-mcp/service/endpoint", page.url()).href;
  await frame.getByTestId("server-endpoint").fill(endpoint);
  const source = await webview.getAttribute("srcdoc");
  await frame
    .locator("body")
    .evaluate((body) => (body.dataset.packagedDocument = "retained"));
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const scheme of ["dark", "light"] as const) {
      await assertHostTheme(page, frame, scheme);
      await expect(frame.locator("body")).toHaveAttribute(
        "data-packaged-document",
        "retained",
      );
      await expect(frame.getByTestId("server-endpoint")).toHaveValue(endpoint);
      await expect.poll(() => frame.locator("html").evaluate((root) =>
        root.scrollHeight <= root.clientHeight + 1,
      )).toBe(true);
      await expect(webview).toHaveAttribute("data-fit-content", "true");
      expect(await webview.getAttribute("srcdoc")).toBe(source);
    }
  }
  await frame.getByTestId("server-authorization").fill(credential);
  expect(
    await frame.getByTestId("save-config").evaluate((button) => {
      (button as HTMLButtonElement).click();
      return (
        document.getElementById("server-authorization") as HTMLInputElement
      ).value;
    }),
  ).toBe("");
  await expect(frame.getByTestId("server-row")).toHaveCount(1);
  await expect(frame.getByTestId("save-config")).toBeEnabled();
  expect(
    await frame.locator("html").evaluate((html) => html.outerHTML),
  ).not.toContain(credential);
  expect(await webview.getAttribute("srcdoc")).not.toContain(credential);
  await frame.getByTestId("test-connection").click();
  await expect(frame.locator(".health")).toContainText(/2\s*(?:个工具|tools)/);
  expect(remote.methods).toEqual(
    expect.arrayContaining([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]),
  );
  expect(remote.methods).not.toContain("tools/call");
  expect(remote.authenticated).toBeGreaterThan(0);
  expect(remote.anonymous).toBe(0);
  for (const scheme of ["light", "dark"] as const) {
    await assertHostTheme(page, frame, scheme);
    await page.screenshot({
      path: info.outputPath(`packaged-mcp-settings-${scheme}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  const requestsBeforeReload = remote.authenticated;
  await page.reload();
  const reopened = await openManager(page, true, artifact.sha256);
  await expect(reopened.frame.getByTestId("server-row")).toHaveCount(1);
  await reopened.frame.getByTestId("edit-server").click();
  await expect(reopened.frame.getByTestId("server-authorization")).toHaveValue(
    "",
  );
  await expect(reopened.frame.getByTestId("server-endpoint")).toHaveValue(
    endpoint,
  );
  await reopened.frame.locator("#cancel-edit").click();
  await reopened.frame.getByTestId("test-connection").click();
  await expect
    .poll(() => remote.authenticated)
    .toBeGreaterThan(requestsBeforeReload);
  await expect(reopened.frame.locator(".health")).toContainText(
    /2\s*(?:个工具|tools)/,
  );
  expect(logs.join("\n")).not.toContain(credential);
});

test("packaged Zig MCP configures without a Session while its conversation sidebar only observes resident history", async ({
  page,
}, info) => {
  const artifact = await packagedSetup(page);
  const { frame } = await openManager(page, false, artifact.sha256);
  await frame.getByTestId("add-server").click();
  await frame.getByTestId("server-id").fill("without-session");
  await frame
    .getByTestId("server-endpoint")
    .fill(new URL("/packaged-mcp/service/endpoint", page.url()).href);
  await frame.getByTestId("save-config").click();
  await expect(frame.getByTestId("server-row")).toHaveCount(1);
  await expect(frame.getByTestId("save-config")).toBeEnabled();
  await frame.getByTestId("remove-server").click();
  await expect(frame.getByTestId("delete-confirm")).toBeVisible();
  await frame.getByTestId("delete-cancel").click();
  await expect(frame.getByTestId("server-row")).toHaveCount(1);
  await page.goto("/#/session/s1");
  const sidebar = page.getByTestId("client-plugin-sidebar");
  await expect(sidebar).toBeVisible();
  await sidebar.locator('[id="plugin-tab-microcrab.mcp-bridge"]').click();
  const webview = sidebar.getByTestId("plugin-webview");
  await expect(webview).toHaveAttribute("data-status", "ready");
  const history = webview.contentFrame();
  await expect(history.getByTestId("mcp-sidebar")).toBeVisible();
  await expect(history.locator("#history-empty")).toBeVisible();
  await expect(history.getByTestId("metric-total")).toHaveText("0");
  await expect(history.getByTestId("history-row")).toHaveCount(0);
  await expect(history.getByTestId("clear-history")).toBeDisabled();
  await expect(
    history.locator(
      "form,input,[data-testid=mcp-settings],[data-testid=add-server],[data-testid=save-config],[data-testid=server-toggle],[data-testid=test-connection]",
    ),
  ).toHaveCount(0);
  await expect(sidebar.getByTestId("plugin-expand")).toHaveCount(0);
  const source = await webview.getAttribute("srcdoc");
  await history
    .locator("body")
    .evaluate((body) => (body.dataset.packagedDocument = "retained"));
  for (const scheme of ["dark", "light"] as const) {
    await assertHostTheme(page, history, scheme);
    await expect(history.locator("body")).toHaveAttribute(
      "data-packaged-document",
      "retained",
    );
    expect(await webview.getAttribute("srcdoc")).toBe(source);
    await page.screenshot({
      path: info.outputPath(`packaged-mcp-sidebar-${scheme}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  const manager = await openManager(page, true, artifact.sha256);
  await expect(manager.frame.getByTestId("server-row")).toHaveCount(1);
  await manager.frame.getByTestId("remove-server").click();
  await manager.frame.getByTestId("delete-confirm").click();
  await expect(manager.frame.getByTestId("server-row")).toHaveCount(0);
});
