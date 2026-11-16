import { LIMITS, type PluginManifest } from "./types";
import { manifest } from "./schema";
export const CLIENT_PLUGIN_ABI = "0.4.0";
export const CAPABILITIES = [
  "session-state",
  "session-state-write",
  "storage",
  "session-manager",
  "net",
  "conversation",
  "resources",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type PluginImportErrorCode =
  | "already-installed"
  | "invalid-wasm"
  | "unsupported-wasm-version"
  | "missing-component-type"
  | "invalid-core-module"
  | "core-componentization-failed"
  | "component-too-large";
export class PluginImportError extends Error {
  constructor(
    public readonly code: PluginImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PluginImportError";
  }
}
export interface Inspection {
  imports: string[];
  providesTools: boolean;
  files: [string, Uint8Array][];
  sourceKind: "core" | "component";
  normalizedBytes?: Uint8Array;
}
/** Check the bounded input without compiling a guest on the browser thread. */
export function wasmSourceKind(bytes: Uint8Array): "core" | "component" {
  if (bytes.length > LIMITS.componentBytes)
    throw new PluginImportError(
      "component-too-large",
      "plugin binary exceeds 16 MiB quota",
    );
  if (
    bytes.length < 8 ||
    bytes[0] !== 0 ||
    bytes[1] !== 97 ||
    bytes[2] !== 115 ||
    bytes[3] !== 109
  )
    throw new PluginImportError(
      "invalid-wasm",
      "expected WebAssembly Component binary or a core module with embedded component-type metadata",
    );
  if (bytes[4] === 13 && bytes[5] === 0 && bytes[6] === 1 && bytes[7] === 0)
    return "component";
  if (bytes[4] === 1 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 0)
    return "core";
  throw new PluginImportError(
    "unsupported-wasm-version",
    `unsupported WebAssembly binary version: ${Array.from(bytes.subarray(4, 8)).join(",")}`,
  );
}
/** Scan section framing and custom names only; wasm-tools validates metadata content. */
function requireComponentType(bytes: Uint8Array): void {
  let pos = 8;
  let found = false;
  const invalid = (detail: string): never => {
    throw new PluginImportError("invalid-core-module", detail);
  };
  const uint = (end: number): number => {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      if (pos >= end) return invalid("truncated core module section LEB");
      const byte = bytes[pos++]!;
      if (shift === 28 && byte & 0xf0)
        return invalid("core module section LEB exceeds u32");
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    return invalid("invalid core module section LEB");
  };
  while (pos < bytes.length) {
    const section = bytes[pos++]!;
    const length = uint(bytes.length);
    const payloadEnd = pos + length;
    if (payloadEnd > bytes.length) invalid("truncated core module section");
    if (section === 0) {
      const size = uint(payloadEnd);
      if (pos + size > payloadEnd)
        invalid("truncated core custom section name");
      let name: string;
      try {
        name = new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(pos, pos + size),
        );
      } catch {
        return invalid("invalid UTF-8 core custom section name");
      }
      if (
        (name === "component-type" || name.startsWith("component-type:")) &&
        pos + size < payloadEnd
      )
        found = true;
    }
    pos = payloadEnd;
  }
  if (!found)
    throw new PluginImportError(
      "missing-component-type",
      "expected WebAssembly Component binary: this core module has no embedded component-type metadata; export a wit-bindgen client plugin with its metadata intact",
    );
}
/** Inspect import framing before jco validates the full Component type graph.
 * Canonical world-use aliases are equality-bounded type imports, never effects.
 */
export function binaryImports(bytes: Uint8Array): string[] {
  let pos = 8,
    sectionEnd = bytes.length,
    importCount = 0;
  const imports: string[] = [];
  const names = new Set<string>();
  const uint = () => {
    let value = 0,
      shift = 0,
      b: number;
    do {
      if (pos >= sectionEnd || shift > 28)
        throw new Error("invalid Component import/section LEB");
      b = bytes[pos++]!;
      if (shift === 28 && b & 0xf0)
        throw new Error("Component import/section LEB exceeds u32");
      value += (b & 127) * 2 ** shift;
      shift += 7;
    } while (b & 128);
    return value;
  };
  while (pos < bytes.length) {
    sectionEnd = bytes.length;
    const section = bytes[pos++]!,
      length = uint(),
      end = pos + length;
    if (end > bytes.length) throw new Error("truncated Component section");
    if (section !== 10) {
      pos = end;
      continue;
    }
    sectionEnd = end;
    const count = uint();
    importCount += count;
    if (importCount > 64) throw new Error("Component exceeds 64 imports");
    for (let i = 0; i < count; i++) {
      const encoding = bytes[pos++]!;
      if (encoding !== 0 && encoding !== 1)
        throw new Error("unsupported Component import name encoding");
      const size = uint();
      if (pos + size > end) throw new Error("truncated Component import name");
      const name = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(pos, pos + size),
      );
      pos += size;
      if (names.has(name))
        throw new Error(`duplicate Component import: ${name}`);
      names.add(name);
      const sort = bytes[pos++]!;
      if (sort === 3) {
        // wasm component type-ref: 0x03, equality bound 0x00, type index.
        // The type index is graph-relative; jco, not this framing scanner,
        // checks its identity against the canonical view-types definitions.
        const bound = bytes[pos++]!;
        if (
          bound !== 0 ||
          !["plugin-manifest", "view-target", "view-output"].includes(name)
        )
          throw new Error(
            `unsupported Component type import: ${name}; expected canonical equality-bounded view type`,
          );
        uint();
        continue;
      }
      if (sort !== 5)
        throw new Error(
          `unsupported Component import ${name}: expected capability interface instance or canonical view type`,
        );
      uint();
      if (
        !CAPABILITIES.some(
          (c) => name === `microcrab:client-plugin/${c}@${CLIENT_PLUGIN_ABI}`,
        ) &&
        name !== `microcrab:client-plugin/view-types@${CLIENT_PLUGIN_ABI}`
      )
        throw new Error(
          `unsupported Component import: ${name}; this runtime supports client-plugin@${CLIENT_PLUGIN_ABI} only. Rebuild/update the plugin; existing installed bytes and preferences are retained.`,
        );
      imports.push(name);
    }
    if (pos !== end) throw new Error("invalid Component import section length");
  }
  return imports;
}
export async function inspectComponent(bytes: Uint8Array): Promise<Inspection> {
  const sourceKind = wasmSourceKind(bytes);
  let normalizedBytes: Uint8Array | undefined;
  if (sourceKind === "core") {
    requireComponentType(bytes);
    // Production calls this inspector inside the dedicated plugin Worker. Import
    // the compiler only after cheap framing, version, size and metadata checks.
    try {
      const { componentNew } =
        await import("@bytecodealliance/jco-transpile/wasm-tools");
      normalizedBytes = await componentNew(bytes, undefined);
    } catch (cause) {
      throw new PluginImportError(
        "core-componentization-failed",
        `could not wrap core plugin using its embedded component-type metadata (no automatic WASI adapters): ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (wasmSourceKind(normalizedBytes) !== "component")
      throw new PluginImportError(
        "core-componentization-failed",
        "core wrapping did not produce a WebAssembly Component binary",
      );
    // Do not structured-clone an oversized compiler backing buffer into the UI.
    normalizedBytes = normalizedBytes.slice();
    bytes = normalizedBytes;
  }
  const imports = binaryImports(bytes);
  const { transpile } = await import("@bytecodealliance/jco/component");
  // Bindgen decodes the actual Component graph before any guest code runs.
  const generated = await transpile(bytes, {
    name: "plugin",
    instantiation: { tag: "async" },
    noTypescript: true,
    noNodejsCompat: true,
    base64Cutoff: 0,
    map: [...CAPABILITIES, "view-types"].map((c) => {
      const name = `microcrab:client-plugin/${c}@${CLIENT_PLUGIN_ABI}`;
      return [name, name] as [string, string];
    }),
    asyncMode: { tag: "sync" },
  });
  for (const name of generated.imports)
    if (
      !imports.some(
        (original) =>
          name === original || name === original.replace(/@0\.4\.0$/, ""),
      )
    )
      throw new Error(`unexpected generated Component import: ${name}`);
  for (const name of [
    "manifest",
    "init",
    "render-view",
    "on-action",
    "on-phase",
  ])
    if (
      !generated.exports.some(
        ([n, k]) =>
          (n === name ||
            n ===
              name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())) &&
          k === "function",
      )
    )
      throw new Error(
        `missing required Component export: ${name}; rebuild/update using client-plugin@${CLIENT_PLUGIN_ABI}. This runtime does not adapt older ABIs; installed bytes/preferences are retained.`,
      );
  const has = (name: string) =>
    generated.exports.some(
      ([n, k]) =>
        k === "function" &&
        (n === name ||
          n === name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())),
    );
  if (has("start-tool") !== has("cancel-tool"))
    throw new Error("tool providers require both start-tool and cancel-tool");
  return {
    imports,
    providesTools: has("start-tool"),
    files: generated.files,
    sourceKind,
    ...(normalizedBytes ? { normalizedBytes } : {}),
  };
}
export function capabilityForKind(kind: string): Capability | undefined {
  if (["state-values", "state-metadata", "state-inspection"].includes(kind))
    return "session-state";
  if (["state-change", "state-operation"].includes(kind))
    return "session-state-write";
  if (kind.startsWith("storage-")) return "storage";
  if (["sessions", "projects"].includes(kind)) return "session-manager";
  if (["http", "ws-open", "ws-send", "ws-close"].includes(kind)) return "net";
  if (kind === "block-slots") return "conversation";
  if (kind.startsWith("resource-")) return "resources";
  return undefined;
}
export function authorizeKind(imports: string[], kind: string): void {
  const capability = capabilityForKind(kind);
  if (
    !capability ||
    !imports.includes(
      `microcrab:client-plugin/${capability}@${CLIENT_PLUGIN_ABI}`,
    )
  )
    throw new Error(
      `effect ${kind} requires actual Component import microcrab:client-plugin/${capability ?? "unsupported"}@${CLIENT_PLUGIN_ABI}`,
    );
}
export type Guest = {
  startTool?: (request: string, ctx: string) => string;
  cancelTool?: (ctx: string) => string;
  manifest: () => unknown;
  init: (ctx: string) => string;
  renderView: (target: string, vars: string, ctx: string) => unknown;
  onAction: (
    action: string,
    payload: string,
    vars: string,
    ctx: string,
  ) => string;
  onPhase: (
    phase: string,
    payload: string,
    vars: string,
    ctx: string,
  ) => string;
};
export async function instantiate(
  inspection: Inspection,
  imports: Record<string, unknown>,
): Promise<{ guest: Guest; manifest: PluginManifest }> {
  const entry = inspection.files.find(([name]) => name === "plugin.js");
  if (!entry) throw new Error("transpiler did not produce plugin.js");
  const url = URL.createObjectURL(
    new Blob([new TextDecoder().decode(entry[1])], { type: "text/javascript" }),
  );
  try {
    type CoreInfo = { memories: number; maxPages: number };
    const cores = new WeakMap<WebAssembly.Module, CoreInfo>();
    let instances = 0,
      memories = 0,
      maxPages = 0;
    const mod = (await import(/* @vite-ignore */ url)) as {
      instantiate: (
        getCoreModule: (path: string) => Promise<WebAssembly.Module>,
        imports: Record<string, unknown>,
        instantiateCore: (
          module: WebAssembly.Module,
          imports?: WebAssembly.Imports,
        ) => WebAssembly.Instance,
      ) => Promise<Guest>;
    };
    const guest = await mod.instantiate(
      async (path) => {
        const file = inspection.files.find(
          ([name]) => name === path || name === path.replace(/^\.\//, ""),
        );
        if (!file) throw new Error(`missing transpiled core module: ${path}`);
        const info = { memories: 0, maxPages: 0 };
        const module = await WebAssembly.compile(
          boundCoreMemory(file[1], info) as Uint8Array<ArrayBuffer>,
        );
        cores.set(module, info);
        return module;
      },
      imports,
      (module, coreImports) => {
        if (++instances > 64)
          throw new Error("Component exceeds 64 core instantiations");
        const info = cores.get(module);
        if (
          !info &&
          WebAssembly.Module.exports(module).some(
            (entry) => entry.kind === "memory",
          )
        )
          throw new Error(
            "untracked inline core memory cannot bypass Component allocation quota",
          );
        memories += info?.memories ?? 0;
        maxPages += info?.maxPages ?? 0;
        if (memories > 4 || maxPages > 2048)
          throw new Error(
            "Component exceeds four linear memories / 128 MiB aggregate maximum",
          );
        return new WebAssembly.Instance(module, coreImports);
      },
    );
    return { guest, manifest: manifest(guest.manifest()) };
  } finally {
    URL.revokeObjectURL(url);
  }
}
/** Bound every defined core memory before compilation, including growth inside a call. */
export function boundCoreMemory(
  bytes: Uint8Array,
  budget: { memories: number; maxPages: number } = { memories: 0, maxPages: 0 },
): Uint8Array {
  let pos = 8;
  const read = () => {
    let n = 0,
      shift = 0,
      b: number;
    do {
      if (pos >= bytes.length || shift > 28)
        throw new Error("invalid core section LEB");
      b = bytes[pos++]!;
      n += (b & 127) * 2 ** shift;
      shift += 7;
    } while (b & 128);
    return n;
  };
  const leb = (n: number) => {
    const r: number[] = [];
    do {
      let b = n & 127;
      n = Math.floor(n / 128);
      if (n) b |= 128;
      r.push(b);
    } while (n);
    return r;
  };
  const parts: Uint8Array[] = [bytes.slice(0, 8)];
  while (pos < bytes.length) {
    const id = bytes[pos++]!;
    const size = read(),
      start = pos,
      end = start + size;
    if (end > bytes.length) throw new Error("truncated core section");
    if (id === 4) {
      const count = read(),
        payload: number[] = [...leb(count)];
      if (count > 16) throw new Error("core module exceeds 16 tables");
      for (let i = 0; i < count; i++) {
        const reference = bytes[pos++]!;
        if (reference !== 0x70 && reference !== 0x6f)
          throw new Error(
            "unsupported core table reference type for allocation quota",
          );
        const flags = read();
        if (flags & ~1) throw new Error("unsupported core table limits");
        const min = read(),
          max = flags & 1 ? read() : 65536;
        if (min > 65536)
          throw new Error("plugin initial table exceeds 65536 elements");
        payload.push(reference, 1, ...leb(min), ...leb(Math.min(max, 65536)));
      }
      if (pos !== end) throw new Error("invalid core table section");
      parts.push(Uint8Array.from([id, ...leb(payload.length), ...payload]));
      continue;
    }
    if (id !== 5) {
      parts.push(Uint8Array.from([id, ...leb(size)]), bytes.slice(start, end));
      pos = end;
      continue;
    }
    const count = read(),
      payload: number[] = [...leb(count)];
    budget.memories += count;
    if (budget.memories > 4)
      throw new Error("core module exceeds four memories");
    for (let i = 0; i < count; i++) {
      const flags = read();
      if (flags & ~1)
        throw new Error(
          "shared or memory64 memory unsupported by plugin quota",
        );
      const min = read(),
        max = flags & 1 ? read() : 1024;
      if (min > 1024)
        throw new Error(
          "plugin initial linear memory exceeds 64 MiB per-memory quota",
        );
      budget.maxPages += Math.min(max, 1024);
      payload.push(1, ...leb(min), ...leb(Math.min(max, 1024)));
    }
    if (pos !== end) throw new Error("invalid core memory section");
    parts.push(Uint8Array.from([id, ...leb(payload.length), ...payload]));
  }
  const output = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
