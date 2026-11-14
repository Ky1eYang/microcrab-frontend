import { expect, test } from "@playwright/test";
import { createBlock } from "../src/client/create-block";
import { applySnapshot } from "../src/client/projector";
import { retainLoadedMessages } from "../src/client/loaded-messages";
import {
  createConversationRegistry,
  type ConversationScheduler,
} from "../src/client/conversation/registry";
import { publishTranscript } from "../src/client/conversation/assembler";
import { nativeSnapshot } from "./native-fixture";

function harness() {
  const microtasks: (() => void)[] = [];
  const frames: (() => void)[] = [];
  const scheduler: ConversationScheduler = {
    microtask: (task) => microtasks.push(task),
    animationFrame: (task) => frames.push(task),
  };
  const registry = createConversationRegistry({ scheduler });
  const flush = (queue: (() => void)[]) => {
    while (queue.length) queue.shift()!();
  };
  return { registry, microtasks, frames, flush };
}

test("first visible evidence allocates a slot; subsequent deltas publish only their node once per frame", () => {
  const { registry, microtasks, frames, flush } = harness();
  const transcript = applySnapshot(structuredClone(nativeSnapshot));
  const pending = createBlock("s1", "request", "text");
  pending.temporary = true;
  pending.stream = "streaming";
  transcript.blocks.push(pending);
  publishTranscript(registry, transcript);
  flush(microtasks);
  expect(registry.order).not.toContain(pending.id);
  const sibling = registry.blocks()[0];
  const siblingVersion = registry.version(sibling.id);
  let structures = 0,
    changed = 0,
    unchanged = 0;
  registry.subscribeStructure(() => structures++);
  registry.subscribe(pending.id, () => changed++);
  registry.subscribe(sibling.id, () => unchanged++);
  pending.payload.text = "first";
  expect(publishTranscript(registry, transcript)).toBe("structure");
  flush(microtasks);
  expect(registry.order.at(-1)).toBe(pending.id);
  expect(structures).toBe(1);
  const order = registry.order;
  const blocks = registry.blocks();
  const live = registry.getBlock(pending.id);
  const version = registry.version(pending.id);
  pending.payload.text += " second";
  expect(publishTranscript(registry, transcript)).toBe("content");
  pending.payload.text += " third";
  expect(publishTranscript(registry, transcript)).toBe("content");
  expect(registry.getBlock(pending.id)).toBe(live);
  expect(registry.getBlock(sibling.id)).toBe(sibling);
  expect(registry.version(pending.id)).toBeGreaterThan(version);
  expect(registry.version(sibling.id)).toBe(siblingVersion);
  expect(registry.order).toBe(order);
  expect(registry.blocks()).toBe(blocks);
  expect(frames).toHaveLength(1);
  expect(changed).toBe(1);
  flush(frames);
  expect(changed).toBe(2);
  expect(unchanged).toBe(0);
  expect(structures).toBe(1);
  expect(live?.payload.text).toBe("first second third");
});

test("covered snapshot content updates only its registry node without mutating the prior transcript", () => {
  const { registry, microtasks, frames, flush } = harness();
  const snapshot = structuredClone(nativeSnapshot);
  const prior = applySnapshot(snapshot);
  publishTranscript(registry, prior);
  flush(microtasks);
  const id = prior.blocks.at(-1)!.id;
  const node = registry.getBlock(id);
  const sibling = registry.blocks()[0];
  const order = registry.order;
  const version = registry.version(id);
  const untouched = JSON.stringify(prior);
  const updated = structuredClone(snapshot);
  updated.messages[1].text = "Authoritative updated answer";
  const result = applySnapshot(updated, prior);
  publishTranscript(registry, result);
  expect(JSON.stringify(prior)).toBe(untouched);
  expect(result.blocks.at(-1)?.payload.text).toBe(
    "Authoritative updated answer",
  );
  expect(registry.getBlock(id)).toBe(node);
  expect(node?.payload.text).toBe("Authoritative updated answer");
  expect(registry.getBlock(sibling.id)).toBe(sibling);
  expect(registry.order).toBe(order);
  expect(registry.version(id)).toBeGreaterThan(version);
  const currentVersion = registry.version(id);
  publishTranscript(registry, structuredClone(result));
  expect(registry.version(id)).toBe(currentVersion);
  expect(frames).toHaveLength(1);
  flush(frames);
});

test("bounded snapshot authority preserves canonical blocks outside its covered range", () => {
  const { registry, microtasks, flush } = harness();
  const full = structuredClone(nativeSnapshot);
  full.history_view = {
    lineage: "selected",
    epoch: 0,
    start_cursor: 0,
    end_cursor: 2,
    message_count: 2,
    turns: [],
  };
  let transcript = applySnapshot(full);
  publishTranscript(registry, transcript);
  flush(microtasks);
  const before = [...registry.blocks()];
  const head = structuredClone(full);
  head.messages = head.messages.slice(0, 1);
  head.history_view!.end_cursor = 1;
  head.messages_truncated = true;
  const retained = retainLoadedMessages(head, full);
  transcript = applySnapshot(retained, transcript);
  publishTranscript(registry, transcript);
  expect(registry.blocks()).toHaveLength(2);
  registry
    .blocks()
    .forEach((block, index) => expect(block).toBe(before[index]));
  expect(registry.blocks()[1].payload.text).toBe("历史回答");
});

test("lineage replacement fences old nodes and dispose cancels queued publications", () => {
  const { registry, microtasks, frames, flush } = harness();
  const transcript = applySnapshot(structuredClone(nativeSnapshot));
  transcript.historyView = {
    lineage: "old",
    epoch: 0,
    message_count: 2,
    start_cursor: 0,
    end_cursor: 2,
    turns: [],
  };
  publishTranscript(registry, transcript);
  flush(microtasks);
  const old = registry.blocks()[0];
  const version = registry.version(old.id);
  let called = 0;
  registry.subscribe(old.id, () => called++);
  const replacement = structuredClone(transcript);
  replacement.historyView!.lineage = "new";
  publishTranscript(registry, replacement);
  expect(registry.getBlock(old.id)).not.toBe(old);
  expect(registry.version(old.id)).toBeGreaterThan(version);
  registry.dispose();
  flush(microtasks);
  flush(frames);
  expect(called).toBe(0);
});
