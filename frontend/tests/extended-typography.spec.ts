import { expect, test } from "@playwright/test";
import { mountMarkdown } from "./rich-markdown-fixture";

const content = `Press <kbd>Ctrl</kbd> + <kbd>C</kbd>. Water H<sub>2</sub>O and x<sup>2</sup>; <mark>highlight</mark>.

<details><summary>Read **details**</summary>

Body **strong** with [safe link](https://example.test).

- first
- second

<details><summary>Nested</summary>

Nested body.

</details>

</details>`;

test("admitted semantic tags render Markdown, toggle with keyboard and retain open state", async ({
  page,
}) => {
  const errors = await mountMarkdown(page, content);
  await expect(page.locator("kbd")).toHaveText(["Ctrl", "C"]);
  await expect(page.locator("sub")).toHaveText("2");
  await expect(page.locator("sup")).toHaveText("2");
  await expect(page.locator("mark")).toHaveText("highlight");
  const outer = page.locator("details").first();
  await expect(outer).not.toHaveAttribute("open");
  await outer.locator("summary").first().focus();
  await page.keyboard.press("Enter");
  await expect(outer).toHaveAttribute("open", "");
  await expect(outer.locator("strong")).toHaveText(["details", "strong"]);
  await expect(outer.locator("li")).toHaveText(["first", "second"]);
  await outer.locator("details summary").click();
  await expect(outer.locator("details")).toHaveAttribute("open", "");
  await page.evaluate(() =>
    (window as any).renderMarkdown({
      text: (window as any).markdownProps.text + "\n\nUpdated",
    }),
  );
  await expect(outer).toHaveAttribute("open", "");
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    await expect(page.locator("mark")).not.toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
  }
  expect(errors).toEqual([]);
});

test("semantic admission strips event/style/resource attributes and leaves other HTML inert", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("https://markdown-evil.test/**", (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await mountMarkdown(
    page,
    `<details open onclick="window.extendedXss=true"><summary>Untrusted</summary>safe</details>

<kbd style="background:url(https://markdown-evil.test/a)">Key</kbd>

<script>window.extendedXss=true</script>

<img src="https://markdown-evil.test/image" onerror="window.extendedXss=true">

<iframe src="https://markdown-evil.test/frame"></iframe>`,
  );
  await expect(
    page.locator(
      ".markdown-body [onclick], .markdown-body [style], .markdown-body script, .markdown-body img, .markdown-body iframe",
    ),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).extendedXss),
  ).toBeUndefined();
  expect(requests).toEqual([]);
});

for (const width of [390, 1440]) {
  test(`wide Markdown tables scroll locally and code operations align right at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mountMarkdown(
      page,
      "| A | B | C |\n| - | - | - |\n| " +
        "long".repeat(140) +
        ' | second | third |\n\n```text\ncode\n```\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>\n```',
    );
    const table = page.locator(".markdown-table-container");
    await expect(table).toBeVisible();
    expect(
      await table.evaluate((node) => ({
        viewport: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        overflow: getComputedStyle(node).overflowX,
      })),
    ).toEqual({ viewport: width, scroll: width, overflow: "auto" });
    for (const header of await page.locator(".code-block-header").all()) {
      const geometry = await header.evaluate((node) => {
        const group = node.querySelector(".code-block-actions")!;
        const [expand, copy] = group.querySelectorAll("button");
        return {
          gap:
            copy.getBoundingClientRect().left -
            expand.getBoundingClientRect().right,
          right:
            node.getBoundingClientRect().right -
            group.getBoundingClientRect().right,
          left:
            group.getBoundingClientRect().left -
            node.getBoundingClientRect().left,
          width: node.getBoundingClientRect().width,
        };
      });
      expect(geometry.gap).toBeLessThanOrEqual(8);
      expect(geometry.right).toBeLessThanOrEqual(8);
      expect(geometry.left).toBeGreaterThan(geometry.width / 2);
    }
  });
}
