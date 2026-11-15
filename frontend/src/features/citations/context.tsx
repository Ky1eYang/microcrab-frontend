import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAppSelector, useAppStore } from "../../state";
import type { AppState, Transcript } from "../../client/types";
import type { FeatureBlock } from "../shared";
import type { CitationRequest } from "../../client/citations";

export interface CitationScope {
  owner: string;
  sessionId: string;
  historyLineage: string;
  childSessionId?: string;
  messageId: string;
  current: () => boolean;
  read: (request: CitationRequest, signal: AbortSignal) => Promise<Blob>;
}
type ConversationScope = Omit<CitationScope, "messageId">;
const Context = createContext<ConversationScope | null>(null);
function identity(state: AppState, child?: string) {
  const popup = state.popup;
  const selectedChild =
    child && popup.type === "subagentDetail" && popup.childId === child
      ? popup
      : null;
  return JSON.stringify([
    state.authSession?.authenticated
      ? state.authSession.principal?.owner
      : null,
    state.sessionId,
    child
      ? selectedChild?.detail?.history_view?.lineage
      : state.transcript.historyView?.lineage,
    child ? selectedChild?.parentId : null,
    child ? selectedChild?.childId : null,
    state.apiBase,
  ]);
}
/** Only actual conversation mounts opt in. Inspector/plugin Markdown receives no
 * context and cannot initiate citation reads. Children retain the root authority. */
export function CitationConversationProvider({
  children,
  transcript,
  sessionId,
  readOnly = false,
}: {
  children: ReactNode;
  transcript?: Transcript;
  sessionId?: string;
  readOnly?: boolean;
}) {
  const store = useAppStore();
  const child = readOnly
    ? (sessionId ?? transcript?.blocks[0]?.sessionId)
    : undefined;
  const stamp = useAppSelector((state) => identity(state, child));
  const provided = !!transcript;
  const scope = useMemo<ConversationScope | null>(() => {
    const state = store.getSnapshot();
    const owner = state.authSession?.authenticated
      ? state.authSession.principal?.owner
      : undefined;
    const popup = state.popup;
    const lineage =
      child && popup.type === "subagentDetail" && popup.childId === child
        ? popup.detail?.history_view?.lineage
        : child
          ? undefined
          : state.transcript.historyView?.lineage;
    const root =
      child && popup.type === "subagentDetail"
        ? popup.parentId
        : state.sessionId;
    if (
      !owner ||
      !root ||
      !lineage ||
      (provided && !child) ||
      (readOnly && !child)
    )
      return null;
    const api = store.api;
    return {
      owner,
      sessionId: root,
      historyLineage: lineage,
      childSessionId: child,
      current: () =>
        store.api === api && identity(store.getSnapshot(), child) === stamp,
      read: (request, signal) => api.readCitation(request, signal),
    };
  }, [store, stamp, child, provided, readOnly]);
  return <Context.Provider value={scope}>{children}</Context.Provider>;
}
export function useCitationScope(
  block: FeatureBlock,
): CitationScope | undefined {
  const scope = useContext(Context);
  const eligible =
    !!scope &&
    block.role === "assistant" &&
    block.kind === "text" &&
    !block.isCompact &&
    !block.displayIncomplete &&
    !block.payload.failure &&
    block.stream === "complete" &&
    block.messageId?.startsWith("message-");
  return useMemo(
    () =>
      scope && eligible ? { ...scope, messageId: block.messageId } : undefined,
    [scope, eligible, block.messageId],
  );
}
