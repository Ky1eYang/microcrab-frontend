import { t } from "../i18n";
import { PluginImportError } from "./component";

/** Keep the original tooling cause alongside an actionable localized explanation. */
export function formatPluginImportError(reason: unknown): string {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return reason instanceof PluginImportError
    ? `${t(`plugins.importError.${reason.code}`)} ${detail}`
    : detail;
}
