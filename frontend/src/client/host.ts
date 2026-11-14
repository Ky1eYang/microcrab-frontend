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
  readonly readiness?: HostReadiness;
  readonly reconciliation_error?: HostReadinessCause | null;
  readonly code?: string;
  readonly message?: string;
}
