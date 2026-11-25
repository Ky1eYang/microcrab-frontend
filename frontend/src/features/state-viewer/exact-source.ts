import { decodeJsonString, scanJson } from "../content-inspection/json-lexemes";

/** The native field index uses parsed JSON/JSON-pointer semantics (last member
 * wins). A shared inspector opened on this value still shows every occurrence
 * *within* the selected raw range, with its own occurrence-aware controls. */
export async function selectedStateSource(
  root: string,
  path: readonly string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  signal.throwIfAborted();
  if (!path.length) return root;
  const stack: {
    array: boolean;
    index: number;
    key?: string;
    matches: boolean;
  }[] = [];
  let selectedStart = -1;
  let selectedEnd = -1;
  let count = 0;
  let deadline = performance.now() + 8;
  for (const { kind, start, end } of scanJson(root)) {
    if (
      (kind === "checkpoint" || (++count & 1023) === 0) &&
      performance.now() >= deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      deadline = performance.now() + 8;
    }
    if (kind === "checkpoint") continue;
    const depth = stack.length;
    const parent = stack.at(-1);
    if (kind === "key") {
      if (parent?.matches && depth <= path.length)
        parent.key = decodeJsonString(root, start, end);
      continue;
    }
    if (kind === "endArray" || kind === "endObject") {
      const value = stack.pop();
      if (value?.matches && depth - 1 === path.length) selectedEnd = end;
      continue;
    }
    let matches = !parent;
    if (parent?.matches && depth <= path.length) {
      const key = parent.array ? String(parent.index++) : parent.key;
      matches = key === path[depth - 1];
      // A later duplicate ancestor can replace a subtree with no such leaf.
      if (matches) {
        selectedStart = depth === path.length ? start : -1;
        selectedEnd = -1;
      }
    }
    if (kind === "array" || kind === "object")
      stack.push({ matches, array: kind === "array", index: 0 });
    else if (matches && depth === path.length) selectedEnd = end;
  }
  signal.throwIfAborted();
  return selectedStart >= 0 && selectedEnd >= 0
    ? root.slice(selectedStart, selectedEnd)
    : undefined;
}
