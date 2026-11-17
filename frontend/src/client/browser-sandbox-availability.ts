import { useSyncExternalStore } from "react";
import {
  fetchBrowserHostManifest,
  verifyBrowserHostEntry,
} from "./browser-host";
import { t } from "../i18n";

/** Picker-facing sandbox availability. `hidden` means this build or browser can
 * never run it; `not_ready` means same-origin runtime assets were not found
 * (yet) and a click may fetch them. Nothing here selects a workspace. */
export type SandboxAvailability =
  | { state: "hidden" }
  | { state: "not_ready" }
  | { state: "loading" }
  | { state: "ready" }
  | { state: "error"; error: string };

/** Build switch (`VITE_MICROCRAB_BROWSER_SANDBOX=0|false`) plus WebAssembly
 * and JSPI (`WebAssembly.Suspending` / `promising`), which the worker needs. */
export function isSandboxSupportedByBuild(
  flag: unknown = import.meta.env?.VITE_MICROCRAB_BROWSER_SANDBOX,
  wasm: unknown = (globalThis as { WebAssembly?: unknown }).WebAssembly,
) {
  const value = String(flag ?? "")
    .trim()
    .toLowerCase();
  if (value === "0" || value === "false") return false;
  const api = wasm as { Suspending?: unknown; promising?: unknown } | undefined;
  return (
    !!api &&
    typeof api.Suspending === "function" &&
    typeof api.promising === "function"
  );
}

const states = new Map<string, SandboxAvailability>();
const inflight = new Map<string, Promise<SandboxAvailability>>();
const listeners = new Set<() => void>();
const HIDDEN: SandboxAvailability = { state: "hidden" };
const NOT_READY: SandboxAvailability = { state: "not_ready" };

const keyOf = (base: string) => {
  try {
    return new URL(base || location.origin, location.href).origin;
  } catch {
    return base;
  }
};
const set = (key: string, value: SandboxAvailability) => {
  states.set(key, value);
  for (const listener of listeners) listener();
};

export function sandboxAvailability(base: string): SandboxAvailability {
  if (!isSandboxSupportedByBuild()) return HIDDEN;
  // Until a probe answers, the row is not ready: never flash available.
  return states.get(keyOf(base)) ?? NOT_READY;
}

/** Light probe: only `current.json`. Ready stays cached for the session. */
export function probeBrowserSandbox(base: string) {
  const key = keyOf(base);
  if (!isSandboxSupportedByBuild()) return Promise.resolve(HIDDEN);
  const known = states.get(key);
  if (known?.state === "ready" || known?.state === "loading")
    return Promise.resolve(known);
  const running = inflight.get(key);
  if (running) return running;
  const probe = fetchBrowserHostManifest(base)
    .then(
      () => ({ state: "ready" }) as const,
      () => NOT_READY,
    )
    .then((result) => {
      // A click-to-fetch that started meanwhile owns the row.
      const current = states.get(key);
      if (current?.state !== "loading" && current?.state !== "error")
        set(key, result);
      return states.get(key) ?? result;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, probe);
  return probe;
}

/** Click on a not-ready row: same-origin manifest plus entry integrity and
 * module load, exactly as attach does. Success makes the row selectable. */
export async function ensureBrowserSandbox(base: string) {
  const key = keyOf(base);
  if (!isSandboxSupportedByBuild()) return HIDDEN;
  if (states.get(key)?.state === "loading") return states.get(key)!;
  set(key, { state: "loading" });
  try {
    const { manifest, manifestUrl } = await fetchBrowserHostManifest(base);
    const entryUrl = await verifyBrowserHostEntry(manifest, manifestUrl);
    await import(/* @vite-ignore */ entryUrl.href);
    set(key, { state: "ready" });
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : t("browserHost.artifactsMissing");
    set(key, { state: "error", error: message });
  }
  return states.get(key)!;
}

export function useSandboxAvailability(base: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => sandboxAvailability(base),
  );
}

/** Test seam: forget cached results. */
export function resetSandboxAvailability() {
  states.clear();
  inflight.clear();
  for (const listener of listeners) listener();
}
