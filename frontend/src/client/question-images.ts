export interface QuestionImageRequest {
  sessionId: string;
  invocationId: string;
  targetSessionId: string;
  historyLineage: string;
  href: string;
}

/** The executor lease is intentionally carried in a header, never a URL. */
export function questionImagePath(request: QuestionImageRequest): string {
  const query = new URLSearchParams({
    history_lineage: request.historyLineage,
    target_session_id: request.targetSessionId,
    href: request.href,
  });
  return `api/v1/sessions/${encodeURIComponent(request.sessionId)}/questions/${encodeURIComponent(request.invocationId)}/image?${query}`;
}
