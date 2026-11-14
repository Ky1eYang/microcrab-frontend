import type { Block } from "../types";
import { definitionFor } from "./definitions";

/** How one publication affected rendered state.
 * - `structure`: membership, order or a grouping/navigation/card-placement
 *   fact changed. List memos must recompute.
 * - `content`: only content of existing nodes changed. Only the
 *   affected block subscribers re-render.
 * - `none`: nothing observable changed. */
export type Publication = "none" | "content" | "structure";

/** Deferral points for notifications. Tests inject a manual scheduler. */
export interface ConversationScheduler {
  microtask(task: () => void): void;
  animationFrame(task: () => void): void;
}

/** One committed block as the assembler classified it. `structure` covers the
 * facts that grouping, card ordering and navigation read; `content` covers
 * everything the block renders. Mutable inputs are compared with the registry's
 * isolated prior copy; string stamps remain available for explicit callers. */
export interface RegistryEntry {
  block: Block;
  structure: string;
  content: string | Block;
  visible: boolean;
}

export interface ConversationRegistry {
  /** Increments once per structure publication. */
  readonly structureRevision: number;
  /** Block ids in projector order. Stable reference until the next structure
   * publication. */
  readonly order: readonly string[];
  /** The registry-owned node. Publication updates it in place from a structured
   * copy of projection facts; read it together with `version(id)` for change
   * evidence. No returned node is an object in the prior Transcript. */
  getBlock(id: string): Block | undefined;
  /** Monotonic across the registry lifetime (never reused, including after a
   * reset). Updated immediately at commit and stable until the next commit
   * that changes this id; 0 for an unknown id. Suitable as the
   * `useSyncExternalStore` snapshot for one block. */
  version(id: string): number;
  /** Ordered blocks. Stable reference until the next structure publication. */
  blocks(): readonly Block[];
  /** Notified once per microtask after any structure publication. */
  subscribeStructure(listener: () => void): () => void;
  /** Notified when this id's version changed: per microtask when the change
   * was structural, otherwise once per animation frame. */
  subscribe(id: string, listener: () => void): () => void;
  /** Assembler entry point. Not for UI code. `scope` changes force a reset. */
  commit(scope: string, entries: readonly RegistryEntry[]): Publication;
  /** Drops listeners and ignores already scheduled flushes. */
  dispose(): void;
}

const defaultScheduler: ConversationScheduler = {
  microtask: (task) => queueMicrotask(task),
  animationFrame: (task) =>
    typeof requestAnimationFrame === "function"
      ? void requestAnimationFrame(() => task())
      : queueMicrotask(task),
};

interface Slot {
  block: Block;
  structure: string;
  content: string | Block;
  version: number;
}

export function createConversationRegistry(
  options: { scheduler?: ConversationScheduler } = {},
): ConversationRegistry {
  const scheduler = options.scheduler ?? defaultScheduler;
  let slots = new Map<string, Slot>();
  let order: string[] = [];
  let list: Block[] = [];
  let scope: string | null = null;
  let structureRevision = 0;
  let versionClock = 0;
  let disposed = false;
  const structureListeners = new Set<() => void>();
  const blockListeners = new Map<string, Set<() => void>>();
  // Pending notification sets. A structural id is moved out of the frame set
  // so it is notified once, at the earlier microtask.
  let structurePending = false;
  const microtaskIds = new Set<string>();
  const frameIds = new Set<string>();
  let microtaskScheduled = false;
  let frameScheduled = false;

  const notifyIds = (ids: Set<string>) => {
    const batch = [...ids];
    ids.clear();
    const listeners = new Set<() => void>();
    for (const id of batch)
      for (const listener of blockListeners.get(id) ?? [])
        listeners.add(listener);
    for (const listener of listeners) listener();
  };
  const flushMicrotask = () => {
    microtaskScheduled = false;
    if (disposed) return;
    const structural = structurePending;
    structurePending = false;
    notifyIds(microtaskIds);
    if (structural) for (const listener of [...structureListeners]) listener();
  };
  const flushFrame = () => {
    frameScheduled = false;
    if (disposed) return;
    notifyIds(frameIds);
  };
  const scheduleMicrotask = () => {
    if (microtaskScheduled) return;
    microtaskScheduled = true;
    scheduler.microtask(flushMicrotask);
  };
  const scheduleFrame = () => {
    if (frameScheduled) return;
    frameScheduled = true;
    scheduler.animationFrame(flushFrame);
  };

  const registry: ConversationRegistry = {
    get structureRevision() {
      return structureRevision;
    },
    get order() {
      return order;
    },
    getBlock: (id) => slots.get(id)?.block,
    version: (id) => slots.get(id)?.version ?? 0,
    blocks: () => list,
    subscribeStructure(listener) {
      structureListeners.add(listener);
      return () => structureListeners.delete(listener);
    },
    subscribe(id, listener) {
      let set = blockListeners.get(id);
      if (!set) blockListeners.set(id, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size) blockListeners.delete(id);
      };
    },
    commit(nextScope, entries) {
      if (disposed) return "none";
      const reset = scope !== null && scope !== nextScope;
      scope = nextScope;
      const previous = reset ? new Map<string, Slot>() : slots;
      const next = new Map<string, Slot>();
      const nextOrder: string[] = [];
      let structural = reset;
      let content = false;
      const changed = new Map<string, boolean>();
      for (const entry of entries) {
        const id = entry.block.id;
        // Identity collisions are an actionable projector error, not permission
        // to silently discard already published content.
        if (next.has(id)) throw Error(`Duplicate conversation block id: ${id}`);
        if (entry.visible) nextOrder.push(id);
        const old = previous.get(id);
        const reshaped = !old || old.structure !== entry.structure;
        const rewritten =
          !old ||
          (typeof entry.content === "string"
            ? old.content !== entry.content
            : !samePublishedContent(old.block, entry.content));
        if (reshaped || rewritten) {
          const block =
            old?.block ?? definitionFor(entry.block).start(entry.block);
          if (old) definitionFor(entry.block).update(block, entry.block);
          // The registry owns a copy. A covered snapshot may update this node
          // in place without changing any object in the prior Transcript.
          const isStructural = old ? reshaped : entry.visible;
          next.set(id, { ...entry, block, version: ++versionClock });
          changed.set(id, isStructural);
          if (isStructural) structural = true;
          else content = true;
        } else next.set(id, old!);
      }
      for (const id of previous.keys())
        if (!next.has(id)) {
          structural = true;
          changed.set(id, true);
        }
      if (
        !structural &&
        (nextOrder.length !== order.length ||
          nextOrder.some((id, index) => id !== order[index]))
      )
        structural = true;
      if (reset)
        for (const id of slots.keys())
          if (!changed.has(id)) changed.set(id, true);
      slots = next;
      if (structural) {
        order = nextOrder;
        list = nextOrder.map((id) => next.get(id)!.block);
        structureRevision++;
        structurePending = true;
      }
      for (const [id, isStructural] of changed) {
        if (isStructural || structural) {
          frameIds.delete(id);
          microtaskIds.add(id);
        } else if (!microtaskIds.has(id)) frameIds.add(id);
      }
      if (structural || microtaskIds.size) scheduleMicrotask();
      if (frameIds.size) scheduleFrame();
      return structural ? "structure" : content ? "content" : "none";
    },
    dispose() {
      disposed = true;
      structureListeners.clear();
      blockListeners.clear();
      microtaskIds.clear();
      frameIds.clear();
      structurePending = false;
    },
  };
  return registry;
}

/** Only proven immutable trees can use reference comparison across commits.
 * Mutable wire/legacy metadata always compares with the isolated owned copy. */
const immutableTrees = new WeakSet<object>();
const immutableEquals = new WeakMap<object, WeakSet<object>>();
export const registryPublicationWork = { comparisons: 0, immutableHits: 0 };
function immutableTree(value: object, visiting = new Set<object>()): boolean {
  if (immutableTrees.has(value)) return true;
  if (
    !Object.isFrozen(value) ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
  )
    return false;
  if (visiting.has(value)) return false;
  visiting.add(value);
  const complete = Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return false;
    const nested: unknown = descriptor.value;
    return (
      !nested || typeof nested !== "object" || immutableTree(nested, visiting)
    );
  });
  visiting.delete(value);
  if (complete) immutableTrees.add(value);
  return complete;
}
/** Compare against the registry-owned copy, never against the previous mutable
 * input reference. No serialization or sorted-key allocation on publication. */
function samePublishedContent(before: unknown, after: unknown): boolean {
  registryPublicationWork.comparisons++;
  if (Object.is(before, after)) return true;
  if (
    !before ||
    !after ||
    typeof before !== "object" ||
    typeof after !== "object"
  )
    return false;
  const immutable = immutableTree(after) && immutableTree(before);
  if (immutable && immutableEquals.get(after)?.has(before)) {
    registryPublicationWork.immutableHits++;
    return true;
  }
  const remember = (equal: boolean): boolean => {
    if (equal && immutable) {
      let matches = immutableEquals.get(after);
      if (!matches) immutableEquals.set(after, (matches = new WeakSet()));
      matches.add(before);
    }
    return equal;
  };
  if (Array.isArray(before) || Array.isArray(after))
    return remember(
      Array.isArray(before) &&
        Array.isArray(after) &&
        before.length === after.length &&
        before.every((value, index) =>
          samePublishedContent(value, after[index]),
        ),
    );
  if (
    Object.getPrototypeOf(before) !== Object.prototype ||
    Object.getPrototypeOf(after) !== Object.prototype
  )
    return false;
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  return remember(
    keys.length ===
      Object.keys(right).filter((key) => right[key] !== undefined).length &&
      keys.every(
        (key) =>
          Object.hasOwn(right, key) &&
          samePublishedContent(left[key], right[key]),
      ),
  );
}
