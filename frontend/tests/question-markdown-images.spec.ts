import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { CLIENT_TOOL_DEFINITIONS } from "../src/client/client-tools";
import type {
  ClientBinding,
  ClientInvocation,
} from "../src/client/client-tool-controller";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7S8AAAAASUVORK5CYII=",
  "base64",
);
function binding(question: string, executor = true): ClientBinding {
  const call: ClientInvocation = {
    invocation_id: "question-image",
    parent_session_id: "s1",
    session_id: "s1",
    call_id: "question-call",
    tool: "ask_user_question",
    arguments: {
      questions: [
        {
          id: "q",
          question,
          options: [
            {
              id: "yes",
              label: "Accept",
              description: "**plain description**",
            },
          ],
        },
      ],
    },
    epoch: 0,
    turn_id: 1,
    round_id: 1,
    catalog_digest: "frozen-question",
    status: "pending",
    created_at_ms: 1,
    deadline_ms: 0,
    interaction: true,
    blocking_mode: "deferred",
  };
  return {
    role: executor ? "executor" : "observer",
    can_interact: executor,
    lease_id: executor ? "question-lease" : undefined,
    catalog_digest: call.catalog_digest,
    definitions: CLIENT_TOOL_DEFINITIONS,
    calls: [call],
    pending: [call],
  };
}
async function setup(
  page: import("@playwright/test").Page,
  question: string,
  executor = true,
) {
  const backend = await nativeBackend(page, {
    clientTools: binding(question, executor),
  });
  backend.snapshot().history_view = {
    lineage: "question-history",
    epoch: 0,
    message_count: 2,
    start_cursor: 0,
    end_cursor: 2,
    turns: [],
  };
  return backend;
}

test("question GFM inherits rich engines while arbitrary HTML stays inert and options stay plain", async ({
  page,
}) => {
  await setup(
    page,
    "**Choose carefully**\n\n| A | B |\n| - | - |\n| one | two |\n\n<script>window.questionXss=true</script>\n\n```mermaid\ngraph TD; A-->B\n```",
  );
  await page.goto("/#session/s1");
  const body = page.locator(".question-body");
  await expect(body.locator("strong")).toHaveText("Choose carefully");
  await expect(body.locator("table")).toBeVisible();
  await expect(body.locator("script, .katex")).toHaveCount(0);
  await expect(body.getByTestId("mermaid-preview")).toBeVisible({
    timeout: 30000,
  });
  await expect(body.locator(".visual-format")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept **plain description**" }),
  ).toBeVisible();
  await expect(page.locator(".choice-list strong")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Accept **plain description**" })
    .click();
  await expect(
    page.getByRole("button", { name: "提交", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => (window as any).questionXss),
  ).toBeUndefined();
});

test("question cancellation immediately revokes a loaded preview before settlement", async ({
  page,
}) => {
  const backend = await setup(page, "![Cancel preview](picture.png)");
  await page.route(
    "**/api/v1/sessions/s1/questions/question-image/image?**",
    (route) => route.fulfill({ contentType: "image/png", body: png }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("button", { name: "加载图片：Cancel preview" }).click();
  await expect(page.locator(".question-body img")).toBeVisible();
  const call = (backend.snapshot().client_tools as ClientBinding).pending[0];
  backend.event("client_tool.cancel_requested", { call });
  await expect(page.locator(".question-body img")).toHaveCount(0);
  await expect(page.locator(".flow-card")).toContainText("此问题延后等待");
});

test("local question image click sends its own invocation, history and lease then retires on travel", async ({
  page,
}) => {
  const backend = await setup(page, "![Local preview](./picture.png)");
  let reads = 0;
  await page.route(
    "**/api/v1/sessions/s1/questions/question-image/image?**",
    async (route) => {
      reads++;
      const url = new URL(route.request().url());
      expect(url.searchParams.get("history_lineage")).toBe("question-history");
      expect(url.searchParams.get("target_session_id")).toBe("s1");
      expect(url.searchParams.get("href")).toBe("./picture.png");
      expect(url.searchParams.has("lease_id")).toBe(false);
      expect(route.request().headers()["x-microcrab-executor-lease"]).toBe(
        "question-lease",
      );
      await route.fulfill({ contentType: "image/png", body: png });
    },
  );
  await page.goto("/#session/s1");
  await expect(
    page.getByRole("button", { name: "加载图片：Local preview" }),
  ).toBeVisible();
  expect(reads).toBe(0);
  await page.getByRole("button", { name: "加载图片：Local preview" }).click();
  await expect(page.locator(".question-body img")).toBeVisible();
  expect(reads).toBe(1);
  backend.snapshot().history_view!.lineage = "history-after-travel";
  backend.publish(backend.snapshot());
  await expect(page.locator(".question-body img")).toHaveCount(0);
});

test("external images require a click and unsafe schemes never load", async ({
  page,
}) => {
  await setup(
    page,
    "![Remote preview](https://images.example.test/preview.png)\n\n![Unsafe](javascript:alert(1))",
  );
  let reads = 0;
  await page.route("https://images.example.test/preview.png", async (route) => {
    reads++;
    expect(route.request().headers().referer).toBeUndefined();
    await route.fulfill({ contentType: "image/png", body: png });
  });
  await page.goto("/#session/s1");
  await expect(
    page.getByRole("button", { name: "加载图片：Remote preview" }),
  ).toBeVisible();
  expect(reads).toBe(0);
  await expect(page.locator(".question-body img")).toHaveCount(0);
  await page.getByRole("button", { name: "加载图片：Remote preview" }).click();
  await expect(page.locator(".question-body img")).toBeVisible();
  expect(reads).toBe(1);
});

test("linked image preview clicks do not follow the enclosing link", async ({
  page,
}) => {
  await setup(
    page,
    "[![Linked preview](./picture.png)](https://navigation.example.test/leave)",
  );
  let reads = 0;
  let navigations = 0;
  await page.route("https://navigation.example.test/**", async (route) => {
    navigations++;
    await route.abort();
  });
  await page.route(
    "**/api/v1/sessions/s1/questions/question-image/image?**",
    async (route) => {
      reads++;
      await route.fulfill({ contentType: "image/png", body: png });
    },
  );
  await page.goto("/#session/s1");
  const initial = page.url();
  await page.getByRole("button", { name: "加载图片：Linked preview" }).click();
  await expect(page.locator(".question-body img")).toBeVisible();
  expect(reads).toBe(1);
  expect(navigations).toBe(0);
  expect(page.url()).toBe(initial);
});

test("observer cannot read local images and wide question tables fit mobile cards", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(
    page,
    "![Local preview](picture.png)\n\n| Long column | Second column |\n| - | - |\n| " +
      "wide".repeat(100) +
      " | value |",
    false,
  );
  let reads = 0;
  await page.route(
    "**/api/v1/sessions/s1/questions/question-image/image?**",
    async (route) => {
      reads++;
      await route.abort();
    },
  );
  await page.goto("/#session/s1");
  const body = page.locator(".question-body");
  await expect(body.getByText("Local preview", { exact: true })).toBeVisible();
  await expect(body.locator("table")).toBeVisible();
  await expect(body.locator("img")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "加载图片：Local preview" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Accept **plain description**" }),
  ).toBeDisabled();
  await body.getByText("Local preview", { exact: true }).click();
  expect(reads).toBe(0);
  const sizes = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.width);
});
