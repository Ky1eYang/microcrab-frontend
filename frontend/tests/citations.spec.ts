import { nativeBackend } from "./native-fixture";
import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.route("**/citation-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body><main id="root"></main><aside id="client-plugin-sidebar-panel">plugin remains</aside></body></html>',
    }),
  );
  await page.goto("/citation-fixture");
  await page.evaluate(async () => {
    const { default: runtime } = await import("/@react-refresh");
    runtime.injectIntoGlobalHook(window);
    (window as any).$RefreshReg$ = () => {};
    (window as any).$RefreshSig$ = () => (type: unknown) => type;
    (window as any).__vite_plugin_react_preamble_installed__ = true;
  });
}
async function mount(page: Page, text: string, scoped = true) {
  await page.evaluate(
    async ({ text, scoped }) => {
      const { default: React } =
        await import("/node_modules/.vite/deps/react.js");
      const { default: ReactDOM } =
        await import("/node_modules/.vite/deps/react-dom_client.js");
      const { Markdown } = await import("/src/features/views.tsx");
      const { ApiClient } = await import("/src/client/api.ts");
      const api = new ApiClient(location.origin + "/");
      const fixture: any = {
        root: ReactDOM.createRoot(document.querySelector("#root")!),
        api,
        reads: 0,
        valid: true,
        urls: [],
        revoked: [],
      };
      (window as any).citations = fixture;
      const create = URL.createObjectURL.bind(URL),
        revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob: Blob) => {
        const url = create(blob);
        fixture.urls.push(url);
        return url;
      };
      URL.revokeObjectURL = (url: string) => {
        fixture.revoked.push(url);
        revoke(url);
      };
      fixture.scope = {
        owner: "owner",
        sessionId: "s1",
        historyLineage: "history-1",
        messageId: "message-1",
        current: () => fixture.valid,
        read: (request: any, signal: AbortSignal) => {
          fixture.reads++;
          return api.readCitation(request, signal);
        },
      };
      fixture.render = (next = text, scope = scoped) =>
        fixture.root.render(
          React.createElement(Markdown, {
            text: next,
            allowImages: scope,
            citation: scope ? fixture.scope : undefined,
          }),
        );
      fixture.render();
    },
    { text, scoped },
  );
}

test("actual conversation binds canonical assistant citations to its history and clears an open image on travel", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  snapshot.messages = [
    {
      id: "message-user",
      role: "user",
      text: "[user reference](user.txt)",
      parts: [],
      tool_calls: [],
    },
    {
      id: "message-assistant",
      role: "assistant",
      text: "![canonical picture](picture.png)",
      parts: [],
      tool_calls: [],
    },
  ];
  snapshot.history_view = {
    lineage: "history-citations",
    epoch: 0,
    message_count: 2,
    start_cursor: 0,
    end_cursor: 2,
    turns: [],
  };
  let requests = 0;
  await page.route("**/api/v1/sessions/s1/files/**", (route) => {
    requests++;
    const url = new URL(route.request().url());
    expect(url.pathname).toBe("/api/v1/sessions/s1/files/message-assistant");
    expect(url.searchParams.get("history_lineage")).toBe("history-citations");
    expect(url.searchParams.has("child_session_id")).toBe(false);
    return route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7S8AAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  await page.goto("/#session/s1");
  await expect(page.getByTestId("file-citation")).toHaveCount(1);
  expect(requests).toBe(0);
  await page.getByTestId("file-citation").click();
  await expect(page.getByTestId("citation-lightbox")).toBeVisible();
  snapshot.history_view.lineage = "history-after-travel";
  snapshot.messages = [];
  backend.publish(snapshot);
  await expect(page.getByTestId("citation-lightbox")).toHaveCount(0);
  expect(requests).toBe(1);
});

test("citation grammar decodes once and AST handles references while excluding prose/code/active URLs", async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const { classifyCitation } =
      await import("/src/features/citations/parser.ts");
    const valid = [
      "./a.md#L123",
      "a.md:123?download=yes",
      "/tmp/a%20b.png",
      "C:/work/a.md:12",
      "C:\\work\\a.md",
      "\\\\server\\share\\a.md",
    ];
    const invalid = [
      "#L12",
      "https://site/a",
      "file:///a",
      "data:a",
      "//site/a",
      "a/../b",
      "a/%2e%2e/b",
      "%252e%252e/a",
      "a%00b",
      "a:stream",
      "C:relative",
      "https://user:secret@site/a",
    ];
    return {
      valid: valid.map(classifyCitation),
      invalid: invalid.map(classifyCitation),
    };
  });
  expect(result.valid.map((value) => value?.path)).toEqual([
    "a.md",
    "a.md",
    "/tmp/a b.png",
    "C:/work/a.md",
    "C:/work/a.md",
    "//server/share/a.md",
  ]);
  expect(result.invalid.every((value) => value === null)).toBe(true);
  await mount(
    page,
    "[ref][r]\n\n[r]: report.txt\n\n`[code](secret)` plain.txt [external](https://example.test/a) [anchor](#part) [active](javascript:alert%281%29)",
  );
  await expect(page.getByTestId("file-citation")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "external" })).toHaveAttribute(
    "href",
    "https://example.test/a",
  );
  await expect(page.getByRole("link", { name: "anchor" })).toHaveAttribute(
    "href",
    "#part",
  );
  expect(await page.evaluate(() => (window as any).citations.reads)).toBe(0);
});

test("click downloads current bytes, raster opens shared keyboard lightbox, and cleanup preserves sidebar", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/v1/sessions/s1/files/**", (route) => {
    const href = new URL(route.request().url()).searchParams.get("href");
    return href === "picture.any"
      ? route.fulfill({
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7S8AAAAASUVORK5CYII=",
            "base64",
          ),
        })
      : route.fulfill({
          contentType: "application/octet-stream",
          body: "current bytes",
        });
  });
  await mount(
    page,
    "[report](report.txt) ![picture](picture.any) ![external](https://external.invalid/eager.png)",
  );
  await expect(page.getByTestId("file-citation")).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).citations.reads)).toBe(0);
  await expect(page.locator("img")).toHaveCount(0);
  const downloaded = page.waitForEvent("download");
  await page.getByTestId("file-citation").filter({ hasText: "report" }).click();
  expect((await downloaded).suggestedFilename()).toBe("report.txt");
  const picture = page
    .getByTestId("file-citation")
    .filter({ hasText: "picture" });
  await picture.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("citation-lightbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("content-dialog")).toHaveCount(0);
  await expect(picture).toBeFocused();
  await picture.click();
  await expect(page.getByTestId("citation-lightbox")).toBeVisible();
  await page.evaluate(() => (window as any).citations.root.unmount());
  expect(
    await page.evaluate(() => {
      const f = (window as any).citations;
      return f.urls.every((url: string) => f.revoked.includes(url));
    }),
  ).toBe(true);
  await expect(page.locator("#client-plugin-sidebar-panel")).toHaveText(
    "plugin remains",
  );
});

test("generic no-network Markdown, cancellation and scope loss discard stale image responses", async ({
  page,
}) => {
  await fixture(page);
  await mount(page, "![generic](picture.png) [report](report.txt)", false);
  await expect(page.getByTestId("file-citation")).toHaveCount(0);
  await expect(page.locator("img")).toHaveCount(0);
  await page.evaluate(() => {
    const f = (window as any).citations;
    f.render("![picture](picture.png)", true);
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/sessions/s1/files/**", async (route) => {
    await gate;
    await route
      .fulfill({ contentType: "image/png", body: "bytes" })
      .catch(() => {});
  });
  const badge = page.getByTestId("file-citation");
  await badge.click();
  await expect(badge).toHaveAttribute("aria-busy", "true");
  await badge.click();
  await expect(badge).toHaveAttribute("aria-busy", "false");
  await badge.click();
  await page.evaluate(() => {
    (window as any).citations.valid = false;
  });
  release();
  await expect(badge).toHaveAttribute("aria-busy", "false");
  await expect(page.getByTestId("citation-lightbox")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).citations.urls.length)).toBe(
    0,
  );
});

test("binary helper enforces actual streamed limit and central API 401 revokes protected reads", async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const { boundedCitationBlob, MAX_CITATION_BYTES } =
      await import("/src/client/citations.ts");
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_CITATION_BYTES));
          controller.enqueue(new Uint8Array(1));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    let code;
    try {
      await boundedCitationBlob(response, new AbortController().signal);
    } catch (error: any) {
      code = error.code;
    }
    return { code, cancelled };
  });
  expect(result).toEqual({ code: "file_limit", cancelled: true });
  await mount(page, "[report](report.txt)");
  await page.route("**/api/v1/sessions/s1/files/**", (route) =>
    route.fulfill({
      status: 401,
      json: {
        error: { code: "unauthenticated", message: "Authentication required" },
      },
    }),
  );
  await page.evaluate(() => {
    const f = (window as any).citations;
    f.revocations = 0;
    f.api.handlers.authRequired = () => {
      f.revocations++;
      f.api.httpPending.forEach((controller: AbortController) =>
        controller.abort(),
      );
    };
  });
  await page.getByTestId("file-citation").click();
  await expect(page.getByRole("alert")).toContainText(
    "Authentication required",
  );
  expect(await page.evaluate(() => (window as any).citations.revocations)).toBe(
    1,
  );
});
