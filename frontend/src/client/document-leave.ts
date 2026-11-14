export type LeaveGuard = (proceed?: () => void) => boolean;
export type DocumentDraft = Readonly<{ label: string; text: string }>;
type Registration = {
  root: () => HTMLElement | null;
  guard: LeaveGuard;
  draft?: () => DocumentDraft | null;
};
type RecoveredDrafts = Readonly<{
  owner: string;
  drafts: readonly DocumentDraft[];
}>;
let recovered: RecoveredDrafts | null = null;
let recoveryDiscarded: (() => void) | undefined;
const recoveryListeners = new Set<() => void>();
const protectRecovery = (event: BeforeUnloadEvent) => {
  if (recovered?.drafts.length) event.preventDefault();
};
export const recoveredDraftsSnapshot = () => recovered;
export function subscribeRecoveredDrafts(listener: () => void) {
  recoveryListeners.add(listener);
  return () => {
    recoveryListeners.delete(listener);
  };
}
export function discardRecoveredDrafts(resumeLeave = true) {
  const proceed = recoveryDiscarded;
  recoveryDiscarded = undefined;
  recovered = null;
  window.removeEventListener("beforeunload", protectRecovery);
  for (const listener of recoveryListeners) listener();
  if (resumeLeave) proceed?.();
}
export function verifyRecoveredDraftOwner(owner: string) {
  if (recovered && recovered.owner !== owner) discardRecoveredDrafts(false);
}
/** Text-only memory survives editor teardown, never retaining an effect, save
 * callback, edit context or capability. A cancelled full-page leave can copy it. */
export function retainDocumentDrafts(owner: string, onDiscard?: () => void) {
  const drafts = [...documents].flatMap((entry) => {
    const snapshot = entry.root()?.isConnected ? entry.draft?.() : null;
    return snapshot
      ? [Object.freeze({ label: snapshot.label, text: snapshot.text })]
      : [];
  });
  if (!drafts.length) return;
  recoveryDiscarded = onDiscard;
  recovered = Object.freeze({ owner, drafts: Object.freeze(drafts) });
  window.addEventListener("beforeunload", protectRecovery);
  for (const listener of recoveryListeners) listener();
}
const documents = new Set<Registration>();
let intentRevision = 0;

/** User navigation consults mounted documents. Authority revocation does not:
 * registrations disappear with the exact document and never transfer consent. */
export function registerDocumentLeave(
  root: () => HTMLElement | null,
  guard: LeaveGuard,
  draft?: () => DocumentDraft | null,
) {
  const document = { root, guard, draft };
  documents.add(document);
  return () => {
    documents.delete(document);
  };
}

/** A later leave intent cancels the older continuation. Re-scan on every
 * confirmed discard: another document may have become dirty during the prompt.
 * Guards may invoke proceed only after returning false and clearing their dirty
 * state; returning true is the synchronous no-confirmation path. */
export function requestGuardedLeave(
  guards: () => LeaveGuard[],
  proceed: () => void,
): boolean {
  const revision = ++intentRevision;
  let completed = false;
  const advance = (): boolean => {
    if (completed || revision !== intentRevision) return false;
    for (const guard of guards()) {
      let resumed = false;
      if (
        !guard(() => {
          if (
            resumed ||
            completed ||
            revision !== intentRevision ||
            !guards().includes(guard)
          )
            return;
          resumed = true;
          advance();
        })
      )
        return false;
    }
    if (revision !== intentRevision) return false;
    completed = true;
    proceed();
    return true;
  };
  return advance();
}

export function requestDocumentLeave(
  proceed: () => void,
  selector?: string,
): boolean {
  return requestGuardedLeave(
    () =>
      [...documents]
        .filter((entry) => {
          const root = entry.root();
          return root?.isConnected && (!selector || root.closest(selector));
        })
        .map((entry) => entry.guard),
    proceed,
  );
}
