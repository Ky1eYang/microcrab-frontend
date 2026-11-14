// Beautify 0.1.6 r3 polish: glyphs replaced by aria-hidden icons, and the
// transcript's scroll-padding keeps focused content clear of the composer.
import { test, expect, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";
import { richMessages, RICH_TITLE } from "./beautify-data";

async function session(page: Page) {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = structuredClone(richMessages);
  backend.snapshot().session.title = RICH_TITLE;
  await page.goto("/#session/s1");
  await expect(page.getByText("路由现状")).toBeVisible();
}

for (const width of [1440, 390]) {
  test(`typing and resizing the focused composer preserves the history scroll position at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    const backend = await nativeBackend(page);
    backend.snapshot().messages = [
      {
        id: "long-answer",
        role: "assistant",
        text: Array.from(
          { length: 90 },
          (_, index) => `History paragraph ${index}.\n\n`,
        ).join(""),
        parts: [],
        tool_calls: [],
      },
    ];
    await page.goto("/#session/s1");
    await connectHostUI(page);
    const input = page.getByRole("textbox", { name: "消息", exact: true });
    await expect(input).toBeEnabled();
    await input.evaluate((el) =>
      (el as HTMLTextAreaElement).focus({ preventScroll: true }),
    );
    const transcript = page.locator("#conversation-transcript");
    await expect
      .poll(() =>
        transcript.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
    const before = await transcript.evaluate(async (el) => {
      // scrollTop changes synchronously, but Conversation observes its scroll
      // event asynchronously. Wait for that event before the first input render
      // can still see the initial follow-latest state.
      const scrolled = new Promise<void>((resolve) =>
        el.addEventListener("scroll", () => resolve(), { once: true }),
      );
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
      const baseline = el.scrollTop;
      await scrolled;
      return baseline;
    });
    expect(before).toBeGreaterThan(100);
    await expect(
      page.getByRole("button", { name: "滚动回最新消息", exact: true }),
    ).toHaveClass(/is-visible/);
    await expect
      .poll(() =>
        transcript.evaluate(
          (el, baseline) => Math.abs(el.scrollTop - baseline),
          before,
        ),
      )
      .toBeLessThanOrEqual(1);
    for (const character of ["a", "b", "c", "d", "e"]) {
      await input.press(character);
      await expect
        .poll(() =>
          transcript.evaluate(
            (el, baseline) => Math.abs(el.scrollTop - baseline),
            before,
          ),
        )
        .toBeLessThanOrEqual(1);
    }
    const height = await input.evaluate(
      (el) => el.getBoundingClientRect().height,
    );
    await input.fill(
      Array.from({ length: 7 }, (_, index) => `Draft line ${index}`).join("\n"),
    );
    await expect
      .poll(() => input.evaluate((el) => el.getBoundingClientRect().height))
      .toBeGreaterThan(height);
    await expect
      .poll(() =>
        transcript.evaluate(
          (el, baseline) => Math.abs(el.scrollTop - baseline),
          before,
        ),
      )
      .toBeLessThanOrEqual(1);
    await input.fill("short");
    await expect
      .poll(() =>
        transcript.evaluate(
          (el, baseline) => Math.abs(el.scrollTop - baseline),
          before,
        ),
      )
      .toBeLessThanOrEqual(1);
  });
}

const composerHeight = (page: Page) =>
  page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".transcript")!;
    const wrap = document.querySelector(".conversation-input-outer-wrap")!;
    return {
      variable: list.style.getPropertyValue("--composer-height"),
      padding: getComputedStyle(list).scrollPaddingBottom,
      height: `${Math.ceil(wrap.getBoundingClientRect().height)}px`,
    };
  });

test("a focused code-card copy button scrolls clear of the composer at 1440", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await session(page);
  const state = await composerHeight(page);
  expect(state.variable).toBe(state.height);
  expect(state.padding).toBe(state.height);
  const copy = page.locator(".assistant-turn .code-block-copy-btn").last();
  // Start with the card under the composer, then reach the button with Tab.
  const covered = async () => {
    const [button, wrap] = await Promise.all([
      copy.boundingBox(),
      page.locator(".conversation-input-outer-wrap").boundingBox(),
    ]);
    return button && wrap ? button.y + button.height - wrap.y : NaN;
  };
  await page.locator(".transcript").evaluate((el) => (el.scrollTop = 0));
  await expect.poll(covered).toBeGreaterThan(0);
  await copy.evaluate((el) =>
    (el as HTMLElement).focus({ preventScroll: true }),
  );
  await page.keyboard.press("Shift+Tab");
  await page.locator(".transcript").evaluate((el) => (el.scrollTop = 0));
  await page.keyboard.press("Tab");
  await expect(copy).toBeFocused();
  await expect.poll(covered).toBeLessThanOrEqual(1);
});

test("--composer-height follows the composer when it grows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await session(page);
  await connectHostUI(page);
  await expect(page.getByLabel("消息", { exact: true })).toBeEnabled();
  const before = await composerHeight(page);
  await page
    .locator(".home-composer-textarea")
    .fill(Array.from({ length: 6 }, (_, i) => `line ${i}`).join("\n"));
  await expect
    .poll(async () => (await composerHeight(page)).variable)
    .not.toBe(before.variable);
  const after = await composerHeight(page);
  expect(after.variable).toBe(after.height);
  expect(parseInt(after.height)).toBeGreaterThan(parseInt(before.height));
});

test("former text glyphs are aria-hidden icons and names keep their text", async ({
  page,
}) => {
  await session(page);
  // Model pill chevron.
  const pill = page.locator(".model-pill-chevron");
  await expect(pill).toHaveJSProperty("tagName", "svg");
  await expect(pill).toHaveAttribute("aria-hidden", "true");
  // No leftover glyphs anywhere in the rendered chrome.
  const glyphs = await page.evaluate(() =>
    [...document.querySelectorAll("button, [role=button], span")]
      .filter((el) => !el.closest(".markdown-body, .payload"))
      .map((el) => el.textContent ?? "")
      .filter((text) => /[⌵⌃⌄↗]/.test(text)),
  );
  expect(glyphs).toEqual([]);
  // Home: workspace badge chevron and the menu check.
  await page.goto("/");
  const badge = page.getByTitle("选择项目工作区");
  await expect(badge.locator("svg.glyph-icon[data-dir=down]")).toHaveCount(1);
  await badge.click();
  const active = page.locator(".workspace-menu-item[data-active=true]");
  await expect(active).toHaveAccessibleName(/Assigned\s+离线/);
  await expect(active).toHaveAttribute("title", "/assigned");
  // Single-line picker retains the path as a tooltip and uses hidden chrome icons.
  await expect(active.locator('svg[aria-hidden="true"]')).toHaveCount(2);
  await expect(active.locator("svg.glyph-icon")).toHaveCount(1);
  await expect(active.locator(".picker-project-status svg")).toHaveCount(1);
});
