import {
  LIMITS,
  type Json,
  type PluginManifest,
  type PluginNode,
  type PluginResult,
  type VariablesChange,
  type PluginRenderOutput,
} from "./types";
import { CONTENT_FORMATS } from "../features/content-inspection/format";
const encoder = new TextEncoder();
export function boundedJson<T>(text: string): T {
  if (
    typeof text !== "string" ||
    encoder.encode(text).length > LIMITS.jsonBytes
  )
    throw new Error("plugin JSON exceeds 16777216 bytes");
  return JSON.parse(text) as T;
}
export function assertJson(value: unknown): asserts value is Json {
  const encoded = JSON.stringify(value);
  if (
    encoded === undefined ||
    encoder.encode(encoded).length > LIMITS.jsonBytes
  )
    throw new Error("plugin JSON is missing or exceeds 16 MiB byte quota");
  const walk = (v: unknown, depth: number): void => {
    if (depth > LIMITS.jsonDepth)
      throw new Error("plugin JSON exceeds depth 128");
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v))
    )
      return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype)
      throw new Error("plugin JSON contains unsupported value");
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(value, 0);
}
export function manifest(value: unknown): PluginManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "ABI 0.2.0 manifest must be a typed record; rebuild this plugin with client-plugin@0.2.0",
    );
  const typed = value as Record<string, unknown>;
  const m = {
    schema_version: 1,
    id: typed.id,
    name: typed.name,
    version: typed.version,
    targets: typed.targets,
    ...(typed.description !== undefined
      ? { description: typed.description }
      : {}),
    ...(typed.networkOrigins !== undefined
      ? { network_origins: typed.networkOrigins }
      : {}),
  } as PluginManifest;
  if (
    m.schema_version !== 1 ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(m.id) ||
    typeof m.name !== "string" ||
    !m.name ||
    m.name.length > 256 ||
    typeof m.version !== "string" ||
    m.version.length > 128 ||
    !Array.isArray(m.targets) ||
    m.targets.length > 16 ||
    m.targets.some(
      (x) =>
        !["sidebar", "expanded-page", "session-tab", "block-slot"].includes(x),
    )
  )
    throw new Error("invalid plugin manifest schema/version/id/name/targets");
  if (
    m.description !== undefined &&
    (typeof m.description !== "string" || m.description.length > 8192)
  )
    throw new Error("plugin manifest description exceeds quota");
  if (
    m.network_origins !== undefined &&
    (!Array.isArray(m.network_origins) ||
      m.network_origins.length > 32 ||
      m.network_origins.some((x) => {
        try {
          const u = new URL(x);
          return (
            !["http:", "https:", "ws:", "wss:"].includes(u.protocol) ||
            u.origin !== x
          );
        } catch {
          return true;
        }
      }))
  )
    throw new Error(
      "network_origins must contain exact HTTP/WebSocket origins",
    );
  return m;
}
const kinds = new Set([
  "column",
  "row",
  "text",
  "button",
  "input",
  "textarea",
  "select",
  "tabs",
  "notice",
  "payload",
  "markdown",
  "conditional",
  "repeat",
  "form",
]);
const propKeys = new Set([
  "text",
  "value",
  "label",
  "placeholder",
  "disabled",
  "visible",
  "icon",
  "action",
  "action_payload",
  "allowed_formats",
  "edit_notice",
  "edit_validate_action",
  "edit_validation_state",
  "clear_action",
  "clear_label",
  "edit_action",
  "edit_value",
  "edit_context",
  "edit_state",
  "edit_observe_action",
  "rows",
  "change_action",
  "bind",
  "options",
  "test",
  "items",
  "as",
  "input_type",
  "tone",
  "pressed",
]);
export function validateTree(tree: PluginNode): void {
  assertJson(tree);
  let count = 0,
    textBytes = 0;
  const visit = (node: PluginNode, depth: number) => {
    if (++count > LIMITS.nodes || depth > LIMITS.depth)
      throw new Error("plugin tree exceeds 2000 nodes or depth 32");
    if (
      !node ||
      !kinds.has(node.type) ||
      Object.keys(node).some(
        (k) => !["type", "id", "props", "children"].includes(k),
      )
    )
      throw new Error("unsupported plugin node schema");
    if (
      node.id !== undefined &&
      (typeof node.id !== "string" || node.id.length > 128)
    )
      throw new Error("invalid plugin node id");
    if (node.props)
      for (const [key, value] of Object.entries(node.props)) {
        if (!propKeys.has(key))
          throw new Error(`unsupported node property: ${key}`);
        const reference =
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          "$ref" in value;
        if (reference) {
          if (
            ![
              "text",
              "value",
              "label",
              "placeholder",
              "disabled",
              "visible",
              "test",
              "items",
              "icon",
              "pressed",
              "action_payload",
              "edit_value",
              "edit_context",
              "edit_state",
              "edit_notice",
              "edit_validation_state",
              "clear_label",
            ].includes(key) ||
            Object.keys(value).length !== 1 ||
            typeof value.$ref !== "string" ||
            value.$ref.length > 512
          )
            throw new Error("invalid node path reference");
          continue;
        }
        if (
          [
            "text",
            "label",
            "placeholder",
            "action",
            "edit_action",
            "edit_observe_action",
            "edit_notice",
            "edit_validate_action",
            "clear_action",
            "clear_label",
            "change_action",
            "bind",
            "as",
          ].includes(key) &&
          typeof value !== "string"
        )
          throw new Error(`node ${key} must be string or reference`);
        if (
          ["disabled", "visible", "pressed"].includes(key) &&
          typeof value !== "boolean"
        )
          throw new Error(`node ${key} must be boolean or reference`);
        if (
          key === "icon" &&
          ![
            "eye",
            "eye-off",
            "search",
            "refresh",
            "close",
            "copy",
            "expand",
          ].includes(String(value))
        )
          throw new Error("unsupported node icon");
        if (
          key === "input_type" &&
          !["text", "password", "search", "number"].includes(String(value))
        )
          throw new Error("unsupported input type");
        if (
          key === "tone" &&
          !["info", "warning", "error"].includes(String(value))
        )
          throw new Error("unsupported notice tone");
        if (
          key === "options" &&
          (!Array.isArray(value) ||
            value.length > 256 ||
            value.some(
              (x) =>
                !x ||
                typeof x !== "object" ||
                !("label" in x) ||
                typeof x.label !== "string" ||
                !("value" in x) ||
                typeof x.value !== "string",
            ))
        )
          throw new Error("invalid bounded select options");
        if (
          key === "rows" &&
          (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 40)
        )
          throw new Error("textarea rows must be an integer from 1 to 40");
        if (
          key === "allowed_formats" &&
          (!Array.isArray(value) ||
            !value.length ||
            value.length > CONTENT_FORMATS.length ||
            new Set(value).size !== value.length ||
            value.some(
              (format) =>
                !CONTENT_FORMATS.some((allowed) => allowed === format),
            ))
        )
          throw new Error(
            "allowed_formats must be a nonempty unique format list",
          );
        if (["edit_state", "edit_validation_state"].includes(key))
          throw new Error(`${key} requires a path reference`);
        if (typeof value === "string")
          textBytes += encoder.encode(value).length;
      }
    if (textBytes > LIMITS.text)
      throw new Error("plugin tree exceeds text quota");
    if (
      node.props?.edit_validate_action !== undefined &&
      (!node.props.edit_action ||
        !node.props.edit_validate_action ||
        !node.props.edit_validation_state)
    )
      throw new Error(
        "edit_validate_action requires an editable Payload and bound edit_validation_state",
      );
    if (node.props?.allowed_formats !== undefined && node.type !== "payload")
      throw new Error("allowed_formats belongs only to Payload nodes");
    if (
      node.props?.clear_action !== undefined &&
      (node.type !== "input" ||
        !node.props.clear_action ||
        node.props.clear_label === undefined)
    )
      throw new Error("clear_action requires an input and clear_label");
    if (node.props?.edit_action !== undefined) {
      const p = node.props;
      if (
        node.type !== "payload" ||
        !p.edit_action ||
        p.edit_value === undefined ||
        p.edit_context === undefined ||
        !p.edit_state ||
        typeof p.edit_state !== "object" ||
        typeof p.edit_state.$ref !== "string"
      )
        throw new Error(
          "editable Payload requires edit_action, edit_value, edit_context and a bound edit_state",
        );
    }
    if (
      node.type !== "payload" &&
      node.props &&
      Object.keys(node.props).some((key) => key.startsWith("edit_"))
    )
      throw new Error("edit properties belong only to Payload nodes");
    if (node.children !== undefined && !Array.isArray(node.children))
      throw new Error("node children must be array");
    node.children?.forEach((c) => visit(c, depth + 1));
  };
  visit(tree, 0);
}
export function variables(change: VariablesChange): void {
  assertJson(change);
  if (
    !change ||
    typeof change !== "object" ||
    Array.isArray(change) ||
    Object.keys(change).some(
      (k) => !["set", "scoped_set", "remove"].includes(k),
    )
  )
    throw new Error(
      "turn_variables must contain only set, scoped_set and remove",
    );
  if (
    change.set !== undefined &&
    (!change.set || typeof change.set !== "object" || Array.isArray(change.set))
  )
    throw new Error("turn_variables.set must be a key/value object");
  if (
    change.scoped_set !== undefined &&
    (!Array.isArray(change.scoped_set) ||
      change.scoped_set.some(
        (x) =>
          !x ||
          typeof x !== "object" ||
          !Object.hasOwn(x, "value") ||
          Object.keys(x).some(
            (k) =>
              ![
                "name",
                "value",
                "visibility",
                "persistence",
                "editors",
              ].includes(k),
          ) ||
          typeof x.name !== "string" ||
          !["visible", "invisible"].includes(x.visibility) ||
          !["persisted", "ephemeral"].includes(x.persistence) ||
          (x.visibility === "visible" && x.persistence === "ephemeral"),
      ))
  )
    throw new Error(
      "invalid scoped variable write: expected name/value/visibility/persistence; visible ephemeral is forbidden",
    );
  if (
    change.remove !== undefined &&
    (!Array.isArray(change.remove) ||
      change.remove.some((x) => typeof x !== "string"))
  )
    throw new Error("invalid variable removal");
  const seen = new Set<string>();
  const name = (key: string, path: string) => {
    if (!key || key.length > 512)
      throw new Error(`${path}: variable name must contain 1..512 characters`);
    if (seen.has(key))
      throw new Error(
        `${path}: duplicate logical variable ${key} within one plugin result`,
      );
    seen.add(key);
  };
  for (const key of Object.keys(change.set ?? {}))
    name(key, `turn_variables.set.${key}`);
  for (const [index, entry] of (change.scoped_set ?? []).entries())
    name(entry.name, `turn_variables.scoped_set[${index}].name`);
  for (const [index, key] of (change.remove ?? []).entries())
    name(key, `turn_variables.remove[${index}]`);
}
/** Results are valid individually; later plugins replace the preceding logical write. */
export function overlayVariables(
  earlier: VariablesChange,
  later: VariablesChange,
): VariablesChange {
  variables(later);
  const set = { ...earlier.set },
    scoped = new Map(
      (earlier.scoped_set ?? []).map((entry) => [entry.name, entry]),
    ),
    remove = new Set(earlier.remove ?? []);
  for (const [name, value] of Object.entries(later.set ?? {})) {
    Object.defineProperty(set, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    scoped.delete(name);
    remove.delete(name);
  }
  for (const entry of later.scoped_set ?? []) {
    delete set[entry.name];
    scoped.set(entry.name, entry);
    remove.delete(entry.name);
  }
  for (const name of later.remove ?? []) {
    delete set[name];
    scoped.delete(name);
    remove.add(name);
  }
  const result: VariablesChange = {};
  if (Object.keys(set).length) result.set = set;
  if (scoped.size) result.scoped_set = [...scoped.values()];
  if (remove.size) result.remove = [...remove];
  return result;
}
export function result(text: string): PluginResult {
  const r = boundedJson<PluginResult>(text);
  assertJson(r);
  if (!r || r.schema_version !== 1)
    throw new Error("plugin result requires schema_version 1");
  if (r.error !== undefined) {
    if (typeof r.error !== "string" || !r.error || r.error.length > 8192)
      throw new Error(
        "plugin result error must be a nonempty string of at most 8192 characters",
      );
    throw new Error(r.error);
  }
  if (r.tree) validateTree(r.tree);
  if (
    r.vars_patch &&
    (typeof r.vars_patch !== "object" || Array.isArray(r.vars_patch))
  )
    throw new Error("vars_patch must be object");
  if (
    r.effects &&
    (!Array.isArray(r.effects) ||
      r.effects.length > LIMITS.effects ||
      r.effects.some(
        (e) =>
          !e ||
          typeof e.kind !== "string" ||
          !("payload" in e) ||
          (e.request_id !== undefined &&
            (!Number.isInteger(e.request_id) ||
              e.request_id < 0 ||
              e.request_id > 0xffffffff)),
      ))
  )
    throw new Error("invalid effects or effect quota exceeded");
  if (r.rewritten_input !== undefined && typeof r.rewritten_input !== "string")
    throw new Error("rewritten_input must be string");
  if (r.rerender !== undefined && typeof r.rerender !== "boolean")
    throw new Error("rerender must be boolean");
  if (r.turn_variables) variables(r.turn_variables);
  if (r.block_slots) {
    if (!Array.isArray(r.block_slots) || r.block_slots.length > 64)
      throw new Error("block slot quota exceeded");
    for (const s of r.block_slots) {
      if (
        typeof s.slot_id !== "string" ||
        typeof s.block_id !== "string" ||
        s.slot_id.length > 128 ||
        s.block_id.length > 256
      )
        throw new Error("invalid block slot identity");
      validateBlockSlot(s);
    }
  }
  return r;
}
export function validateProjection(
  tree: PluginNode,
  vars: Record<string, Json>,
): void {
  let nodes = 0,
    textBytes = 0;
  const encoder = new TextEncoder();
  const get = (
    value: unknown,
    scope: Record<string, Json>,
  ): Json | undefined =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "$ref" in value &&
    typeof value.$ref === "string"
      ? resolvePath(scope, value.$ref)
      : (value as Json | undefined);
  const countText = (value: Json | undefined) => {
    if (value === undefined || value === null) return;
    const text =
      typeof value === "string"
        ? value
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    textBytes += encoder.encode(text).length;
    if (textBytes > LIMITS.text)
      throw new Error(
        "rendered plugin text exceeds 256 KiB (Payload values have their independent JSON budget)",
      );
  };
  const visit = (
    node: PluginNode,
    scope: Record<string, Json>,
    depth: number,
  ): void => {
    if (depth > LIMITS.depth)
      throw new Error("rendered plugin tree exceeds depth 32");
    const props = node.props ?? {};
    const icon = get(props.icon, scope);
    if (
      icon !== undefined &&
      ![
        "eye",
        "eye-off",
        "search",
        "refresh",
        "close",
        "copy",
        "expand",
      ].includes(String(icon))
    )
      throw new Error("unsupported resolved node icon");
    const pressed = get(props.pressed, scope);
    if (pressed !== undefined && typeof pressed !== "boolean")
      throw new Error("resolved node pressed must be boolean");
    if (get(props.visible, scope) === false) return;
    if (++nodes > LIMITS.nodes)
      throw new Error(
        "rendered plugin tree exceeds 2000 nodes after repeat expansion",
      );
    if (node.type === "conditional" && !get(props.test, scope)) return;
    for (const key of ["text", "label", "placeholder"] as const)
      countText(get(props[key], scope));
    if (
      node.type === "input" ||
      node.type === "textarea" ||
      node.type === "select"
    )
      countText(
        props.value === undefined && props.bind
          ? resolvePath(scope, props.bind)
          : get(props.value, scope),
      );
    if (node.type === "select" || node.type === "tabs")
      for (const option of props.options ?? []) {
        if (++nodes > LIMITS.nodes)
          throw new Error(
            "rendered plugin tree exceeds 2000 nodes including options",
          );
        countText(option.label);
      }
    if (node.type === "repeat") {
      const items = get(props.items, scope);
      if (!Array.isArray(items)) return;
      for (const [index, item] of items.entries())
        for (const child of node.children ?? [])
          visit(
            child,
            { ...scope, [props.as ?? "item"]: item, index },
            depth + 1,
          );
    } else if (
      !["input", "textarea", "select", "payload", "markdown"].includes(
        node.type,
      )
    )
      for (const child of node.children ?? []) visit(child, scope, depth + 1);
  };
  visit(tree, vars, 0);
}

export function resolvePath(root: unknown, path: string): Json | undefined {
  let current = root;
  for (const key of path
    .replace(/^\$\.?/, "")
    .split(".")
    .filter(Boolean)) {
    if (
      ["__proto__", "prototype", "constructor"].includes(key) ||
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, key)
    )
      return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current as Json | undefined;
}
export function writePath(
  root: Record<string, Json>,
  path: string,
  value: Json,
): Record<string, Json> {
  const parts = path
    .replace(/^\$\.?/, "")
    .split(".")
    .filter(Boolean);
  if (
    !parts.length ||
    parts.some((p) => ["__proto__", "prototype", "constructor"].includes(p))
  )
    throw new Error("invalid variable path");
  const next = structuredClone(root);
  let node: Record<string, Json> = next;
  for (const p of parts.slice(0, -1)) {
    if (Array.isArray(node) && (!/^\d+$/.test(p) || Number(p) >= node.length))
      throw new Error("array variable path is outside the current items");
    const v = node[p];
    if (!v || typeof v !== "object") node[p] = {};
    node = node[p] as Record<string, Json>;
  }
  const last = parts[parts.length - 1]!;
  if (
    Array.isArray(node) &&
    (!/^\d+$/.test(last) || Number(last) >= node.length)
  )
    throw new Error("array variable path is outside the current items");
  node[last] = value;
  assertJson(next);
  return next;
}

/** Decode actual camelCase Component binding records, never legacy JSON exports. */
export function renderOutput(value: unknown): PluginResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "ABI 0.2.0 render-view must return a typed view-output record",
    );
  const r = value as Record<string, unknown>;
  if (
    r.schemaVersion !== 1 ||
    !["native-json", "webview-html"].includes(String(r.mode)) ||
    typeof r.content !== "string" ||
    typeof r.rerender !== "boolean"
  )
    throw new Error(
      "invalid typed view-output schemaVersion/mode/content/rerender",
    );
  if (r.error !== undefined) {
    if (typeof r.error !== "string" || !r.error || r.error.length > 8192)
      throw new Error("invalid view-output error");
    throw new Error(r.error);
  }
  let output: PluginRenderOutput;
  if (r.mode === "native-json") {
    const tree = boundedJson<PluginNode | null>(r.content);
    if (tree !== null) validateTree(tree);
    output = { mode: "native-json", content: r.content, tree };
  } else {
    const envelope = boundedJson<{ html: string; view_state?: Json }>(
      r.content,
    );
    assertJson(envelope);
    if (
      !envelope ||
      typeof envelope.html !== "string" ||
      Object.keys(envelope).some((k) => !["html", "view_state"].includes(k)) ||
      encoder.encode(envelope.html).length > LIMITS.text
    )
      throw new Error(
        "HTML view requires bounded {html,view_state?} content envelope",
      );
    output = {
      mode: "webview-html",
      content: envelope.html,
      tree: null,
      ...(envelope.view_state !== undefined
        ? { viewState: envelope.view_state }
        : {}),
    };
  }
  const patch =
    r.varsPatch === undefined
      ? undefined
      : boundedJson<Record<string, Json>>(String(r.varsPatch));
  if (
    patch !== undefined &&
    (!patch || typeof patch !== "object" || Array.isArray(patch))
  )
    throw new Error("view varsPatch must encode an object");
  if (patch) assertJson(patch);
  return {
    schema_version: 1,
    view_output: output,
    ...(output.tree ? { tree: output.tree } : {}),
    ...(patch ? { vars_patch: patch } : {}),
    rerender: r.rerender,
  };
}
export function validateBlockSlot(slot: import("./types").BlockSlot): void {
  if (
    !slot ||
    typeof slot.slot_id !== "string" ||
    !slot.slot_id ||
    slot.slot_id.length > 128 ||
    typeof slot.block_id !== "string" ||
    !slot.block_id ||
    slot.block_id.length > 256 ||
    (slot.target !== undefined && slot.target !== "block-slot") ||
    (slot.placement !== undefined &&
      !["before", "after"].includes(slot.placement))
  )
    throw new Error("invalid block slot identity/target/placement");
  if (slot.mode === "webview-html") {
    if (
      typeof slot.content !== "string" ||
      encoder.encode(slot.content).length > LIMITS.text ||
      slot.tree !== undefined
    )
      throw new Error(
        "HTML block slot requires bounded content and no native tree",
      );
    if (slot.view_state !== undefined) assertJson(slot.view_state);
  } else {
    if (slot.mode !== undefined && slot.mode !== "native-json")
      throw new Error("unsupported block slot render mode");
    if (!slot.tree) throw new Error("native block slot requires tree");
    validateTree(slot.tree);
  }
}
