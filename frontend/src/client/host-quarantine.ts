import { reportDiagnostic } from "./diagnostics";

export type HostTerminalCode = "binding_mismatch" | "host_preflight_unsupported";
export type HostMismatchReason =
  | "host_descriptor_mismatch"
  | "host_identity_mismatch"
  | "workspace_identity_mismatch"
  | "inspected_descriptor_changed"
  | "project_identity_mismatch";
export interface HostCandidate {
  readonly scope: string;
  readonly projectId: string;
  readonly digest: string;
}
interface QuarantineRecord {
  projectId: string;
  candidate: string;
  code: HostTerminalCode;
  reason?: HostMismatchReason;
}
const LIMIT = 128;
const scopes = new Map<string, QuarantineRecord[]>();
const candidates = new Map<string, string>();
const storageKey = (scope: string) => "microcrab.host-quarantine.v1:" + scope;
export function hostTerminalCode(code: unknown): code is HostTerminalCode {
  return code === "binding_mismatch" || code === "host_preflight_unsupported";
}
export function hostMismatchReason(value: unknown): HostMismatchReason | undefined {
  return value === "host_descriptor_mismatch" ||
    value === "host_identity_mismatch" ||
    value === "workspace_identity_mismatch" ||
    value === "inspected_descriptor_changed" ||
    value === "project_identity_mismatch"
    ? value
    : undefined;
}
function records(scope: string): QuarantineRecord[] {
  const cached = scopes.get(scope);
  if (cached) return cached;
  let result: QuarantineRecord[] = [];
  try {
    const text = localStorage.getItem(storageKey(scope));
    // Storage is untrusted presentation state, not Server binding authority.
    const value: unknown = text && text.length <= 65536 ? JSON.parse(text) : [];
    if (Array.isArray(value))
      result = value.slice(-LIMIT).flatMap((entry) => {
        if (!entry || typeof entry !== "object" ||
            typeof entry.projectId !== "string" || entry.projectId.length > 256 ||
            typeof entry.candidate !== "string" || !/^[a-f0-9]{64}$/.test(entry.candidate) ||
            !hostTerminalCode(entry.code)) return [];
        return [{ projectId: entry.projectId, candidate: entry.candidate,
          code: entry.code, reason: hostMismatchReason(entry.reason) }];
      });
  } catch (error) {
    reportDiagnostic("storage", "hostQuarantine.read", error, undefined, "warn");
  }
  scopes.set(scope, result);
  return result;
}
function save(scope: string, value: QuarantineRecord[]) {
  scopes.set(scope, value);
  try {
    localStorage.setItem(storageKey(scope), JSON.stringify(value));
  } catch (error) {
    // Keep the same terminal gate for this page when persistence is unavailable.
    reportDiagnostic("storage", "hostQuarantine.write", error, undefined, "warn");
  }
}
const candidateKey = (url: string, directory: string) => JSON.stringify([url.trim(), directory]);
/** Hash the entire candidate snapshot: persisted records contain no URL credentials,
 * pairing token, query secrets, directory, or Server error text. */
export async function prepareHostCandidate(
  scope: string,
  projectId: string,
  url: string,
  directory: string,
): Promise<HostCandidate> {
  const key = candidateKey(url, directory);
  let digest = candidates.get(key);
  if (!digest) {
    digest = Array.from(new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(key),
    )), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (candidates.size >= 256) candidates.delete(candidates.keys().next().value!);
    candidates.set(key, digest);
  }
  return { scope, projectId, digest };
}
export function quarantinedHost(candidate: HostCandidate): QuarantineRecord | undefined {
  return records(candidate.scope).find((record) =>
    record.projectId === candidate.projectId && record.candidate === candidate.digest);
}
/** Synchronous presentation after bootstrap/connection prepares the candidate. */
export function preparedHostCandidate(
  scope: string | null,
  projectId: string,
  url: string | undefined,
  directory: string,
): HostCandidate | undefined {
  if (!scope || !url) return;
  const digest = candidates.get(candidateKey(url, directory));
  return digest ? { scope, projectId, digest } : undefined;
}
export function peekHostQuarantine(
  scope: string | null,
  projectId: string,
  url: string | undefined,
  directory: string,
): QuarantineRecord | undefined {
  const candidate = preparedHostCandidate(scope, projectId, url, directory);
  return candidate ? quarantinedHost(candidate) : undefined;
}
export function quarantineHost(candidate: HostCandidate, code: HostTerminalCode, reason?: unknown) {
  const next = records(candidate.scope).filter((record) =>
    record.projectId !== candidate.projectId || record.candidate !== candidate.digest);
  next.push({ projectId: candidate.projectId, candidate: candidate.digest,
    code, reason: hostMismatchReason(reason) });
  // A bounded browser hint: evicted candidates can be checked again by the Server.
  save(candidate.scope, next.slice(-LIMIT));
}
export function clearHostQuarantine(candidate: HostCandidate) {
  save(candidate.scope, records(candidate.scope).filter((record) =>
    record.projectId !== candidate.projectId || record.candidate !== candidate.digest));
}
export function forgetProjectQuarantine(scope: string | null, projectId: string) {
  if (scope) save(scope, records(scope).filter((record) => record.projectId !== projectId));
}
