import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createBlock } from "../src/client/create-block";
import { AppProvider } from "../src/state/context";
import { SubAgentCard } from "../src/features/views";
import { setActiveLocale } from "../src/i18n";

/** Open child presentation statuses are render inputs, not NativeExecution.status.
 * The latter is a closed runtime vocabulary validated on the wire. */
export async function renderChildStatus(
  root: HTMLElement,
  status: string,
  locale: "zh-CN" | "en",
) {
  await import("../src/styles/tokens.css");
  await import("../src/styles/chrome.css");
  await import("../src/styles/components.css");
  await import("../src/styles/interaction-polish.css");
  setActiveLocale(locale);
  const block = createBlock(
    "s1",
    "child-status",
    "child-status",
    "child",
    "assistant",
  );
  block.stream = "complete";
  block.payload.text = "worker";
  block.payload.structured = {
    child_id: "0123456789abcdef",
    subagent: "worker",
    status,
  };
  block.tool = {
    name: "delegate",
    input: { subagent: "worker", prompt: "Inspect" },
  } as typeof block.tool;
  root.style.padding = "var(--sp-4)";
  createRoot(root).render(
    createElement(
      AppProvider,
      null,
      createElement(SubAgentCard, { block, readOnly: true }),
    ),
  );
  document.documentElement.dataset.fixture = "ready";
}
