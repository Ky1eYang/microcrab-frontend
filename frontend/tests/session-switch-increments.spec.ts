import { expect, test, type Page } from "@playwright/test";
import type { NativeSnapshot } from "../src/client/types";
import { connectHostUI } from "./host-fixture";
import { nativeBackend, nativeSnapshot } from "./native-fixture";

// v0.1.14 interaction targets: cached first frame, per-session drafts,
// settled-block render stability, and incremental (not refresh) turn ends.

const second = (): NativeSnapshot => ({
  ...structuredClone(nativeSnapshot),
  session: {
    ...structuredClone(nativeSnapshot.session),
    id: "s2",
    title: "第二会话",
    updated_at_ms: 1,
  },
  messages: [
    { id: "s2-u", role: "user", text: "第二提问", parts: [], tool_calls: [] },
    {
      id: "s2-a",
      role: "assistant",
      text: "第二回答",
      parts: [],
      tool_calls: [],
    },
  ],
});
/** Projected block ids of the seeded settled history rows. */
const SETTLED = /^s1:h\d+:/;
const row = (page: Page, title: string) =>
  page.getByTestId("session-item").filter({ hasText: title });
const attaches = (backend: { sessionSockets: unknown[] }) =>
  backend.sessionSockets;
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};

test("switching to a cached session paints from memory before its attach answers", async ({
  page,
}) => {
  // Every attach takes 400 ms; a cached switch must not wait for it.
  const backend = await nativeBackend(page, {
    sessions: [second()],
    attachDelayMs: 400,
  });
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await row(page, "第二会话").click();
  await expect(page.getByText("第二回答", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#session\/s2$/);
  const cold = await page.evaluate(() =>
    ((globalThis as any).__mcSwitchFrames ?? []).filter(
      (frame: any) => frame.source === "server",
    ),
  );
  expect(cold.length).toBeGreaterThan(0);
  for (let index = 0; index < 20; index++) {
    const [title, text, id] =
      index % 2 === 0
        ? ["原生会话", "历史回答", "s1"]
        : ["第二会话", "第二回答", "s2"];
    const before = attaches(backend).length;
    await row(page, title).click();
    // The cached conversation is on screen while its attach is outstanding.
    await expect(page.getByText(text, { exact: true })).toBeVisible();
    expect(attaches(backend).length).toBeLessThanOrEqual(before + 1);
    await expect(page).toHaveURL(new RegExp(`#session/${id}$`));
    await expect(row(page, title)).toHaveAttribute("data-loading", "false");
  }
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          ((globalThis as any).__mcSwitchFrames ?? []).filter(
            (frame: any) => frame.source === "cache",
          ).length,
      ),
    )
    .toBe(20);
  const frames: { source: string; ms: number }[] = await page.evaluate(
    () => (globalThis as any).__mcSwitchFrames,
  );
  const cached = frames
    .filter((frame) => frame.source === "cache")
    .map((frame) => frame.ms);
  expect(cached).toHaveLength(20);
  const p95 = percentile(cached, 0.95);
  console.log(
    `[metric] cached switch first frame: n=${cached.length} p50=${percentile(cached, 0.5).toFixed(1)}ms p95=${p95.toFixed(1)}ms; cold attach first frame=${cold[0].ms.toFixed(1)}ms (attach delay 400ms)`,
  );
  // No cached frame waits for its 400 ms attach. The 50 ms p95 target is
  // checked against the production build (MC_FRAME_BUDGET_MS=50); the dev
  // server renders twice under StrictMode and shares CPU with other workers.
  expect(Math.max(...cached)).toBeLessThan(400);
  expect(p95).toBeLessThan(Number(process.env.MC_FRAME_BUDGET_MS ?? 150));
  // The previous subscription is released; the cached view is reconciled.
  expect(
    backend.sessionSockets
      .slice(0, -1)
      .some((socket) => backend.connection(socket)?.closed),
  ).toBe(true);
});

test("each session keeps its own draft text and images across switches", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    sessions: [second()],
    images: true,
  });
  await page.goto("/#session/s1");
  await connectHostUI(page);
  const composer = page.getByTestId("composer").locator("textarea");
  await expect(composer).toBeEnabled();
  await composer.fill("s1 draft text");
  await composer.evaluate((element) => {
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCwAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    const data = new DataTransfer();
    data.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(page.getByTestId("composer-images").locator("img")).toHaveCount(
    1,
  );
  await row(page, "第二会话").click();
  await expect(page.getByText("第二回答", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("composer-images")).toHaveCount(0);
  await composer.fill("s2 draft text");
  await row(page, "原生会话").click();
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("s1 draft text");
  await expect(page.getByTestId("composer-images").locator("img")).toHaveCount(
    1,
  );
  await row(page, "第二会话").click();
  await expect(composer).toHaveValue("s2 draft text");
  await expect(page.getByTestId("composer-images")).toHaveCount(0);
  // Drafts are memory-only: nothing is written to browser storage.
  const stored = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage }),
  );
  expect(stored).not.toContain("draft text");
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(0);
});

test("streaming re-renders only the live block and a turn end needs no re-attach", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = Array.from({ length: 40 }, (_, index) => ({
    id: `h${index}`,
    role: index % 2 ? "assistant" : "user",
    text: `History ${index}`,
    parts: [],
    tool_calls: [],
  })) as NativeSnapshot["messages"];
  await page.addInitScript(() => ((window as any).__mcRenderCounts = {}));
  await page.goto("/#session/s1");
  await expect(page.getByText("History 39", { exact: true })).toBeVisible();
  const before = attaches(backend).length;
  // The counter sees the settled history blocks it later expects to stay quiet.
  const initial: string[] = await page.evaluate(() =>
    Object.keys((window as any).__mcRenderCounts),
  );
  expect(initial.filter((id) => SETTLED.test(id)).length).toBeGreaterThan(10);
  await page.evaluate(() => ((window as any).__mcRenderCounts = {}));
  backend.event("model_observation", {
    operation_id: "op-stream",
    call_id: "call-stream",
    phase: "started",
  });
  let text = "";
  for (let index = 0; index < 60; index++) {
    text += `chunk${index} `;
    backend.event("model_observation", {
      operation_id: "op-stream",
      call_id: "call-stream",
      phase: "text_delta",
      text: `chunk${index} `,
    });
  }
  await expect(page.getByText(text.trim(), { exact: false })).toBeVisible();
  const counts: Record<string, number> = await page.evaluate(
    () => (window as any).__mcRenderCounts,
  );
  const settled = Object.entries(counts)
    .filter(([id]) => SETTLED.test(id))
    .reduce((sum, [, count]) => sum + count, 0);
  const live = Object.entries(counts)
    .filter(([id]) => !SETTLED.test(id))
    .reduce((sum, [, count]) => sum + count, 0);
  console.log(
    `[metric] preview start + 60 deltas: settled-block re-renders=${settled}, live-block renders=${live}`,
  );
  expect(settled).toBe(0);
  expect(live).toBeGreaterThan(0);
  // The settled answer arrives as an increment; the turn end fetches nothing.
  backend.finish("Streamed final answer");
  backend.event("turn", { id: "op-stream", status: "completed" });
  await expect(
    page.getByText("Streamed final answer", { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(300);
  expect(attaches(backend)).toHaveLength(before);
  expect(
    backend.commands.filter((command) => command.method === "session.blocks"),
  ).toHaveLength(0);
});

test("a sequence gap resumes from the held boundary instead of reloading cold", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().history_view = {
    lineage: "gap-resume-lineage",
    epoch: 0,
    start_cursor: 0,
    end_cursor: 2,
    message_count: 2,
    turns: [],
  };
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  const before = attaches(backend).length;
  backend.event("session", backend.snapshot().session, 2);
  await expect.poll(() => attaches(backend).length).toBe(before + 1);
  const resume = new URL(backend.sessionSockets.at(-1)!.url());
  expect(resume.searchParams.get("history_lineage")).toBe("gap-resume-lineage");
  // Reconnect initializes a bounded full page, never an unsafe after-id prefix.
  expect(resume.searchParams.has("after_message_id")).toBe(false);
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
});
