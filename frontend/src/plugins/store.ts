import { LIMITS, type InstalledPlugin } from "./types";
export interface Preferences {
  sessions: Record<string, Record<string, boolean>>;
  tombstones: string[];
}
export function ownRecordValue<T>(
  record: Record<string, T>,
  key: string,
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
export function setRecordValue<T>(
  record: Record<string, T>,
  key: string,
  value: T,
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
export function normalizePreferences(value: unknown): Preferences {
  if (
    !value ||
    typeof value !== "object" ||
    !Object.hasOwn(value, "sessions") ||
    !Object.hasOwn(value, "tombstones")
  )
    throw new Error(
      "invalid client plugin preferences: expected own sessions and tombstones",
    );
  const input = value as Preferences;
  if (
    !input.sessions ||
    typeof input.sessions !== "object" ||
    Array.isArray(input.sessions) ||
    !Array.isArray(input.tombstones) ||
    input.tombstones.some((id) => typeof id !== "string")
  )
    throw new Error(
      "invalid client plugin preferences: Session choices or deletion records",
    );
  const sessions: Preferences["sessions"] = {};
  for (const [id, choices] of Object.entries(input.sessions)) {
    if (!choices || typeof choices !== "object" || Array.isArray(choices))
      throw new Error(`invalid plugin choices for Session ${id}`);
    const clean: Record<string, boolean> = {};
    for (const [pluginId, enabled] of Object.entries(choices)) {
      if (typeof enabled !== "boolean")
        throw new Error(
          `invalid plugin enablement ${pluginId} for Session ${id}: expected boolean`,
        );
      setRecordValue(clean, pluginId, enabled);
    }
    setRecordValue(sessions, id, clean);
  }
  return { sessions, tombstones: [...input.tombstones] };
}
const ARTIFACT_REFERENCES_KEY = "artifact-references.v1";
const ARTIFACT_REFERENCES_LIMIT = 8192;

// Host settings, never guest KV: entries and ambiguity tombstones outlive plugin
// removal/reset so a historical short reference cannot select replacement bytes.
function artifactReferences(value: unknown): Record<string, string | null> {
  if (value === undefined) return {};
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw Error("Invalid plugin artifact reference storage");
  const entries = Object.entries(value);
  if (entries.length > ARTIFACT_REFERENCES_LIMIT)
    throw Error("Plugin artifact reference storage exceeds 8192 entries");
  for (const [key, artifact] of entries) {
    if (
      !/^[a-z0-9][a-z0-9._-]{0,127}:[a-f0-9]{16}$/.test(key) ||
      (artifact !== null &&
        (typeof artifact !== "string" ||
          !/^[a-f0-9]{64}$/.test(artifact) ||
          !artifact.startsWith(key.slice(-16))))
    )
      throw Error("Invalid plugin artifact reference storage entry");
  }
  return value as Record<string, string | null>;
}

export class PluginStore {
  private db?: Promise<IDBDatabase>;
  constructor(private readonly namespace: string) {}
  private open(): Promise<IDBDatabase> {
    return (this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(
        `microcrab.client-plugins.v1:${this.namespace}`,
        1,
      );
      request.onupgradeneeded = () => {
        for (const name of ["plugins", "kv", "settings"])
          if (!request.result.objectStoreNames.contains(name))
            request.result.createObjectStore(name);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          new Error(`plugin IndexedDB open failed: ${request.error?.message}`),
        );
    }));
  }
  private async transact<T>(
    store: string,
    mode: IDBTransactionMode,
    work: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode),
        req = work(tx.objectStore(store));
      let value: T;
      req.onsuccess = () => {
        value = req.result;
      };
      tx.oncomplete = () => resolve(value);
      tx.onerror = () =>
        reject(
          new Error(
            `plugin IndexedDB ${store}: ${tx.error?.message ?? req.error?.message}`,
          ),
        );
      tx.onabort = () =>
        reject(
          new Error(
            `plugin IndexedDB ${store} aborted: ${tx.error?.message ?? req.error?.message}`,
          ),
        );
    });
  }
  async registerArtifactReference(
    id: string,
    artifact: string,
  ): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(artifact))
      throw Error("Plugin artifact must be a full SHA-256");
    return (
      (await this.artifactReference(id, artifact.slice(0, 16), artifact)) !==
      null
    );
  }
  async resolveArtifactReference(
    id: string,
    reference: string,
  ): Promise<string> {
    const artifact = await this.artifactReference(id, reference);
    if (artifact === null)
      throw Error(
        "Plugin artifact reference is ambiguous; use the full SHA-256",
      );
    if (artifact === undefined)
      throw Error("Plugin artifact reference is unknown; discover again");
    return artifact;
  }
  private async artifactReference(
    id: string,
    reference: string,
    artifact?: string,
  ): Promise<string | null | undefined> {
    if (
      !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) ||
      !/^[a-f0-9]{16}$/.test(reference)
    )
      throw Error("Invalid plugin artifact reference");
    const db = await this.open();
    return new Promise((resolve, reject) => {
      // A single settings read/write transaction serializes registration across
      // tabs. A collision is committed as null, never overwritten with a winner.
      const tx = db.transaction(
          "settings",
          artifact ? "readwrite" : "readonly",
        ),
        store = tx.objectStore("settings"),
        request = store.get(ARTIFACT_REFERENCES_KEY);
      let result: string | null | undefined;
      let cause: unknown;
      request.onsuccess = () => {
        try {
          const entries = artifactReferences(request.result),
            key = `${id}:${reference}`;
          result = ownRecordValue(entries, key);
          if (artifact !== undefined) {
            if (result === undefined) {
              if (Object.keys(entries).length >= ARTIFACT_REFERENCES_LIMIT)
                throw Error(
                  "Plugin artifact reference storage exceeds 8192 entries",
                );
              result = artifact;
            } else if (result !== artifact) result = null;
            setRecordValue(entries, key, result);
            store.put(entries, ARTIFACT_REFERENCES_KEY);
          }
        } catch (error) {
          cause = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          cause ??
            Error(
              `Plugin artifact reference storage aborted: ${tx.error?.message ?? request.error?.message}`,
            ),
        );
      tx.onerror = () =>
        reject(
          cause ??
            Error(
              `Plugin artifact reference storage failed: ${tx.error?.message ?? request.error?.message}`,
            ),
        );
    });
  }
  async plugins(): Promise<InstalledPlugin[]> {
    return this.transact("plugins", "readonly", (s) => s.getAll());
  }
  async put(plugin: InstalledPlugin): Promise<void> {
    await this.transact("plugins", "readwrite", (s) =>
      s.put(
        { ...plugin, status: "disabled", error: undefined },
        plugin.manifest.id,
      ),
    );
  }
  async remove(id: string): Promise<void> {
    await this.transact("plugins", "readwrite", (s) => s.delete(id));
    await this.clearKV(id);
  }
  async preferences(): Promise<Preferences> {
    const saved = await this.transact<unknown>("settings", "readonly", (s) =>
      s.get("preferences"),
    );
    return saved === undefined
      ? { sessions: {}, tombstones: [] }
      : normalizePreferences(saved);
  }
  async savePreferences(p: Preferences): Promise<void> {
    await this.transact("settings", "readwrite", (s) =>
      s.put(p, "preferences"),
    );
  }
  async kv(id: string): Promise<Record<string, string>> {
    return (
      (await this.transact<Record<string, string> | undefined>(
        "kv",
        "readonly",
        (s) => s.get(id),
      )) ?? {}
    );
  }
  async writeKV(
    id: string,
    key: string,
    value: string | undefined,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    if (
      typeof key !== "string" ||
      key.length > 512 ||
      ["__proto__", "constructor", "prototype"].includes(key)
    )
      throw new Error("invalid plugin storage key");
    const db = await this.open();
    if (signal?.aborted) throw new Error("plugin storage request cancelled");
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite"),
        store = tx.objectStore("kv"),
        get = store.get(id);
      let next: Record<string, string> = {};
      let cause = "plugin storage request cancelled";
      const abort = () => {
        try {
          tx.abort();
        } catch {
          /* A completed transaction already has its durable receipt. */
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      const clean = () => signal?.removeEventListener("abort", abort);
      get.onsuccess = () => {
        next = { ...(get.result as Record<string, string> | undefined) };
        if (value === undefined) delete next[key];
        else next[key] = value;
        if (
          new TextEncoder().encode(JSON.stringify(next)).length >
          LIMITS.storageBytes
        ) {
          cause = "plugin storage exceeds 4 MiB quota";
          tx.abort();
          return;
        }
        store.put(next, id);
      };
      tx.oncomplete = () => {
        clean();
        resolve(next);
      };
      tx.onabort = () => {
        clean();
        reject(new Error(tx.error?.message ?? cause));
      };
      tx.onerror = () => {
        clean();
        reject(new Error(`plugin storage write failed: ${tx.error?.message}`));
      };
    });
  }
  async clearKV(id: string): Promise<void> {
    await this.transact("kv", "readwrite", (s) => s.delete(id));
  }
  close(): void {
    void this.db?.then((db) => db.close());
  }
}
