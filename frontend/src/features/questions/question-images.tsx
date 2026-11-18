import { useEffect, useMemo, useRef, useState } from "react";
import type { Components } from "react-markdown";
import type { AppState, PendingQuestion } from "../../client/types";
import type { ClientBinding } from "../../client/client-tool-controller";
import type { QuestionImageRequest } from "../../client/question-images";
import { useAppSelector, useAppStore } from "../../state";
import { t } from "../../i18n";
import { classifyCitation } from "../citations/parser";

export interface QuestionImageScope {
  identity: string;
  leaseId?: string;
  sessionId: string;
  invocationId: string;
  targetSessionId: string;
  historyLineage: string;
  current: () => boolean;
  read: (request: QuestionImageRequest, signal: AbortSignal) => Promise<Blob>;
}

function witness(state: AppState, question: PendingQuestion): string {
  const owner = state.authSession?.authenticated
    ? state.authSession.principal?.owner
    : undefined;
  const binding = state.clientTools as ClientBinding | null | undefined;
  const call = binding?.pending.find(
    (item) => item.invocation_id === question.id,
  );
  const root = question.parentSessionId ?? question.sessionId;
  const lineage = state.transcript.historyView?.lineage;
  const visibleQuestion = state.transcript.pendingQuestions.find(
    (item) => item.id === question.id,
  );
  if (
    !owner ||
    !(binding?.participation_id || binding?.lease_id) ||
    !(binding?.can_interact === true || (binding?.can_interact === undefined && binding?.role === "executor" && !!binding?.lease_id)) ||
    !lineage ||
    state.page !== "conversation" ||
    state.sessionId !== root ||
    !call ||
    call.tool !== "ask_user_question" ||
    call.session_id !== question.sessionId ||
    call.parent_session_id !== root ||
    !["pending", "paused"].includes(call.status) ||
    !visibleQuestion ||
    visibleQuestion.observer ||
    visibleQuestion.imageRevoked ||
    visibleQuestion.awaitingConfirmation
  )
    return "";
  return JSON.stringify([
    owner,
    state.apiBase,
    root,
    lineage,
    state.transcript.historyResetRevision,
    question.id,
    call.session_id,
    call.call_id,
    call.epoch,
    call.turn_id,
    call.round_id,
    call.catalog_digest,
    call.arguments,
    binding?.role,
    binding?.can_interact,
    binding?.lease_id,
    binding?.participation_id,
  ]);
}

/** Question arguments have their own witness; assistant-message citation authority
 * never enters this scope. Rebinding, history travel or settlement retires it. */
export function useQuestionImageScope(
  question: PendingQuestion,
): QuestionImageScope | undefined {
  const store = useAppStore();
  const stamp = useAppSelector((state) => witness(state, question));
  return useMemo(() => {
    if (!stamp) return undefined;
    const state = store.getSnapshot();
    const api = store.api;
    const binding = state.clientTools as ClientBinding;
    const leaseId = binding.participation_id ?? (binding.role === "executor" ? binding.lease_id : undefined);
    return {
      identity: stamp,
      leaseId,
      sessionId: question.parentSessionId ?? question.sessionId,
      invocationId: question.id,
      targetSessionId: question.sessionId,
      historyLineage: state.transcript.historyView!.lineage,
      current: () =>
        store.api === api && witness(store.getSnapshot(), question) === stamp,
      read: (request: QuestionImageRequest, signal: AbortSignal) =>
        api.readQuestionImage(request, leaseId, signal),
    };
  }, [store, stamp, question.id, question.sessionId, question.parentSessionId]);
}

function externalImage(href: string): string | undefined {
  try {
    const url = new URL(href);
    if (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    /* Relative references are handled exclusively by the leased Host read. */
  }
  return undefined;
}

function QuestionImage({
  href,
  alt,
  scope,
}: {
  href: string;
  alt: string;
  scope: QuestionImageScope;
}) {
  const local = classifyCitation(href);
  const external = local ? undefined : externalImage(href);
  const [source, setSource] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef<AbortController | null>(null);
  const blobUrl = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort();
      if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    };
  }, [scope.identity, href]);
  if ((!local && !external) || !scope.current()) return <span>{alt}</span>;
  const load = async () => {
    if (operation.current) {
      operation.current.abort();
      return;
    }
    if (!scope.current()) return;
    setError("");
    if (external) {
      setSource(external);
      return;
    }
    if (!scope.leaseId) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    try {
      const blob = await scope.read(
        {
          sessionId: scope.sessionId,
          invocationId: scope.invocationId,
          targetSessionId: scope.targetSessionId,
          historyLineage: scope.historyLineage,
          href,
        },
        controller.signal,
      );
      if (!mounted.current || controller.signal.aborted || !scope.current())
        return;
      const url = URL.createObjectURL(blob);
      blobUrl.current = url;
      setSource(url);
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && scope.current())
        setError(
          failure instanceof Error
            ? failure.message
            : t("question.imageFailed"),
        );
    } finally {
      if (operation.current === controller) operation.current = null;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <span className="question-image" data-testid="question-image">
      {source ? (
        <img
          src={source}
          alt={alt}
          referrerPolicy="no-referrer"
          onError={() => {
            setSource(undefined);
            if (blobUrl.current) {
              URL.revokeObjectURL(blobUrl.current);
              blobUrl.current = undefined;
            }
            setError(t("question.imageFailed"));
          }}
        />
      ) : (
        <button
          type="button"
          className="ghost-btn question-image-load"
          disabled={!!local && !scope.leaseId}
          title={
            local && !scope.leaseId ? t("question.imageExecutorRequired") : href
          }
          aria-busy={busy}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void load();
          }}
        >
          {t(busy ? "question.imageCancel" : "question.imageLoad", {
            alt: alt || local?.filename || href,
          })}
        </button>
      )}
      {error && (
        <span role="alert" className="question-image-error">
          {error}
        </span>
      )}
    </span>
  );
}

export function questionImageComponents(scope: QuestionImageScope): Components {
  return {
    img: ({ node, src, alt }) => {
      const original = node?.properties["data-citation-href"];
      const href =
        typeof original === "string"
          ? original
          : typeof src === "string"
            ? src
            : "";
      return (
        <QuestionImage
          key={JSON.stringify([scope.identity, href])}
          href={href}
          alt={alt ?? ""}
          scope={scope}
        />
      );
    },
  };
}
