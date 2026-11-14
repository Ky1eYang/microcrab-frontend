/** Receipts and model arguments are untrusted JSON, never React children or status methods. */
export function childText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
