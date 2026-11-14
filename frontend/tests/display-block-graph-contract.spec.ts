import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { applyDisplayBatch } from "../src/client/display-replay";
import { applySnapshot } from "../src/client/projector";
import { applyDisplayGraphEnvelope } from "../src/client/display-graph";
import type {
  NativeDisplayBatch,
  NativeDisplayPage,
  NativeDisplayRecord,
} from "../src/client/types";
import {
  emit,
  graphRows,
  graphTranscript,
  message,
  snapshot,
} from "./display-graph-inputs";

test("unknown historical selection preserves current canonical rows and exact retained redo bytes", () => {
  const live = graphTranscript();
  for (const frame of fixture.frames) emit(live, structuredClone(frame));
  const frozen = structuredClone(live.displayGraph!.nodes);
  const revision = fixture.settled.high_water + 1;
  expect(applyDisplayGraphEnvelope(live, "s1", {
    selected_head: null, selection_known: false, revision, nodes: [], complete: false,
  })).toBe(true);
  expect(graphRows(live)).toEqual([]);
  expect(live.displayGraph!.incomplete).toBe(true);
  const canonical = message("historical", "assistant", "readable historical response");
  const projected = applySnapshot(snapshot([canonical]), live);
  expect(projected.blocks.some((block) => block.payload.text === canonical.text)).toBe(true);
  expect(graphRows(projected)).toEqual([]);
  expect(live.displayGraph!.nodes).toEqual(frozen);
  expect(applyDisplayGraphEnvelope(projected, "s1", {
    ...structuredClone(fixture.page.graph!), selection_known: true, revision: revision + 1,
  })).toBe(true);
  expect(graphRows(projected).map((block) => block.id)).toEqual(
    fixture.page.graph!.nodes.map((node) => node.block_id),
  );
  expect(live.displayGraph!.nodes).toEqual(frozen);
});

// Written by the native recorder/server graph test. Never synthesize block IDs,
// source bindings, hashes, offsets or graph ancestry at this boundary.
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/display-block-graph.json", import.meta.url),
    "utf8",
  ),
) as {
  frames: NativeDisplayRecord[];
  page: NativeDisplayPage;
  settled: NativeDisplayPage;
};
function batch(page: NativeDisplayPage, after = 0): NativeDisplayBatch {
  return {
    ...page,
    history_lineage: "selected",
    after,
    scanned_through: page.high_water,
  };
}
function displayed(transcript: ReturnType<typeof graphTranscript>) {
  return graphRows(transcript).map((block) => ({
    id: block.id,
    kind: block.kind,
    text: block.payload.text,
    input: block.tool?.input,
  }));
}

test("actual native recorder metadata gives live and attach the identical selected graph", () => {
  let live = graphTranscript();
  for (const frame of fixture.frames) emit(live, structuredClone(frame));
  const idle = snapshot();
  idle.session.status = "idle";
  live = applySnapshot(idle, live);
  const attached = applySnapshot(idle);
  expect(
    applyDisplayBatch(attached, "s1", structuredClone(batch(fixture.page))),
  ).toBe(true);
  const selectedIds = fixture.page.graph!.nodes.map((node) => node.block_id);
  expect(graphRows(live).map((block) => block.id)).toEqual(selectedIds);
  expect(graphRows(attached).map((block) => block.id)).toEqual(selectedIds);
  expect(displayed(attached)).toEqual(displayed(live));
  expect(
    graphRows(attached).find((block) => block.kind === "tool")?.tool.input,
  ).toEqual({ path: "README.md" });
  expect(
    graphRows(attached)
      .filter((block) => block.kind === "reasoning")
      .map((block) => block.payload.text),
  ).toEqual(["first thought", "retry thought"]);
  expect(
    applyDisplayBatch(
      attached,
      "s1",
      structuredClone(batch(fixture.settled, fixture.page.high_water)),
    ),
  ).toBe(true);
  expect(graphRows(attached).map((block) => block.id)).toEqual(selectedIds);
});

test("actual retry selection excludes abandoned siblings while preserving immutable received bytes", () => {
  const live = graphTranscript();
  const selected = new Set(
    fixture.page.graph!.nodes.map((node) => node.block_id),
  );
  const abandoned = fixture.frames.find((frame) => {
    const node = frame.event.display_block as { block_id?: string } | undefined;
    return node?.block_id && !selected.has(node.block_id);
  })!;
  for (const frame of fixture.frames) emit(live, structuredClone(frame));
  const abandonedId = (abandoned.event.display_block as { block_id: string })
    .block_id;
  expect(live.displayGraph!.nodes[abandonedId].chunks[0]).toBe(
    abandoned.event.text,
  );
  expect(graphRows(live).some((block) => block.id === abandonedId)).toBe(false);
  const frozen = structuredClone(
    live.displayGraph!.nodes[abandonedId].identity,
  );
  applyDisplayBatch(live, "s1", structuredClone(batch(fixture.page)));
  expect(live.displayGraph!.nodes[abandonedId].identity).toEqual(frozen);
  expect(graphRows(live).some((block) => block.id === abandonedId)).toBe(false);
});

test("actual catchup may arrive out of order and repeat without changing selected identities or bodies", () => {
  const transcript = graphTranscript();
  const reversed = structuredClone(batch(fixture.page));
  reversed.records.reverse();
  expect(applyDisplayBatch(transcript, "s1", reversed)).toBe(true);
  const before = displayed(transcript);
  expect(
    applyDisplayBatch(transcript, "s1", structuredClone(batch(fixture.page))),
  ).toBe(true);
  expect(displayed(transcript)).toEqual(before);
  expect(graphRows(transcript).map((block) => block.id)).toEqual(
    fixture.page.graph!.nodes.map((node) => node.block_id),
  );
});
