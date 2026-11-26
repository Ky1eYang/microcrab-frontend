const MAX_U64 = 18_446_744_073_709_551_615n;

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

/** Validate the Session State inspection wire boundary without walking
 * ordinary or Secret values. */
export function parseStateInspection(value: unknown) {
  const inspection = record(value);
  const values = record(own(inspection, "values"));
  const metadata = record(own(inspection, "metadata"));
  const descriptors = record(own(inspection, "descriptors"));
  const witness = record(own(inspection, "witness"));
  const runtime = own(witness, "runtime_instance_id");
  const revisionText = own(witness, "variables_revision");
  const revision = uint64(revisionText);
  if (
    !values ||
    !metadata ||
    !descriptors ||
    !runtime ||
    typeof runtime !== "string" ||
    typeof revisionText !== "string" ||
    revision === undefined
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
  };
}
