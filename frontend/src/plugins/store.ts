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
