import { expect, test, type Locator, type Page } from "@playwright/test";
import type { NativeMessage } from "../src/client/types";
import { nativeBackend } from "./native-fixture";

const position = (round: number) => ({ epoch: 0, turn: 1, round });
const text = (label: string, lines = 70) =>
  Array.from(
    { length: lines },
    (_, index) => `${label} retained line ${index}`,
  ).join("\n");
const message = (id: string, value: string, round: number): NativeMessage => ({
  id,
  role: "assistant",
  text: value,
  parts: [],
  tool_calls: [],
  position: position(round),
});
const canonicalTool = (
  round: number,
  call = `interaction-call-${round}`,
): NativeMessage[] => [
  {
    ...message(`interaction-assistant-${round}`, "", round),
    tool_calls: [
      {
        id: call,
        name: `interaction_tool_${round}`,
        arguments: { path: `file-${round}` },
      },
    ],
  },
  {
    ...message(`interaction-result-${round}`, text(`Result ${round}`), round),
    role: "tool",
    call_id: call,
    tool_name: `interaction_tool_${round}`,
  },
];
async function setup(page: Page, content: NativeMessage[]) {
  await page.setViewportSize({ width: 1440, height: 700 });
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  snapshot.session.status = "running";
  snapshot.inbox = { items: [], active: true, paused: false };
  snapshot.messages = [
    {
      ...message("interaction-user", "Keep reading the selected invocation", 0),
      role: "user",
    },
    ...content,
    message(
      "interaction-tail",
      text("Later content", 95).replaceAll("\n", "\n\n"),
      9,
    ),
  ];
  snapshot.messages.at(-1)!.position = {
    epoch: 0,
    turn: content.at(-1)?.position?.turn ?? 1,
    round: 9,
  };
  snapshot.messages_truncated = false;
  snapshot.next_cursor = null;
  snapshot.history_view = {
    lineage: "interaction-lineage",
    epoch: 0,
    start_cursor: 0,
    end_cursor: snapshot.messages.length,
    message_count: snapshot.messages.length,
    turns: [
      {
        epoch: 0,
        turn: 1,
        tool_calls: content.filter((row) => row.role === "tool").length,
        ordinary_tool_calls: content.filter((row) => row.role === "tool")
          .length,
        delegate_calls: 0,
      },
    ],
  };
  await page.goto("/#session/s1");
  await expect(
    page.getByText("Keep reading the selected invocation", { exact: true }),
  ).toBeAttached();
  return backend;
}
const tool = (page: Page, round: number) =>
  page.getByTestId("tool-row").filter({ hasText: `interaction_tool_${round}` });
async function rememberInteraction(page: Page, chosen: Locator) {
  await chosen.click();
  await rememberAlreadyOpenReading(chosen);
}
async function rememberAlreadyOpenReading(chosen: Locator) {
  const output = chosen.locator("..").getByTestId("tool-payload-output");
  await output.locator("pre").focus();
  await output.locator("pre").evaluate((body) => {
    body.scrollTop = 140;
  });
  await expect
    .poll(() => output.locator("pre").evaluate((body) => body.scrollTop))
    .toBe(140);
  await chosen.evaluate((node) => {
    const root = node.parentElement!;
    const payload = root.querySelector('[data-testid="tool-payload-output"]')!;
    const body = payload.querySelector("pre")!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    const textNode = document
      .createTreeWalker(body, NodeFilter.SHOW_TEXT)
      .nextNode()!;
    range.setStart(textNode, 8);
    range.setEnd(textNode, 38);
    selection.removeAllRanges();
    selection.addRange(range);
    const host = node.closest<HTMLElement>(".transcript")!;
    host.scrollTop +=
      node.getBoundingClientRect().top - host.getBoundingClientRect().top + 100;
    (window as any).__liveInteraction = {
      row: node,
      body,
      scrollTop: body.scrollTop,
      focus: document.activeElement,
      selection: selection.toString(),
      top: node.getBoundingClientRect().top,
    };
  });
  await expect(chosen).toHaveAttribute("aria-expanded", "true");
  await expect(output).toHaveAttribute("data-collapsed", "false");
}
async function expectRetained(chosen: Locator) {
  await expect(chosen).toHaveAttribute("aria-expanded", "true");
  await expect(
    chosen.locator("..").getByTestId("tool-payload-output"),
  ).toHaveAttribute("data-collapsed", "false");
  expect(
    await chosen.evaluate((node) => {
      const prior = (window as any).__liveInteraction;
      const body = node.parentElement!.querySelector(
        '[data-testid="tool-payload-output"] pre',
      );
      return {
        row: node === prior.row,
        body: body === prior.body,
        scroll: body?.scrollTop === prior.scrollTop,
        focus: document.activeElement === prior.focus,
        selection: document.getSelection()?.toString() === prior.selection,
      };
    }),
  ).toEqual({
    row: true,
    body: true,
    scroll: true,
    focus: true,
    selection: true,
  });
  await expect
    .poll(() =>
      chosen.evaluate((node) =>
        Math.abs(
          node.getBoundingClientRect().top -
            (window as any).__liveInteraction.top,
        ),
      ),
    )
    .toBeLessThanOrEqual(1);
}

test("live tool handoff retains the exact detail DOM, keyboard focus and selection when canonical row ids arrive", async ({
  page,
}) => {
  const backend = await setup(page, canonicalTool(1));
  backend.event("tool", {
    operation_id: "interaction-operation",
    ...position(2),
    call_id: "interaction-call-2",
    name: "interaction_tool_2",
    phase: "running",
    arguments: { path: "file-2" },
    result: text("Result 2"),
  });
  const chosen = tool(page, 2);
  await expect(chosen).toHaveCount(1);
  await rememberInteraction(page, chosen);
  backend.event("tool", {
    operation_id: "interaction-operation",
    ...position(2),
    call_id: "interaction-call-2",
    name: "interaction_tool_2",
    phase: "completed",
    arguments: { path: "file-2" },
    result: text("Result 2"),
  });
  await expect(chosen).toHaveAttribute("data-status", "succeeded");
  await expect(chosen).toHaveAttribute("data-raw-status", "completed");
  await expectRetained(chosen);
  const canonical = structuredClone(backend.snapshot());
  canonical.messages.splice(
    canonical.messages.length - 1,
    0,
    ...canonicalTool(2),
  );
  canonical.history_view = {
    ...canonical.history_view!,
    end_cursor: canonical.messages.length,
    message_count: canonical.messages.length,
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
  canonical.session.title = "Canonical interaction handoff";
  backend.publish(canonical);
  await expect(
    page.getByText("Canonical interaction handoff", { exact: true }).first(),
  ).toBeAttached();
  await expectRetained(chosen);
});

test("a provisional tool keeps its disclosure and focus when its real call id arrives", async ({
  page,
}) => {
  const backend = await setup(page, canonicalTool(1));
  const delta = {
    operation_id: "slot-operation",
    call_id: "slot-provider",
    ...position(2),
    phase: "tool_call_delta",
    index: 0,
    name: "interaction_tool_2",
  };
  backend.event("model_observation", {
    ...delta,
    arguments: '{"path":"provisional"}',
  });
  const chosen = tool(page, 2);
  await chosen.click();
  await expect(chosen).toHaveAttribute("aria-expanded", "true");
  const payload = chosen
    .locator("..")
    .getByTestId("tool-payload-input")
    .locator("pre");
  await payload.focus();
  await payload.evaluate((node) => {
    (window as any).__provisionalData = node;
  });
  backend.event("model_observation", { ...delta, id: "slot-tool" });
  backend.event("tool", {
    ...position(2),
    operation_id: "slot-operation",
    call_id: "slot-tool",
    name: "interaction_tool_2",
    phase: "failed",
    execution_id: 88,
  });
  await expect(chosen).toHaveAttribute("data-status", "failed");
  await expect(chosen).toHaveAttribute("aria-expanded", "true");
  await expect(payload).toBeFocused();
  expect(
    await payload.evaluate(
      (node) => node === (window as any).__provisionalData,
    ),
  ).toBe(true);
});

test("the actively read later tool keeps its native detail subtree through group merge and split", async ({
  page,
}) => {
  const backend = await setup(page, [
    ...canonicalTool(1),
    message(
      "interaction-boundary",
      "A visible boundary between tool groups",
      2,
    ),
    ...canonicalTool(3),
  ]);
  const headers = page.locator(".tool-accordion-group-header");
  await expect(headers).toHaveCount(2);
  const chosen = tool(page, 3);
  await rememberInteraction(page, chosen);
  const merged = structuredClone(backend.snapshot());
  merged.messages.find((row) => row.id === "interaction-boundary")!.text = "";
  backend.publish(merged);
  await expect(headers).toHaveCount(1);
  await expectRetained(chosen);
  backend.publish(structuredClone(backend.snapshot()));
  await expect(headers).toHaveCount(2);
  await expectRetained(chosen);
  // Explicit user collapse remains authoritative after passive refresh.
  await chosen.click();
  await expect(chosen).toHaveAttribute("aria-expanded", "false");
  const refreshed = structuredClone(backend.snapshot());
  refreshed.session.title = "After explicit close";
  backend.publish(refreshed);
  await expect(
    page.getByText("After explicit close", { exact: true }).first(),
  ).toBeAttached();
  await expect(chosen).toHaveAttribute("aria-expanded", "false");
});

test("native focus back into an already open detail outranks an older toggle when groups merge", async ({
  page,
}) => {
  const backend = await setup(page, [
    ...canonicalTool(1),
    message(
      "interaction-boundary",
      "A visible boundary between tool groups",
      2,
    ),
    ...canonicalTool(3),
  ]);
  const later = tool(page, 3),
    earlier = tool(page, 1);
  await rememberInteraction(page, later);
  await rememberInteraction(page, earlier);
  // No disclosure click: return by keyboard focus and select B's existing output.
  await rememberAlreadyOpenReading(later);
  await expect(earlier).toHaveAttribute("aria-expanded", "true");
  const merged = structuredClone(backend.snapshot());
  merged.messages.find((row) => row.id === "interaction-boundary")!.text = "";
  backend.publish(merged);
  await expect(page.locator(".tool-accordion-group-header")).toHaveCount(1);
  await expectRetained(later);
  await expect(earlier).toHaveAttribute("aria-expanded", "false");
  await later.click();
  const refreshed = structuredClone(merged);
  refreshed.session.title = "Explicit close after native reading";
  backend.publish(refreshed);
  await expect(
    page
      .getByText("Explicit close after native reading", { exact: true })
      .first(),
  ).toBeAttached();
  await expect(later).toHaveAttribute("aria-expanded", "false");
});

test("hydrating a user anchor between assistant chunks retains the later exact tool detail", async ({
  page,
}) => {
  const laterTools = canonicalTool(3).map((row) => ({
    ...row,
    position: { epoch: 0, turn: 2, round: 1 },
  }));
  const backend = await setup(page, [
    ...canonicalTool(1),
    {
      ...message("interaction-second-user", "", 0),
      role: "user",
      position: { epoch: 0, turn: 2, round: 0 },
    },
    ...laterTools,
  ]);
  const chosen = tool(page, 3);
  await rememberInteraction(page, chosen);
  const hydrated = structuredClone(backend.snapshot());
  hydrated.messages.find((row) => row.id === "interaction-second-user")!.text =
    "Hydrated second user anchor";
  backend.publish(hydrated);
  await expect(
    page.getByText("Hydrated second user anchor", { exact: true }),
  ).toBeAttached();
  await expectRetained(chosen);
  backend.publish(structuredClone(backend.snapshot()));
  await expect(
    page.getByText("Hydrated second user anchor", { exact: true }),
  ).not.toBeAttached();
  await expectRetained(chosen);
});

test("an unrelated tool event retains focused and selected unchanged Markdown code", async ({
  page,
}) => {
  const backend = await setup(page, [
    ...canonicalTool(1),
    message(
      "interaction-code",
      "```typescript\nconst retained = 'read this exact code';\nconsole.log(retained);\n```",
      2,
    ),
  ]);
  const code = page.getByTestId("code-block").locator("pre");
  await expect(code).toHaveCount(1);
  await code.focus();
  await code.evaluate((node) => {
    const text = node.querySelector("code")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 27);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    (window as any).__liveCode = { node, selection: selection.toString() };
  });
  backend.event("tool", {
    operation_id: "interaction-code-update",
    ...position(3),
    call_id: "interaction-call-3",
    name: "interaction_tool_3",
    phase: "completed",
    arguments: {},
    result: "Unrelated tool update",
  });
  await expect(tool(page, 3)).toHaveCount(1);
  expect(
    await code.evaluate((node) => ({
      node: node === (window as any).__liveCode.node,
      focus: document.activeElement === node,
      selection:
        document.getSelection()?.toString() ===
        (window as any).__liveCode.selection,
    })),
  ).toEqual({ node: true, focus: true, selection: true });
});

test("a different selected lineage revokes retained detail and local reading for the same call id", async ({
  page,
}) => {
  const backend = await setup(page, canonicalTool(1));
  const chosen = tool(page, 1);
  await rememberInteraction(page, chosen);
  const replacement = structuredClone(backend.snapshot());
  replacement.history_view!.lineage = "replacement-interaction-lineage";
  replacement.messages = replacement.messages.map((message) => ({
    ...message,
    id: `different-branch:${message.id}`,
  }));
  backend.publish(replacement);
  await expect(chosen).toHaveAttribute("aria-expanded", "false");
  await chosen.click();
  const replacementOutput = chosen
    .locator("..")
    .getByTestId("tool-payload-output");
  await expect(replacementOutput).toHaveAttribute("data-variant", "trajectory");
  await expect
    .poll(() =>
      replacementOutput.locator("pre").evaluate((body) => body.scrollTop),
    )
    .toBe(0);
});
