import { LIMITS, type Json } from "./types";

const RESOURCE_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;
type ResourceMethod = (typeof RESOURCE_METHODS)[number];

export interface ResourceConfig {
  id: string;
  endpoint: string;
  authorization?: string;
  enabled: boolean;
  config_pin: string;
  grant_artifact?: string;
  methods: readonly ResourceMethod[];
}
/** Browser-owned credential vault and exact-endpoint grants. No credentials are
 * returned to guests, projected in views, or included in inventory/errors. */
export class PluginResources {
  private readonly key: string;
  private configs: ResourceConfig[] = [];
  private controllers = new Map<string, AbortController>();
  private revoked = false;
  private requestGeneration = 0;
  private storageChanged = (event: StorageEvent) => {
    if (event.key === null || event.key === this.key) {
      this.revoked = true;
      for (const c of this.controllers.values()) c.abort();
      this.controllers.clear();
    }
  };
  constructor(
    serverOrigin: string,
    ownerId: string,
    pluginId: string,
    private readonly artifact: string,
  ) {
    this.key = `microcrab.plugin.resources.v1:${JSON.stringify([new URL(serverOrigin).origin, ownerId, pluginId])}`;
    let raw: string | null;
    try {
      raw = localStorage.getItem(this.key);
    } catch {
      throw Error("Plugin resource LocalStorage is unavailable");
    }
    if (raw !== null) {
      try {
        if (new TextEncoder().encode(raw).length > LIMITS.storageBytes)
          throw Error();
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length > 32) throw Error();
        this.configs = parsed.map((item) => this.validate(item));
        if (new Set(this.configs.map((c) => c.id)).size !== this.configs.length)
          throw Error();
      } catch {
        throw Error(
          "Plugin resource storage is corrupt; use explicit local-data reset",
        );
      }
    }
    globalThis.addEventListener("storage", this.storageChanged);
  }
  private validate(value: unknown): ResourceConfig {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("Invalid resource configuration");
    const c = value as ResourceConfig;
    if (
      !/^[a-zA-Z0-9._-]{1,64}$/.test(c.id) ||
      typeof c.endpoint !== "string" ||
      c.endpoint.length > 2048 ||
      typeof c.enabled !== "boolean" ||
      typeof c.config_pin !== "string" ||
      c.config_pin.length > 128
    )
      throw Error("Invalid resource configuration");
    let endpoint: URL;
    try {
      endpoint = new URL(c.endpoint);
    } catch {
      throw Error("Resource endpoint must be an absolute HTTP(S) URL");
    }
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash
    )
      throw Error("Invalid resource endpoint");
    if (
      c.authorization !== undefined &&
      (typeof c.authorization !== "string" ||
        c.authorization.length > 8192 ||
        /[\r\n]/.test(c.authorization))
    )
      throw Error("Invalid resource authorization header");
    if (
      c.grant_artifact !== undefined &&
      !/^[a-f0-9]{64}$/.test(c.grant_artifact)
    )
      throw Error("Invalid resource artifact grant");
    const methods = c.methods === undefined ? (["POST"] as const) : c.methods;
    if (
      !Array.isArray(methods) ||
      methods.length === 0 ||
      methods.length > RESOURCE_METHODS.length ||
      methods.some((method) => !RESOURCE_METHODS.includes(method)) ||
      new Set(methods).size !== methods.length
    )
      throw Error(
        "Invalid resource methods: use a nonempty list of distinct uppercase HTTP methods",
      );
    return {
      methods: [...methods],
      grant_artifact: c.grant_artifact,
      id: c.id,
      endpoint: endpoint.href,
      enabled: c.enabled,
      config_pin: c.config_pin,
      ...(c.authorization ? { authorization: c.authorization } : {}),
    };
  }
  list(): Json {
    return this.configs.map(
      ({ id, endpoint, enabled, config_pin, grant_artifact, methods }) => ({
        id,
        endpoint,
        origin: new URL(endpoint).origin,
        enabled: !this.revoked && enabled && grant_artifact === this.artifact,
        requires_reenable: enabled && grant_artifact !== this.artifact,
        config_pin,
        methods: [...methods],
      }),
    );
  }
  configure(payload: Json, userAction: boolean): Json;
  configure(
    payload: Json,
    userAction: boolean,
    approveMethods: (
      endpoint: string,
      methods: readonly ResourceMethod[],
    ) => boolean | Promise<boolean>,
    signal?: AbortSignal,
  ): Json | Promise<Json>;
  configure(
    payload: Json,
    userAction: boolean,
    approveMethods?: (
      endpoint: string,
      methods: readonly ResourceMethod[],
    ) => boolean | Promise<boolean>,
    signal?: AbortSignal,
  ): Json | Promise<Json> {
    if (this.revoked)
      throw Error(
        "Resource grants changed in another browser tab; reload the plugin before configuring",
      );
    if (!userAction)
      throw Error(
        "Resource grants require an explicit owner configuration action",
      );
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw Error("Invalid resource configuration");
    const id = payload.id;
    if (typeof id !== "string") throw Error("Resource ID is required");
    const original = this.configs,
      generation = this.requestGeneration;
    const next = original.filter((c) => c.id !== id);
    let approvalDetails: ResourceConfig | undefined;
    if (payload.remove !== true) {
      const old = this.configs.find((c) => c.id === id);
      const c = this.validate({
        ...payload,
        authorization:
          payload.clear_authorization === true
            ? undefined
            : payload.authorization === "" && old?.endpoint === payload.endpoint
              ? old?.authorization
              : payload.authorization,
        config_pin: crypto.randomUUID(),
        grant_artifact: this.artifact,
      });
      if (c.enabled && payload.methods !== undefined) approvalDetails = c;
      next.push(c);
    }
    if (next.length > 32) throw Error("Plugin resource limit is 32 servers");
    const encoded = JSON.stringify(next);
    if (new TextEncoder().encode(encoded).length > LIMITS.storageBytes)
      throw Error("Plugin resource storage quota exceeded");
    const commit = (approved: boolean) => {
      signal?.throwIfAborted();
      if (!approved)
        throw Error("Owner did not approve the endpoint and HTTP methods");
      if (
        this.revoked ||
        this.configs !== original ||
        generation !== this.requestGeneration
      )
        throw Error("Resource grants changed while approval was pending");
      try {
        localStorage.setItem(this.key, encoded);
      } catch {
        throw Error(
          "Plugin resource LocalStorage write failed; configuration was not changed",
        );
      }
      this.controllers.get(id)?.abort();
      this.controllers.delete(id);
      this.configs = next;
      return this.list();
    };
    const approval = approvalDetails
      ? (approveMethods?.(approvalDetails.endpoint, approvalDetails.methods) ??
        false)
      : true;
    return typeof approval === "boolean"
      ? commit(approval)
      : approval.then(commit);
  }
  network(payload: Record<string, Json>): {
    url: string;
    method: ResourceMethod;
    authorization: string | undefined;
    headers: Record<string, string>;
    signal: AbortSignal;
    isCurrent: () => boolean;
  } {
    const c = this.configs.find((c) => c.id === payload.resource);
    if (
      this.revoked ||
      !c ||
      !c.enabled ||
      c.grant_artifact !== this.artifact ||
      payload.config_pin !== c.config_pin
    )
      throw Error(
        "Resource grant is disabled, missing, or its configuration changed",
      );
    // Resource references bind the full endpoint. Guests cannot redirect credentials
    // to another path/origin, override authorization, or obtain ambient egress.
    if (payload.url !== undefined && payload.url !== c.endpoint)
      throw Error(
        "Resource request endpoint differs from the configured endpoint",
      );
    const method = c.methods.find(
      (method) =>
        method === (payload.method === undefined ? "POST" : payload.method),
    );
    if (!method)
      throw Error("HTTP method is not approved for this resource endpoint");
    let controller = this.controllers.get(c.id);
    if (!controller) {
      controller = new AbortController();
      this.controllers.set(c.id, controller);
    }
    const generation = this.requestGeneration;
    return {
      url: c.endpoint,
      method,
      authorization: c.authorization,
      headers: c.authorization ? { Authorization: c.authorization } : {},
      signal: controller.signal,
      isCurrent: () =>
        !this.revoked &&
        !controller.signal.aborted &&
        generation === this.requestGeneration &&
        this.configs.includes(c) &&
        c.enabled,
    };
  }
  /** History changes retire work, not the owner's exact-artifact saved grants.
   * Revocation/close remain permanent; this method never reauthorizes them. */
  retireRequests(): void {
    this.requestGeneration++;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
  close(): void {
    globalThis.removeEventListener("storage", this.storageChanged);
    this.revoked = true;
    this.retireRequests();
  }
  static reset(serverOrigin: string, ownerId: string, pluginId: string): void {
    const key = `microcrab.plugin.resources.v1:${JSON.stringify([new URL(serverOrigin).origin, ownerId, pluginId])}`;
    try {
      localStorage.removeItem(key);
    } catch {
      throw Error("Plugin resource LocalStorage reset failed");
    }
  }
}
