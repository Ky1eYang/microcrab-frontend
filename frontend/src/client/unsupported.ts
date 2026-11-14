import { t } from "../i18n";
import { CommandError } from "./errors";

/** Fail locally until a native command is implemented; never simulate backend success. */
export function unsupported(operation: string): never {
  throw new CommandError(
    "unsupported",
    t("unsupported.message", { operation }),
  );
}
