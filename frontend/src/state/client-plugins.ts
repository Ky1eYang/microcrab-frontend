import { CommandError } from "../client/errors";
import { failureText } from "../client/failure";
import { parseStateInspection } from "../client/state-inspection";
import { isPluginDrawerViewport } from "../client/viewport";
import { PluginRegistry } from "../plugins/registry";
import { parseToolRequest } from "../plugins/tool-hub";
import type { ClientToolDefinition } from "../client/client-tools";
import { supportsShortPluginArtifacts } from "../plugins/tool-schema-compatibility";
import type { ClientInvocation } from "../client/client-tool-controller";
import type { HostEffect, Json, PluginRegistryAPI } from "../plugins/types";
import type { AppState, NativePart } from "../client/types";
import type { VariablesChange } from "../plugins/types";
export interface PluginInput {
  parts: NativePart[];
  variables?: VariablesChange;
}
import type { ApiClient } from "../client/api";

/** One browser owner scope. Runtime generations own cancellation; this bridge also
 * fences HTTP completions before exposing private owner data to a component. */
export class ClientPlugins {
  registry: PluginRegistryAPI | null = null;
  private scope = "";
  private session: string | null | undefined;
  private environment = "";
  private summaries = "";
  private shortArtifactReferences = true;
  private settledPending = new Map<string, Json>();
  private settledQueued = false;
  private decorationGeneration = 0;
  get historyRevision() {
    return this.decorationGeneration;
  }
  private generation = 0;
  private revision = 0;
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private ready: Promise<void> = Promise.resolve();
  private seen = new Map<string, string>();
  initializing = false;
  syncedSession: string | null | undefined;
  private syncRevision = 0;
  isReadyFor(sessionId: string | null) {
    return (
      !this.initializing &&
      (this.session === undefined || this.syncedSession === sessionId)
    );
  }
  retrySynchronization(state: AppState) {
    if (this.initializing || this.isReadyFor(state.sessionId)) return;
    this.dispose();
    this.sync(state);
  }
  bypass = false;
  error: string | null = null;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.revision;
  private publish = () => {
    this.revision++;
    for (const listener of this.listeners) listener();
  };
  constructor(
    private api: () => ApiClient,
    private onStateRead?: (value: unknown, sessionId: string) => void,
    private onRequestError?: (message: string) => void,
  ) {}
  sync(state: AppState) {
    const owner =
      state.authSession?.authenticated && !state.authRequired
        ? state.authSession.principal?.owner
        : null;
    const scope = owner ? JSON.stringify([state.apiBase, owner]) : "";
    if (scope !== this.scope) {
      this.dispose();
      this.scope = scope;
      if (owner) {
        const generation = this.generation;
        this.registry = new PluginRegistry({
          serverOrigin: new URL(state.apiBase, location.origin).origin,
          ownerId: owner,
          effectHandler: (effect) => this.effect(effect, generation),
        });
        this.unsubscribe = this.registry.subscribe(this.publish);
        this.initializing = true;
        this.ready = this.registry.initialize().then(
          () => {},
          (error) => {
            if (generation === this.generation) {
              this.initializing = false;
              this.error = String(error);
              this.publish();
            }
            throw error;
          },
        );
        void this.ready.catch(() => {});
      }
      this.publish();
    }
    // Only exact known bound schemas prove short support, including prior short16.
    // Unknown/legacy64 schemas retain full references; drafts use short.
    this.shortArtifactReferences =
      !state.sessionId ||
      !!state.clientTools?.definitions.some(
        (definition: ClientToolDefinition) =>
          definition.name === "plugin" &&
          supportsShortPluginArtifacts(definition.parameters),
      );
    const selectedTab = state.sessionPluginTab;
    const tabVisible =
      state.page === "conversation" &&
      !!selectedTab &&
      selectedTab.sessionId === state.sessionId &&
      !(
        state.popup.type === "subagentDetail" &&
        state.popup.parentId === state.sessionId
      ) &&
      !!this.registry
        ?.getSnapshot()
        .some(
          (entry) =>
            entry.manifest.id === selectedTab.pluginId &&
            entry.manifest.targets.includes("session-tab") &&
            this.registry?.isEnabled(entry.manifest.id, state.sessionId),
        );
    const rightRailActive =
      state.page === "conversation" &&
      Boolean(state.sessionId) &&
      !!this.registry
        ?.getSnapshot()
        .some(
          (entry) =>
            entry.manifest.targets.includes("sidebar") &&
            this.registry?.isEnabled(entry.manifest.id, state.sessionId) &&
            entry.status !== "disabled",
        );
    const targetVisible =
      tabVisible ||
      state.pluginWorkspace?.type === "view" ||
      state.page === "plugin" ||
      state.page === "plugins" ||
      (rightRailActive &&
        (isPluginDrawerViewport()
          ? state.rightOverlayOpen
          : !state.rightRailCollapsed));
    const environment = JSON.stringify([
      state.resolvedLocale,
      state.resolvedTheme,
      targetVisible,
    ]);
    if (this.registry && this.environment !== environment) {
      this.environment = environment;
      this.registry.setEnvironment({
        locale: state.resolvedLocale,
        theme: state.resolvedTheme,
        target_visible: targetVisible,
      });
      this.registry.observe("visibility-change", {
        visible: targetVisible,
      });
    }
    const summaries = JSON.stringify([
      state.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        project_id: session.projectID ?? null,
      })),
      state.projects.map((project) => ({ id: project.id, name: project.name })),
    ]);
    if (
      this.registry &&
      (state.sessionId !== this.session || summaries !== this.summaries)
    ) {
      if (state.sessionId !== this.session) {
        this.decorationGeneration++;
        this.settledPending.clear();
        this.seen.clear();
        this.bypass = false;
        this.error = null;
      }
      const sessionChanged = state.sessionId !== this.session;
      if (sessionChanged || this.syncedSession === undefined) {
        this.initializing = true;
        this.syncedSession = undefined;
      }
      const ticket = ++this.syncRevision;
      this.session = state.sessionId;
      this.summaries = summaries;
      const registry = this.registry;
      this.ready = this.ready.then(() =>
        registry === this.registry && ticket === this.syncRevision
          ? registry.setSession(state.sessionId, {
              sessions: state.sessions.map((session) => ({
                id: session.id,
                title: session.title,
                project_id: session.projectID ?? null,
              })),
              projects: state.projects.map((project) => ({
                id: project.id,
                name: project.name,
              })),
            })
          : undefined,
      );
      void this.ready.then(
        () => {
          if (registry === this.registry && ticket === this.syncRevision) {
            this.syncedSession = state.sessionId;
            this.initializing = false;
            this.publish();
          }
        },
        (error) => {
          if (registry === this.registry && ticket === this.syncRevision) {
            this.syncedSession = undefined;
            this.initializing = false;
            this.error = String(error);
            this.publish();
          }
        },
      );
    }
  }
  private async effect(effect: HostEffect, generation: number): Promise<Json> {
    if (generation !== this.generation || effect.signal.aborted)
      throw Error("Plugin owner scope expired");
    // Authority comes exclusively from the broker's captured context, never payload.
    const sessionId = effect.context.session_id;
    const history = this.decorationGeneration;
    if (
      !sessionId ||
      sessionId !== this.session ||
      effect.sessionId !== sessionId
    )
      throw Error("Plugin request requires the current Session");
    const current = () =>
      generation === this.generation &&
      !effect.signal.aborted &&
      sessionId === this.session &&
      history === this.decorationGeneration;
    const notify = (
      error: unknown,
      operationId?: string,
      outcome: "rejected" | "unknown" = "rejected",
    ) => {
      if (!current() || effect.context.tool_invocation) return;
      if (operationId) {
        const key = `${outcome}:${operationId}`;
        if (this.reportedRequests.has(key)) return;
        this.reportedRequests.add(key);
        if (this.reportedRequests.size > 512)
          this.reportedRequests.delete(
            this.reportedRequests.values().next().value!,
          );
      }
      this.onRequestError?.(failureText(error));
    };
    const request = async (
      method: string,
      payload: Record<string, unknown> = {},
    ) => {
      try {
        const result = await this.api().request(
          method,
          payload,
          sessionId,
          undefined,
          undefined,
          effect.signal,
        );
        // Queue admission is not completion. Observation reports the exact outcome
        // while leaving its receipt and explicit-save contract intact.
        if (
          result &&
          typeof result === "object" &&
          "status" in result &&
          (result.status === "rejected" || result.status === "unknown") &&
          "operation_id" in result &&
          typeof result.operation_id === "string" &&
          "reason" in result
        )
          notify(result.reason, result.operation_id, result.status);
        return result;
      } catch (error) {
        notify(
          error,
          typeof payload.operation_id === "string"
            ? payload.operation_id
            : undefined,
          error instanceof CommandError &&
            (error.outcomeUnknown ||
              (effect.kind === "state-change" &&
                error.details?.operation_id !== payload.operation_id))
            ? "unknown"
            : "rejected",
        );
        throw error;
      }
    };
    let result: unknown;
    if (effect.kind === "state-values" || effect.kind === "state.get") {
      result = await request("state.get");
    } else if (
      effect.kind === "state-metadata" ||
      effect.kind === "state.metadata"
    ) {
      result = await request("state.metadata");
    } else if (effect.kind === "state-inspection") {
      result = await request("state.inspection");
    } else if (
      effect.kind === "state-change" ||
      effect.kind === "state-operation"
    ) {
      const payload = effect.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw Error("State operation requires an object payload");
      const fields =
        effect.kind === "state-change"
          ? ["operation_id", "expected", "change"]
          : ["operation_id"];
      if (
        Object.keys(payload).some((key) => !fields.includes(key)) ||
        fields.some((key) => !(key in payload)) ||
        typeof payload.operation_id !== "string" ||
        !payload.operation_id
      )
        throw Error("State operation requires exact checked fields");
      // Errors retain their typed unknown/rejected distinction. Never replay writes.
      try {
        result = await request(
          effect.kind === "state-change"
            ? "session.variables.patch"
            : "session.variables.operation",
          payload,
        );
      } catch (error) {
        if (effect.kind !== "state-change" || !(error instanceof CommandError))
          throw error;
        const certified =
          !error.outcomeUnknown &&
          error.details?.operation_id === payload.operation_id;
        result = {
          operation_id: payload.operation_id,
          status: certified ? "rejected" : "unknown",
          reason: { code: error.code, message: error.message },
        };
      }
    } else throw Error(`Unsupported client plugin Host effect: ${effect.kind}`);
    if (
      generation !== this.generation ||
      effect.signal.aborted ||
      sessionId !== this.session ||
      history !== this.decorationGeneration
    )
      throw Error("Plugin request scope expired");
    if (effect.kind === "state-values" || effect.kind === "state.get")
      this.onStateRead?.(result, sessionId);
    if (effect.kind === "state-inspection") {
      // Keep the existing plugin ABI JSON-only. Validate before publishing any
      // ordinary values so a malformed overlapping Bytes row cannot leak there.
      const { ordinary } = parseStateInspection(result);
      this.onStateRead?.(ordinary.values, sessionId);
      return ordinary as Json;
    }
    return result as Json;
  }
  settle(
    block: import("../features/shared").FeatureBlock,
    historyRevision: string,
  ) {
    const registry = this.registry;
    if (
      !registry ||
      block.sessionId !== this.session ||
      block.temporary ||
      block.stream !== "complete"
    )
      return;
    const key = JSON.stringify([historyRevision, block.id]);
    const signature = JSON.stringify([
      block.messageId,
      block.partId,
      block.kind,
      block.role,
      block.payload.text,
    ]);
    if (this.seen.get(key) === signature) return;
    this.seen.set(key, signature);
    if (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value!);
    this.settledPending.set(key, {
      block_id: block.id,
      message_id: block.messageId,
      part_id: block.partId ?? null,
      history_revision: historyRevision,
      kind: block.kind,
      role: block.role,
      text: block.payload.text.slice(0, 64 * 1024),
      text_truncated: block.payload.text.length > 64 * 1024,
    });
    if (this.settledPending.size > 512)
      this.settledPending.delete(this.settledPending.keys().next().value!);
    if (this.settledQueued) return;
    this.settledQueued = true;
    queueMicrotask(() => {
      this.settledQueued = false;
      const registry = this.registry;
      const generation = this.generation;
      const decoration = this.decorationGeneration;
      if (!registry) return;
      const pending = [...this.settledPending.entries()].map(
        ([key, payload]) => ({ key, payload, signature: this.seen.get(key) }),
      );
      this.settledPending.clear();
      void this.ready
        .then(async () => {
          if (
            registry !== this.registry ||
            generation !== this.generation ||
            decoration !== this.decorationGeneration
          )
            return;
          const prepared: {
            key: string;
            signature: string | undefined;
            payload: Json;
          }[] = [];
          for (const entry of pending) {
            const payload = entry.payload;
            if (
              !payload ||
              typeof payload !== "object" ||
              Array.isArray(payload) ||
              typeof payload.text !== "string"
            )
              continue;
            const digest = new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(payload.text),
              ),
            );
            prepared.push({
              ...entry,
              payload: {
                ...payload,
                source_digest: [...digest]
                  .map((byte) => byte.toString(16).padStart(2, "0"))
                  .join(""),
              },
            });
          }
          if (
            registry !== this.registry ||
            generation !== this.generation ||
            decoration !== this.decorationGeneration
          )
            return;
          let blocks: Json[] = [],
            bytes = 0;
          for (const entry of prepared) {
            if (this.seen.get(entry.key) !== entry.signature) continue;
            const payload = entry.payload;
            const size = new TextEncoder().encode(
              JSON.stringify(payload),
            ).byteLength;
            if (bytes + size > 768 * 1024 && blocks.length) {
              registry.observe("settled-blocks", { blocks });
              blocks = [];
              bytes = 0;
            }
            blocks.push(payload);
            bytes += size;
          }
          if (blocks.length) registry.observe("settled-blocks", { blocks });
        })
        .catch(() => {});
    });
  }
  resetHistory() {
    this.decorationGeneration++;
    this.settledPending.clear();
    this.seen.clear();
    this.registry?.observe("history-reset", {
      session_id: this.session ?? null,
    });
  }
  allowBypassOnce() {
    this.bypass = true;
    this.publish();
  }
  async execute(
    name: string,
    args: unknown,
    signal: AbortSignal,
    invocation: Readonly<ClientInvocation>,
  ): Promise<Json> {
    if (name !== "plugin") throw Error(`Unknown client tool: ${name}`);
    const registry = this.registry,
      generation = this.generation;
    await this.ready;
    if (
      !registry ||
      registry !== this.registry ||
      generation !== this.generation ||
      signal.aborted
    )
      throw Error("Plugin owner scope expired");
    return registry.executeTool(
      parseToolRequest(args),
      {
        invocation_id: invocation.invocation_id,
        session_id: invocation.session_id,
        parent_session_id: invocation.parent_session_id,
        call_id: invocation.call_id,
        catalog_digest: invocation.catalog_digest,
        epoch: invocation.epoch,
        turn_id: invocation.turn_id,
        round_id: invocation.round_id,
        history_anchor: invocation.history_anchor,
        deadline_ms: invocation.deadline_ms,
      },
      signal,
    );
  }
  private inventory(variables?: VariablesChange): VariablesChange {
    const observed = this.registry?.toolInventory() ?? [];
    const inventory = this.shortArtifactReferences
      ? observed
      : observed.map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry))
            throw Error("Invalid plugin inventory entry");
          const installed = this.registry
            ?.getSnapshot()
            .find(
              (plugin) =>
                plugin.manifest.id === entry.id &&
                plugin.artifact &&
                /^[a-f0-9]{64}$/.test(plugin.artifact) &&
                (entry.artifact === plugin.artifact ||
                  entry.artifact === plugin.artifact.slice(0, 16)),
            );
          if (!installed?.artifact)
            throw Error(
              "Canonical plugin artifact is unavailable for the frozen catalog",
            );
          return { ...entry, artifact: installed.artifact };
        });
    return mergeVariables(variables, {
      scoped_set: [
        {
          name: "plugins",
          value: inventory,
          visibility: "visible",
          persistence: "persisted",
          editors: ["client"],
        },
      ],
    })!;
  }
  private freezeInput(input: PluginInput, operationId: string): PluginInput {
    if (this.prepared.size >= 128 && !this.prepared.has(operationId))
      throw Error("Too many unresolved plugin input operations");
    const frozen = structuredClone(input);
    this.prepared.set(operationId, frozen);
    return structuredClone(frozen);
  }
  async preprocess(
    input: PluginInput,
    operationId: string,
    sessionId: string,
    current: () => boolean,
  ): Promise<PluginInput | null> {
    const cached = this.prepared.get(operationId);
    if (cached) return current() ? structuredClone(cached) : null;
    const registry = this.registry;
    const generation = this.generation;
    if (!current()) return null;
    if (this.bypass) {
      this.bypass = false;
      this.error = null;
      const frozen = this.freezeInput(
        { ...input, variables: this.inventory(input.variables) },
        operationId,
      );
      this.publish();
      return frozen;
    }
    if (!registry)
      return this.freezeInput(
        { ...input, variables: this.inventory(input.variables) },
        operationId,
      );
    try {
      await this.ready;
      if (!current() || generation !== this.generation) return null;
      if (this.prepared.size >= 128)
        throw Error("Too many unresolved plugin input operations");
      const text = input.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const result = await registry.beforeSubmit(text, { sessionId });
      if (!current() || generation !== this.generation) return null;
      let replaced = false;
      const parts = input.parts.flatMap((part) => {
        if (part.type !== "text") return [part];
        if (replaced) return [];
        replaced = true;
        return [{ ...part, text: result.input }];
      });
      if (!replaced && result.input)
        parts.unshift({ type: "text", text: result.input });
      const frozen = this.freezeInput(
        {
          ...input,
          parts,
          variables: this.inventory(
            mergeVariables(input.variables, result.variables),
          ),
        },
        operationId,
      );
      this.error = null;
      this.publish();
      return frozen;
    } catch (error) {
      if (current() && generation === this.generation) {
        this.error = error instanceof Error ? error.message : String(error);
        this.publish();
      }
      throw error;
    }
  }
  // Retain exact transformed bytes under the admission identity; unknown receipts
  // are observation only and never call preprocessing again.
  private reportedRequests = new Set<string>();
  private prepared = new Map<string, PluginInput>();
  forget(operationId: string) {
    this.prepared.delete(operationId);
  }
  dispose() {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.registry?.dispose();
    this.registry = null;
    this.scope = "";
    this.session = undefined;
    this.syncedSession = undefined;
    this.syncRevision++;
    this.environment = "";
    this.summaries = "";
    this.shortArtifactReferences = true;
    this.decorationGeneration++;
    this.settledPending.clear();
    this.ready = Promise.resolve();
    this.seen.clear();
    this.prepared.clear();
    this.reportedRequests.clear();
    this.initializing = false;
    this.bypass = false;
    this.error = null;
    this.publish();
  }
}
function mergeVariables(
  left: PluginInput["variables"],
  right: PluginInput["variables"],
): PluginInput["variables"] {
  if (!left && !right) return undefined;
  const writes = new Map<
    string,
    {
      kind: "set" | "scoped" | "remove";
      value?: Json;
      scoped?: NonNullable<VariablesChange["scoped_set"]>[number];
    }
  >();
  for (const changes of [left, right]) {
    for (const [name, value] of Object.entries(changes?.set ?? {}))
      writes.set(name, { kind: "set", value });
    for (const scoped of changes?.scoped_set ?? [])
      writes.set(scoped.name, { kind: "scoped", scoped });
    for (const name of changes?.remove ?? [])
      writes.set(name, { kind: "remove" });
  }
  const result: VariablesChange = { set: {}, scoped_set: [], remove: [] };
  for (const [name, write] of writes) {
    if (write.kind === "set") result.set![name] = write.value!;
    else if (write.kind === "scoped") result.scoped_set!.push(write.scoped!);
    else result.remove!.push(name);
  }
  return result;
}
