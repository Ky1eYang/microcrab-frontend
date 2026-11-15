import {
  PluginImportError,
  authorizeKind,
  capabilityForKind,
  inspectComponent,
  instantiate,
  type Guest,
} from "./component";
import { assertJson, boundedJson, result, renderOutput } from "./schema";
import { LIMITS, type Json, type PluginContext } from "./types";
import type { WorkerReply, WorkerRequest } from "./protocol";
const port = globalThis as unknown as {
  postMessage(message: WorkerReply): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};
let guest: Guest | undefined,
  imports: string[] = [],
  cache: Record<string, string> = {},
  sessions: Json[] = [],
  projects: Json[] = [];
let current: WorkerRequest | undefined,
  context: PluginContext | undefined,
  requestId = 0,
  callEffects = 0;
const post = (message: WorkerReply) => port.postMessage(message);
function request(
  capability: string,
  kind: string,
  payloadText: string,
): number {
  if (!current || !context)
    throw new Error("host request outside active plugin invocation");
  if (current.type === "load")
    throw new Error("manifest must not issue host requests");
  if (capabilityForKind(kind) !== capability)
    throw new Error(`request kind ${kind} is not part of ${capability}`);
  if (++callEffects > LIMITS.effects)
    throw new Error("plugin exceeds 64 host requests per call");
  if (
    !["0.2.0", "0.3.0"].some((v) =>
      imports.includes(`microcrab:client-plugin/${capability}@${v}`),
    )
  )
    throw new Error(`missing actual ${capability} import`);
  authorizeKind(imports, kind);
  const payload = boundedJson<Json>(payloadText);
  assertJson(payload);
  if (requestId >= 0x7fffffff)
    throw new Error("plugin imported request identity exhausted");
  const id = ++requestId;
  post({
    type: "effect",
    generation: current.generation,
    callId: current.callId,
    effect: { kind, payload, request_id: id },
    context: structuredClone(context),
  });
  return id;
}
port.onmessage = async ({ data }) => {
  try {
    current = data;
    callEffects = 0;
    if (data.type === "cache") {
      cache = data.cache;
      return;
    }
    if (data.type === "snapshots") {
      sessions = data.sessions;
      projects = data.projects;
      return;
    }
    context = data.context;
    if (data.type === "load") {
      cache = data.cache;
      sessions = data.sessions;
      projects = data.projects;
      const inspection = await inspectComponent(data.bytes);
      imports = inspection.imports;
      const host: Record<string, unknown> = {
        "microcrab:client-plugin/view-types@0.2.0": {},
      };
      for (const version of ["0.2.0", "0.3.0"]) {
        host[`microcrab:client-plugin/view-types@${version}`] = {};
        for (const capability of [
          "session-state",
          "session-state-write",
          "net",
          "conversation",
          "resources",
        ])
          host[`microcrab:client-plugin/${capability}@${version}`] = {
            request: (kind: string, payload: string) =>
              request(capability, kind, payload),
          };
        host[`microcrab:client-plugin/storage@${version}`] = {
          get: (key: string) =>
            Object.hasOwn(cache, key) ? cache[key] : undefined,
          set: (key: string, value: string) => {
            if (
              typeof key !== "string" ||
              key.length > 512 ||
              typeof value !== "string"
            )
              throw new Error("invalid storage key/value");
            const id = request(
              "storage",
              "storage-set",
              JSON.stringify({ key, value }),
            );
            return id;
          },
          remove: (key: string) => {
            const id = request(
              "storage",
              "storage-remove",
              JSON.stringify({ key }),
            );
            return id;
          },
        };
        host[`microcrab:client-plugin/session-manager@${version}`] = {
          sessions: () => JSON.stringify(sessions),
          projects: () => JSON.stringify(projects),
        };
      }
      const loaded = await instantiate(inspection, host);
      guest = loaded.guest;
      post({
        type: "loaded",
        generation: data.generation,
        callId: data.callId,
        manifest: loaded.manifest,
        imports,
        providesTools: inspection.providesTools,
        sourceKind: inspection.sourceKind,
        ...(inspection.normalizedBytes
          ? { normalizedBytes: inspection.normalizedBytes }
          : {}),
      });
    } else {
      if (!guest) throw new Error("plugin is not loaded");
      const fn = guest[data.method] as (...args: string[]) => unknown;
      if (typeof fn !== "function")
        throw new Error("plugin does not export optional tool provider");
      const value = fn(...data.args);
      post({
        type: "result",
        generation: data.generation,
        callId: data.callId,
        result:
          data.method === "renderView"
            ? renderOutput(value)
            : result(String(value)),
      });
    }
  } catch (error) {
    post({
      type: "error",
      generation: data.generation,
      callId: data.callId,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof PluginImportError ? { code: error.code } : {}),
    });
  } finally {
    current = undefined;
  }
};
