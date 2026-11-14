import { useEffect, useRef, useState } from "react";
import { useApp } from "../state";
import { t } from "../i18n";
import { Payload } from "./Payload";
import { trapFocus } from "../client/viewport";
import type { PermissionProposalView } from "../client/types";

/** Proposals are independent of the once-decision: never replace the composer or
 * hold the current invocation while a future rule awaits confirmation. */
export function PermissionProposalDialog() {
  const { state } = useApp();
  const proposal: PermissionProposalView | undefined =
    state.permissionProposals?.[0];
  return proposal ? (
    <Proposal
      key={`${state.authSession?.principal?.owner}:${state.sessionId}:${proposal.proposal_id}`}
      value={proposal}
    />
  ) : null;
}
function Proposal({ value }: { value: PermissionProposalView }) {
  const { dispatch } = useApp();
  const [now, setNow] = useState(Date.now());
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const replyRef = useRef<(accept: boolean) => Promise<void>>(async () => {});
  const expired = now >= value.expires_at_ms;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [value.expires_at_ms]);
  useEffect(() => {
    if (dismissed) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Tab") trapFocus(dialog.current, event);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void replyRef.current(false);
      }
    };
    window.addEventListener("keydown", key, true);
    dialog.current
      ?.querySelector<HTMLButtonElement>('[data-testid="proposal-decline"]')
      ?.focus();
    return () => {
      window.removeEventListener("keydown", key, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [dismissed]);
  // Expiry is a server-owned decline. Never send an automatic acceptance or replay
  // an uncertain mutation; closing locally does not obstruct the admitted action.
  useEffect(() => {
    if (expired) setDismissed(true);
  }, [expired]);
  const reply = async (accept: boolean) => {
    if (value.disabled || value.submitting || expired) {
      if (!accept) setDismissed(true);
      return;
    }
    try {
      await dispatch({
        type: "ReplyPermissionProposal",
        proposalId: value.proposal_id,
        accept,
      });
      setDismissed(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  replyRef.current = reply;
  if (dismissed) return null;
  return (
    <div className="overlay" data-testid="permission-proposal-overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="permission-proposal-heading"
        ref={dialog}
        data-testid="permission-proposal"
        data-proposal-id={value.proposal_id}
      >
        <h3 id="permission-proposal-heading">
          {t("permission.proposal.title")}
        </h3>
        <p className="inline-notice">{t("permission.proposal.independent")}</p>
        <p>
          {t("permission.proposal.scope", {
            session: value.session_id,
            agent: value.agent,
            mode: value.mode,
            tool: value.tool,
          })}
        </p>
        <p role="timer" aria-live="off">
          {t("permission.proposal.countdown", {
            seconds: Math.max(0, Math.ceil((value.expires_at_ms - now) / 1000)),
          })}
        </p>
        {value.observer && (
          <p className="inline-notice">{t("permission.observer")}</p>
        )}
        {error && (
          <p role="alert" className="inline-notice" data-tone="danger">
            {error}
          </p>
        )}
        <Payload
          value={{
            tool: value.tool,
            args: value.args,
            controller_id: value.controller_id,
            revision: value.revision,
          }}
          testid="permission-proposal-payload"
        />
        <div className="settings-actions-row">
          <button
            className="ghost-btn"
            data-testid="proposal-decline"
            disabled={value.submitting}
            onClick={() => void reply(false)}
          >
            {t("permission.proposal.decline")}
          </button>
          <button
            className="primary-btn"
            data-testid="proposal-accept"
            disabled={value.disabled || expired}
            onClick={() => void reply(true)}
          >
            {t("permission.proposal.accept")}
          </button>
        </div>
      </div>
    </div>
  );
}
