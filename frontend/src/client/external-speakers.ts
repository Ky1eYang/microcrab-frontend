import { CommandError } from "./errors";

export type SpeakerScope = { kind: "project" | "session"; id: string };
export type SpeakerBinding =
  | {
      action: "set";
      key:
        | { kind: "generated" }
        | { kind: "custom"; value: string }
        | { kind: "keep" };
    }
  | { action: "disable" };
export type SpeakerLayer = Record<string, SpeakerBinding>;
export interface SpeakerRow {
  identity: string;
  fingerprint?: string;
  source: "project" | "session";
  disabled: boolean;
}
export interface SpeakerSnapshot {
  revision: number;
  speakers: SpeakerRow[];
  overrides: Record<
    string,
    { action: "set"; key: { kind: "keep" } } | { action: "disable" }
  >;
}
export interface SpeakerKey {
  identity: string;
  fingerprint: string;
  key: string;
}
export interface SpeakerOperationResponse extends SpeakerSnapshot {
  operation_id: string;
}
export interface SpeakerUpdate {
  operation_id: string;
  expected_revision: number;
  speakers: SpeakerLayer;
}
export const validSpeakerIdentity = (value: string) =>
  /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(value);
export const validSpeakerCustomKey = (value: string) =>
  /^[A-Za-z0-9_-]{43,128}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const fingerprint = (value: unknown) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export function speakerPath(scope: SpeakerScope) {
  if (!scope.id)
    throw new CommandError(
      "invalid_request",
      "Speaker scope identity is required",
    );
  return `api/v1/${scope.kind === "project" ? "projects" : "sessions"}/${encodeURIComponent(scope.id)}/external-speakers`;
}
/** Effective rows are presentation only. Only overrides can seed a replacement PUT. */
export function validateSpeakerSnapshot(
  value: unknown,
): asserts value is SpeakerSnapshot {
  if (
    !object(value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.speakers) ||
    !object(value.overrides)
  )
    throw new CommandError(
      "invalid_result",
      "external-speakers: expected revision, effective speakers and local overrides",
    );
  const identities = new Set<string>();
  for (const row of value.speakers) {
    if (
      !object(row) ||
      Object.keys(row).some(
        (key) =>
          !["identity", "fingerprint", "source", "disabled"].includes(key),
      ) ||
      typeof row.identity !== "string" ||
      !validSpeakerIdentity(row.identity) ||
      identities.has(row.identity) ||
      !["project", "session"].includes(row.source as string) ||
      typeof row.disabled !== "boolean" ||
      (row.fingerprint !== undefined && !fingerprint(row.fingerprint)) ||
      (!row.disabled && !fingerprint(row.fingerprint))
    )
      throw new CommandError(
        "invalid_result",
        "external-speakers.speakers: invalid identity, fingerprint, source or disabled state",
      );
    identities.add(row.identity);
  }
  for (const [identity, binding] of Object.entries(value.overrides)) {
    if (
      !validSpeakerIdentity(identity) ||
      !object(binding) ||
      !(
        (binding.action === "disable" && Object.keys(binding).length === 1) ||
        (binding.action === "set" &&
          Object.keys(binding).length === 2 &&
          object(binding.key) &&
          binding.key.kind === "keep" &&
          Object.keys(binding.key).length === 1)
      )
    )
      throw new CommandError(
        "invalid_result",
        "external-speakers.overrides: expected local keep binding or disable",
      );
  }
}
export function validateSpeakerOperation(
  value: unknown,
  operationId: string,
): asserts value is SpeakerOperationResponse {
  validateSpeakerSnapshot(value);
  if ((value as SpeakerOperationResponse).operation_id !== operationId)
    throw new CommandError(
      "invalid_result",
      "external-speakers.operation_id: receipt identity mismatch",
    );
}
export function validateSpeakerUpdate(
  scope: SpeakerScope,
  update: SpeakerUpdate,
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      update.operation_id,
    )
  )
    throw new CommandError(
      "invalid_request",
      "external-speakers.operation_id: expected UUID",
    );
  if (
    !Number.isSafeInteger(update.expected_revision) ||
    update.expected_revision < 0
  )
    throw new CommandError(
      "invalid_request",
      "external-speakers.expected_revision: expected nonnegative safe integer",
    );
  for (const [identity, binding] of Object.entries(update.speakers)) {
    if (!validSpeakerIdentity(identity))
      throw new CommandError(
        "invalid_request",
        "external-speakers.identity: expected tag-safe identity (1–64 characters)",
      );
    if (binding.action === "disable") {
      if (scope.kind !== "session")
        throw new CommandError(
          "invalid_request",
          "external-speakers: disable is only available for sessions",
        );
    } else if (
      binding.key.kind === "custom" &&
      !validSpeakerCustomKey(binding.key.value)
    )
      throw new CommandError(
        "invalid_request",
        "external-speakers.key: expected 43–128 ASCII letters, digits, underscores or hyphens",
      );
  }
}
export function validateSpeakerKey(
  value: unknown,
): asserts value is SpeakerKey {
  if (
    !object(value) ||
    typeof value.identity !== "string" ||
    !validSpeakerIdentity(value.identity) ||
    !fingerprint(value.fingerprint) ||
    typeof value.key !== "string" ||
    !validSpeakerCustomKey(value.key)
  )
    throw new CommandError(
      "invalid_result",
      "external-speakers.key: invalid key response",
    );
}
/** A pending/unknown receipt never authorizes a second mutation. */
export const speakerOutcomeUnknown = (error: unknown) =>
  error instanceof CommandError &&
  (error.outcomeUnknown ||
    ["receipt_pending", "outcome_unknown"].includes(error.code));
