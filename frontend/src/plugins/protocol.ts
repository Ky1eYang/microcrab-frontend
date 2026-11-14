import type { PluginImportErrorCode } from "./component";
import type {
  Json,
  PluginContext,
  PluginEffect,
  PluginManifest,
  PluginResult,
  Vars,
} from "./types";
export type WorkerRequest = { generation: number; callId: number } & (
  | {
      type: "load";
      bytes: Uint8Array;
      context: PluginContext;
      cache: Record<string, string>;
      sessions: Json[];
      projects: Json[];
    }
  | {
      type: "call";
      method: "init" | "renderView" | "onAction" | "onPhase";
      args: string[];
      context: PluginContext;
    }
  | { type: "cache"; cache: Record<string, string> }
  | { type: "snapshots"; sessions: Json[]; projects: Json[] }
);
export type WorkerReply = { generation: number; callId: number } & (
  | {
      type: "loaded";
      manifest: PluginManifest;
      imports: string[];
      sourceKind: "core" | "component";
      normalizedBytes?: Uint8Array;
    }
  | { type: "result"; result: PluginResult }
  | { type: "error"; error: string; code?: PluginImportErrorCode }
  | {
      type: "effect";
      effect: PluginEffect & { request_id: number };
      context: PluginContext;
    }
);
export interface Instance {
  generation: number;
  worker: Worker;
  vars: Vars;
}
