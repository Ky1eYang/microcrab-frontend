export type HostConnectionState =
  "detached" | "connecting" | "pairing" | "reconciling" | "ready" | "suspended";
export interface HostDescriptor {
  readonly protocol_version: number;
  readonly host_id: string;
  readonly workspace_id: string;
  readonly bridge_instance_id: string;
  readonly workspace_root: string;
  readonly platform: string;
  readonly info: Readonly<Record<string, unknown>>;
  readonly tool_capabilities: readonly string[];
  readonly supported_primitives: readonly string[];
  readonly descriptor_digest: string;
}
export type ObservedHostDescriptor = Pick<HostDescriptor,
  "host_id" | "workspace_id" | "workspace_root" | "platform" |
  "tool_capabilities" | "supported_primitives"
>;
export type ProjectHostCarrier =
  | "server_direct_grpc" | "server_direct_outbound" | "browser_relay"
  | "embedded" | "detached";
export type ProjectHostCarrierMode =
  | Exclude<ProjectHostCarrier, "browser_relay">
  | "browser_relay_active" | "browser_relay_passive";
export interface HostReadinessCause {
  readonly code: string;
  readonly message: string;
  readonly operation_id?: string;
  readonly request_id?: string;
}
export interface HostReadiness {
  readonly connection_generation: string;
  readonly connected: boolean;
  readonly ready: boolean;
  readonly reconciling: boolean;
  readonly phase:
    | "disconnected"
    | "awaiting_reconciliation"
    | "reconciling"
    | "ready"
    | "unready";
  readonly cause: HostReadinessCause | null;
  readonly transport_warning?: HostReadinessCause | null;
}
export interface HostStateDetails {
  readonly connection_generation?: string | null;
  readonly observed_existing?: boolean;
  readonly readiness?: HostReadiness;
  readonly reconciliation_error?: HostReadinessCause | null;
  readonly code?: string;
  readonly message?: string;
}
