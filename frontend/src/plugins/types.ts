import type { ContentFormat } from "../features/content-inspection/format";

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type Vars = Record<string, Json>;
export type ViewTarget =
  "sidebar" | "expanded-page" | "session-tab" | "block-slot" | "setting-page";
export type RenderMode = "native-json" | "webview-html";
/** Supplied by the host mount, never accepted from plugin action payloads. */
export interface PluginSurfaceDescriptor {
  surface_id: string;
  target: ViewTarget;
  block_id?: string;
  slot_id?: string;
  placement?: "before" | "after";
}
export interface PluginRenderOutput {
  mode: RenderMode;
  content: string;
  tree: PluginNode | null;
  viewState?: Json;
}
export type VariableRole = "runtime" | "client" | "agent";
export interface VariableWrite {
  name: string;
  value: Json;
  visibility: "visible" | "invisible";
  persistence: "persisted" | "ephemeral";
  editors?: VariableRole[];
}
export interface VariablesChange {
  set?: Record<string, Json>;
  scoped_set?: VariableWrite[];
  remove?: string[];
}
export interface PluginContext {
  schema_version: 1;
  server_origin: string;
  owner_id: string;
  session_id: string | null;
  instance_generation: number;
  locale?: string;
  theme?: string;
  target_visible?: boolean;
  surface?: PluginSurfaceDescriptor;
  surface_id?: string;
  /** Host mount revision; changes on hide/remount and history replacement. */
  surface_generation?: number;
  history_generation?: number;
  /** Observational host samples; never execution/deadline authority. */
  host_time_ms?: number;
  /** Host-owned HTTP budget captured for this invocation; never guest-selected. */
  host_http_timeout_ms?: number;
  host_monotonic_ms?: number;
  invocation_id?: string;
  tool_invocation?: PluginToolIdentity;
  /** Host-only bounded cancellation cleanup authority. */
  tool_cleanup?: boolean;
  user_action?: boolean;
}
export interface PluginManifest {
  schema_version: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  targets: ViewTarget[];
  network_origins?: string[];
}
export interface Ref {
  $ref: string;
}
export type Bound<T> = T | Ref;
export type NodeKind =
  | "column"
  | "row"
  | "text"
  | "button"
  | "input"
  | "textarea"
  | "select"
  | "tabs"
  | "notice"
  | "payload"
  | "markdown"
  | "conditional"
  | "repeat"
  | "form";
export interface PluginNode {
  type: NodeKind;
  id?: string;
  children?: PluginNode[];
  props?: {
    text?: Bound<string>;
    value?: Bound<Json>;
    label?: Bound<string>;
    placeholder?: Bound<string>;
    disabled?: Bound<boolean>;
    visible?: Bound<boolean>;
    icon?:
      | Bound<string>
      | "eye"
      | "eye-off"
      | "search"
      | "refresh"
      | "close"
      | "copy"
      | "expand";
    pressed?: Bound<boolean> | boolean;
    action?: string;
    action_payload?: Bound<Json>;
    allowed_formats?: ContentFormat[];
    edit_notice?: Bound<string>;
    edit_validate_action?: string;
    edit_validation_state?: Ref;
    clear_action?: string;
    clear_label?: Bound<string>;
    edit_action?: string;
    edit_value?: Bound<Json>;
    edit_context?: Bound<Json>;
    edit_state?: Ref;
    edit_observe_action?: string;
    rows?: number;
    change_action?: string;
    bind?: string;
    options?: { label: string; value: string }[];
    test?: Bound<Json>;
    items?: Bound<Json>;
    as?: string;
    input_type?: "text" | "password" | "search" | "number";
    tone?: "info" | "warning" | "error";
  };
}
export interface PluginEffect {
  request_id?: number;
  kind: string;
  payload: Json;
}
export interface BlockSlot {
  slot_id: string;
  block_id: string;
  target?: "block-slot";
  placement?: "before" | "after";
  mode?: RenderMode;
  content?: string;
  view_state?: Json;
  tree?: PluginNode;
}
export interface BlockTextVariant {
  block_id: string;
  variant_id: string;
  source_digest: string;
  history_revision: string;
  label: string;
  status: "pending" | "completed" | "skipped" | "error" | "cancelled";
  text: string;
  default_display: "inline" | "after";
  reason?: "same_language" | "no_prose" | "unchanged";
  error?: string;
  retry_action?: string;
  force_action?: string;
}
export interface PluginToolIdentity {
  invocation_id: string;
  session_id: string;
  parent_session_id: string;
  call_id: string;
  catalog_digest: string;
  epoch: number;
  turn_id: number | null;
  round_id: number | null;
  history_anchor?: string | null;
  deadline_ms: number;
  /** Exact full SHA-256, never a model-facing artifact reference. */
  artifact: string;
  generation: number;
  history_generation: number;
}
export interface PluginToolRequest {
  plugin: string;
  action: "list" | "describe" | "call";
  /** Required model-facing 16-hex reference or legacy full SHA-256 input. */
  artifact: string;
  server?: string;
  tool?: string;
  cursor?: string;
  limit?: number;
  pin?: string;
  schema_pin?: string;
  config_pin?: string;
  arguments?: Record<string, Json>;
}
export interface PluginToolCompletion {
  identity: PluginToolIdentity;
  status: "pending" | "completed" | "failed";
  output?: Json;
  error?: string;
  outcome_unknown?: boolean;
}
export interface PluginResult {
  schema_version: 1;
  error?: string;
  tool_completion?: PluginToolCompletion;
  vars_patch?: Vars;
  effects?: PluginEffect[];
  rerender?: boolean;
  rewritten_input?: string;
  turn_variables?: VariablesChange;
  block_slots?: BlockSlot[];
  block_variants?: BlockTextVariant[];
  /** Remove only exact already-certified variants owned by this plugin. */
  remove_block_variants?: { block_id: string; variant_id: string }[];
  /** Remove only exact already-certified slots owned by this plugin. */
  remove_block_slots?: { block_id: string; slot_id: string }[];
  tree?: PluginNode;
  view_output?: PluginRenderOutput;
}
export interface HostEffect extends PluginEffect {
  pluginId: string;
  instanceGeneration: number;
  sessionId: string | null;
  requestId: number;
  context: Readonly<PluginContext>;
  signal: AbortSignal;
}
export type HostEffectHandler = (effect: HostEffect) => Promise<Json>;
export interface InstalledPlugin {
  manifest: PluginManifest;
  imports: string[];
  bytes: Uint8Array;
  importFormat?: "core" | "component";
  providesTools?: boolean;
  artifact?: string;
  enabledByDefault: boolean;
  priority: number;
  status: "disabled" | "loading" | "ready" | "faulted";
  error?: string;
}
export interface PluginView {
  pluginId: string;
  target: string;
  mode: RenderMode;
  content?: string;
  viewState?: Json;
  surface?: PluginSurfaceDescriptor;
  instanceGeneration?: number;
  historyGeneration?: number;
  tree: PluginNode | null;
  vars: Vars;
  status: InstalledPlugin["status"];
  error?: string;
}
export interface SubmitResult {
  input: string;
  variables?: VariablesChange;
}
export interface RuntimeOptions {
  serverOrigin: string;
  ownerId: string;
  effectHandler?: HostEffectHandler;
  workerFactory?: () => Worker;
}
export interface PluginRegistryAPI {
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly InstalledPlugin[];
  initialize(): Promise<void>;
  importPlugin(
    bytes: Uint8Array,
    options?: {
      replace?: boolean;
      enabledByDefault?: boolean;
      expectedId?: string;
    },
  ): Promise<InstalledPlugin>;
  remove(pluginId: string): Promise<void>;
  /** Restart the enabled current instance without clearing plugin storage. */
  restart(pluginId: string): Promise<void>;
  /** Explicitly reinstall missing bundled Components, including removed IDs. */
  restoreBundled(): Promise<number>;
  /** Destructive manager action: clear plugin KV and restart if enabled. */
  reset(pluginId: string): Promise<void>;
  setDefaultEnabled(pluginId: string, enabled: boolean): Promise<void>;
  setEnabled(
    pluginId: string,
    sessionId: string,
    enabled: boolean,
  ): Promise<void>;
  isEnabled(pluginId: string, sessionId?: string | null): boolean;
  setPriority(pluginId: string, priority: number): Promise<void>;
  getHttpRequestTimeout(pluginId: string): number;
  setHttpRequestTimeout(pluginId: string, timeoutMs: number): Promise<void>;
  setSession(
    sessionId: string | null,
    snapshots?: { sessions?: Json[]; projects?: Json[] },
  ): Promise<void>;
  setEffectHandler(handler: HostEffectHandler): void;
  setEnvironment(environment: {
    locale?: string;
    theme?: string;
    target_visible?: boolean;
  }): void;
  view(
    pluginId: string,
    target: string,
    surface?: PluginSurfaceDescriptor,
  ): PluginView;
  render(
    pluginId: string,
    target: string,
    force?: boolean,
    surface?: PluginSurfaceDescriptor,
  ): Promise<PluginView>;
  action(
    pluginId: string,
    action: string,
    payload?: Json,
    surface?: PluginSurfaceDescriptor,
  ): Promise<void>;
  releaseSurface(pluginId: string, surface: PluginSurfaceDescriptor): void;
  setSurfaceVisible(
    pluginId: string,
    surface: PluginSurfaceDescriptor,
    visible: boolean,
  ): void;
  setVariable(
    pluginId: string,
    path: string,
    value: Json,
    surface?: PluginSurfaceDescriptor,
  ): void;
  toolInventory(): Json[];
  executeTool(
    request: PluginToolRequest,
    identity: Omit<
      PluginToolIdentity,
      "artifact" | "generation" | "history_generation"
    >,
    signal: AbortSignal,
  ): Promise<Json>;
  beforeSubmit(
    input: string,
    options?: { sessionId?: string; deadlineMs?: number },
  ): Promise<SubmitResult>;
  observe(phase: string, payload: Json): void;
  getBlockSlots(blockId: string): readonly (BlockSlot & { pluginId: string })[];
  getBlockVariants(
    blockId: string,
    sourceText?: string,
  ): readonly (BlockTextVariant & { pluginId: string })[];
  dispose(): void;
}
export const LIMITS = {
  componentBytes: 16 * 1024 * 1024,
  jsonBytes: 16 * 1024 * 1024,
  jsonDepth: 128,
  retainedBytes: 1024 * 1024,
  storageBytes: 4 * 1024 * 1024,
  nodes: 2000,
  depth: 32,
  text: 256 * 1024,
  effects: 64,
  pending: 128,
  callMs: 2500,
  startupMs: 15000,
  submitMs: 4000,
  eventQueue: 128,
  rendersPerSecond: 12,
  networkBytes: 2 * 1024 * 1024,
  sockets: 4,
} as const;
