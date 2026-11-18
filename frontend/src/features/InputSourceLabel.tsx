import type { NativeInputSource } from "../client/types";
import {
  isDirectUserSource,
  validateNativeInputSource,
} from "../client/input-source";
import { t } from "../i18n";

/** Trusted transport labels are escaped text; they confer no user-input authority. */
export function InputSourceLabel({ source }: { source?: NativeInputSource }) {
  if (isDirectUserSource(source)) return null;
  let label: string;
  try {
    validateNativeInputSource(source);
    if (source === "framework") label = t("inputSource.framework");
    else if (source && "agent" in source) {
      label = t("inputSource.agent", { identity: source.agent.agent_id });
      if (source.agent.exchange)
        label += ` · ${t(`inputSource.${source.agent.exchange.intent}`, { exchange: source.agent.exchange.exchange_id })}`;
    } else if (source && "external" in source)
      label = t("inputSource.external", { identity: source.external.identity });
    else label = t("inputSource.unknown");
  } catch {
    // A malformed already-projected block is shown explicitly without raw metadata.
    label = t("inputSource.unknown");
  }
  return (
    <div
      className="muted"
      data-testid="input-source-label"
      style={{ overflowWrap: "anywhere" }}
    >
      {label}
    </div>
  );
}
