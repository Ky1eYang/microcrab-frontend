/** History disclosure is presentation state. Only an exact Turn transition may
 * request another automatic fold; statistics clocks never own this decision. */
export interface HistoryFoldState {
  observed: boolean;
  completionRevision: number | null;
}

export interface HistoryFoldInput {
  hasBlocks: boolean;
  busy: boolean;
  completionRevision: number | null;
  following: boolean;
  showAll: boolean;
  failed: boolean;
}

export function historyFoldPolicy(
  previous: HistoryFoldState,
  input: HistoryFoldInput,
): { state: HistoryFoldState; fold: boolean } {
  if (!input.hasBlocks) return { state: previous, fold: false };
  const state = {
    observed: true,
    completionRevision: input.completionRevision,
  };
  if (!previous.observed)
    return {
      state,
      fold: !input.busy && input.following && !input.showAll && !input.failed,
    };
  const completed =
    input.completionRevision !== null &&
    previous.completionRevision !== null &&
    input.completionRevision > previous.completionRevision;
  // Consume completion even while busy/reading. It must never become a deferred
  // fold when a later status update or scroll gesture changes the view.
  return {
    state,
    fold:
      completed &&
      !input.busy &&
      input.following &&
      !input.showAll &&
      !input.failed,
  };
}
