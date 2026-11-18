import type {
  AppState,
  NativeProject,
  SessionView,
} from "../../../client/types";
import { sessionActiveTime } from "../../../state/model";

/** Recent is an owner-scoped projection of catalog membership, never another registry. */
export function recentProjects(
  projects: NativeProject[],
  sessions: SessionView[],
) {
  const activity = new Map<string, number>();
  for (const session of sessions) {
    if (session.parentID || !session.projectID) continue;
    activity.set(
      session.projectID,
      Math.max(
        activity.get(session.projectID) ?? 0,
        sessionActiveTime(session),
      ),
    );
  }
  return projects
    .filter((p) => activity.has(p.id))
    .sort(
      (a, b) =>
        activity.get(b.id)! - activity.get(a.id)! || a.id.localeCompare(b.id),
    )
    .slice(0, 3);
}

export function projectAvailability(
  project: NativeProject,
  observed: AppState["hostConnection"],
  terminal?: "binding_mismatch" | "host_preflight_unsupported",
): "online" | "offline" | "unknown" | "binding_mismatch" | "host_preflight_unsupported" {
  if (terminal) return terminal;
  if (observed?.projectId === project.id) {
    if (typeof observed.connected === "boolean")
      return observed.connected ? "online" : "offline";
    if (["detached", "offline"].includes(observed.state)) return "offline";
    return "unknown";
  }
  if (typeof project.host_connected === "boolean")
    return project.host_connected ? "online" : "offline";
  return project.status === "online" || project.status === "offline"
    ? project.status
    : "unknown";
}

export function filterProjects(projects: NativeProject[], query: string) {
  const q = query.trim().toLowerCase();
  return projects.filter((p) =>
    `${p.name}\n${p.root ?? ""}`.toLowerCase().includes(q),
  );
}

/** Locators supply presentation only. A shared address never merges Host identities. */
export function hostGroups(
  projects: NativeProject[],
  locator: (p: NativeProject) => string | null | undefined,
) {
  const groups = new Map<
    string,
    { id: string; label: string; projects: NativeProject[] }
  >();
  for (const project of projects) {
    const id = project.host_id || "";
    let group = groups.get(id);
    if (!group) {
      group = { id, label: "", projects: [] };
      groups.set(id, group);
    }
    group.projects.push(project);
    if (!group.label) {
      const endpoint = id ? locator(project) : null;
      if (endpoint) {
        try {
          group.label = new URL(endpoint).host;
        } catch {
          /* identity fallback */
        }
      }
    }
  }
  const list = [...groups.values()].sort((a, b) =>
    !a.id ? 1 : !b.id ? -1 : a.id.localeCompare(b.id),
  );
  for (const group of list) group.label ||= group.id.slice(0, 12);
  const sharedLabels = new Set(
    list
      .filter((group) =>
        list.some((other) => other !== group && other.label === group.label),
      )
      .map((group) => group.label),
  );
  for (const group of list) {
    if (group.id && sharedLabels.has(group.label)) {
      // Include the full identity if its short prefix is shared as well.
      const short = group.id.slice(0, 8);
      group.label += ` · ${list.some((other) => other !== group && other.id.startsWith(short)) ? group.id : short}`;
    }
  }
  return list;
}
