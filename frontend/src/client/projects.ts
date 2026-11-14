import type { SessionView } from "./types";
export const UNKNOWN_PROJECT = "unknown-project";
/** Project IDs are assigned by the server; display paths do not define identity. */
export function projectIdentity(project: { id?: string }): string {
  return project.id || UNKNOWN_PROJECT;
}
export function sessionProject(session: SessionView): string {
  return session.projectID || UNKNOWN_PROJECT;
}
export function isConversation(
  session: SessionView,
  _conversations: string[],
): boolean {
  return !session.projectID;
}
