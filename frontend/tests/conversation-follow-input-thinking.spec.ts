import { expect, test, type Locator, type Page } from "@playwright/test";
import type { NativeMessage } from "../src/client/types";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

const prose = (label: string, count = 45) =>
  Array.from({ length: count }, (_, i) => `${label} ${i}`).join("\n\n");
const message = (id: string, text: string): NativeMessage => ({
  id,
  role: "assistant",
  text,
  parts: [],
  tool_calls: [],
});
const host = (page: Page) => page.locator("#conversation-transcript");
const gap = (node: Locator) =>
  node.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
async function setup(
  page: Page,
  options: Parameters<typeof nativeBackend>[1] = {},
) {
  await page.setViewportSize({ width: 1440, height: 700 });
  const backend = await nativeBackend(page, options);
  backend.snapshot().messages = [
    { ...message("follow-user", "Earlier question"), role: "user" },
    message("follow-answer", prose("Earlier answer")),
  ];
  await page.goto("/#session/s1");
  await expect(
    page.getByText("Earlier answer 44", { exact: true }),
  ).toBeAttached();
  await connectHostUI(page);
  return backend;
}
async function pause(page: Page) {
  await host(page).evaluate((el) => {
    el.scrollTop = 300;
  });
  await expect(host(page)).toHaveAttribute("data-following", "false");
}
async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "消息", exact: true }).fill(text);
  await page.getByRole("button", { name: "发送 (Enter)", exact: true }).click();
}
for (const reading of [false, true]) {
  test(`accepted direct Send immediately follows and keeps incremental output following, paused=${reading}`, async ({
    page,
  }) => {
    const backend = await setup(page);
    if (reading) await pause(page);
    await send(page, "Continue this conversation");
    await expect(
      page.getByRole("textbox", { name: "消息", exact: true }),
    ).toHaveValue("");
    await expect(host(page)).toHaveAttribute("data-following", "true");
    await expect.poll(() => gap(host(page))).toBeLessThanOrEqual(1);
    for (let i = 0; i < 3; i++) {
      const next = structuredClone(backend.snapshot());
      next.messages = [
        ...next.messages.filter((m) => m.id !== "follow-stream"),
        message("follow-stream", prose("Incremental output", 40 + i * 20)),
      ];
      backend.publish(next); // The fixture publishes real ordered blocks.upsert events.
      await expect(
        page.getByText(`Incremental output ${39 + i * 20}`, { exact: true }),
      ).toBeAttached();
      await expect(host(page)).toHaveAttribute("data-following", "true");
      await expect.poll(() => gap(host(page))).toBeLessThanOrEqual(1);
    }
  });
}
test("passive growth before admission cannot cancel a direct Send's follow intent", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend = await setup(page, {
    inboxTurn: async (command) => {
      await held;
      return {
        id: command.params.operation_id,
        session_id: "s1",
        method: command.method,
        status: "completed",
        result: { admitted: true },
      };
    },
  });
  await send(page, "Admit while layout grows");
  await expect
    .poll(
      () => backend.commands.filter((c) => c.method === "turn.queue").length,
    )
    .toBe(1);
  await host(page).evaluate((el) => {
    // Delayed Markdown/media layout can deliver scroll before the size observer.
    (el.querySelector(".transcript-inner") as HTMLElement).style.paddingBottom =
      "240px";
    el.dispatchEvent(new Event("scroll"));
  });
  await expect(host(page)).toHaveAttribute("data-following", "true");
  release();
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toHaveValue("");
  await expect(host(page)).toHaveAttribute("data-following", "true");
  await expect.poll(() => gap(host(page))).toBeLessThanOrEqual(1);
  const next = structuredClone(backend.snapshot());
  next.session.status = "running";
  next.messages.push(
    message("follow-admitted-stream", prose("After admission", 70)),
  );
  backend.publish(next);
  await expect(
    page.getByText("After admission 69", { exact: true }),
  ).toBeAttached();
  await expect(host(page)).toHaveAttribute("data-following", "true");
  await expect.poll(() => gap(host(page))).toBeLessThanOrEqual(1);
});

test("rejected input does not rearm paused reading", async ({ page }) => {
  await setup(page, {
    submitError: {
      code: "invalid_input",
      message: "Input validation rejected",
    },
  });
  await pause(page);
  await send(page, "Rejected direct input");
  await expect(page.getByText(/Input validation rejected/)).toBeVisible();
  await expect(host(page)).toHaveAttribute("data-following", "false");
});
async function thinking(page: Page) {
  const backend = await setup(page);
  const running = structuredClone(backend.snapshot());
  running.session.status = "running";
  running.inbox = { items: [], active: true, paused: false };
  backend.publish(running);
  const scope = {
    operation_id: "follow-thinking-op",
    call_id: "follow-thinking-call",
    epoch: 0,
    turn: 1,
    round: 1,
  };
  backend.event("model_observation", { ...scope, phase: "started" });
  backend.event("model_observation", {
    ...scope,
    phase: "reasoning_delta",
    text: prose("Thinking", 50),
  });
  const thought = page.getByTestId("think-block");
  await expect(thought).toHaveAttribute("data-expanded", "true");
  const inner = thought.locator(".think-content");
  await expect
    .poll(() => inner.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(300);
  return { backend, scope, thought, inner };
}
test("expanded streaming thinking follows both capped inner content and outer conversation", async ({
  page,
}) => {
  const { backend, scope, thought, inner } = await thinking(page);
  await expect(host(page)).toHaveAttribute("data-following", "true");
  for (let i = 0; i < 3; i++) {
    backend.event("model_observation", {
      ...scope,
      phase: "reasoning_delta",
      text: prose(`More thinking ${i}`, 25),
    });
    await expect(thought).toContainText(`More thinking ${i} 24`);
    await expect.poll(() => gap(inner)).toBeLessThanOrEqual(1);
    await expect.poll(() => gap(host(page))).toBeLessThanOrEqual(1);
    await expect(host(page)).toHaveAttribute("data-following", "true");
  }
});
test("explicit bottom navigation resumes an already expanded streaming thought", async ({
  page,
}) => {
  const { backend, scope, inner, thought } = await thinking(page);
  await inner.hover();
  await page.mouse.wheel(0, -120);
  await expect(host(page)).toHaveAttribute("data-following", "false");
  await host(page).evaluate((el) => {
    el.scrollTop -= 200;
  });
  await page
    .getByRole("button", { name: "滚动回最新消息", exact: true })
    .click();
  await expect(host(page)).toHaveAttribute("data-following", "true");
  backend.event("model_observation", {
    ...scope,
    phase: "reasoning_delta",
    text: prose("Resumed thought", 35),
  });
  await expect(thought).toContainText("Resumed thought 34");
  await expect.poll(() => gap(inner)).toBeLessThanOrEqual(1);
  await expect.poll(() => gap(host(page))).toBeLessThanOrEqual(1);
  await expect(thought).toHaveAttribute("data-expanded", "true");
});

for (const gesture of ["wheel", "keyboard", "touch", "scrollbar"] as const) {
  test(`reading up inside thinking pauses both hosts with ${gesture}`, async ({
    page,
  }) => {
    const { backend, scope, thought, inner } = await thinking(page);
    // Establish the same starting viewport even on the unfixed implementation.
    await inner.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    if (gesture === "wheel") {
      await inner.hover();
      await page.mouse.wheel(0, -160);
    } else if (gesture === "keyboard") {
      await inner.evaluate((el) => {
        el.setAttribute("tabindex", "0");
      });
      await inner.focus();
      await page.keyboard.press("PageUp");
    } else if (gesture === "scrollbar") {
      await inner.dispatchEvent("pointerdown", { pointerType: "mouse" });
      await inner.evaluate((el) => {
        el.scrollTop -= 160;
      });
    } else {
      await inner.dispatchEvent("touchstart", {
        touches: [{ identifier: 1, clientY: 100 }],
      });
      await inner.dispatchEvent("touchmove", {
        touches: [{ identifier: 1, clientY: 200 }],
      });
      await inner.evaluate((el) => {
        el.scrollTop -= 160;
      });
    }
    await expect(host(page)).toHaveAttribute("data-following", "false");
    await inner.evaluate(async (el) => {
      let prior = el.scrollTop,
        stable = 0;
      while (stable < 8) {
        await new Promise(requestAnimationFrame);
        const next = el.scrollTop;
        stable = next === prior ? stable + 1 : 0;
        prior = next;
      }
    });
    const before = await inner.evaluate((el) => el.scrollTop);
    const outerBefore = await host(page).evaluate((el) => el.scrollTop);
    backend.event("model_observation", {
      ...scope,
      phase: "reasoning_delta",
      text: prose("Paused thinking", 30),
    });
    backend.event("model_observation", {
      ...scope,
      phase: "text_delta",
      text: prose("Paused tail", 30),
    });
    await expect(thought).toContainText("Paused thinking 29");
    await expect(
      page.getByText("Paused tail 29", { exact: true }),
    ).toBeAttached();
    expect(
      await inner.evaluate((el) => el.scrollTop),
      `inner reading offset, ${gesture}`,
    ).toBe(before);
    await expect
      .poll(() => host(page).evaluate((el) => el.scrollTop))
      .toBe(outerBefore);
    await expect(host(page)).toHaveAttribute("data-following", "false");
  });
}

test("paused reading anchors survive incremental code and delayed media growth", async ({
  page,
}) => {
  const backend = await setup(page);
  const next = structuredClone(backend.snapshot());
  const code = (lines: number) =>
    "```typescript\n" +
    Array.from({ length: lines }, (_, i) => `const value${i} = ${i};`).join(
      "\n",
    ) +
    "\n```";
  next.messages = [
    next.messages[0],
    message("follow-code", code(3)),
    { ...message("follow-anchor", "Keep this reading anchor"), role: "user" },
    message("follow-reading-tail", prose("Reading below", 60)),
  ];
  backend.publish(next);
  const anchor = page
    .locator(".user-turn")
    .filter({ hasText: "Keep this reading anchor" });
  await expect(anchor).toBeAttached();
  await host(page).evaluate((el) => {
    const row = [...el.querySelectorAll<HTMLElement>(".user-turn")].find(
      (node) => node.textContent?.includes("Keep this reading anchor"),
    )!;
    el.scrollTop +=
      row.getBoundingClientRect().top - el.getBoundingClientRect().top - 30;
  });
  await expect(host(page)).toHaveAttribute("data-following", "false");
  const before = await anchor.evaluate((el) => el.getBoundingClientRect().top);
  next.messages[1].text = code(24);
  backend.publish(structuredClone(next));
  await expect(
    page.getByText("const value23 = 23;", { exact: false }),
  ).toBeAttached();
  await expect
    .poll(() =>
      anchor.evaluate(
        (el, top) => Math.abs(el.getBoundingClientRect().top - top),
        before,
      ),
    )
    .toBeLessThanOrEqual(1);
  // Real asynchronous image sizing exercises the observer without a transcript render.
  await page
    .locator(".assistant-piece-anchor")
    .first()
    .evaluate(async (el) => {
      const image = new Image();
      image.style.display = "block";
      el.append(image);
      await new Promise<void>((resolve, reject) => {
        image.onload = () => {
          image.style.height = "180px";
          resolve();
        };
        image.onerror = () => reject(new Error("Fixture image failed"));
        image.src =
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l4sAAAAASUVORK5CYII=";
      });
    });
  await expect
    .poll(() =>
      anchor.evaluate(
        (el, top) => Math.abs(el.getBoundingClientRect().top - top),
        before,
      ),
    )
    .toBeLessThanOrEqual(1);
  await expect(host(page)).toHaveAttribute("data-following", "false");
});
