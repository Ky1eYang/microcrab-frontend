import type { NativeModelSelection } from "./types";

export interface RelayKey {
  id: string;
  name: string;
  key_prefix: string;
  enabled: boolean;
  revoked: boolean;
  allowed_providers: string[] | null;
  default_model_selection: NativeModelSelection | null;
  created_at_ms: number;
  last_used_at_ms: number | null;
  request_count: number;
  revision: number;
}

export interface RelayKeyConfig {
  name: string;
  enabled?: boolean;
  allowed_providers?: string[] | null;
  default_model_selection?: NativeModelSelection | null;
}
