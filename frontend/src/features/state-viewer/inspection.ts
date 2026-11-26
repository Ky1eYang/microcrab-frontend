import {
  admitsOrdinaryState,
  own,
  parseStateInspection,
  record,
  stateKeyPattern,
} from "../../client/state-inspection";
import type { NativeStateInspection } from "../../client/native-state-inspection";
import { stateReferenceProjection } from "./references";

// Mirror the Core tool placeholder limits. The response
// budget is enforced by ApiClient; these tighter limits bound native tree rendering.
const MAX_NODES = 1500;
const MAX_DEPTH = 32;
const MAX_POINTER_BYTES = 512;
const MAX_PREVIEW = 512;
const encoder = new TextEncoder();

type Visibility = "visible" | "invisible" | "secret";
type Persistence = "persisted" | "ephemeral";
type Role = "client" | "agent" | "runtime";
type ValueType = "object" | "array" | "string" | "number" | "boolean" | "null";

interface StateMetadata {
  visibility?: Visibility;
  persistence?: Persistence;
  owner?: Role;
  editors?: Role[];
}

interface StateDescriptor {
  kind?: "custom" | "framework" | "reference";
  editable?: boolean;
  owner_editable?: boolean;
  deletable?: boolean;
}

export interface StateNode {
  id: number;
  label: string;
  type?: ValueType;
  preview?: string;
  // The tree labels and search text are clipped independently. Keep the actual
  // member key and projected string for selected-container formatting only.
  key: string;
  projectedString?: string;
  rootKey?: string;
  path?: readonly string[];
  childrenLimited?: true;
  exact?: string;
  metadata: StateMetadata;
  descriptor: StateDescriptor;
  reference?: string;
  children: StateNode[];
}

interface CapacityCount {
  limit: number;
  used: number;
  remaining: number;
}

export interface ExecutionCapacity {
  buffers?: CapacityCount;
  pending?: CapacityCount;
}

export interface StateTree {
  roots: StateNode[];
  nodes: Map<number, StateNode>;
  limited: boolean;
  revision: string;
  runtime: string;
  exactRoots?: ReadonlyMap<string, string>;
  compactStrings: ReadonlyMap<
    string,
    ReadonlyMap<string, { exact: string; label: string }>
  >;
  executionCapacity: ExecutionCapacity;
}

function oneOf<T extends string>(
  value: unknown,
  possible: readonly T[],
): T | undefined {
  return possible.find((option) => value === option);
}

const bool = (value: unknown) =>
  typeof value === "boolean" ? value : undefined;
const roles = ["agent", "client", "runtime"] as const;

function preview(text: string, limit: number) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export function stateReference(
  key: string,
  visibility: Visibility,
  path: readonly string[] = [],
): string | undefined {
  if (!stateKeyPattern.test(key) || path.length > MAX_DEPTH) return undefined;
  if (visibility === "secret")
    return path.length ? undefined : `{{secret:${key}}}`;
  if (visibility !== "visible") return undefined;
  if (!path.length) return `{{var:${key}}}`;
  const pointer = path
    .map((part) => `/${part.replaceAll("~", "~0").replaceAll("/", "~1")}`)
    .join("");
  // The placeholder closes at the first '}}', even if one brace belongs to the pointer.
  if (
    pointer.includes("}}") ||
    pointer.includes("{{var:") ||
    pointer.includes("{{secret:") ||
    pointer.endsWith("}") ||
    /[\uD800-\uDFFF]/u.test(pointer) ||
    encoder.encode(pointer).byteLength > MAX_POINTER_BYTES
  )
    return undefined;
  return `{{var:${key}:${pointer}}}`;
}

/** Drop protected and unclassified custom values before React ever receives data. */
export function buildStateTree(inspection: unknown): StateTree {
  return projectStateTree(parseStateInspection(inspection));
}

export function buildNativeStateTree(
  inspection: NativeStateInspection,
): StateTree {
  return projectStateTree(inspection, inspection.exactRoots);
}

function projectStateTree(
  {
    ordinary: { values, metadata, descriptors, witness },
  }: ReturnType<typeof parseStateInspection>,
  exactRoots?: ReadonlyMap<string, string>,
): StateTree {
  const nodes = new Map<number, StateNode>();
  const roots: StateNode[] = [];
  let limited = false;
  const append = (
    label: string,
    data: StateMetadata,
    descriptor: StateDescriptor,
  ): StateNode => {
    const node: StateNode = {
      id: nodes.size,
      key: label,
      label: preview(label || '\"\"', 160),
      metadata: data,
      descriptor,
      children: [],
    };
    nodes.set(node.id, node);
    return node;
  };
  const addValue = (
    node: StateNode,
    value: unknown,
    exact: unknown,
    key: string,
    path: readonly string[],
    canReference: boolean,
  ) => {
    if (canReference) node.reference = stateReference(key, "visible", path);
    if (exactRoots?.has(key)) {
      node.rootKey = key;
      node.path = path;
    }
    const kind = typeof value;
    if (value === null) node.type = "null";
    else if (kind === "string" || kind === "number" || kind === "boolean")
      node.type = kind;
    else if (kind === "object")
      node.type = Array.isArray(value) ? "array" : "object";
    if (node.type === "string") {
      node.projectedString = value as string;
      node.preview = JSON.stringify(preview(node.projectedString, MAX_PREVIEW));
      if (typeof exact === "string" && exact !== value) node.exact = exact;
    } else if (node.type !== "object" && node.type !== "array") {
      if (node.type) node.preview = String(value);
      else node.reference = undefined;
    } else {
      const children = value as Record<string, unknown>;
      for (const part in children) {
        if (!Object.hasOwn(children, part)) continue;
        if (nodes.size >= MAX_NODES || path.length >= MAX_DEPTH) {
          limited = true;
          node.childrenLimited = true;
          break;
        }
        const child = append(part, node.metadata, node.descriptor);
        node.children.push(child);
        addValue(
          child,
          children[part],
          own(exact as Record<string, unknown>, part),
          key,
          [...path, part],
          canReference && part.length <= MAX_POINTER_BYTES,
        );
      }
    }
  };
  const rootsToRead: { key: string; node: StateNode }[] = [];
  const seen = new Set<string>();
  for (const source of [metadata, descriptors, values]) {
    for (const key in source) {
      if (!Object.hasOwn(source, key) || seen.has(key)) continue;
      if (nodes.size >= MAX_NODES) {
        limited = true;
        break;
      }
      seen.add(key);
      const raw = record(own(metadata, key));
      const rawDescriptor = record(own(descriptors, key));
      const editors = Array.isArray(raw?.editors)
        ? raw.editors.slice(0, 3)
        : undefined;
      const data: StateMetadata = {
        visibility: oneOf(raw?.visibility, ["visible", "invisible", "secret"]),
        persistence: oneOf(raw?.persistence, ["persisted", "ephemeral"]),
        owner: oneOf(raw?.owner, roles),
        editors: editors && roles.filter((role) => editors.includes(role)),
      };
      const descriptor: StateDescriptor = {
        kind: oneOf(rawDescriptor?.kind, ["custom", "framework", "reference"]),
        editable: bool(rawDescriptor?.editable),
        owner_editable: bool(rawDescriptor?.owner_editable),
        deletable: bool(rawDescriptor?.deletable),
      };
      const node = append(key, data, descriptor);
      roots.push(node);
      if (data.visibility === "secret") {
        if (descriptor.kind === "custom" || !Object.hasOwn(descriptors, key))
          node.reference = stateReference(key, "secret");
        continue; // Never read, traverse, index, or retain a Secret payload.
      }
      if (admitsOrdinaryState(metadata, descriptors, key)) {
        rootsToRead.push({ key, node });
      }
    }
  }
  const compactStrings = new Map<
    string,
    Map<string, { exact: string; label: string }>
  >();
  for (const { key, node } of rootsToRead) {
    const exact = own(values, key);
    const projected = stateReferenceProjection(
      key,
      node.descriptor.kind,
      exact,
      (path, exact, label) => {
        const entries = compactStrings.get(key) ?? new Map();
        entries.set(JSON.stringify(path), { exact, label });
        compactStrings.set(key, entries);
      },
    );
    addValue(
      node,
      projected,
      exact,
      key,
      [],
      node.descriptor.kind === "custom" &&
        node.metadata.visibility === "visible",
    );
  }
  // Do not depend on whether the bounded tree reached this framework field,
  // and never treat a historical custom field of the same name as capacity.
  const capacityKey = "execution_capacity";
  const capacity =
    own(record(own(metadata, capacityKey)), "visibility") !== "secret" &&
    own(record(own(descriptors, capacityKey)), "kind") === "framework"
      ? record(own(values, capacityKey))
      : undefined;
  return {
    roots,
    nodes,
    limited,
    revision: witness.variables_revision,
    runtime: witness.runtime_instance_id,
    exactRoots,
    compactStrings,
    executionCapacity: {
      buffers: capacity && capacityCount(own(capacity, "buffers")),
      pending: capacity && capacityCount(own(capacity, "pending")),
    },
  };
}

function capacityCount(value: unknown): CapacityCount | undefined {
  const count = record(value);
  const limit = own(count, "limit");
  const used = own(count, "used");
  const remaining = own(count, "remaining");
  const uint = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  // Usage can exceed a newly lowered limit. Display the supplied facts, not
  // capacity inferred from the visible history or computed on the client.
  if (uint(limit) && uint(used) && uint(remaining))
    return { limit, used, remaining };
}

// Matching descendants are reachable even when their ancestors are collapsed.
export function findStateNodes(roots: StateNode[], query: string): Set<number> {
  const matches = new Set<number>();
  const term = query.trim().toLowerCase();
  if (!term) return matches;
  const visit = (node: StateNode): boolean => {
    let found =
      node.label.toLowerCase().includes(term) ||
      !!node.preview?.toLowerCase().includes(term) ||
      node.exact?.toLowerCase() === term;
    for (const child of node.children) if (visit(child)) found = true;
    if (found) matches.add(node.id);
    return found;
  };
  roots.forEach(visit);
  return matches;
}
