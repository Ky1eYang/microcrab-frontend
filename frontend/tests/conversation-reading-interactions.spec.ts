import { expect, test, type Locator, type Page } from "@playwright/test";
import type { NativeMessage } from "../src/client/types";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

const position = (round: number) => ({ epoch: 0, turn: 1, round });
const output = (label: string, lines = 65) =>
  Array.from({ length: lines }, (_, i) => `${label} line ${i}`).join("\n");
const message = (id: string, text: string, round: number): NativeMessage => ({
  id,
  role: "assistant",
  text,
  parts: [],
  tool_calls: [],
  position: position(round),
});
const tools = (
  round: number,
  call = `reading-call-${round}`,
): NativeMessage[] => [
  {
    ...message(`reading-assistant-${round}`, "", round),
    tool_calls: [
      {
        id: call,
        name: `reading_tool_${round}`,
        arguments: { path: `file-${round}` },
      },
    ],
  },
  {
    ...message(`reading-result-${round}`, output(`Result ${round}`), round),
    role: "tool",
    call_id: call,
    tool_name: `reading_tool_${round}`,
  },
];
async function setup(
  page: Page,
  messages?: NativeMessage[],
  options: Parameters<typeof nativeBackend>[1] = {},
) {
  await page.setViewportSize({ width: 1440, height: 700 });
  const backend = await nativeBackend(page, options);
  const snapshot = backend.snapshot();
  snapshot.session.status = "running";
  snapshot.inbox = { items: [], active: true, paused: false };
  snapshot.messages = [
    { ...message("reading-user", "Inspect the files", 0), role: "user" },
    ...(messages ?? [...tools(1), ...tools(2)]),
    message(
      "reading-tail",
      output("Later paragraph", 90).replaceAll("\n", "\n\n"),
      8,
    ),
  ];
  snapshot.history_view = {
    lineage: "reading-lineage",
    epoch: 0,
    start_cursor: 0,
    end_cursor: snapshot.messages.length,
    message_count: snapshot.messages.length,
    turns: [
      {
        epoch: 0,
        turn: 1,
        tool_calls: 2,
        ordinary_tool_calls: 2,
        delegate_calls: 0,
      },
    ],
  };
  snapshot.messages_truncated = false;
  snapshot.next_cursor = null;
  await page.goto("/#session/s1");
  await expect(page.getByTestId("tool-row")).toHaveCount(2);
  return backend;
}
const row = (page: Page, round: number) =>
  page.getByTestId("tool-row").filter({ hasText: `reading_tool_${round}` });
const gap = (page: Page) =>
  page
    .locator("#conversation-transcript")
    .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
async function readTool(page: Page, chosen: Locator) {
  await chosen.click();
  const container = chosen.locator("..");
  const output = container.getByTestId("tool-payload-output");
  await expect(output).toHaveAttribute("data-variant", "trajectory");
  const body = output.locator("pre");
  await body.focus();
  await body.evaluate((node) => {
    node.scrollTop = 140;
  });
  await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBe(140);
  await page.locator("#conversation-transcript").evaluate(async (host) => {
    const chosen = host.querySelector<HTMLElement>(
      '[data-testid="tool-row"][aria-expanded="true"]',
    )!;
    const scrolled = new Promise<void>((resolve) =>
      host.addEventListener("scroll", () => resolve(), { once: true }),
    );
    host.scrollTop +=
      chosen.getBoundingClientRect().top -
      host.getBoundingClientRect().top +
      150;
    await scrolled;
  });
  await expect.poll(() => gap(page)).toBeGreaterThan(200);
  return chosen.evaluate((node) => node.getBoundingClientRect().top);
}

test("first incoming snapshot inserts content before an expanded tool without remount or reading jump", async ({
  page,
}) => {
  const backend = await setup(page);
  const chosen = row(page, 1);
  const before = await readTool(page, chosen);
  await chosen.evaluate((node) => {
    (window as any).__readingTool = node;
  });
  const next = structuredClone(backend.snapshot());
  // Hydration of the same canonical assistant inserts visible content before
  // its exact existing invocation; this changes the old assistant-container key.
  next.messages.find((m) => m.id === "reading-assistant-1")!.text = output(
    "Hydrated earlier text",
    15,
  ).replaceAll("\n", "\n\n");
  backend.publish(next);
  await expect(
    page.getByText("Hydrated earlier text line 0", { exact: false }).first(),
  ).toBeAttached();
  await expect(chosen).toHaveAttribute("aria-expanded", "true");
  expect(
    await chosen.evaluate((node) => node === (window as any).__readingTool),
  ).toBe(true);
  await expect(
    chosen.locator("..").getByTestId("tool-payload-output"),
  ).toHaveAttribute("data-collapsed", "false");
  await expect
    .poll(() =>
      chosen.evaluate(
        (node, y) => Math.abs(node.getBoundingClientRect().top - y),
        before,
      ),
    )
    .toBeLessThanOrEqual(1);
  backend.event("tool", {
    operation_id: "reading-op",
    ...position(3),
    call_id: "reading-call-3",
    name: "reading_tool_3",
    phase: "completed",
    arguments: {},
    result: output("Incoming", 100),
  });
  await expect(page.getByTestId("tool-row")).toHaveCount(3);
  await expect
    .poll(() =>
      chosen.evaluate(
        (node, y) => Math.abs(node.getBoundingClientRect().top - y),
        before,
      ),
    )
    .toBeLessThanOrEqual(1);
  // Asynchronous layout growth above the reading row is also anchored, without
  // depending on a transcript render (e.g. delayed rich content sizing).
  await page
    .locator(".assistant-piece-anchor")
    .first()
    .evaluate((node) => {
      (node as HTMLElement).style.paddingTop = "180px";
    });
  await expect
    .poll(() =>
      chosen.evaluate(
        (node, y) => Math.abs(node.getBoundingClientRect().top - y),
        before,
      ),
    )
    .toBeLessThanOrEqual(1);
  await expect.poll(() => gap(page)).toBeGreaterThan(200);
  await page
    .getByRole("button", { name: "滚动回最新消息", exact: true })
    .click();
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1);
  backend.event("tool", {
    operation_id: "reading-op",
    ...position(9),
    call_id: "reading-call-9",
    name: "reading_tool_9",
    phase: "completed",
    arguments: {},
    result: "new bottom",
  });
  await expect(page.getByTestId("tool-row")).toHaveCount(4);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1);
});

test("a later explicit expanded group survives a legitimate group merge and split", async ({
  page,
}) => {
  const backend = await setup(page, [
    ...tools(1),
    message("reading-boundary", "Temporary visible boundary", 2),
    ...tools(3),
  ]);
  const headers = page.locator(".tool-accordion-group-header");
  await expect(headers).toHaveCount(2);
  await row(page, 1).click();
  await headers.nth(0).click();
  const chosen = row(page, 3);
  const before = await readTool(page, chosen);
  const merged = structuredClone(backend.snapshot());
  merged.messages.find((m) => m.id === "reading-boundary")!.text = "";
  backend.publish(merged);
  await expect(headers).toHaveCount(1);
  await expect(headers).toHaveAttribute("aria-expanded", "true");
  await expect(chosen).toHaveAttribute("aria-expanded", "true");
  await expect(
    chosen.locator("..").getByTestId("tool-payload-output"),
  ).toHaveAttribute("data-collapsed", "false");
  await expect
    .poll(() =>
      chosen.evaluate(
        (node, y) => Math.abs(node.getBoundingClientRect().top - y),
        before,
      ),
    )
    .toBeLessThanOrEqual(1);
  backend.publish(structuredClone(backend.snapshot()));
  await expect(headers).toHaveCount(2);
  await expect(chosen).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() =>
      chosen.evaluate(
        (node, y) => Math.abs(node.getBoundingClientRect().top - y),
        before,
      ),
    )
    .toBeLessThanOrEqual(1);
});

test("reused call IDs across rounds keep selection and local payload reading separate", async ({
  page,
}) => {
  await setup(page, [...tools(1, "reused-call"), ...tools(2, "reused-call")]);
  const first = row(page, 1),
    second = row(page, 2);
  await first.click();
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await expect(second).toHaveAttribute("aria-expanded", "false");
  const firstOutput = first.locator("..").getByTestId("tool-payload-output");
  await firstOutput.locator("pre").evaluate((body) => {
    body.scrollTop = 140;
  });
  await expect
    .poll(() => firstOutput.locator("pre").evaluate((body) => body.scrollTop))
    .toBe(140);
  await second.click();
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect(second).toHaveAttribute("aria-expanded", "true");
  const secondOutput = second.locator("..").getByTestId("tool-payload-output");
  await expect(secondOutput).toContainText("Result 2 line 64");
  await expect(secondOutput).not.toContainText("Result 1 line 0");
  await expect
    .poll(() => secondOutput.locator("pre").evaluate((body) => body.scrollTop))
    .toBe(0);
  await secondOutput.getByTestId("payload-dialog-expand").click();
  const dialog = page.getByRole("dialog", {
    name: "reading_tool_2 · 输出",
    exact: true,
  });
  await expect(dialog).toContainText("Result 2 line 64");
  await expect(dialog).not.toContainText("Result 1 line 0");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("passive shrink near the bottom cannot resume follow after disclosure reading; lineage reset revokes choices", async ({
  page,
}) => {
  const backend = await setup(page);
  await readTool(page, row(page, 1));
  const shortened = structuredClone(backend.snapshot());
  shortened.messages.find((m) => m.id === "reading-tail")!.text = "short tail";
  backend.publish(shortened);
  await expect(page.getByText("short tail", { exact: true })).toBeAttached();
  await expect(row(page, 1)).toHaveAttribute("aria-expanded", "true");
  const scrollBefore = await page
    .locator("#conversation-transcript")
    .evaluate((el) => el.scrollTop);
  shortened.messages.find((m) => m.id === "reading-tail")!.text = output(
    "Growing tail",
    100,
  ).replaceAll("\n", "\n\n");
  backend.publish(structuredClone(shortened));
  await expect(
    page.getByText("Growing tail line 0", { exact: false }).first(),
  ).toBeAttached();
  await expect
    .poll(() =>
      page
        .locator("#conversation-transcript")
        .evaluate((el, top) => Math.abs(el.scrollTop - top), scrollBefore),
    )
    .toBeLessThanOrEqual(1);
  shortened.history_view!.lineage = "different-reading-lineage";
  backend.publish(structuredClone(shortened));
  await expect(row(page, 1)).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#conversation-transcript")).toHaveAttribute(
    "data-following",
    "false",
  );
  await expect(page.getByTestId("history-reading-changed")).toContainText(
    "历史已变更",
  );
  await expect(
    page.getByRole("button", { name: "滚动回最新消息", exact: true }),
  ).toBeVisible();
  const branch = structuredClone(shortened);
  branch.history_view!.lineage = "reused-coordinate-branch";
  branch.messages.find((m) => m.id === "reading-result-1")!.text =
    "Different branch result";
  branch.messages.find((m) => m.id === "reading-result-1")!.id =
    "branch-result-1";
  branch.messages.find((m) => m.id === "reading-assistant-1")!.id =
    "branch-assistant-1";
  backend.publish(branch);
  await expect(row(page, 1)).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#conversation-transcript")).toHaveAttribute(
    "data-following",
    "false",
  );
});

test("valid explicit send resumes following from an expanded tool reading position", async ({
  page,
}) => {
  const backend = await setup(page);
  await connectHostUI(page);
  await readTool(page, row(page, 1));
  const idle = structuredClone(backend.snapshot());
  idle.session.status = "idle";
  idle.inbox = { items: [], active: false, paused: false };
  backend.publish(idle);
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await expect(input).toBeEnabled();
  // Focusing the composer is allowed to reveal it; restore reading afterward
  // and use a real click/submit rather than a mocked callback invocation.
  await input.fill("Continue inspecting");
  await page.locator("#conversation-transcript").evaluate(async (host) => {
    const scrolled = new Promise<void>((resolve) =>
      host.addEventListener("scroll", () => resolve(), { once: true }),
    );
    host.scrollTop = 300;
    await scrolled;
  });
  await expect.poll(() => gap(page)).toBeGreaterThan(200);
  await page.getByRole("button", { name: "发送 (Enter)", exact: true }).click();
  await expect
    .poll(() =>
      backend.commands.some(
        (command) =>
          command.method === "turn.queue" || command.method === "turn.submit",
      ),
    )
    .toBe(true);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1);
  await expect(row(page, 1)).toHaveAttribute("aria-expanded", "true");
});

for (const mode of ["queue", "steer", "submit"] as const) {
  const outcomes =
    mode === "queue"
      ? (["completed"] as const)
      : (["completed", "failed", "newer-pause", "pending"] as const);
  for (const outcome of outcomes) {
    test(`${mode} ${outcome} receipt respects reading and submission intent`, async ({
      page,
    }) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const backend = await setup(page, undefined, {
        extraMethods: ["turn.queue", "turn.steer"],
        inboxTurn: async (command) => {
          await held;
          return {
            id: command.params.operation_id,
            session_id: "s1",
            method: command.method,
            status:
              outcome === "failed"
                ? "failed"
                : outcome === "pending"
                  ? "accepted"
                  : "completed",
            result: outcome === "failed" ? null : { admitted: true },
            error:
              outcome === "failed"
                ? { code: "rejected", message: "Admission rejected" }
                : null,
          };
        },
      });
      await connectHostUI(page);
      await readTool(page, row(page, 1));
      if (mode === "submit") {
        const idle = structuredClone(backend.snapshot());
        idle.session.status = "idle";
        idle.inbox = { items: [], active: false, paused: false };
        backend.publish(idle);
        await expect(page.getByTestId("queue-input")).toHaveCount(0);
      }
      const input = page.getByRole("textbox", { name: "消息", exact: true });
      await input.fill(`Reading ${mode} ${outcome}`);
      const host = page.locator("#conversation-transcript");
      // Focusing the sticky composer can reveal it; restore the reading position
      // before sending so only the accepted submission may resume following.
      await host.evaluate((node) => {
        node.scrollTop = 300;
      });
      await expect.poll(() => gap(page)).toBeGreaterThan(200);
      await expect(host).toHaveAttribute("data-following", "false");
      const button =
        mode === "submit"
          ? page.getByRole("button", { name: "发送 (Enter)", exact: true })
          : page.getByTestId(`${mode}-input`);
      await button.click();
      const method = mode === "steer" ? "turn.steer" : "turn.queue";
      await expect
        .poll(
          () =>
            backend.commands.filter((command) => command.method === method)
              .length,
        )
        .toBe(1);
      const command = backend.commands.find(
        (command) => command.method === method,
      )!;
      expect(command.params.activate_if_idle).toBe(
        mode === "submit" ? true : undefined,
      );
      // The request is in flight: clicking send alone must not move reading.
      await expect(host).toHaveAttribute("data-following", "false");
      await expect.poll(() => gap(page)).toBeGreaterThan(200);
      if (outcome === "newer-pause") {
        const box = (await host.boundingBox())!;
        await page.mouse.move(box.x + 5, box.y + box.height / 2);
        await page.mouse.wheel(0, -100);
        await expect
          .poll(() => host.evaluate((node) => node.scrollTop))
          .toBeLessThan(300);
      }
      release();
      if (outcome === "completed" || outcome === "newer-pause")
        await expect(input).toHaveValue("");
      else if (outcome === "failed") {
        await expect(input).toHaveValue(`Reading ${mode} ${outcome}`);
        await expect(button).toBeEnabled();
      } else if (mode === "submit") {
        await expect(
          page.getByText(
            "发送接纳结果未知，草稿已保留；正在核对操作回执，请勿重复发送。",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(input).toHaveValue(`Reading ${mode} ${outcome}`);
      } else {
        // Barrier after processing the nonterminal receipt, with the same
        // operation still pending; it must not be treated as accepted success.
        backend.event("tool", {
          operation_id: "reading-pending-op",
          ...position(9),
          call_id: "reading-pending-call",
          name: "pending_receipt_barrier",
          phase: "completed",
          arguments: {},
          result: "Still reading",
        });
        await expect(page.getByTestId("tool-row")).toHaveCount(3);
        await expect(input).toHaveValue(`Reading ${mode} ${outcome}`);
      }
      const resumes = outcome === "completed" && mode !== "queue";
      await expect(host).toHaveAttribute("data-following", String(resumes));
      if (resumes) await expect.poll(() => gap(page)).toBeLessThanOrEqual(1);
      else await expect.poll(() => gap(page)).toBeGreaterThan(200);
      await expect(row(page, 1)).toHaveAttribute("aria-expanded", "true");
    });
  }
}
test("clicking the thought header pauses following before expansion and incoming events", async ({
  page,
}) => {
  const backend = await setup(page);
  const observation = {
    operation_id: "reading-op",
    call_id: "thought-request",
    ...position(9),
  };
  backend.event("model_observation", { ...observation, phase: "started" });
  backend.event("model_observation", {
    ...observation,
    phase: "reasoning_delta",
    text: output("Thought", 80).replaceAll("\n", "\n\n"),
  });
  backend.event("model_observation", {
    ...observation,
    phase: "validated",
    text: "",
  });
  const thought = page.getByTestId("think-block");
  await expect(thought).toHaveCount(1);
  // Collapse the streamed thought, then explicitly resume bottom following so
  // opening the label tests disclosure intent rather than prior scroll-up.
  if ((await thought.getAttribute("data-expanded")) === "true")
    await thought.locator(".think-title").click();
  const host = page.locator("#conversation-transcript");
  await host.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const hostBox = (await host.boundingBox())!;
  await page.mouse.move(
    hostBox.x + hostBox.width / 2,
    hostBox.y + hostBox.height / 2,
  );
  await page.mouse.wheel(0, 160);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1);
  const before = await thought.evaluate(
    (node) => node.getBoundingClientRect().top,
  );
  await thought.locator(".think-title").click();
  await expect(thought).toHaveAttribute("data-expanded", "true");
  await expect
    .poll(() =>
      thought.evaluate(
        (node, y) => Math.abs(node.getBoundingClientRect().top - y),
        before,
      ),
    )
    .toBeLessThanOrEqual(1);
  backend.event("tool", {
    operation_id: "reading-op",
    ...position(10),
    call_id: "reading-call-10",
    name: "reading_tool_10",
    phase: "completed",
    arguments: {},
    result: "next result",
  });
  await expect(page.getByTestId("tool-row")).toHaveCount(3);
  await expect
    .poll(() =>
      thought.evaluate(
        (node, y) => Math.abs(node.getBoundingClientRect().top - y),
        before,
      ),
    )
    .toBeLessThanOrEqual(1);
});

test("an invalid slash command does not resume following while reading", async ({
  page,
}) => {
  const backend = await setup(page);
  await connectHostUI(page);
  await readTool(page, row(page, 1));
  const idle = structuredClone(backend.snapshot());
  idle.session.status = "idle";
  idle.inbox = { items: [], active: false, paused: false };
  backend.publish(idle);
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await expect(input).toBeEnabled();
  await input.fill("/unknown-command details");
  await page.locator("#conversation-transcript").evaluate(async (host) => {
    const scrolled = new Promise<void>((resolve) =>
      host.addEventListener("scroll", () => resolve(), { once: true }),
    );
    host.scrollTop = 300;
    await scrolled;
  });
  const before = await page
    .locator("#conversation-transcript")
    .evaluate((host) => host.scrollTop);
  await input.press("Enter");
  await expect(
    page
      .getByText(/unknown-command/)
      .filter({ hasText: /未知|Unknown/ })
      .first(),
  ).toBeAttached();
  await expect
    .poll(() =>
      page
        .locator("#conversation-transcript")
        .evaluate((host, top) => Math.abs(host.scrollTop - top), before),
    )
    .toBeLessThanOrEqual(1);
  expect(
    backend.commands.some(
      (command) =>
        command.method === "turn.queue" || command.method === "turn.submit",
    ),
  ).toBe(false);
});

test("conversation snapshot preserves viewport movement before its native scroll callback", async ({
  page,
}) => {
  const backend = await setup(page);
  await readTool(page, row(page, 1));
  const host = page.locator("#conversation-transcript");
  const before = await host.evaluate((node) => {
    const defer = (event: Event) => {
      if (event.target === node) event.stopImmediatePropagation();
    };
    window.addEventListener("scroll", defer, true);
    (window as any).__releasePendingScroll = () =>
      window.removeEventListener("scroll", defer, true);
    node.scrollTop += 170;
    return node.scrollTop;
  });
  try {
    const refreshed = structuredClone(backend.snapshot());
    refreshed.session.title = "Pending conversation scroll";
    backend.publish(refreshed);
    await expect(
      page.getByText("Pending conversation scroll", { exact: true }).first(),
    ).toBeAttached();
    await expect
      .poll(() => host.evaluate((node) => node.scrollTop))
      .toBe(before);
    await expect(row(page, 1)).toHaveAttribute("aria-expanded", "true");
  } finally {
    await page.evaluate(() => (window as any).__releasePendingScroll());
  }
});

test("selection at the bottom pauses passive output growth until deliberate down navigation", async ({
  page,
}) => {
  const backend = await setup(page);
  const host = page.locator("#conversation-transcript");
  await host.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    const text = [...node.querySelectorAll(".transcript-inner p")].at(
      -1,
    )?.firstChild;
    if (!text) throw Error("missing selectable conversation text");
    const range = document.createRange();
    range.selectNodeContents(text);
    const selected = window.getSelection()!;
    selected.removeAllRanges();
    selected.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const before = await host.evaluate((node) => node.scrollTop);
  backend.event("tool", {
    operation_id: "selection-op",
    ...position(9),
    call_id: "selection-call",
    name: "selection_tool",
    phase: "completed",
    arguments: {},
    result: output("Selection tail", 100),
  });
  await expect(page.getByTestId("tool-row")).toHaveCount(3);
  await expect
    .poll(() =>
      host.evaluate((node, top) => Math.abs(node.scrollTop - top), before),
    )
    .toBeLessThanOrEqual(1);
  await host.evaluate((node) => {
    window.getSelection()?.removeAllRanges();
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }));
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1);
  backend.event("tool", {
    operation_id: "selection-op",
    ...position(10),
    call_id: "selection-next",
    name: "selection_next_tool",
    phase: "completed",
    arguments: {},
    result: output("Following tail", 100),
  });
  await expect(page.getByTestId("tool-row")).toHaveCount(4);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1);
});
