import { reportDiagnostic } from "./diagnostics";
import type { BrowserAuthSession } from "./auth";
import type { NativeProject } from "./types";

export type HostCarrier = "relay" | "grpc";

/** HTTP explicitly selects gRPC. Loopback WebSocket locators allow a negotiated
 * server-owned outbound route, retaining browser relay as the fallback. */
export function hostCarrier(endpoint: string): HostCarrier | null {
  try {
    const protocol = new URL(endpoint).protocol;
    if (protocol === "ws:" || protocol === "wss:") return "relay";
    if (protocol === "http:" || protocol === "https:") return "grpc";
  } catch {
    /* The caller reports an unusable address. */
  }
  return null;
}

const ephemeralClientId = crypto.randomUUID();
const memoryLocators = new Map<string, string>();
/** Locators belong to this browser and authenticated backend owner, never Project identity. */
export function browserClientId(): string {
  const key = "microcrab.browser-client.v1";
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = ephemeralClientId;
      localStorage.setItem(key, id);
    }
    return id;
  } catch (error) {
    reportDiagnostic("storage", "browserClientId", error, undefined, "warn");
    return ephemeralClientId;
  }
}
export function hostPreferenceScope(
  base: string,
  auth?: BrowserAuthSession | null,
): string | null {
  const owner = auth?.authenticated && auth.principal?.owner;
  return owner ? JSON.stringify([base, owner, browserClientId()]) : null;
}
export function hostLocatorKey(scope: string, hostId: string): string {
  return (
    "microcrab.host-locator.v2:" +
    JSON.stringify([...JSON.parse(scope), hostId])
  );
}
export function hostLocator(
  scope: string | null,
  project?: NativeProject,
): string | undefined {
  if (!scope || !project) return;
  const key = project.host_id
    ? hostLocatorKey(scope, project.host_id)
    : undefined;
  try {
    // Legacy locators are candidates until descriptor + backend attach verify the pins.
    return (
      (key && localStorage.getItem(key)) ||
      localStorage.getItem(
        "microcrab.host-endpoint:" + JSON.parse(scope)[0] + project.id,
      ) ||
      undefined
    );
  } catch (error) {
    reportDiagnostic("storage", "hostLocator", error, undefined, "warn");
    return key ? memoryLocators.get(key) : undefined;
  }
}
export function rememberHost(
  scope: string,
  hostId: string,
  projectId: string,
  endpoint: string,
) {
  const key = hostLocatorKey(scope, hostId);
  memoryLocators.set(key, endpoint);
  try {
    localStorage.setItem(key, endpoint);
    localStorage.setItem("microcrab.host-project.v2:" + scope, projectId);
    localStorage.removeItem(
      "microcrab.host-endpoint:" + JSON.parse(scope)[0] + projectId,
    );
  } catch (error) {
    reportDiagnostic("storage", "rememberHost", error, undefined, "warn");
  }
}
