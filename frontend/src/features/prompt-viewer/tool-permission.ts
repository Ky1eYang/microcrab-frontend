import type { CurrentPermissionList } from "../../client/permissions";
import type { PermissionAction } from "../../client/types";

type RegisteredToolPermission = PermissionAction | "conditional" | "combined";

export type ToolPermissionDisplay =
  RegisteredToolPermission | "unregistered" | "unavailable" | "loading";
export type CurrentToolPermissions = ReadonlyMap<
  string,
  RegisteredToolPermission
>;
export type ReadCurrentPermissions = (
  scope: string,
  signal: AbortSignal,
) => Promise<CurrentPermissionList | undefined>;

/** Display categories only; never evaluate call arguments or infer authority. */
export function classifyCurrentTools(
  list: CurrentPermissionList,
): CurrentToolPermissions {
  return new Map(
    list.tools.map(({ name, policy }) => [
      name,
      policy.kind === "static"
        ? policy.action
        : policy.kind === "conditional"
          ? "conditional"
          : "combined",
    ]),
  );
}
