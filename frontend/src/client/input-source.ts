import { CommandError } from "./errors";
import type { NativeInputSource } from "./types";

/** Only omission denotes a direct human input. Unknown/null/future sources fail closed. */
export function isDirectUserSource(source: unknown): source is undefined {
  return source === undefined;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const identity = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
/** Transport metadata only. Validation never grants composer or child-entry authority. */
export function validateNativeInputSource(
  source: unknown,
): asserts source is NativeInputSource | undefined {
  if (source === undefined || source === "framework") return;
  if (record(source) && Object.keys(source).length === 1) {
    if (
      record(source.external) &&
      keys(source.external, ["identity"]) &&
      identity(source.external.identity)
    )
      return;
    if (
      record(source.agent) &&
      keys(source.agent, ["agent_id", "exchange"]) &&
      identity(source.agent.agent_id)
    ) {
      const exchange = source.agent.exchange;
      if (
        exchange === undefined ||
        (record(exchange) &&
          keys(exchange, ["exchange_id", "intent"]) &&
          identity(exchange.exchange_id) &&
          ["send", "reply"].includes(exchange.intent as string))
      )
        return;
    }
  }
  throw new CommandError(
    "invalid_result",
    "message.source: expected omitted user, framework, agent or external carrier metadata",
  );
}
