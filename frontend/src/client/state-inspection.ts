// The v0.2 State inspection has a distinct private image metadata map. Mirror
// Core's static production ceilings, not a Session's dynamic upload limits.
const MAX_BYTES_ENTRIES = 64;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PRIVATE_BYTES = 64 * 1024 * 1024;
const MAX_U64 = 18_446_744_073_709_551_615n;
const mediaTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export const byteFields = new Set([
  "name",
  "kind",
  "media_type",
  "byte_length",
  "lifecycle",
  "availability",
  "revision",
  "selector",
  "redirect_execution_id",
]);

export interface BytesMetadata {
  name: string;
  kind: "bytes";
  media_type: (typeof mediaTypes)[number];
  byte_length: number;
  lifecycle: "ephemeral";
  availability: "available";
  revision: string;
  selector: string;
  redirect_execution_id?: string;
}

export const stateKeyPattern = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}(?![\s\S])/;

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function own(row: Record<string, unknown> | undefined, key: string) {
  return row && Object.hasOwn(row, key) ? row[key] : undefined;
}

/** The native inspector and its raw adapter use the same ordinary-root admission. */
export function admitsOrdinaryState(
  metadata: Record<string, unknown>,
  descriptors: Record<string, unknown>,
  key: string,
) {
  const visibility = own(record(own(metadata, key)), "visibility");
  const kind = own(record(own(descriptors, key)), "kind");
  return (
    visibility === "visible" ||
    visibility === "invisible" ||
    (!Object.hasOwn(metadata, key) &&
      (kind === "framework" || kind === "reference"))
  );
}

function uint64(value: unknown): bigint | undefined {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,19})(?![\s\S])/.test(value)
  )
    return undefined;
  const number = BigInt(value);
  return number <= MAX_U64 ? number : undefined;
}

function parseBytes(
  map: Record<string, unknown>,
  ordinary: readonly Record<string, unknown>[],
  runtime: string,
  revision: bigint,
): BytesMetadata[] {
  const rows: BytesMetadata[] = [];
  const seenRevisions = new Set<bigint>();
  let total = 0;
  for (const key in map) {
    if (!Object.hasOwn(map, key)) continue;
    if (
      rows.length >= MAX_BYTES_ENTRIES ||
      !stateKeyPattern.test(key) ||
      ordinary.some((row) => Object.hasOwn(row, key)) ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/.test(runtime)
    )
      throw Error("invalid_result");
    const row = record(map[key]);
    if (!row) throw Error("invalid_result");
    // Reject unrecognized fields without reading them. Never spread a wire row
    // into the tree, or disclose any wire values in errors.
    for (const field in row)
      if (Object.hasOwn(row, field) && !byteFields.has(field))
        throw Error("invalid_result");
    const mediaType = mediaTypes.find(
      (type) => type === own(row, "media_type"),
    );
    const length = own(row, "byte_length");
    const revisionText = own(row, "revision");
    const rowRevision = uint64(revisionText);
    const selector = own(row, "selector");
    const executionId = own(row, "redirect_execution_id");
    if (
      own(row, "name") !== key ||
      own(row, "kind") !== "bytes" ||
      !mediaType ||
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > MAX_IMAGE_BYTES ||
      own(row, "lifecycle") !== "ephemeral" ||
      own(row, "availability") !== "available" ||
      typeof revisionText !== "string" ||
      !rowRevision ||
      rowRevision > revision ||
      seenRevisions.has(rowRevision) ||
      typeof selector !== "string" ||
      selector !==
        `bytes_${runtime.replaceAll("-", "")}_${rowRevision.toString(16).padStart(16, "0")}` ||
      (Object.hasOwn(row, "redirect_execution_id") &&
        (typeof executionId !== "string" || !uint64(executionId)))
    )
      throw Error("invalid_result");
    seenRevisions.add(rowRevision);
    total += length;
    if (total > MAX_PRIVATE_BYTES) throw Error("invalid_result");
    rows.push({
      name: key,
      kind: "bytes",
      media_type: mediaType,
      byte_length: length,
      lifecycle: "ephemeral",
      availability: "available",
      revision: revisionText,
      selector,
      ...(typeof executionId === "string" && {
        redirect_execution_id: executionId,
      }),
    });
  }
  return rows;
}

/** Validate the wire boundary without walking ordinary/Secret values. Only the
 * native inspector consumes the validated Bytes projection; legacy consumers
 * get the prior shape and never receive the private metadata map. */
export function parseStateInspection(value: unknown) {
  const inspection = record(value);
  const values = record(own(inspection, "values"));
  const metadata = record(own(inspection, "metadata"));
  const descriptors = record(own(inspection, "descriptors"));
  const witness = record(own(inspection, "witness"));
  const runtime = own(witness, "runtime_instance_id");
  const revisionText = own(witness, "variables_revision");
  const revision = uint64(revisionText);
  const bytes = record(own(inspection, "bytes"));
  if (
    !values ||
    !metadata ||
    !descriptors ||
    !runtime ||
    typeof runtime !== "string" ||
    typeof revisionText !== "string" ||
    revision === undefined ||
    (Object.hasOwn(inspection ?? {}, "bytes") && !bytes)
  )
    throw Error("invalid_result");
  return {
    ordinary: {
      values,
      metadata,
      descriptors,
      witness: {
        runtime_instance_id: runtime,
        variables_revision: revisionText,
      },
    },
    bytes: bytes
      ? parseBytes(bytes, [values, metadata, descriptors], runtime, revision)
      : [],
  };
}
