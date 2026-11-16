import { expect, test } from "@playwright/test";
import { richQuestion, catSvg } from "./rich-question-fixture";

const fence = (language: string, source: string) =>
  `\`\`\`${language}\n${source}\n\`\`\``;

test("question inherits native SVG, visual fences, math and semantics while options remain plain", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as any).copiedSvg = value;
        },
      },
    }),
  );
  const chart = JSON.stringify({ series: [{ type: "bar", data: [1, 2] }] });
  await richQuestion(
    page,
    `**What does this synthetic figure show?**\n\n${catSvg}\n\n${fence("svg", catSvg)}\n\n${fence("mermaid", "graph TD; A-->B")}\n\n${fence("echarts", chart)}\n\n$E=mc^2$\n\n<details><summary>Hint</summary>Use <kbd>Enter</kbd>; H<sub>2</sub>O and x<sup>2</sup> <mark>highlight</mark>.</details>`,
  );
  await page.goto("/#session/s1");
  const body = page.locator(".question-body");
  await expect(body.getByTestId("svg-preview")).toHaveCount(2);
  await expect(
    body.locator('[data-testid="svg-preview"] svg ellipse'),
  ).toHaveCount(6);
  await expect(body.getByTestId("mermaid-preview")).toBeVisible({
    timeout: 30000,
  });
  await expect(body.getByTestId("echarts-preview")).toBeVisible();
  await expect(body.getByTestId("math-preview")).toBeVisible();
  await expect(page.locator(".choice-list strong")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Accept **plain description**" }),
  ).toBeVisible();
  await body.locator("summary").click();
  await expect(body.locator("kbd")).toBeVisible();
  const svgCode = body.getByTestId("code-block").first();
  await svgCode.locator(".visual-format").selectOption("raw");
  await expect(svgCode.locator(".code-block-pre")).toHaveText(catSvg + "\n");
  await svgCode.getByRole("button", { name: "复制", exact: true }).click();
  expect(await page.evaluate(() => (window as any).copiedSvg)).toBe(
    catSvg + "\n",
  );
  await svgCode.locator(".visual-format").selectOption("preview");
  await svgCode.getByRole("button", { name: "展开内容", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByTestId("svg-preview"),
  ).toBeVisible();
  const ids = await page
    .locator('[data-testid="svg-preview"] svg')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-svg-scope")),
    );
  expect(new Set(ids).size).toBe(ids.length);
  await page.keyboard.press("Escape");
});

test("question native SVG and semantics are responsive in both themes without enabling HTML resources", async ({
  page,
}) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://markdown-evil.test/**", (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await richQuestion(
    page,
    `Inline figure ${catSvg} after.\n\n<svg xmlns="http://www.w3.org/2000/svg" onload="window.svgXss=true"><script>window.svgXss=true</script><image href="https://markdown-evil.test/image"/></svg>\n\n${fence("svg", '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img src="https://markdown-evil.test/pixel"/></foreignObject></svg>')}\n\n<details><summary>Safe</summary>**strong**</details>\n\n| A | B |\n| - | - |\n| ${"wide".repeat(160)} | cell |`,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#session/s1");
  const body = page.locator(".question-body");
  await expect(body.getByTestId("svg-preview")).toHaveCount(1);
  await expect(
    body.locator("script, foreignObject, image, img, iframe"),
  ).toHaveCount(0);
  await expect(
    body.getByTestId("code-block").locator(".code-block-pre"),
  ).toBeVisible();
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    await expect(body.getByTestId("svg-preview").locator("svg")).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }
  expect(await page.evaluate(() => (window as any).svgXss)).toBeUndefined();
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});
