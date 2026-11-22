import { HTTP_REQUEST_TIMEOUT, validateHttpRequestTimeout } from "./http-deadline";
import {
  authorizeKind,
  binaryImports,
  PluginImportError,
  wasmSourceKind,
} from "./component";
import { PluginNetwork } from "./network";
import { PluginResources } from "./resources";
import { approveNetworkGrant } from "./network-approval";
import { identityKey } from "./tool-hub";
import {
  assertJson,
  overlayVariables,
  validateProjection,
  resolveViewState,
  validateBlockSlot,
  validateBlockTextVariant,
  writePath,
} from "./schema";
import {
  ownRecordValue,
  setRecordValue,
  PluginStore,
  type Preferences,
} from "./store";
import {
  LIMITS,
  type BlockSlot,
  type BlockTextVariant,
  type HostEffectHandler,
  type InstalledPlugin,
  type Json,
  type PluginContext,
  type PluginToolIdentity,
  type PluginToolRequest,
  type PluginEffect,
  type PluginRegistryAPI,
  type PluginResult,
  type PluginView,
  type PluginSurfaceDescriptor,
  type PluginRenderOutput,
  type ViewTarget,
  type RuntimeOptions,
  type SubmitResult,
  type VariablesChange,
  type Vars,
} from "./types";
import type { WorkerReply, WorkerRequest } from "./protocol";
interface BundledPlugin {
  id: string;
  file: string;
  sha256: string;
  default_enabled: boolean;
  supersedes?: string[];
}
interface Live {
  worker: Worker;
  generation: number;
  vars: Vars;
  trees: Map<string, PluginRenderOutput>;
  surfaces: Map<
    string,
    { descriptor: PluginSurfaceDescriptor; visible: boolean; revision: number }
  >;
  surfaceSequence: number;
  renderTimes: number[];
  eventTimes: number[];
  queue: Promise<unknown>;
  queued: number;
  controllers: Map<AbortController, string | undefined>;
  network: PluginNetwork;
  resources: PluginResources;
  ready: boolean;
  effectIds: Set<number>;
  effectSequence: number;
}
class StalePluginCall extends Error {}
interface Pending {
  worker: Worker;
  generation: number;
  historyGeneration: number;
  sessionId: string | null;
  context: PluginContext;
  surfaceRevision?: number;
  isCurrent?: () => boolean;
  resolve: (r: WorkerReply) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
/** A tab-local owner. No Server API is imported; effects use the injected frozen bridge. */
export class PluginRegistry implements PluginRegistryAPI {
  private readonly store: PluginStore;
  private plugins = new Map<string, InstalledPlugin>();
  private live = new Map<string, Live>();
  private artifactReferences = new Map<string, string | null>();
  private listeners = new Set<() => void>();
  private snapshot: readonly InstalledPlugin[] = [];
  private preferences: Preferences = { sessions: {}, tombstones: [] };
  private preferenceWrites: Promise<void> = Promise.resolve();
  private updatePreferences(update: (draft: Preferences) => void): Promise<void> {
    const operation = this.preferenceWrites.then(async () => {
      this.assertActive();
      const draft = structuredClone(this.preferences);
      update(draft);
      await this.store.savePreferences(draft);
      this.assertActive();
      this.preferences = draft;
    });
    this.preferenceWrites = operation.catch(() => {});
    return operation;
  }
  private resultContexts = new WeakMap<PluginResult, PluginContext>();
  // Streams and native consent have a live user-facing lifecycle. Keep the
  // existing bounded receipt observation for ordinary, potentially mutating HTTP.
  private cancelOnSurfaceHide = new WeakSet<AbortController>();
  private pending = new Map<number, Pending>();
  private cleanupTools = new Map<
    string,
    {
      instance: Live;
      identity: PluginToolIdentity;
      controller: AbortController;
      expires: number;
      used: boolean;
    }
  >();
  private toolSeen = new Set<string>();
  private tools = new Map<
    string,
    {
      pluginId: string;
      instance: Live;
      identity: PluginToolIdentity;
      context: PluginContext;
      resolve: (value: Json) => void;
      reject: (error: Error) => void;
      controller: AbortController;
    }
  >();
  private generation = 0;
  private callId = 0;
  private sessionId: string | null = null;
  private sessionTransition = 0;
  private sessions: Json[] = [];
  private projects: Json[] = [];
  private environment: {
    locale?: string;
    theme?: string;
    target_visible?: boolean;
  } = {};
  private handler?: HostEffectHandler;
  private disposed = false;
  private initialized?: Promise<void>;
  private slots = new Map<string, BlockSlot & { pluginId: string }>();
  private variants = new Map<string, BlockTextVariant & { pluginId: string }>();
  getBlockVariants(blockId: string, sourceText?: string): readonly (BlockTextVariant & { pluginId: string })[] {
    const source = this.settled.get(blockId)?.payload;
    if (!source || typeof source !== "object" || Array.isArray(source) ||
        (sourceText !== undefined && source.text !== sourceText)) return [];
    return [...this.variants.values()].filter((variant) =>
      variant.block_id === blockId && this.isEnabled(variant.pluginId) &&
      this.plugins.get(variant.pluginId)?.status === "ready" &&
      variant.source_digest === source.source_digest &&
      variant.history_revision === source.history_revision);
  }
  private variantBytes(variants = this.variants): number {
    return new TextEncoder().encode(JSON.stringify([...variants.values()])).byteLength;
  }
  private retireVariantSurfaces(blockId: string, pluginId?: string, variantId?: string): void {
    for (const [id, instance] of this.live) {
      if (pluginId !== undefined && pluginId !== id) continue;
      for (const [key, mount] of instance.surfaces) {
        if (mount.descriptor.target === "block-slot" && mount.descriptor.block_id === blockId &&
            (variantId === undefined || mount.descriptor.slot_id === variantId)) {
          instance.surfaces.delete(key);
          instance.trees.delete(key);
          for (const [controller, surfaceId] of instance.controllers)
            if (surfaceId === key) {
              controller.abort(new Error("block variant retired"));
              instance.controllers.delete(controller);
            }
        }
      }
      instance.network.retireStale();
    }
  }
  private settled = new Map<string, { payload: Json; bytes: number }>();
  private settledBytes = 0;
  private historyGeneration = 0;
  constructor(private readonly options: RuntimeOptions) {
    this.store = new PluginStore(
      JSON.stringify([new URL(options.serverOrigin).origin, options.ownerId]),
    );
    this.handler = options.effectHandler;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): readonly InstalledPlugin[] => this.snapshot;
  private publish(): void {
    this.snapshot = [...this.plugins.values()]
      .sort(
        (a, b) =>
          a.priority - b.priority || a.manifest.id.localeCompare(b.manifest.id),
      )
      .map((p) => ({ ...p }));
    for (const listener of this.listeners) listener();
  }
  initialize(): Promise<void> {
    return (this.initialized ??= this.load());
  }
  private assertActive(): void {
    if (this.disposed) throw new Error("plugin registry disposed");
  }
  private async sha256(bytes: Uint8Array): Promise<string> {
    return [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
    ]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
  }
  private async readBundledIndex(): Promise<BundledPlugin[]> {
    this.assertActive();
    const response = await fetch("/plugins/current.json", {
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(`bundled plugin index fetch failed: ${response.status}`);
    const index = await response.json();
    this.assertActive();
    if (
      !index ||
      index.version !== 1 ||
      !Array.isArray(index.plugins) ||
      index.plugins.length > 64
    )
      throw new Error("invalid bundled plugin index or exceeds 64 plugins");
    const ids = new Set<string>();
    // Validate every entry before any installation can change persistent state.
    for (const item of index.plugins) {
      if (
        !item ||
        typeof item.id !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(item.id) ||
        typeof item.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.sha256) ||
        item.file !== `${item.id}/${item.sha256}/plugin.wasm` ||
        typeof item.default_enabled !== "boolean" ||
        (item.supersedes !== undefined &&
          (!Array.isArray(item.supersedes) ||
            item.supersedes.length > 16 ||
            item.supersedes.some(
              (hash: unknown) =>
                typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash),
            )))
      )
        throw new Error(
          "invalid bundled component path/hash, default_enabled or supersedes hashes",
        );
      if (ids.has(item.id))
        throw new Error(`duplicate bundled plugin id: ${item.id}`);
      ids.add(item.id);
    }
    return index.plugins;
  }
  private async installBundled(
    item: BundledPlugin,
    replace: boolean,
    invocation?: { sessionId: string | null; transition: number },
  ): Promise<boolean> {
    this.assertActive();
    const binary = await fetch(`/plugins/${item.file}`);
    if (!binary.ok)
      throw new Error(
        `bundled plugin fetch failed: ${item.id}: ${binary.status}`,
      );
    const length = binary.headers.get("Content-Length");
    if (length !== null && Number(length) > LIMITS.componentBytes)
      throw new Error(`bundled plugin exceeds 16 MiB: ${item.id}`);
    const bytes = new Uint8Array(await binary.arrayBuffer());
    if (bytes.length > LIMITS.componentBytes)
      throw new Error(`bundled plugin exceeds 16 MiB: ${item.id}`);
    if ((await this.sha256(bytes)) !== item.sha256)
      throw new Error(`bundled plugin SHA-256 mismatch: ${item.id}`);
    this.assertActive();
    if (!replace && this.plugins.has(item.id)) return false;
    await this.importComponent(
      bytes,
      {
        replace,
        expectedId: item.id,
        enabledByDefault: item.default_enabled,
      },
      invocation,
    );
    return true;
  }
  async restoreBundled(): Promise<number> {
    this.assertActive();
    const invocation = {
      sessionId: this.sessionId,
      transition: this.sessionTransition,
    };
    const index = await this.readBundledIndex();
    let restored = 0;
    for (const item of index) {
      this.assertActive();
      if (this.plugins.has(item.id)) continue;
      if (await this.installBundled(item, false, invocation)) restored++;
    }
    return restored;
  }
  private async load(): Promise<void> {
    this.preferences = await this.store.preferences();
    this.assertActive();
    const installed = await this.store.plugins();
    this.assertActive();
    for (const p of installed) {
      const artifact = await this.sha256(p.bytes);
      const referenceAvailable = await this.store.registerArtifactReference(
        p.manifest.id,
        artifact,
      );
      this.assertActive();
      this.artifactReferences.set(
        p.manifest.id,
        referenceAvailable ? artifact : null,
      );
      this.plugins.set(p.manifest.id, { ...p, artifact, status: "disabled" });
    }
    this.publish();
    // Normal startup honors removals. Only an explicit action restores tombstones.
    try {
      for (const item of await this.readBundledIndex()) {
        if (this.preferences.tombstones.includes(item.id)) continue;
        const existing = this.plugins.get(item.id);
        if (existing) {
          // An obsolete/unsupported installed ABI requires explicit replacement.
          // Inspect its bytes before considering bundled repair; persisted metadata
          // never authorizes an implicit ABI upgrade or rewrites retained choices.
          try {
            if (wasmSourceKind(existing.bytes) !== "component") continue;
            binaryImports(existing.bytes);
          } catch {
            continue;
          }
          const hash = await this.sha256(existing.bytes);
          // Only a declared predecessor authorizes automatic bundled repair.
          if (hash === item.sha256 || !item.supersedes?.includes(hash))
            continue;
        }
        await this.installBundled(item, existing !== undefined);
      }
    } catch (error) {
      console.warn(
        "Client plugin default installation failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (this.disposed) return;
    for (const p of this.plugins.values())
      if (this.isEnabled(p.manifest.id))
        void this.start(p.manifest.id).catch(() => {});
  }
  private createWorker(): Worker {
    if (this.disposed) throw new Error("plugin registry disposed");
    return (
      this.options.workerFactory?.() ??
      new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
    );
  }
  private context(
    generation: number,
    surface?: PluginSurfaceDescriptor,
  ): PluginContext {
    const entry = [...this.live.entries()].find(([, live]) => live.generation === generation);
    const mount = surface ? entry?.[1].surfaces.get(surface.surface_id) : undefined;
    return {
      schema_version: 1,
      server_origin: new URL(this.options.serverOrigin).origin,
      owner_id: this.options.ownerId,
      session_id: this.sessionId,
      instance_generation: generation,
      ...this.environment,
      history_generation: this.historyGeneration,
      host_http_timeout_ms: entry ? this.getHttpRequestTimeout(entry[0]) : HTTP_REQUEST_TIMEOUT.defaultMs,
      host_time_ms: Date.now(),
      host_monotonic_ms: performance.now(),
      ...(surface
        ? {
            surface: structuredClone(surface),
            surface_id: surface.surface_id,
            surface_generation: mount?.revision,
            target_visible: mount?.visible ?? true,
          }
        : {}),
    };
  }
  private bind(worker: Worker, id?: string): void {
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      if (data.type === "effect") {
        // Worker messages retain order: legitimate import effects precede their
        // call result. A delayed old effect must not gain the current history's
        // authority merely because its instance and Session are still alive.
        const pending = this.pending.get(data.callId);
        if (
          !pending ||
          (pending.isCurrent && !pending.isCurrent()) ||
          pending.worker !== worker ||
          pending.generation !== data.generation ||
          pending.historyGeneration !== this.historyGeneration ||
          pending.sessionId !== this.sessionId ||
          data.context.session_id !== pending.sessionId ||
          (pending.context.surface &&
            (this.live
              .get(id ?? "")
              ?.surfaces.get(pending.context.surface.surface_id)?.revision !==
              pending.surfaceRevision ||
              !this.live
                .get(id ?? "")
                ?.surfaces.get(pending.context.surface.surface_id)?.visible))
        )
          return;
        if (id) {
          const instance = this.live.get(id);
          if (
            instance?.worker === worker &&
            instance.generation === data.generation
          ) {
            if (!instance.ready) {
              this.fault(
                id,
                new Error("manifest must not issue host requests"),
              );
              return;
            }
            void this.effect(id, instance, data.effect, pending.context).catch(
              (e) => this.fault(id, e),
            );
          }
        }
        return;
      }
      const p = this.pending.get(data.callId);
      if (!p || p.worker !== worker || p.generation !== data.generation) return;
      clearTimeout(p.timer);
      this.pending.delete(data.callId);
      if (data.type === "error")
        p.reject(
          data.code
            ? new PluginImportError(data.code, data.error)
            : new Error(data.error),
        );
      else p.resolve(data);
    };
    worker.onerror = (event) => {
      const error = new Error(`plugin Worker failed: ${event.message}`);
      for (const [key, p] of this.pending)
        if (p.worker === worker) {
          clearTimeout(p.timer);
          this.pending.delete(key);
          p.reject(error);
        }
      if (id) this.fault(id, error);
    };
    worker.onmessageerror = () => {
      if (id)
        this.fault(id, new Error("plugin Worker message could not be decoded"));
    };
  }
  private send(
    worker: Worker,
    generation: number,
    data:
      | Omit<Extract<WorkerRequest, { type: "load" }>, "generation" | "callId">
      | Omit<Extract<WorkerRequest, { type: "call" }>, "generation" | "callId">,
    timeout: number,
    isCurrent?: () => boolean,
  ): Promise<WorkerReply> {
    if (this.pending.size >= LIMITS.pending)
      return Promise.reject(new Error("plugin exceeds 128 pending calls"));
    const callId = ++this.callId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(callId);
          worker.terminate();
          const error = new Error(
            `plugin ${data.type} exceeded main-thread deadline ${timeout}ms`,
          );
          for (const [id, instance] of this.live)
            if (instance.worker === worker) this.fault(id, error);
          reject(error);
        },
        Math.max(1, timeout),
      );
      this.pending.set(callId, {
        worker,
        generation,
        historyGeneration: this.historyGeneration,
        sessionId: data.context.session_id,
        context: structuredClone(data.context),
        isCurrent,
        surfaceRevision: data.context.surface
          ? [...this.live.values()]
              .find((live) => live.worker === worker)
              ?.surfaces.get(data.context.surface.surface_id)?.revision
          : undefined,
        resolve,
        reject,
        timer,
      });
      worker.postMessage({
        ...data,
        generation,
        callId,
      } satisfies WorkerRequest);
    });
  }
  async importPlugin(
    bytes: Uint8Array,
    options: {
      replace?: boolean;
      enabledByDefault?: boolean;
      expectedId?: string;
    } = {},
  ): Promise<InstalledPlugin> {
    return this.importComponent(bytes, options);
  }
  private async importComponent(
    bytes: Uint8Array,
    options: {
      replace?: boolean;
      enabledByDefault?: boolean;
      expectedId?: string;
    },
    invocation?: { sessionId: string | null; transition: number },
  ): Promise<InstalledPlugin> {
    this.assertActive();
    wasmSourceKind(bytes);
    const worker = this.createWorker(),
      generation = ++this.generation;
    this.bind(worker);
    let reply: WorkerReply;
    try {
      reply = await this.send(
        worker,
        generation,
        {
          type: "load",
          bytes: bytes.slice(),
          context: this.context(generation),
          cache: {},
          sessions: this.sessions,
          projects: this.projects,
        },
        LIMITS.startupMs,
      );
    } finally {
      worker.terminate();
    }
    this.assertActive();
    if (reply.type !== "loaded")
      throw new Error("unexpected Component inspection response");
    const storedBytes = reply.normalizedBytes ?? bytes;
    if (
      !(storedBytes instanceof Uint8Array) ||
      wasmSourceKind(storedBytes) !== "component" ||
      (reply.normalizedBytes !== undefined && reply.sourceKind !== "core") ||
      (reply.sourceKind === "core" && reply.normalizedBytes === undefined)
    )
      throw new Error("invalid normalized Component inspection response");
    if (
      options.expectedId !== undefined &&
      reply.manifest.id !== options.expectedId
    )
      throw new Error(
        `update expected plugin ${options.expectedId}, but Component manifest declares ${reply.manifest.id}`,
      );
    const id = reply.manifest.id,
      old = this.plugins.get(id);
    if (old && !options.replace)
      throw new PluginImportError(
        "already-installed",
        `plugin already installed: ${id}; use update`,
      );
    if (!old && this.plugins.size >= 64)
      throw new Error("client installation exceeds 64 plugins");
    if (
      [...this.plugins.values()].reduce(
        (sum, p) => sum + (p.manifest.id === id ? 0 : p.bytes.length),
        storedBytes.length,
      ) >
      64 * 1024 * 1024
    )
      throw new Error("installed plugin Components exceed 64 MiB total");
    const artifact = await this.sha256(storedBytes);
    const referenceAvailable = await this.store.registerArtifactReference(
      id,
      artifact,
    );
    this.assertActive();
    this.stop(id);
    const p: InstalledPlugin = {
      manifest: reply.manifest,
      imports: reply.imports,
      bytes: storedBytes.slice(),
      importFormat: reply.sourceKind,
      providesTools: reply.providesTools,
      artifact,
      priority: old?.priority ?? this.plugins.size,
      enabledByDefault:
        old?.enabledByDefault ?? options.enabledByDefault ?? false,
      status: "disabled",
    };
    await this.store.put(p);
    this.assertActive();
    this.plugins.set(id, p);
    this.artifactReferences.set(id, referenceAvailable ? artifact : null);
    await this.updatePreferences((draft) => {
      draft.tombstones = draft.tombstones.filter(
        (x) => x !== id,
      );
      if (invocation?.sessionId !== undefined && invocation.sessionId !== null) {
        let choices = ownRecordValue(
          draft.sessions,
          invocation.sessionId,
        );
        if (!choices) {
          choices = {};
          setRecordValue(
            draft.sessions,
            invocation.sessionId,
            choices,
          );
        }
        setRecordValue(choices, id, p.enabledByDefault);
      }
    });
    this.assertActive();
    this.publish();
    if (
      (!invocation ||
        (invocation.sessionId === this.sessionId &&
          invocation.transition === this.sessionTransition)) &&
      this.isEnabled(id)
    )
      await this.start(id);
    return { ...this.plugins.get(id)! };
  }
  async remove(id: string): Promise<void> {
    this.stop(id);
    await this.store.remove(id);
    this.plugins.delete(id);
    this.artifactReferences.delete(id);
    await this.updatePreferences((draft) => {
      if (!draft.tombstones.includes(id))
        draft.tombstones.push(id);
      for (const enabled of Object.values(draft.sessions))
        delete enabled[id];
    });
    this.publish();
  }
  async restart(id: string): Promise<void> {
    this.assertActive();
    const p = this.require(id);
    if (!this.isEnabled(id))
      throw new Error(`plugin is disabled in the current Session: ${id}`);
    const session = this.sessionId,
      transition = this.sessionTransition;
    this.stop(id);
    p.error = undefined;
    p.status = "disabled";
    this.publish();
    // Publishing may synchronously change scope or enablement through a listener.
    if (
      session !== this.sessionId ||
      transition !== this.sessionTransition ||
      !this.isEnabled(id)
    )
      throw new StalePluginCall(
        "Session or enablement changed during plugin restart",
      );
    await this.start(id);
    if (session !== this.sessionId || transition !== this.sessionTransition)
      throw new StalePluginCall("Session changed during plugin restart");
  }
  async reset(id: string): Promise<void> {
    this.require(id);
    this.stop(id);
    await this.store.clearKV(id);
    PluginResources.reset(this.options.serverOrigin, this.options.ownerId, id);
    const p = this.require(id);
    p.error = undefined;
    p.status = "disabled";
    this.publish();
    if (this.isEnabled(id)) await this.start(id);
  }
  async setDefaultEnabled(id: string, enabled: boolean): Promise<void> {
    const p = this.require(id);
    p.enabledByDefault = enabled;
    await this.store.put(p);
    this.publish();
    if (!this.sessionId) {
      if (enabled) await this.start(id);
      else this.stop(id);
    }
  }
  async setEnabled(
    id: string,
    sessionId: string,
    enabled: boolean,
  ): Promise<void> {
    this.require(id);
    await this.updatePreferences((draft) => {
      let choices = ownRecordValue(draft.sessions, sessionId);
      if (!choices) {
        choices = {};
        setRecordValue(draft.sessions, sessionId, choices);
      }
      setRecordValue(choices, id, enabled);
    });
    if (sessionId === this.sessionId) {
      if (enabled) await this.start(id);
      else this.stop(id);
    }
    this.publish();
  }
  isEnabled(id: string, sessionId: string | null = this.sessionId): boolean {
    const p = this.plugins.get(id);
    if (!p) return false;
    const saved = sessionId
      ? ownRecordValue(this.preferences.sessions, sessionId)
      : undefined;
    return saved ? (ownRecordValue(saved, id) ?? false) : p.enabledByDefault;
  }
  async setPriority(id: string, priority: number): Promise<void> {
    if (!Number.isFinite(priority) || Math.abs(priority) > 1000000)
      throw new Error("plugin priority outside supported range");
    const p = this.require(id);
    p.priority = priority;
    await this.store.put(p);
    this.publish();
  }
  async setSession(
    sessionId: string | null,
    snapshots?: { sessions?: Json[]; projects?: Json[] },
  ): Promise<void> {
    if (sessionId === this.sessionId) {
      if (!snapshots) return;
      this.sessions = structuredClone(snapshots.sessions ?? this.sessions);
      this.projects = structuredClone(snapshots.projects ?? this.projects);
      assertJson(this.sessions);
      assertJson(this.projects);
      for (const instance of this.live.values())
        instance.worker.postMessage({
          type: "snapshots",
          sessions: this.sessions,
          projects: this.projects,
          generation: instance.generation,
          callId: 0,
        } satisfies WorkerRequest);
      this.observe("session-list-changed", {
        sessions: this.sessions,
        projects: this.projects,
      });
      return;
    }
    const transition = ++this.sessionTransition;
    for (const id of this.live.keys()) this.stop(id);
    this.sessionId = sessionId;
    if (sessionId && !ownRecordValue(this.preferences.sessions, sessionId)) {
      await this.updatePreferences((draft) => {
        setRecordValue(
          draft.sessions,
          sessionId,
          Object.fromEntries(
            [...this.plugins.values()].map((p) => [
              p.manifest.id,
              p.enabledByDefault,
            ]),
          ),
        );
      });
    }
    if (transition !== this.sessionTransition || this.disposed) return;
    this.sessions = structuredClone(snapshots?.sessions ?? this.sessions);
    this.projects = structuredClone(snapshots?.projects ?? this.projects);
    this.slots.clear();
    this.variants.clear();
    this.settled.clear();
    this.settledBytes = 0;
    this.historyGeneration++;
    this.publish();
    await Promise.all(
      [...this.plugins.keys()]
        .filter((id) => this.isEnabled(id))
        .map((id) => this.start(id).catch(() => {})),
    );
  }
  setEffectHandler(handler: HostEffectHandler): void {
    this.handler = handler;
  }
  setEnvironment(environment: {
    locale?: string;
    theme?: string;
    target_visible?: boolean;
  }): void {
    this.environment = { ...this.environment, ...environment };
    this.observe("environment-changed", environment as Json);
  }
  getHttpRequestTimeout(id: string): number {
    this.require(id);
    return ownRecordValue(this.preferences.request_timeout_ms ?? {}, id) ?? HTTP_REQUEST_TIMEOUT.defaultMs;
  }
  async setHttpRequestTimeout(id: string, timeoutMs: number): Promise<void> {
    this.assertActive();
    this.require(id);
    validateHttpRequestTimeout(timeoutMs);
    await this.updatePreferences((draft) => {
      draft.request_timeout_ms ??= {};
      setRecordValue(draft.request_timeout_ms, id, timeoutMs);
    });
    this.publish();
  }
  private require(id: string): InstalledPlugin {
    const p = this.plugins.get(id);
    if (!p) throw new Error(`plugin is not installed: ${id}`);
    return p;
  }
  private async start(id: string): Promise<void> {
    const previous = this.live.get(id);
    if (previous) return previous.queue.then(() => {});
    const p = this.require(id);
    if (!p.artifact) throw Error("Plugin artifact pin is unavailable");
    const resources = new PluginResources(
      this.options.serverOrigin,
      this.options.ownerId,
      id,
      p.artifact,
    );
    const worker = this.createWorker(),
      generation = ++this.generation;
    const instance: Live = {
      worker,
      generation,
      vars: {},
      trees: new Map(),
      surfaces: new Map(),
      surfaceSequence: 0,
      renderTimes: [],
      eventTimes: [],
      queue: Promise.resolve(),
      queued: 0,
      controllers: new Map(),
      resources,
      network: new PluginNetwork(
        p.manifest,
        (requestId, value) =>
          this.completion(id, instance, requestId, true, value),
        resources,
      ),
      ready: false,
      effectIds: new Set(),
      effectSequence: 0,
    };
    this.live.set(id, instance);
    this.bind(worker, id);
    p.status = "loading";
    p.error = undefined;
    this.publish();
    const load = async () => {
      try {
        const cache = await this.store.kv(id);
        if (this.live.get(id) !== instance) return;
        const reply = await this.send(
          worker,
          generation,
          {
            type: "load",
            bytes: p.bytes,
            context: this.context(generation),
            cache,
            sessions: this.sessions,
            projects: this.projects,
          },
          LIMITS.startupMs,
        );
        if (
          reply.type !== "loaded" ||
          JSON.stringify(reply.imports) !== JSON.stringify(p.imports) ||
          JSON.stringify(reply.manifest) !== JSON.stringify(p.manifest)
        )
          throw new Error(
            "installed Component inspection differs from persisted manifest/imports",
          );
        if (this.live.get(id) !== instance) return;
        p.providesTools = reply.providesTools;
        const artifact = await this.sha256(p.bytes);
        const referenceAvailable = await this.store.registerArtifactReference(
          id,
          artifact,
        );
        if (this.live.get(id) !== instance) return;
        p.artifact = artifact;
        this.artifactReferences.set(id, referenceAvailable ? artifact : null);
        instance.ready = true;
        const session = this.sessionId,
          deadline = Date.now() + LIMITS.callMs;
        let init: PluginResult;
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0)
            throw new Error("plugin init exceeded history recovery deadline");
          try {
            init = await this.invoke(
              id,
              instance,
              "init",
              [JSON.stringify(this.context(generation))],
              remaining,
            );
            break;
          } catch (error) {
            // History can arrive while the initial subscription is loading.
            // Reinitialize only the retained instance, sharing one call budget.
            if (
              !(error instanceof StalePluginCall) ||
              this.live.get(id) !== instance ||
              session !== this.sessionId
            )
              throw error;
          }
        }
        this.apply(id, instance, init);
        p.status = "ready";
        if (!referenceAvailable)
          p.error =
            "Plugin artifact reference is ambiguous; short discovery is unavailable; use the full SHA-256";
        this.publish();
        if (this.settled.size) {
          const history = this.historyGeneration,
            blocks = [...this.settled.values()].map((entry) => entry.payload);
          queueMicrotask(() => {
            if (
              this.live.get(id) !== instance ||
              history !== this.historyGeneration
            )
              return;
            void this.enqueue(id, async (live) => {
              const r = await this.invoke(
                id,
                live,
                "onPhase",
                [
                  "settled-blocks",
                  JSON.stringify({ blocks }),
                  JSON.stringify(live.vars),
                  JSON.stringify(this.context(live.generation)),
                ],
                LIMITS.callMs,
              );
              this.apply(id, live, r);
            }).catch((error) => {
              if (
                !(error instanceof StalePluginCall) &&
                this.live.get(id) === instance
              )
                this.fault(id, error);
            });
          });
        }
      } catch (error) {
        if (this.live.get(id) === instance) this.fault(id, error);
        throw error;
      }
    };
    instance.queue = load();
    return instance.queue.then(() => {});
  }
  private stop(id: string): void {
    const instance = this.live.get(id);
    if (instance) {
      this.live.delete(id);
      instance.worker.terminate();
      instance.network.close();
      instance.resources.close();
      for (const [key, cleanup] of this.cleanupTools)
        if (cleanup.instance === instance) {
          this.cleanupTools.delete(key);
          cleanup.controller.abort();
        }
      for (const [key, tool] of this.tools)
        if (tool.instance === instance) {
          this.tools.delete(key);
          tool.controller.abort();
          tool.reject(
            new Error("Plugin authority retired; outcome may be unknown"),
          );
        }
      for (const controller of instance.controllers.keys()) controller.abort();
      for (const [key, p] of this.pending)
        if (p.worker === instance.worker) {
          clearTimeout(p.timer);
          this.pending.delete(key);
          p.reject(new StalePluginCall("plugin instance ended"));
        }
    }
    for (const [key, variant] of this.variants)
      if (variant.pluginId === id) this.variants.delete(key);
    for (const [key, slot] of this.slots)
      if (slot.pluginId === id) this.slots.delete(key);
    const plugin = this.plugins.get(id);
    if (plugin && plugin.status !== "faulted") plugin.status = "disabled";
    this.publish();
  }
  private fault(id: string, error: unknown): void {
    this.stop(id);
    const p = this.plugins.get(id);
    if (p) {
      p.status = "faulted";
      p.error = error instanceof Error ? error.message : String(error);
      this.publish();
    }
  }
  private async invoke(
    id: string,
    instance: Live,
    method:
      | "init"
      | "renderView"
      | "onAction"
      | "onPhase"
      | "startTool"
      | "cancelTool",
    args: string[],
    timeout: number,
    surface?: PluginSurfaceDescriptor,
    captured?: PluginContext,
    isCurrent?: () => boolean,
  ): Promise<PluginResult> {
    if (this.live.get(id) !== instance)
      throw new StalePluginCall("stale plugin instance");
    const authority = captured ?? {
        ...this.context(instance.generation, surface),
        user_action: method === "onAction",
        invocation_id: crypto.randomUUID(),
      },
      context: PluginContext = {
        ...authority,
        host_time_ms: Date.now(),
        host_monotonic_ms: performance.now(),
      },
      history = this.historyGeneration;
    const surfaceRevision = surface
      ? instance.surfaces.get(surface.surface_id)?.revision
      : undefined;
    args = [...args];
    args[args.length - 1] = JSON.stringify(context);
    const response = await this.send(
      instance.worker,
      instance.generation,
      { type: "call", method, args, context },
      timeout,
      isCurrent,
    );
    if (
      this.live.get(id) !== instance ||
      context.session_id !== this.sessionId ||
      history !== this.historyGeneration ||
      (surface &&
        (instance.surfaces.get(surface.surface_id)?.revision !==
          surfaceRevision ||
          instance.surfaces.get(surface.surface_id)?.visible === false))
    )
      throw new StalePluginCall("stale plugin call result discarded");
    if (response.type !== "result")
      throw new Error("unexpected plugin call response");
    this.resultContexts.set(response.result, context);
    return response.result;
  }
  private enqueue<T>(
    id: string,
    work: (instance: Live) => Promise<T>,
  ): Promise<T> {
    const instance = this.live.get(id);
    if (!instance)
      return Promise.reject(new Error(`plugin ${id} is not enabled/ready`));
    const now = Date.now();
    instance.eventTimes = instance.eventTimes.filter((t) => now - t < 1000);
    if (
      instance.queued >= LIMITS.eventQueue ||
      instance.eventTimes.length >= LIMITS.eventQueue
    ) {
      this.fault(
        id,
        new Error("plugin exceeds 128 queued events or events per second"),
      );
      return Promise.reject(
        new Error("plugin event queue/rate quota exceeded"),
      );
    }
    instance.eventTimes.push(now);
    instance.queued++;
    const history = this.historyGeneration,
      session = this.sessionId;
    const task = instance.queue.then(() => {
      if (
        this.live.get(id) !== instance ||
        history !== this.historyGeneration ||
        session !== this.sessionId
      )
        throw new StalePluginCall("stale plugin event dropped");
      return work(instance);
    });
    instance.queue = task
      .catch(() => {})
      .finally(() => {
        instance.queued--;
      });
    return task;
  }
  private apply(
    id: string,
    instance: Live,
    r: PluginResult,
    target?: string,
    context?: PluginContext,
  ): void {
    if (this.live.get(id) !== instance) return;
    const invoked = this.resultContexts.get(r);
    context ??= invoked;
    // Preserve explicit surface/tool authority while sharing the actual invocation's
    // HTTP snapshot with queued imports and the guest's returned JSON effects.
    if (context && invoked)
      context = { ...context, host_http_timeout_ms: invoked.host_http_timeout_ms };
    const vars = r.vars_patch
      ? { ...instance.vars, ...r.vars_patch }
      : instance.vars;
    assertJson(vars);
    const trees = new Map(instance.trees);
    const retiredSurfaces = new Set<string>();
    let slots = this.slots;
    if (r.remove_block_slots !== undefined) {
      authorizeKind(this.require(id).imports, "block-slots");
      if (
        !Array.isArray(r.remove_block_slots) ||
        r.remove_block_slots.length > 128
      )
        throw new Error("block slot removal quota exceeded");
      slots = new Map(slots);
      const seen = new Set<string>();
      for (const removal of r.remove_block_slots) {
        const pair = JSON.stringify([removal.block_id, removal.slot_id]);
        if (seen.has(pair))
          throw new Error("duplicate block slot removal identity");
        seen.add(pair);
        const key = JSON.stringify([id, removal.block_id, removal.slot_id]);
        const existing = slots.get(key);
        if (
          !existing ||
          existing.pluginId !== id ||
          existing.block_id !== removal.block_id ||
          existing.slot_id !== removal.slot_id
        )
          throw new Error(
            "block slot removal does not address an existing owned slot",
          );
        slots.delete(key);
        for (const [surfaceId, mount] of instance.surfaces) {
          if (
            mount.descriptor.target === "block-slot" &&
            mount.descriptor.block_id === removal.block_id &&
            mount.descriptor.slot_id === removal.slot_id
          ) {
            retiredSurfaces.add(surfaceId);
            trees.delete(surfaceId);
          }
        }
      }
    }
    if (r.view_output && target) {
      if (retiredSurfaces.has(target))
        throw new Error("retired block slot cannot publish a replacement view");
      trees.set(target, r.view_output);
    }
    for (const output of trees.values()) {
      if (output.tree) validateProjection(output.tree, vars);
      if (output.mode === "webview-html")
        resolveViewState(output.viewState, vars);
    }
    if (r.block_slots) {
      authorizeKind(this.require(id).imports, "block-slots");
      if (r.block_slots.length > 64)
        throw new Error("plugin exceeds 64 settled slots per call");
      slots = new Map(slots);
      for (const slot of r.block_slots) {
        if (!this.settled.has(slot.block_id))
          throw new Error(
            `decoration target is not a settled block: ${slot.block_id}`,
          );
        validateBlockSlot(slot);
        if (slot.tree) validateProjection(slot.tree, vars);
        slots.set(JSON.stringify([id, slot.block_id, slot.slot_id]), {
          ...slot,
          pluginId: id,
        });
      }
      if (slots.size > 512)
        throw new Error("plugin settled slot quota exceeds 512");
    }
    for (const slot of slots.values())
      if (slot.pluginId === id && slot.tree)
        validateProjection(slot.tree, vars);
    const variants = new Map(this.variants);
    const variantRetirements: { block_id: string; variant_id: string }[] = [];
    if (r.block_variants !== undefined || r.remove_block_variants !== undefined) {
      authorizeKind(this.require(id).imports, "block-slots");
      if ((r.block_variants?.length ?? 0) > 128 || (r.remove_block_variants?.length ?? 0) > 128)
        throw new Error("block variant per-call quota exceeds 128");
      const removals = new Set<string>();
      for (const removal of r.remove_block_variants ?? []) {
        const key = JSON.stringify([id, removal.block_id, removal.variant_id]);
        if (removals.has(key)) throw new Error("duplicate block variant removal");
        removals.add(key);
        if (!variants.has(key)) throw new Error("block variant removal does not address an existing owned variant");
        variants.delete(key);
        variantRetirements.push(removal);
      }
      const additions = new Set<string>();
      for (const variant of r.block_variants ?? []) {
        validateBlockTextVariant(variant);
        const key = JSON.stringify([id, variant.block_id, variant.variant_id]);
        if (additions.has(key) || removals.has(key)) throw new Error("duplicate or conflicting block variant identity");
        additions.add(key);
        const source = this.settled.get(variant.block_id)?.payload;
        if (!source || typeof source !== "object" || Array.isArray(source) || source.kind !== "text" ||
            source.role !== "assistant" || source.text_truncated === true ||
            typeof source.text !== "string" || !source.text ||
            variant.source_digest !== source.source_digest || variant.history_revision !== source.history_revision)
          throw new Error("block variant does not match a current untruncated settled assistant text source");
        variants.set(key, { ...variant, pluginId: id });
      }
      if (variants.size > 512 || this.settledBytes + this.variantBytes(variants) > LIMITS.retainedBytes)
        throw new Error("block variant retained count or byte quota exceeded");
    }
    for (const effect of r.effects ?? [])
      authorizeKind(this.require(id).imports, effect.kind);
    // A rejected projection/patch must not publish a terminal tool success or
    // abort its observation scope before the complete result passes admission.
    if (r.tool_completion) {
      const c = r.tool_completion;
      const tool = this.tools.get(c.identity.invocation_id);
      if (
        !tool ||
        tool.pluginId !== id ||
        tool.instance !== instance ||
        identityKey(c.identity) !== identityKey(tool.identity) ||
        !this.currentContext(instance, tool.context)
      )
        throw new StalePluginCall(
          "Tool completion identity expired or differs",
        );
      if (c.status !== "pending") {
        this.tools.delete(c.identity.invocation_id);
        tool.controller.abort();
        if (c.status === "completed" && c.output !== undefined)
          tool.resolve(c.output);
        else
          tool.reject(
            new Error(
              (c.error ?? "Plugin tool failed") +
                (c.outcome_unknown
                  ? "; outcome unknown; do not retry automatically"
                  : ""),
            ),
          );
      }
    }
    // All sibling slots, projections, effects and terminal receipts validated.
    // Retire old mounts before publishing new variables so index reuse cannot
    // route another block's projection into an evicted iframe.
    for (const surfaceId of retiredSurfaces)
      instance.surfaces.delete(surfaceId);
    for (const [controller, surfaceId] of instance.controllers) {
      if (surfaceId !== undefined && retiredSurfaces.has(surfaceId)) {
        controller.abort(new Error("block slot retired"));
        instance.controllers.delete(controller);
      }
    }
    instance.network.retireStale();
    instance.vars = vars;
    instance.trees = trees;
    this.slots = slots;
    this.variants = variants;
    for (const removal of variantRetirements)
      this.retireVariantSurfaces(removal.block_id, id, removal.variant_id);
    for (const effect of r.effects ?? [])
      void this.effect(
        id,
        instance,
        effect,
        context ?? this.context(instance.generation),
      ).catch((error) => this.fault(id, error));
    if (r.rerender) {
      const targets = [...instance.trees.keys()];
      // Keep each mounted output until its forced render validates and replaces it.
      // Publishing an empty cache here would unmount HTML documents and drafts
      // before the queued render/host completion can acknowledge the action.
      for (const name of targets) {
        const mounted = instance.surfaces.get(name);
        if (mounted?.visible)
          void this.render(
            id,
            mounted.descriptor.target,
            true,
            mounted.descriptor,
          ).catch(() => {});
      }
    }
    this.publish();
  }
  private surface(
    target: string,
    descriptor?: PluginSurfaceDescriptor,
  ): PluginSurfaceDescriptor {
    if (
      ![
        "sidebar",
        "expanded-page",
        "session-tab",
        "block-slot",
        "setting-page",
      ].includes(target)
    )
      throw new Error(`unsupported view target: ${target}`);
    const surface = descriptor ?? {
      surface_id: `default:${target}`,
      target: target as ViewTarget,
    };
    if (
      surface.target !== target ||
      !surface.surface_id ||
      surface.surface_id.length > 512
    )
      throw new Error("invalid host surface identity/target");
    if (target === "block-slot" && (!surface.block_id || !surface.slot_id))
      throw new Error("block surface requires exact block and slot identity");
    return structuredClone(surface);
  }
  releaseSurface(id: string, descriptor: PluginSurfaceDescriptor): void {
    const instance = this.live.get(id);
    if (!instance) return;
    this.setSurfaceVisible(id, descriptor, false);
    instance.surfaces.delete(descriptor.surface_id);
    instance.trees.delete(descriptor.surface_id);
    instance.network.retireStale();
  }
  setSurfaceVisible(
    id: string,
    descriptor: PluginSurfaceDescriptor,
    visible: boolean,
  ): void {
    const surface = this.surface(descriptor.target, descriptor),
      instance = this.live.get(id);
    if (!instance) return;
    const previous = instance.surfaces.get(surface.surface_id);
    if (
      previous &&
      JSON.stringify(previous.descriptor) !== JSON.stringify(surface)
    )
      throw new Error(
        "surface identity cannot be rebound to another target/block",
      );
    // Cleanup after eviction/reset must not recreate a retired mount.
    if (!previous && !visible) return;
    if (visible && surface.block_id && !this.settled.has(surface.block_id))
      throw new StalePluginCall(
        "block surface is not settled in the current history",
      );
    if (
      visible &&
      surface.target === "block-slot" &&
      !this.slots.has(JSON.stringify([id, surface.block_id, surface.slot_id])) &&
      !this.variants.has(JSON.stringify([id, surface.block_id, surface.slot_id]))
    )
      throw new StalePluginCall("block slot is absent or retired");
    if (previous?.visible === visible) return;
    if (!previous && instance.surfaces.size >= 512)
      throw new Error("plugin exceeds 512 surface identities per instance");
    instance.surfaces.set(surface.surface_id, {
      descriptor: surface,
      visible,
      revision: ++instance.surfaceSequence,
    });
    if (!visible) {
      instance.trees.delete(surface.surface_id);
      for (const [controller, surfaceId] of instance.controllers)
        if (surfaceId === surface.surface_id && this.cancelOnSurfaceHide.has(controller))
          controller.abort(new Error("plugin network surface retired"));
    }
    instance.network.retireStale();
    this.publish();
  }
  view(
    id: string,
    target: string,
    descriptor?: PluginSurfaceDescriptor,
  ): PluginView {
    const p = this.require(id),
      instance = this.live.get(id),
      surface = this.surface(target, descriptor),
      output = instance?.trees.get(surface.surface_id);
    return {
      pluginId: id,
      target,
      mode: output?.mode ?? "native-json",
      content: output?.content,
      viewState:
        output?.mode === "webview-html"
          ? resolveViewState(output.viewState, instance?.vars ?? {})
          : output?.viewState,
      tree: output?.tree ?? null,
      vars: instance?.vars ?? {},
      surface,
      instanceGeneration: instance?.generation,
      historyGeneration: this.historyGeneration,
      status: p.status,
      error: p.error,
    };
  }
  async render(
    id: string,
    target: string,
    force = false,
    descriptor?: PluginSurfaceDescriptor,
  ): Promise<PluginView> {
    const p = this.require(id),
      surface = this.surface(target, descriptor);
    if (!p.manifest.targets.includes(target as ViewTarget))
      throw new Error(`plugin ${id} does not declare target ${target}`);
    if (!this.isEnabled(id)) return this.view(id, target, surface);
    const existing = this.live.get(id);
    if (existing && !existing.surfaces.has(surface.surface_id))
      this.setSurfaceVisible(id, surface, true);
    const originRevision = existing?.surfaces.get(surface.surface_id)?.revision;
    if (existing?.trees.has(surface.surface_id) && !force)
      return this.view(id, target, surface);
    await this.enqueue(id, async (instance) => {
      if (!instance.surfaces.has(surface.surface_id)) {
        if (originRevision !== undefined)
          throw new StalePluginCall("render surface was retired");
        this.setSurfaceVisible(id, surface, true);
      }
      const mount = instance.surfaces.get(surface.surface_id)!;
      if (
        !mount.visible ||
        (originRevision !== undefined && mount.revision !== originRevision) ||
        (surface.block_id && !this.settled.has(surface.block_id))
      )
        throw new StalePluginCall(
          "surface is hidden, retired or outside current settled history",
        );
      if (instance.trees.has(surface.surface_id) && !force) return;
      const now = Date.now();
      instance.renderTimes = instance.renderTimes.filter((t) => now - t < 1000);
      if (instance.renderTimes.length >= LIMITS.rendersPerSecond)
        throw new Error("plugin exceeds 12 structural renders per second");
      instance.renderTimes.push(now);
      const ctx = this.context(instance.generation, surface);
      const r = await this.invoke(
        id,
        instance,
        "renderView",
        [target, JSON.stringify(instance.vars), JSON.stringify(ctx)],
        LIMITS.callMs,
        surface,
      );
      if (!r.view_output)
        throw new Error("render-view did not return a typed view output");
      this.apply(id, instance, r, surface.surface_id, ctx);
    }).catch((error) => {
      if (!(error instanceof StalePluginCall)) this.fault(id, error);
      throw error;
    });
    return this.view(id, target, surface);
  }
  async action(
    id: string,
    action: string,
    payload: Json = null,
    descriptor?: PluginSurfaceDescriptor,
  ): Promise<void> {
    assertJson(payload);
    const surface = descriptor
      ? this.surface(descriptor.target, descriptor)
      : this.surface("sidebar");
    if (
      !descriptor &&
      this.live.has(id) &&
      !this.live.get(id)!.surfaces.has(surface.surface_id)
    )
      this.setSurfaceVisible(id, surface, true);
    const original = this.live.get(id),
      mount = original?.surfaces.get(surface.surface_id),
      revision = mount?.revision;
    if (!mount?.visible)
      throw new StalePluginCall("action surface is not mounted/visible");
    const sameDescriptor = (actual: PluginSurfaceDescriptor | undefined) =>
      actual?.surface_id === surface.surface_id && actual.target === surface.target &&
      actual.block_id === surface.block_id && actual.slot_id === surface.slot_id &&
      actual.placement === surface.placement;
    if (!sameDescriptor(mount.descriptor))
      throw new StalePluginCall("action descriptor differs from its mounted surface");
    await this.enqueue(id, async (instance) => {
      if (
        instance !== original ||
        !sameDescriptor(instance.surfaces.get(surface.surface_id)?.descriptor) ||
        instance.surfaces.get(surface.surface_id)?.revision !== revision ||
        !instance.surfaces.get(surface.surface_id)?.visible
      )
        throw new StalePluginCall("action surface was retired");
      const ctx = {
        ...this.context(instance.generation, surface),
        user_action: true,
      };
      const r = await this.invoke(
        id,
        instance,
        "onAction",
        [
          action,
          JSON.stringify(payload),
          JSON.stringify(instance.vars),
          JSON.stringify(ctx),
        ],
        LIMITS.callMs,
        surface,
      );
      this.apply(id, instance, r, undefined, ctx);
    }).catch((error) => {
      if (!(error instanceof StalePluginCall)) this.fault(id, error);
      throw error;
    });
  }
  setVariable(
    id: string,
    path: string,
    value: Json,
    descriptor?: PluginSurfaceDescriptor,
  ): void {
    const instance = this.live.get(id);
    if (!instance) throw new Error("plugin is not enabled");
    if (
      descriptor &&
      !instance.surfaces.get(
        this.surface(descriptor.target, descriptor).surface_id,
      )?.visible
    )
      throw new StalePluginCall("variable binding surface is retired");
    try {
      const vars = writePath(instance.vars, path, value);
      for (const output of instance.trees.values()) {
        if (output.tree) validateProjection(output.tree, vars);
        if (output.mode === "webview-html")
          resolveViewState(output.viewState, vars);
      }
      for (const slot of this.slots.values())
        if (slot.pluginId === id && slot.tree)
          validateProjection(slot.tree, vars);
      instance.vars = vars;
      this.publish();
    } catch (error) {
      this.fault(id, error);
    }
  }
  async beforeSubmit(
    input: string,
    options: { sessionId?: string; deadlineMs?: number } = {},
  ): Promise<SubmitResult> {
    assertJson(input);
    if (
      options.deadlineMs !== undefined &&
      (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0)
    )
      throw new Error(
        "preprocessing deadline must be a positive finite number",
      );
    if (options.sessionId !== undefined && options.sessionId !== this.sessionId)
      throw new Error("beforeSubmit Session differs from active Session");
    const session = this.sessionId,
      history = this.historyGeneration,
      deadline =
        Date.now() +
        Math.min(options.deadlineMs ?? LIMITS.submitMs, LIMITS.submitMs);
    let transformed = input,
      changes: VariablesChange = {};
    for (const p of this.snapshot) {
      const id = p.manifest.id;
      if (!this.isEnabled(id)) continue;
      if (p.status === "faulted") throw new Error(`${id}: ${p.error}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error("plugin preprocessing exceeded total 4000ms deadline");
      const r = await this.totalDeadline(
        this.enqueue(id, async (instance) => {
          const time = deadline - Date.now();
          if (time <= 0)
            throw new Error(
              "plugin preprocessing deadline exceeded in event queue",
            );
          const result = await this.invoke(
            id,
            instance,
            "onPhase",
            [
              "before-submit",
              JSON.stringify({ input: transformed }),
              JSON.stringify(instance.vars),
              JSON.stringify(this.context(instance.generation)),
            ],
            time,
          );
          this.apply(id, instance, result);
          return result;
        }),
        remaining,
        id,
      ).catch((error) => {
        if (!(error instanceof StalePluginCall)) this.fault(id, error);
        throw error;
      });
      if (session !== this.sessionId || history !== this.historyGeneration)
        throw new Error("Session/history changed during input preprocessing");
      if (r.rewritten_input !== undefined) transformed = r.rewritten_input;
      if (r.turn_variables)
        changes = overlayVariables(changes, r.turn_variables);
    }
    const freeze = (value: unknown): void => {
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    const output: SubmitResult = { input: transformed };
    if (Object.keys(changes).length)
      output.variables = structuredClone(changes);
    freeze(output);
    return output;
  }
  private totalDeadline<T>(
    work: Promise<T>,
    ms: number,
    id: string,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(
          `plugin ${id} exceeded total preprocessing deadline`,
        );
        this.fault(id, error);
        reject(error);
      }, ms);
      work.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }
  private rememberSettled(payload: Json): void {
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof payload.block_id !== "string"
    )
      throw new Error("settled block requires block_id");
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).length,
      previous = this.settled.get(payload.block_id);
    if (previous) {
      this.settledBytes -= previous.bytes;
      if (JSON.stringify(previous.payload) !== JSON.stringify(payload)) {
        for (const [key, variant] of this.variants)
          if (variant.block_id === payload.block_id) {
            this.variants.delete(key);
            this.retireVariantSurfaces(variant.block_id, variant.pluginId, variant.variant_id);
          }
      }
    }
    this.settled.delete(payload.block_id);
    this.settled.set(payload.block_id, {
      payload: structuredClone(payload),
      bytes,
    });
    this.settledBytes += bytes;
    while (
      this.settled.size > 512 ||
      this.settledBytes + this.variantBytes() > LIMITS.retainedBytes - 16384
    ) {
      const first = this.settled.entries().next().value;
      if (!first) break;
      const [id, entry] = first;
      this.settled.delete(id);
      this.settledBytes -= entry.bytes;
      for (const [key, variant] of this.variants)
        if (variant.block_id === id) this.variants.delete(key);
      this.retireVariantSurfaces(id);
      for (const [key, slot] of this.slots)
        if (slot.block_id === id) this.slots.delete(key);
      for (const instance of this.live.values()) {
        for (const [key, mount] of instance.surfaces)
          if (mount.descriptor.block_id === id) {
            instance.surfaces.delete(key);
            instance.trees.delete(key);
          }
        instance.network.retireStale();
      }
    }
  }
  observe(phase: string, payload: Json): void {
    try {
      assertJson(payload);
      if (phase === "history-reset") {
        this.historyGeneration++;
        for (const instance of this.live.values()) {
          for (const controller of instance.controllers.keys())
            controller.abort(new Error("history replaced"));
          instance.network.close();
          instance.resources.retireRequests();
          for (const [key, cleanup] of this.cleanupTools)
            if (cleanup.instance === instance) {
              this.cleanupTools.delete(key);
              cleanup.controller.abort();
            }
          for (const [key, tool] of this.tools)
            if (tool.instance === instance) {
              this.tools.delete(key);
              tool.controller.abort();
              tool.reject(
                new Error("Plugin authority retired; outcome may be unknown"),
              );
            }
          instance.trees.clear();
          for (const [key, mount] of instance.surfaces) {
            if (mount.descriptor.target === "block-slot")
              instance.surfaces.delete(key);
            else mount.revision = ++instance.surfaceSequence;
          }
        }
        this.slots.clear();
    this.variants.clear();
        this.settled.clear();
        this.settledBytes = 0;
        this.publish();
      }
      if (phase === "settled-block") this.rememberSettled(payload);
      if (phase === "settled-blocks") {
        if (
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          !Array.isArray(payload.blocks)
        )
          throw new Error("settled-blocks requires blocks array");
        for (const block of payload.blocks) this.rememberSettled(block);
      }
      for (const p of this.snapshot) {
        const id = p.manifest.id;
        if (!this.isEnabled(id) || p.status !== "ready") continue;
        void this.enqueue(id, async (instance) => {
          const r = await this.invoke(
            id,
            instance,
            "onPhase",
            [
              phase,
              JSON.stringify(payload),
              JSON.stringify(instance.vars),
              JSON.stringify(this.context(instance.generation)),
            ],
            LIMITS.callMs,
          );
          this.apply(id, instance, r);
        }).catch((error) => {
          if (!(error instanceof StalePluginCall) && this.live.has(id))
            this.fault(id, error);
        });
      }
    } catch (error) {
      for (const id of [...this.live.keys()]) this.fault(id, error);
    }
  }
  getBlockSlots(
    blockId: string,
  ): readonly (BlockSlot & { pluginId: string })[] {
    return [...this.slots.values()].filter((s) => s.block_id === blockId);
  }
  toolInventory(): Json[] {
    return this.snapshot
      .filter(
        (p) =>
          p.providesTools &&
          p.artifact &&
          this.artifactReferences.get(p.manifest.id) === p.artifact &&
          p.status === "ready" &&
          this.isEnabled(p.manifest.id),
      )
      .slice(0, 32)
      .map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name.slice(0, 128),
        version: p.manifest.version,
        artifact: p.artifact!.slice(0, 16),
        description: (p.manifest.description ?? "").slice(0, 256),
      }));
  }
  async executeTool(
    request: PluginToolRequest,
    invocation: Omit<
      PluginToolIdentity,
      "artifact" | "generation" | "history_generation"
    >,
    signal: AbortSignal,
  ): Promise<Json> {
    this.assertActive();
    request = structuredClone(request);
    const id = request.plugin,
      p = this.require(id),
      instance = this.live.get(id),
      transition = this.sessionTransition,
      history = this.historyGeneration;
    if (
      !instance?.ready ||
      p.status !== "ready" ||
      !p.providesTools ||
      !this.isEnabled(id) ||
      !p.artifact ||
      !/^(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(request.artifact)
    )
      throw Error(
        "Plugin provider/artifact is unavailable or changed; discover again",
      );
    let artifact = request.artifact;
    if (artifact.length === 16) {
      try {
        // Read the authoritative persisted binding on every short dispatch so
        // another tab's collision cannot be hidden by the inventory cache.
        artifact = await this.store.resolveArtifactReference(id, artifact);
      } catch (error) {
        if (
          this.live.get(id) === instance &&
          this.plugins.get(id) === p &&
          request.artifact === p.artifact.slice(0, 16)
        ) {
          this.artifactReferences.delete(id);
          p.error = error instanceof Error ? error.message : String(error);
          this.publish();
        }
        throw error;
      }
    }
    this.assertActive();
    if (
      this.live.get(id) !== instance ||
      this.plugins.get(id) !== p ||
      transition !== this.sessionTransition ||
      history !== this.historyGeneration ||
      !instance.ready ||
      p.status !== "ready" ||
      !p.providesTools ||
      !this.isEnabled(id) ||
      p.artifact !== artifact
    )
      throw Error(
        "Plugin provider/artifact is unavailable or changed; discover again",
      );
    // The guest and all host-owned invocation identities retain exact bytes.
    request.artifact = artifact;
    // Delegated sessions must own their own registry; do not borrow the selected
    // main Session's authority through its execution lease.
    if (
      invocation.session_id !== this.sessionId ||
      invocation.parent_session_id !== this.sessionId
    )
      throw Error("Plugin authority is unavailable for this delegated Session");
    if (
      signal.aborted ||
      (invocation.deadline_ms > 0 && invocation.deadline_ms <= Date.now())
    )
      throw Error("Plugin invocation was cancelled or expired before dispatch");
    if (
      this.toolSeen.has(invocation.invocation_id) ||
      this.toolSeen.size >= 8192 ||
      this.tools.size >= 32
    )
      throw Error("Plugin invocation is duplicate or pending budget exceeded");
    const identity: PluginToolIdentity = {
      ...invocation,
      artifact: request.artifact,
      generation: instance.generation,
      history_generation: this.historyGeneration,
    };
    const context: PluginContext = {
      ...this.context(instance.generation),
      invocation_id: invocation.invocation_id,
      tool_invocation: identity,
    };
    this.toolSeen.add(invocation.invocation_id);
    const controller = new AbortController();
    let cancel = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completion = new Promise<Json>((resolve, reject) => {
      this.tools.set(identity.invocation_id, {
        pluginId: id,
        instance,
        identity,
        context,
        resolve,
        reject,
        controller,
      });
      cancel = () => {
        if (!this.tools.delete(identity.invocation_id)) return;
        controller.abort();
        const cleanup = {
          instance,
          identity,
          controller: new AbortController(),
          expires: Date.now() + 1000,
          used: false,
        };
        this.cleanupTools.set(identity.invocation_id, cleanup);
        setTimeout(() => {
          if (this.cleanupTools.get(identity.invocation_id) === cleanup)
            this.cleanupTools.delete(identity.invocation_id);
          cleanup.controller.abort();
        }, 1000);
        reject(
          Error(
            "Plugin invocation cancelled or deadline exceeded; outcome may be unknown; do not retry automatically",
          ),
        );
        // Cancellation is queued after the bounded synchronous export, never after
        // the unresolved tool promise. The worker is always free to process it.
        void this.enqueue(id, async (live) => {
          if (live !== instance) return;
          await this.invoke(
            id,
            live,
            "cancelTool",
            [JSON.stringify(context)],
            LIMITS.callMs,
            undefined,
            { ...context, tool_cleanup: true },
          );
        }).catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      // Nonpositive deadlines leave cancellation to the external signal.
      if (identity.deadline_ms > 0)
        timer = setTimeout(
          cancel,
          Math.max(1, Math.min(2147483647, identity.deadline_ms - Date.now())),
        );
    });
    // Only start/ack occupies the serial worker queue; event-result can now run.
    void this.enqueue(id, async (live) => {
      if (!this.tools.has(identity.invocation_id) || live !== instance) return;
      const r = await this.invoke(
        id,
        live,
        "startTool",
        [JSON.stringify(request), JSON.stringify(context)],
        LIMITS.callMs,
        undefined,
        context,
      );
      if (
        !r.tool_completion ||
        identityKey(r.tool_completion.identity) !== identityKey(identity)
      )
        throw Error("Tool provider did not acknowledge the exact invocation");
      this.apply(id, live, r, undefined, context);
    }).catch((error) => {
      const tool = this.tools.get(identity.invocation_id);
      if (tool) {
        this.tools.delete(identity.invocation_id);
        controller.abort();
        tool.reject(
          error instanceof Error ? error : Error("Plugin start failed"),
        );
      }
    });
    try {
      return await completion;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      controller.abort();
    }
  }
  private currentContext(instance: Live, context: PluginContext): boolean {
    return (
      context.owner_id === this.options.ownerId &&
      context.session_id === this.sessionId &&
      context.instance_generation === instance.generation &&
      context.history_generation === this.historyGeneration &&
      (!context.tool_invocation ||
        (() => {
          if (context.tool_cleanup) {
            const cleanup = this.cleanupTools.get(
              context.tool_invocation.invocation_id,
            );
            return (
              !!cleanup &&
              cleanup.instance === instance &&
              Date.now() < cleanup.expires &&
              !cleanup.controller.signal.aborted &&
              identityKey(cleanup.identity) ===
                identityKey(context.tool_invocation)
            );
          }
          const tool = this.tools.get(context.tool_invocation.invocation_id);
          return (
            !!tool &&
            tool.instance === instance &&
            !tool.controller.signal.aborted &&
            (tool.identity.deadline_ms <= 0 ||
              Date.now() < tool.identity.deadline_ms) &&
            identityKey(tool.identity) === identityKey(context.tool_invocation)
          );
        })()) &&
      (!context.surface ||
        (instance.surfaces.get(context.surface.surface_id)?.visible === true &&
          instance.surfaces.get(context.surface.surface_id)?.revision ===
            context.surface_generation))
    );
  }
  private completion(
    id: string,
    instance: Live,
    requestId: number,
    ok: boolean,
    value?: Json,
    error?: string,
    origin?: PluginContext,
    current?: () => boolean,
  ): void | Promise<void> {
    if (
      this.live.get(id) !== instance ||
      (current && !current()) ||
      (origin && !this.currentContext(instance, origin))
    )
      return;
    const history = this.historyGeneration,
      session = this.sessionId;
    const originRevision = origin?.surface_generation;
    const payload: Json = {
      request_id: requestId,
      ok,
      ...(value !== undefined ? { value } : {}),
      ...(error ? { error } : {}),
    };
    try {
      assertJson(payload);
    } catch (cause) {
      this.fault(id, cause);
      return;
    }
    const completion = this.enqueue(id, async (live) => {
      if (
        live !== instance ||
        (current && !current()) ||
        (origin && !this.currentContext(instance, origin)) ||
        history !== this.historyGeneration ||
        session !== this.sessionId ||
        (origin?.surface &&
          (instance.surfaces.get(origin.surface.surface_id)?.revision !==
            originRevision ||
            !instance.surfaces.get(origin.surface.surface_id)?.visible))
      )
        throw new StalePluginCall("stale plugin completion dropped");
      const r = await this.invoke(
        id,
        live,
        "onPhase",
        [
          "event-result",
          JSON.stringify(payload),
          JSON.stringify(live.vars),
          JSON.stringify(this.context(live.generation, origin?.surface)),
        ],
        LIMITS.callMs,
        origin?.surface,
        origin?.tool_invocation ? origin : undefined,
        current,
      );
      // An async response inherits scope, not the original user gesture.
      if (!current || current())
        this.apply(id, live, r, undefined, origin && { ...origin, user_action: false });
    }).catch((e) => {
      if (!(e instanceof StalePluginCall) && this.live.get(id) === instance)
        this.fault(id, e);
    });
    return completion;
  }
  private async effect(
    id: string,
    instance: Live,
    effect: PluginEffect,
    context: PluginContext,
  ): Promise<void> {
    if (
      this.live.get(id) !== instance ||
      !this.currentContext(instance, context)
    )
      return;
    authorizeKind(this.require(id).imports, effect.kind);
    assertJson(effect.payload);
    if (context.tool_invocation) {
      if (context.tool_cleanup) {
        const cleanup = this.cleanupTools.get(
          context.tool_invocation.invocation_id,
        );
        if (
          !cleanup ||
          cleanup.used ||
          effect.kind !== "http" ||
          !effect.payload ||
          typeof effect.payload !== "object" ||
          Array.isArray(effect.payload) ||
          effect.payload.response_mode !== "discard" ||
          (effect.payload.method !== undefined && effect.payload.method !== "POST")
        )
          throw Error(
            "Cancellation cleanup permits one bounded resource notification only",
          );
        cleanup.used = true;
      }
      const surfaceOnly = [
        "state-change",
        "state-operation",
        "storage-set",
        "storage-remove",
        "block-slots",
        "resource-configure",
      ];
      if (surfaceOnly.includes(effect.kind))
        throw Error(
          "This capability requires an explicit owner surface action",
        );
      if (
        ["http", "ws-open", "ws-send", "ws-close"].includes(effect.kind) &&
        (effect.kind !== "http" ||
          !effect.payload ||
          typeof effect.payload !== "object" ||
          Array.isArray(effect.payload) ||
          typeof effect.payload.resource !== "string")
      )
        throw Error(
          "Model plugin networking requires an exact configured resource grant",
        );
    }
    const requestId =
      effect.request_id ?? 0x80000000 + ++instance.effectSequence;
    if (requestId > 0xffffffff || instance.effectIds.size >= 65536)
      throw new Error(
        "plugin exceeds 65536 asynchronous request identities per instance",
      );
    if (instance.effectIds.has(requestId))
      throw new Error(`duplicate plugin request identity: ${requestId}`);
    instance.effectIds.add(requestId);
    if (instance.controllers.size >= LIMITS.pending)
      throw new Error("plugin exceeds 128 pending asynchronous requests");
    const controller = new AbortController();
    instance.controllers.set(controller, context.surface?.surface_id);
    const toolSignal = context.tool_invocation
      ? context.tool_cleanup
        ? this.cleanupTools.get(context.tool_invocation.invocation_id)
            ?.controller.signal
        : this.tools.get(context.tool_invocation.invocation_id)?.controller
            .signal
      : undefined;
    const cancelToolEffect = () => controller.abort();
    toolSignal?.addEventListener("abort", cancelToolEffect, { once: true });
    if (toolSignal?.aborted) controller.abort();
    const history = this.historyGeneration;
    const surfaceRevision = context.surface
      ? instance.surfaces.get(context.surface.surface_id)?.revision
      : undefined;
    let deadlineExceeded = false,
      completed = false;
    const finish = (ok: boolean, value?: Json, error?: string): void => {
      if (
        completed ||
        (controller.signal.aborted && !deadlineExceeded) ||
        this.live.get(id) !== instance ||
        history !== this.historyGeneration ||
        context.session_id !== this.sessionId ||
        (context.surface &&
          (instance.surfaces.get(context.surface.surface_id)?.revision !==
            surfaceRevision ||
            !instance.surfaces.get(context.surface.surface_id)?.visible))
      )
        return;
      completed = true;
      this.completion(id, instance, requestId, ok, value, error, context);
    };
    // The invocation's trusted host context is the shared guest/host snapshot.
    // Changing a preference never shortens an already admitted request.
    const payload = effect.payload && typeof effect.payload === "object" && !Array.isArray(effect.payload)
      ? effect.payload : undefined;
    const asksNetworkApproval = effect.kind === "resource-configure" &&
      payload?.methods !== undefined && payload.enabled === true && payload.remove !== true;
    const streaming = effect.kind === "http" && payload?.response_mode === "sse";
    if (asksNetworkApproval || streaming) this.cancelOnSurfaceHide.add(controller);
    const requestTimeout = effect.kind === "http"
      ? validateHttpRequestTimeout(context.host_http_timeout_ms ?? HTTP_REQUEST_TIMEOUT.defaultMs)
      : asksNetworkApproval ? 60_000 : 10_000;
    const timeout = Math.max(1, Math.min(
      requestTimeout,
      context.tool_cleanup ? 1000
        : context.tool_invocation && context.tool_invocation.deadline_ms > 0
          ? context.tool_invocation.deadline_ms - Date.now()
          : requestTimeout,
    ));
    const timer = setTimeout(
      () => {
        // Scope cancellation is silent. A deadline in the current scope must
        // settle the guest even if the underlying host operation ignores abort.
        if (controller.signal.aborted) return;
        deadlineExceeded = true;
        const error = `plugin host effect exceeded ${timeout}ms deadline`;
        controller.abort(new Error(error));
        finish(false, undefined, error);
        instance.controllers.delete(controller);
      },
      timeout,
    );
    try {
      let value: Json;
      if (effect.kind === "resource-list") value = instance.resources.list();
      else if (effect.kind === "resource-configure")
        value = await instance.resources.configure(
          effect.payload,
          context.user_action === true && !context.tool_invocation,
          (endpoint, methods) => approveNetworkGrant(
            `${this.require(id).manifest.name} (${id})`,
            endpoint,
            methods,
            controller.signal,
          ),
          controller.signal,
        );
      else if (effect.kind.startsWith("storage-")) {
        const p = effect.payload;
        if (
          !p ||
          typeof p !== "object" ||
          Array.isArray(p) ||
          typeof p.key !== "string"
        )
          throw new Error("storage effect requires key");
        if (effect.kind === "storage-get") {
          value = (await this.store.kv(id))[p.key] ?? null;
        } else if (
          effect.kind === "storage-set" ||
          effect.kind === "storage-remove"
        ) {
          if (effect.kind === "storage-set" && typeof p.value !== "string")
            throw new Error("storage-set requires string value");
          const cache = await this.store.writeKV(
            id,
            p.key,
            effect.kind === "storage-set" ? (p.value as string) : undefined,
            controller.signal,
          );
          if (this.live.get(id) === instance)
            instance.worker.postMessage({
              type: "cache",
              cache,
              generation: instance.generation,
              callId: 0,
            } satisfies WorkerRequest);
          value = { ack: true };
        } else throw new Error(`unsupported storage operation: ${effect.kind}`);
      } else if (
        ["http", "ws-open", "ws-send", "ws-close"].includes(effect.kind)
      )
        value = await instance.network.execute(
          effect.kind,
          effect.payload,
          controller.signal,
          requestId,
          {
            isCurrent: () =>
              this.live.get(id) === instance &&
              this.currentContext(instance, context),
            event: (requestId, value, current) =>
              this.completion(
                id,
                instance,
                requestId,
                true,
                value,
                undefined,
                context,
                current,
              ),
          },
        );
      else if (effect.kind === "sessions") value = this.sessions;
      else if (effect.kind === "projects") value = this.projects;
      else if (effect.kind === "block-slots") {
        const p = effect.payload;
        if (
          !p ||
          typeof p !== "object" ||
          Array.isArray(p) ||
          !Array.isArray(p.slots)
        )
          throw new Error("block-slots requires slots array");
        const r: PluginResult = {
          schema_version: 1,
          block_slots: p.slots as unknown as BlockSlot[],
        };
        for (const slot of r.block_slots!) {
          validateBlockSlot(slot);
          if (
            typeof slot.block_id !== "string" ||
            typeof slot.slot_id !== "string"
          )
            throw new Error("invalid block slot identity");
        }
        this.apply(id, instance, r);
        value = { ack: true };
      } else {
        if (!this.handler)
          throw new Error(`no host adapter installed for ${effect.kind}`);
        const frozen = Object.freeze({ ...context });
        value = await this.abortable(
          this.handler({
            ...effect,
            pluginId: id,
            instanceGeneration: instance.generation,
            sessionId: context.session_id,
            requestId,
            context: frozen,
            signal: controller.signal,
          }),
          controller.signal,
        );
      }
      assertJson(value);
      finish(true, value);
    } catch (error) {
      finish(
        false,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
      toolSignal?.removeEventListener("abort", cancelToolEffect);
      instance.controllers.delete(controller);
    }
  }
  private abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("plugin effect cancelled"),
        );
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      promise.then(
        (v) => {
          signal.removeEventListener("abort", abort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener("abort", abort);
          reject(e);
        },
      );
    });
  }
  dispose(): void {
    this.disposed = true;
    for (const id of this.live.keys()) this.stop(id);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.worker.terminate();
      p.reject(new Error("plugin registry disposed"));
    }
    this.pending.clear();
    this.listeners.clear();
    this.store.close();
  }
}
