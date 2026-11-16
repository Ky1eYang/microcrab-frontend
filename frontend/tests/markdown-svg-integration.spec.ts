import { expect, test } from "@playwright/test";
import { mountMarkdown } from "./rich-markdown-fixture";
import { catSvg } from "./rich-question-fixture";

for (const code of [
  "```svg\n<svg><rect/></svg>\n",
  "~~~svg\n<svg><rect/></svg>\n```\n",
  "`` a ` <kbd>literal</kbd> ``",
]) {
  test(`disclosure code delimiter boundaries remain literal ${JSON.stringify(code)}`, async ({
    page,
  }) => {
    await mountMarkdown(
      page,
      `<details open><summary>Title</summary>\n${code}</details>`,
    );
    await expect(page.getByTestId("svg-preview")).toHaveCount(0);
    await expect(page.locator("details kbd")).toHaveCount(0);
    await expect(page.locator("details")).toContainText(
      code.includes("<svg>") ? "<svg><rect/></svg>" : "<kbd>literal</kbd>",
    );
  });
}

test("disclosure phrasing retains sentence spacing and block placement", async ({
  page,
}) => {
  await mountMarkdown(
    page,
    "<details open><summary>Hint</summary>Press <kbd>Enter</kbd> to continue; H<sub>2</sub>O.</details>\n\nBefore <details><summary>Inline source</summary>Body</details> after.",
  );
  const details = page.locator("details").first();
  await expect(details.locator("summary > p, kbd > p, sub > p")).toHaveCount(0);
  await expect(details.locator("p")).toHaveText(
    "Press Enter to continue; H2O.",
  );
  await expect(page.locator("p > details")).toHaveCount(0);
});

for (const rich of [null, { streaming: true }]) {
  test(`native and fenced SVG remain source without completed rich scope ${JSON.stringify(rich)}`, async ({
    page,
  }) => {
    await mountMarkdown(
      page,
      `${catSvg}\n\n\`\`\`svg\n${catSvg}\n\`\`\``,
      rich,
    );
    await expect(page.getByTestId("svg-preview")).toHaveCount(0);
    await expect(page.locator(".code-block-pre")).toContainText(
      "Synthetic cat",
    );
    await page.evaluate(() =>
      (window as any).renderMarkdown({ rich: { streaming: false } }),
    );
    await expect(page.getByTestId("svg-preview")).toHaveCount(2);
  });
}

test("incomplete SVG stays inert and admitted inline styles cannot affect prose", async ({
  page,
}) => {
  await mountMarkdown(
    page,
    'Before <svg width="20" height="20"><style>rect { fill: red }</style><rect width="20" height="20"/></svg> after.',
  );
  await expect(page.getByTestId("svg-preview")).toBeVisible();
  await expect(page.locator('[data-testid="svg-preview"] rect')).toHaveCSS(
    "fill",
    "rgb(255, 0, 0)",
  );
  await page.evaluate(() =>
    (window as any).renderMarkdown({
      text: '<svg width="20" height="20"><rect',
    }),
  );
  await expect(page.getByTestId("svg-preview")).toHaveCount(0);
});

test("fences inside disclosures retain exact CRLF source and inline code remains literal", async ({
  page,
}) => {
  const source =
    '<svg width="20" height="20"><rect width="20" height="20"/></svg>\r\n';
  await mountMarkdown(
    page,
    "<details open><summary>Example</summary>\r\n\r\n```svg\r\n" +
      source +
      "```\r\n\r\n`<kbd>literal</kbd>`\r\n\r\n</details>",
  );
  await expect(page.locator("details")).toHaveAttribute("open", "");
  await expect(page.locator("details").getByTestId("code-block")).toHaveCount(
    1,
  );
  await expect(page.getByTestId("svg-preview")).toHaveCount(1);
  await expect(page.locator("details kbd")).toHaveCount(0);
  await expect(
    page.locator("details code").filter({ hasText: "<kbd>literal</kbd>" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  expect(await page.evaluate(() => (window as any).copiedSource)).toBe(source);
});
