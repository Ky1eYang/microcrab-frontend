import { expect, test } from "@playwright/test";
import type { NativeProject, SessionView } from "../src/client/types";
import {
  recentProjects,
  filterProjects,
  hostGroups,
  projectAvailability,
} from "../src/features/home/WorkspacePicker/projects";

const projects: NativeProject[] = Array.from({ length: 5 }, (_, i) => ({
  id: `p${i}`,
  name: `Project ${i}`,
  root: `/work/tree-${i}`,
  host_id: `host-${i}`,
}));
const session = (projectID: string, lastActiveAt: number, parentID?: string) =>
  ({ projectID, lastActiveAt, parentID }) as SessionView;

test("Recent uses catalog membership and activity, excludes child-only evidence and ignores catalog/sidebar ordering", () => {
  const sessions = [
    session("p1", 30),
    session("p2", 90),
    session("p3", 20),
    session("p4", 15),
    session("deleted", 100),
    session("p0", 200, "parent"),
  ];
  expect(recentProjects(projects, sessions).map((p) => p.id)).toEqual([
    "p2",
    "p1",
    "p3",
  ]);
  expect(projects.map((p) => p.id)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
  expect(filterProjects(projects, "TREE-2").map((p) => p.id)).toEqual(["p2"]);
});

test("Host groups preserve identity even when locators share a label, including colliding identity prefixes", () => {
  const catalog = [
    { ...projects[0], host_id: "sameprefix-a" },
    { ...projects[1], host_id: "sameprefix-b" },
    { ...projects[2], host_id: undefined },
  ];
  const groups = hostGroups(catalog, () => "ws://shared.example/host");
  expect(groups.map((g) => g.id)).toEqual(["sameprefix-a", "sameprefix-b", ""]);
  expect(groups[0].label).toBe("shared.example · sameprefix-a");
  expect(groups[1].label).toBe("shared.example · sameprefix-b");
  expect(groups[0].projects.map((p) => p.id)).toEqual(["p0"]);
});

test("project availability uses exact live scope, preserves offline evidence and keeps missing evidence unknown", () => {
  const online = { state: "ready", projectId: "p0", connected: true };
  expect(projectAvailability(projects[0], online)).toBe("online");
  expect(projectAvailability(projects[1], online)).toBe("unknown");
  expect(
    projectAvailability(
      { ...projects[1], host_connected: false, status: "online" },
      online,
    ),
  ).toBe("offline");
  expect(
    projectAvailability(
      { ...projects[0], host_connected: true },
      { ...online, connected: false },
    ),
  ).toBe("offline");
  expect(
    projectAvailability(
      { ...projects[0], host_connected: true },
      { state: "connecting", projectId: "p0" },
    ),
  ).toBe("unknown");
  expect(
    projectAvailability(projects[0], { state: "detached", projectId: "p0" }),
  ).toBe("offline");
});

for (const width of [390, 1440]) {
  test(`picker search, direct create, nested Escape and fixed project scope at ${width}`, async ({
    page,
  }) => {
    page.on("pageerror", (error) =>
      console.error("Picker fixture page error:", error.message),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/picker-fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<html><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const {default:React}=await import('/node_modules/.vite/deps/react.js');
const {default:ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');
const {AppStore}=await import('/src/state/store.ts'); const {AppProvider}=await import('/src/state/index.ts');
const {WorkspacePicker}=await import('/src/features/home/WorkspacePicker/index.tsx'); const {PopupView}=await import('/src/features/popups.tsx');
for (const style of ['client-plugins','plugins','tokens','chrome','components','interaction-polish','dashboard']) await import('/src/styles/' + style + '.css');
const projects=${JSON.stringify(projects)}.map((project,index)=>index>=2?{...project,host_id:'host-2'}:project);
AppStore.prototype.start=function(){ this.update({authSession:{authenticated:true,principal:{owner:'picker-owner'}},projects,connection:'ws',draftWorkspace:{kind:'chat_only'},hostConnection:{projectId:'p0',state:'ready',connected:true,catalogReady:true}}); const store=this; const calls=[]; this.api.disconnectHost=async()=>calls.push('disconnect'); this.api.request=async(method)=>{calls.push(method);throw Error('unexpected API '+method)}; window.pickerFixture={store,calls}; };
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AppProvider,null,React.createElement(WorkspacePicker),React.createElement(PopupView)));
</script></body></html>`,
      }),
    );
    await page.goto("/picker-fixture");
    await page.getByTitle("选择项目工作区").click();
    await page.locator('[data-host-id="host-2"]').click();
    await page.getByRole("searchbox").fill("tree-2");
    await expect(
      page.getByTestId("picker-host-submenu").getByTestId("home-project-item"),
    ).toHaveCount(1);
    const search = page.getByRole("searchbox");
    const submenu = page.getByTestId("picker-host-submenu");
    await search.press("ArrowDown");
    await expect(submenu.locator('[data-project-id="p2"]')).toBeFocused();
    await search.fill("no-match");
    await search.press("ArrowUp");
    await expect(search).toBeFocused();
    await search.press("ArrowDown");
    await expect(search).toBeFocused();
    await search.fill("");
    await search.press("ArrowUp");
    await expect(submenu.locator('[data-project-id="p4"]')).toBeFocused();
    await search.focus();
    await search.press("ArrowDown");
    await expect(submenu.locator('[data-project-id="p2"]')).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("picker-host-submenu")).toHaveCount(0);
    await expect(page.getByTestId("home-project-picker")).toBeVisible();
    await page.getByTestId("picker-create-project").click();
    await expect(page.locator("#host-project-name")).toBeVisible();
    await expect(page.locator("#host-project")).toHaveCount(0);
    await page.evaluate(() =>
      (window as any).pickerFixture.store.dispatch({
        type: "OpenRemoteConnectDialog",
        projectId: "p2",
      }),
    );
    await expect(page.getByTestId("host-fixed-project")).toHaveText(
      "Project 2",
    );
    await expect(
      page.getByRole("button", { name: "断开连接", exact: true }),
    ).toBeDisabled();
    await page.evaluate(async () => {
      const { store } = (window as any).pickerFixture;
      await store.dispatch({ type: "DisconnectHost", projectId: "p2" });
      await store.dispatch({ type: "RetryHostCatalog", projectId: "p2" });
      await store.dispatch({ type: "RefreshHostState", projectId: "p2" });
    });
    expect(
      await page.evaluate(() => (window as any).pickerFixture.calls),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () =>
          (window as any).pickerFixture.store.getSnapshot().hostConnection
            .projectId,
      ),
    ).toBe("p0");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.evaluate(() => {
      const fixture = (window as any).pickerFixture;
      fixture.created = 0;
      fixture.store.call = async () => {
        fixture.created++;
        return { id: "provisional", name: "Partial project", root: "/partial" };
      };
      fixture.store.connectHost = async () => {
        throw Error("Pair acknowledged without Hello; fresh pairing required");
      };
      return fixture.store.dispatch({ type: "OpenCreateProjectDialog" });
    });
    await page.locator("#host-project-name").fill("Partial project");
    await page.locator("#host-url").fill("ws://example.test/host");
    await page.locator("#host-code").fill("one-use-code");
    await page.getByRole("button", { name: "创建并连接", exact: true }).click();
    await expect(page.getByTestId("host-fixed-project")).toHaveText(
      "Partial project",
    );
    await expect(page.locator("#host-code")).toHaveValue("");
    await expect(page.getByRole("alert")).toContainText(
      "fresh pairing required",
    );
    await expect(page.locator("#host-project-name")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as any).pickerFixture.created),
    ).toBe(1);
  });
}
