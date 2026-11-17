import { expect, test, type Page } from "@playwright/test";
import { nativeBackend, nativeSnapshot } from "./native-fixture";

const LONG =
  "Investigate flaky e2e: a-really-long-identifier-without-spaces-0123456789abcdefghijklmnopqrstuvwxyz and then some more words to wrap";
const LONG_PROJECT =
  "very-long-project-name-for-recent-session-cards-0123456789";

async function mount(page: Page, opts: { emptyCurrent?: boolean } = {}) {
  const now = Date.now();
  const view = (
    id: string,
    title: string,
    project: string,
    minutes: number,
    status = "idle",
  ) => {
    const v = structuredClone(nativeSnapshot);
    Object.assign(v.session, {
      id,
      title,
      project_id: project,
      status,
      created_at_ms: now - minutes * 60_000 - 1,
      updated_at_ms: now - minutes * 60_000,
    });
    return v;
  };
  const sessions = [
    view("r1", "Running work", "project-1", 1, "running"),
    view("r2", LONG, "project-2", 2, "faulted"),
    view("r3", "Third", "project-1", 3),
    view("r4", "Fourth", "project-1", 4),
    view("r5", "Fifth", "project-2", 5),
    view("r6", "Sixth", "project-1", 6),
    view("r7", "Seventh", "project-1", 7),
    view("r8", "Eighth", "project-1", 8),
  ].filter((v) => !opts.emptyCurrent || v.session.project_id !== "project-1");
  const backend = await nativeBackend(page, {
    projects: [
      {
        id: "project-1",
        name: "Assigned",
        root: "/assigned",
        host_id: "h1",
        workspace_id: "w1",
      },
      {
        id: "project-2",
        name: LONG_PROJECT,
        root: "/long",
        host_id: "h1",
        workspace_id: "w2",
      },
    ],
    sessions,
  });
  // s1 is older than every recent card and lives in project-2.
  Object.assign(backend.snapshot().session, {
    project_id: "project-2",
    updated_at_ms: now - 600 * 60_000,
  });
  await page.goto("/");
  return backend;
}

test.describe("new chat recent sessions", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("current project by default, two columns, max six, status marks", async ({
    page,
  }) => {
    await mount(page);
    const section = page.getByTestId("recent-sessions");
    await expect(section).toHaveAttribute("data-scope", "current");
    await expect(section).toContainText("最近会话");
    await expect(section).toContainText("Assigned");
    const cards = section.getByTestId("recent-session-card");
    await expect(cards).toHaveCount(6);
    await expect(cards.first()).toHaveAttribute("data-session-id", "r1");
    await expect(cards.first()).toHaveAttribute("data-status", "running");
    await expect(section.locator(".recent-session-project")).toHaveCount(0);
    const boxes = await Promise.all(
      [0, 1].map((i) => cards.nth(i).boundingBox()),
    );
    expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2);
    expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x + 100);
  });

  test("all projects shows project tags, long titles clamp, scope persists", async ({
    page,
  }) => {
    await mount(page);
    await page.getByTestId("recent-scope-all").click();
    const section = page.getByTestId("recent-sessions");
    await expect(section).toHaveAttribute("data-scope", "all");
    await expect(page.getByTestId("recent-scope-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const faulted = section.locator('[data-session-id="r2"]');
    await expect(faulted).toHaveAttribute("data-status", "faulted");
    await expect(faulted).toHaveAttribute("title", LONG);
    await expect(faulted.locator(".recent-session-dot")).toBeVisible();
    const tag = faulted.locator(".recent-session-project span");
    await expect(tag).toHaveText(LONG_PROJECT);
    const overflow = await faulted.evaluate((card) => {
      const title = card.querySelector(".recent-session-title")!;
      const tag = card.querySelector(".recent-session-project span")!;
      const time = card.querySelector(".recent-session-time")!;
      return {
        titleLines: Math.round(
          title.getBoundingClientRect().height /
            parseFloat(getComputedStyle(title).lineHeight),
        ),
        tagClipped: tag.scrollWidth > tag.clientWidth,
        timeInside:
          time.getBoundingClientRect().right <=
          card.getBoundingClientRect().right,
        cardFits: card.scrollWidth <= card.clientWidth + 1,
      };
    });
    expect(overflow).toEqual({
      titleLines: 2,
      tagClipped: true,
      timeInside: true,
      cardFits: true,
    });
    await page.reload();
    await expect(page.getByTestId("recent-sessions")).toHaveAttribute(
      "data-scope",
      "all",
    );
  });

  test("whole card attaches the session", async ({ page }) => {
    await mount(page);
    await page.locator('[data-session-id="r3"]').click();
    await expect(page).toHaveURL(/#session\/r3$/);
    await expect(page.getByTestId("recent-sessions")).toHaveCount(0);
  });

  test("empty current project offers all projects", async ({ page }) => {
    await mount(page, { emptyCurrent: true });
    const empty = page.getByTestId("recent-sessions-empty");
    await expect(empty).toContainText("当前项目还没有会话。");
    await page.getByTestId("recent-view-all").click();
    await expect(page.getByTestId("recent-sessions")).toHaveAttribute(
      "data-scope",
      "all",
    );
    await expect(page.getByTestId("recent-session-card").first()).toBeVisible();
  });
});

test.describe("new chat recent sessions narrow", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("single column with 44px scope switch and no horizontal scroll", async ({
    page,
  }) => {
    await mount(page);
    const cards = page.getByTestId("recent-session-card");
    await expect(cards).toHaveCount(6);
    const [a, b] = await Promise.all([
      cards.nth(0).boundingBox(),
      cards.nth(1).boundingBox(),
    ]);
    expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);
    expect(Math.abs(a!.x - b!.x)).toBeLessThan(2);
    const switchBox = await page.getByTestId("recent-scope-all").boundingBox();
    expect(switchBox!.height).toBeGreaterThanOrEqual(44);
    const scroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(scroll).toBe(true);
  });
});
