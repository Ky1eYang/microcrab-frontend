import { usageRanges, type UsageRange } from "./dashboard-usage";
import { CommandError } from "./errors";
import type { LocalePreference } from "../i18n";
import type { ThemePreference } from "./theme";
import type { NativeModelSelection } from "./types";

export type DefaultConversationFlavor = "chat_only" | "browser_sandbox" | "project";

export interface AccountPreferences {
  revision: number;
  last_operation_id: string | null;
  dashboard_default_range: UsageRange;
  low_cache_hit_warn_pct: number | null;
  relay_default_selection: NativeModelSelection | null;
  default_conversation_flavor: DefaultConversationFlavor | null;
  theme: ThemePreference | null;
  locale: LocalePreference | null;
  relay_models: NativeModelSelection[];
}

export interface SaveAccountPreferences {
  expected_revision: number;
  operation_id: string;
  dashboard_default_range: UsageRange;
  low_cache_hit_warn_pct: number | null;
  relay_default_selection: NativeModelSelection | null;
  default_conversation_flavor: DefaultConversationFlavor | null;
  theme: ThemePreference | null;
  locale: LocalePreference | null;
}

export function relaySelectionKey(selection: NativeModelSelection | null | undefined): string {
  if (!selection) return "";
  return `${selection.provider_id}/${selection.model}${
    selection.variant && selection.variant !== "default" ? `:${selection.variant}` : ""
  }`;
}

function validSelection(raw: unknown): raw is NativeModelSelection {
  return (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as any).provider_id === "string" &&
    typeof (raw as any).model === "string" &&
    ((raw as any).variant === undefined ||
      (raw as any).variant === null ||
      typeof (raw as any).variant === "string")
  );
}

export function validateAccountPreferences(
  raw: unknown,
  saved?: SaveAccountPreferences,
): AccountPreferences {
  if (typeof raw !== "object" || raw === null) {
    throw new CommandError("invalid_result", "Server returned malformed account preferences", true);
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.revision !== "number" ||
    !Number.isSafeInteger(obj.revision) ||
    obj.revision < 0
  ) {
    throw new CommandError("invalid_result", "Preferences revision is invalid", true);
  }
  if (!usageRanges.includes(obj.dashboard_default_range as UsageRange)) {
    throw new CommandError("invalid_result", "Invalid dashboard_default_range", true);
  }
  if (
    obj.low_cache_hit_warn_pct !== null &&
    (typeof obj.low_cache_hit_warn_pct !== "number" ||
      !Number.isInteger(obj.low_cache_hit_warn_pct) ||
      obj.low_cache_hit_warn_pct < 1 ||
      obj.low_cache_hit_warn_pct > 99)
  ) {
    throw new CommandError("invalid_result", "Invalid low_cache_hit_warn_pct", true);
  }
  if (
    obj.relay_default_selection !== null &&
    !validSelection(obj.relay_default_selection)
  ) {
    throw new CommandError("invalid_result", "Invalid relay_default_selection", true);
  }
  const relayModels = Array.isArray(obj.relay_models)
    ? obj.relay_models.filter(validSelection)
    : [];
  const data: AccountPreferences = {
    revision: obj.revision,
    last_operation_id:
      typeof obj.last_operation_id === "string" ? obj.last_operation_id : null,
    dashboard_default_range: obj.dashboard_default_range as UsageRange,
    low_cache_hit_warn_pct: obj.low_cache_hit_warn_pct as number | null,
    relay_default_selection: obj.relay_default_selection as NativeModelSelection | null,
    default_conversation_flavor:
      obj.default_conversation_flavor === "chat_only" ||
      obj.default_conversation_flavor === "browser_sandbox" ||
      obj.default_conversation_flavor === "project"
        ? obj.default_conversation_flavor
        : null,
    theme:
      obj.theme === "system" || obj.theme === "light" || obj.theme === "dark"
        ? obj.theme
        : null,
    locale:
      obj.locale === "system" || obj.locale === "zh-CN" || obj.locale === "en"
        ? obj.locale
        : null,
    relay_models: relayModels,
  };
  if (
    saved &&
    data.revision > saved.expected_revision &&
    data.last_operation_id &&
    data.last_operation_id !== saved.operation_id
  ) {
    throw new CommandError("revision_conflict", "Concurrent account preference modification", true);
  }
  return data;
}

export function accountPreferenceSaveObserved(
  latest: AccountPreferences,
  attempted: SaveAccountPreferences,
): boolean {
  return latest.last_operation_id === attempted.operation_id && latest.revision > attempted.expected_revision;
}
