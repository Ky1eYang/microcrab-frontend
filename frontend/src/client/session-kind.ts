import type { SessionView } from "./types";
import { isRecord } from "./permissions";

/** Session kind controls task input, independently of permission interaction and
 * parent-authorized read inspection. Historical missing kind stays interactive. */
export function userTaskInputAllowed(
  session?: Pick<SessionView, "kind" | "parentID"> | null,
  state?: unknown,
): boolean {
  if (!session) return true;
  const current =
    isRecord(state) && isRecord(state.session) ? state.session.kind : undefined;
  const kind = current ?? session?.kind;
  return !session?.parentID && (kind === undefined || kind === "interactive");
}
