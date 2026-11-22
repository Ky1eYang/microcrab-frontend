import { useState } from "react";
import { useAppFields, useAppSelector } from "../../state";
import { t } from "../../i18n";
import { ExpandableNotice } from "../ExpandableNotice";

export function BrowserHostTakeoverNotice() {
  const { state, dispatch } = useAppFields([
    "hostConnection",
    "sessionId",
    "resolvedLocale",
  ]);
  const sessionStatus = useAppSelector(
    (state) => state.transcript.sessionStatus,
  );
  const [takingOver, setTakingOver] = useState(false);
  const hostParticipant =
    state.hostConnection?.browserParticipant &&
    state.hostConnection.conversationId === state.sessionId &&
    state.hostConnection.hostFlavor === "browser_sandbox";
  const takeover = async () => {
    if (takingOver) return;
    setTakingOver(true);
    try {
      await dispatch({ type: "TakeOverBrowserHost" });
    } finally {
      setTakingOver(false);
    }
  };
  if (!hostParticipant) return null;
  return (
    <ExpandableNotice
      className="composer-notification-row"
      tone="info"
      data-testid="browser-host-takeover-notice"
      text={t("interaction.browserHostParticipant")}
      action={
        <button
          type="button"
          className="ghost-btn"
          disabled={takingOver || sessionStatus !== "idle"}
          onClick={() => void takeover()}
        >
          {t("interaction.takeoverHost")}
        </button>
      }
    />
  );
}
