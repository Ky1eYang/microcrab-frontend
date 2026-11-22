import { expect, test, type Locator, type Page } from "@playwright/test";

/* v0.1.18 UI/UX polish acceptance, driven through the Designer review
 * fixture (fixture/scenarios.ts) on the test dev server. */
async function scenario(page: Page, id: string, extra = "") {
  await page.goto(`/fixture/?scenario=${id}&theme=light&locale=zh-CN${extra}`);
  await expect(page.locator("html")).toHaveAttribute("data-fixture", "ready", {
    timeout: 20000,
  });
}

/** Effective clickable size via elementFromPoint, including ::after hit pads. */
async function measureHitArea(target: Locator) {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hits = (x: number, y: number) => {
      const node = document.elementFromPoint(x, y);
      return !!node && (node === el || el.contains(node));
    };
    let up = 0;
    while (up < 30 && hits(cx, r.top - up - 1)) up++;
    let dn = 0;
    while (dn < 30 && hits(cx, r.bottom + dn + 1)) dn++;
    let lf = 0;
    while (lf < 30 && hits(r.left - lf - 1, cy)) lf++;
    let rt = 0;
    while (rt < 30 && hits(r.right + rt + 1, cy)) rt++;
    return {
      visualW: Math.round(r.width),
      visualH: Math.round(r.height),
      hitW: Math.round(r.width + lf + rt),
      hitH: Math.round(r.height + up + dn),
    };
  });
}

test.describe("touch (hover: none) at 390", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("3.1 failed reply shows a labelled 44px Retry without hover", async ({
    page,
  }) => {
    await scenario(page, "retry-failure");
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(
      true,
    );
    const retry = page
      .getByTestId("operation-failure")
      .getByTestId("retry-model-request");
    await expect(retry).toBeVisible();
    await expect(retry).toHaveText("重试");
    await expect(retry).toHaveAccessibleName("重试");
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test("3.5 mode, model, and sessions + hit areas are at least 44px", async ({
    page,
  }) => {
    await scenario(page, "default");
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    const agent = page.getByTestId("composer-agent-pill");
    const model = page.getByTestId("composer-model-pill");
    await expect(agent).toBeVisible();
    await expect(model).toBeVisible();
    for (const control of [agent, model]) {
      // The pills settle after the composer's first layout pass.
      await expect
        .poll(async () => (await measureHitArea(control)).hitW)
        .toBeGreaterThanOrEqual(44);
      const size = await measureHitArea(control);
      // Visual stays compact; only the invisible hit pad grows.
      expect(size.visualH).toBeLessThan(44);
      expect(size.hitW).toBeGreaterThanOrEqual(44);
      expect(size.hitH).toBeGreaterThanOrEqual(44);
    }

    await page.getByTestId("header-open-rail").click();
    const add = page.getByTestId("sessions-new-chat");
    await expect(add).toBeVisible();
    const size = await measureHitArea(add);
    expect(size.visualH).toBeLessThan(44);
    expect(size.hitW).toBeGreaterThanOrEqual(44);
    expect(size.hitH).toBeGreaterThanOrEqual(44);
  });

  test("3.5 D3 remaining composer, header and drawer controls hit 44px", async ({
    page,
  }) => {
    const expectHit = async (control: Locator, label: string) => {
      await expect(control, label).toBeVisible();
      await expect
        .poll(async () => (await measureHitArea(control)).hitW, {
          message: `${label} settles`,
        })
        .toBeGreaterThanOrEqual(44);
      const size = await measureHitArea(control);
      expect(size.hitW, `${label} hit width`).toBeGreaterThanOrEqual(44);
      expect(size.hitH, `${label} hit height`).toBeGreaterThanOrEqual(44);
      return size;
    };
    await scenario(page, "default");
    for (const id of [
      "header-open-rail",
      "header-host-connection",
      "tab-conversation",
      "composer-session-permissions",
      "composer-send",
      "statistics-activity",
      "statistics-usage",
    ])
      await expectHit(page.getByTestId(id), id);
    // Pills, Host capsule and send keep their compact visual box.
    expect(
      (await measureHitArea(page.getByTestId("header-host-connection")))
        .visualH,
    ).toBeLessThan(44);
    expect(
      (await measureHitArea(page.getByTestId("statistics-usage"))).visualH,
    ).toBeLessThan(44);
    await expectHit(
      page.getByRole("button", { name: "快捷操作与工具" }),
      "composer-plus",
    );

    await page.getByTestId("header-open-rail").click();
    for (const id of [
      "nav-new-chat",
      "nav-dashboard",
      "rail-plugins-btn",
      "nav-history",
      "project-host-warn",
    ])
      await expectHit(page.getByTestId(id), id);
    await expectHit(
      page.getByRole("button", { name: "收起侧边栏" }),
      "collapse-sidebar",
    );

    await scenario(page, "inbox-mixed-draft");
    for (const id of ["composer-stop", "steer-input", "queue-input"])
      await expectHit(page.getByTestId(id), id);
  });
});

test.describe("narrow 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("3.3 host-offline notice is one line with a disclosure that expands and collapses", async ({
    page,
  }) => {
    // One notice pattern everywhere (D2): ExpandableNotice = dot + one-line
    // ellipsis + "…" disclosure popover, actions on the same row.
    await scenario(page, "default");
    const notice = page.locator(".composer-host-notice").first();
    await expect(notice).toBeVisible();
    await expect(notice).toHaveClass(/expandable-notice/);
    const text = notice.locator(".notice-text");
    await expect
      .poll(() => text.evaluate((el) => el.getBoundingClientRect().height))
      .toBeLessThanOrEqual(24);
    const reveal = notice.locator(".notice-reveal");
    await expect(reveal).toBeVisible();
    await reveal.click();
    await expect(reveal).toHaveAttribute("aria-expanded", "true");
    await expect(notice).toHaveAttribute("data-expanded", "true");
    await expect(notice.locator(".notice-popover")).toBeVisible();
    await reveal.click();
    await expect(reveal).toHaveAttribute("aria-expanded", "false");
    await expect(notice).toHaveAttribute("data-expanded", "false");
  });

  test("3.2 actionable permission cards: Will run, Deny then Allow once, no overflow", async ({
    page,
  }) => {
    await scenario(page, "permission-request-actionable");
    const cards = page.locator(".permission-card");
    await expect(cards.first()).toBeVisible();
    const first = cards.first();
    await expect(first.locator(".permission-will-run-body")).toBeVisible();
    const labels = await first
      .locator(".flow-card-actions button")
      .allInnerTexts();
    expect(labels.map((label) => label.trim()).slice(-2)).toEqual([
      "拒绝",
      "允许本次",
    ]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

  test("3.2 observer permission card has no action buttons", async ({
    page,
  }) => {
    await scenario(page, "permission-request");
    const card = page.locator(".permission-card").first();
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: "允许本次" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "拒绝" })).toHaveCount(0);
  });

  test("3.5 queue starts collapsed and inputs are 16px", async ({ page }) => {
    await scenario(page, "inbox-mixed-draft");
    await expect(page.locator(".queue-dock-header")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(page.getByTestId("composer").locator("textarea")).toHaveCSS(
      "font-size",
      "16px",
    );
  });

  test("P2-2 permission JSON wraps inside the card", async ({ page }) => {
    await scenario(page, "permission-request");
    const details = page.locator(".permission-card .flow-card-details").first();
    await details.evaluate((el) => ((el as HTMLDetailsElement).open = true));
    const body = details.locator(".payload-body").first();
    await expect(body).toBeVisible();
    expect(
      await body.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    const card = (await page
      .locator(".permission-card")
      .first()
      .boundingBox())!;
    const box = (await body.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
  });

  test("P2-1 rail never shows epoch ages", async ({ page }) => {
    await scenario(page, "default");
    await page.getByTestId("header-open-rail").click();
    const times = await page.locator(".session-item-time").allInnerTexts();
    expect(times.length).toBeGreaterThan(0);
    for (const time of times)
      expect(time).toMatch(/^(now|\d{1,3}[mhd]|\d+y|—)$/);
  });

  test("P1-1 settings feedback banner and toast stay compact and reveal full text", async ({
    page,
  }) => {
    await scenario(page, "settings-feedback");
    const banner = page.locator(".settings-feedback-banner.expandable-notice");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-expanded", "false");
    await banner.locator(".notice-reveal").click();
    await expect(banner).toHaveAttribute("data-expanded", "true");
    await expect(banner.locator(".notice-popover")).toBeVisible();
    const toast = page.getByTestId("toast-body");
    await expect(toast).toHaveAttribute("data-expanded", "false");
    await expect(toast).toHaveCSS("-webkit-line-clamp", "2");
    const clamped = (await toast.boundingBox())!.height;
    await toast.click();
    await expect(toast).toHaveAttribute("data-expanded", "true");
    expect((await toast.boundingBox())!.height).toBeGreaterThan(clamped);
  });

  test("3.6 no collapsed icon rail; header menu opens the drawer", async ({
    page,
  }) => {
    await scenario(page, "default");
    await expect(page.locator(".session-rail.collapsed-rail")).toHaveCount(0);
    const menu = page.getByTestId("header-open-rail");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("nav-new-chat").first()).toBeVisible();
  });
});

test.describe("narrow 320", () => {
  test.use({ viewport: { width: 320, height: 720 } });

  test("P1-1 queue draft note ellipsizes to one line and expands", async ({
    page,
  }) => {
    await scenario(page, "inbox-mixed-draft");
    const note = page.getByTestId("inbox-draft-note");
    await expect(note).toHaveAttribute("data-expanded", "false");
    const text = note.locator(".notice-text");
    await expect(text).toHaveCSS("white-space", "nowrap");
    await expect(text).toHaveCSS("text-overflow", "ellipsis");
    await note.locator(".notice-reveal").click();
    await expect(note).toHaveAttribute("data-expanded", "true");
    // The full text opens in a popover; the row itself stays one line.
    await expect(note.locator(".notice-popover")).toBeVisible();
    await expect(text).toHaveCSS("white-space", "nowrap");
  });
  test("P2-4 transcript status lines are one-line expandable notices", async ({
    page,
  }) => {
    await scenario(page, "transcript-notices");
    const coverage = page.getByTestId("conversation-display-coverage");
    const gap = page.getByTestId("conversation-history-gap");
    for (const notice of [coverage, gap]) {
      await expect(notice).toHaveClass(/expandable-notice/);
      await expect(notice.locator(".notice-text")).toHaveCSS(
        "white-space",
        "nowrap",
      );
    }
    await expect(coverage).toHaveAttribute("data-expanded", "false");
    await coverage.locator(".notice-reveal").click();
    await expect(coverage).toHaveAttribute("data-expanded", "true");
    await expect(coverage.locator(".notice-popover")).toContainText(
      "已恢复的思考内容可能不完整",
    );
    // The "load earlier" control stays a plain fold button.
    await expect(
      page.locator(".transcript-history-fold-btn.expandable-notice"),
    ).toHaveCount(0);
  });
});

test.describe("desktop 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("D3 touch hit areas do not bloat fine-pointer desktop controls", async ({
    page,
  }) => {
    await scenario(page, "default");
    for (const [id, max] of [
      ["composer-send", 32],
      ["header-host-connection", 28],
      ["statistics-usage", 24],
    ] as const) {
      const size = await measureHitArea(page.getByTestId(id));
      expect(size.visualH, id).toBeLessThanOrEqual(max);
      expect(size.hitH, id).toBeLessThanOrEqual(max + 1);
    }
  });

  test("3.1 Retry is visible without hover on desktop and at least 32px", async ({
    page,
  }) => {
    await scenario(page, "retry-failure");
    const retry = page
      .getByTestId("operation-failure")
      .getByTestId("retry-model-request");
    await expect(retry).toBeVisible();
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(32);
  });

  test("3.4 tool group header carries outcome glyphs with accessible labels", async ({
    page,
  }) => {
    await scenario(page, "tools-mixed-status");
    const glyphs = page.getByTestId("tool-group-outcomes").first();
    await expect(glyphs).toBeVisible();
    await expect(glyphs.locator(".sr-only").first()).not.toBeEmpty();
  });

  test("3.7 login error is an alert", async ({ page }) => {
    await scenario(page, "login-error");
    await expect(page.getByTestId("auth-login-error")).toHaveAttribute(
      "role",
      "alert",
    );
  });
});
