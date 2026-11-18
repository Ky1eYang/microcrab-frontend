/** Host-owned HTTP policy, independent of guest payloads and synchronous calls. */
export const HTTP_REQUEST_TIMEOUT = {
  defaultMs: 10_000,
  minMs: 10_000,
  maxMs: 300_000,
} as const;

export function validateHttpRequestTimeout(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < HTTP_REQUEST_TIMEOUT.minMs ||
    value > HTTP_REQUEST_TIMEOUT.maxMs
  )
    throw Error(
      "Plugin HTTP request timeout must be an integer from 10000 to 300000 ms",
    );
  return value;
}
