export interface PersonalLibraryQuota {
  used_bytes: number;
  max_bytes: number;
  object_count: number;
  max_entries: number;
}

export type PersonalLibraryShortcutTarget =
  | {
      type: "host_path";
      path: string;
      project_id?: string;
      host_id?: string;
      workspace_id?: string;
    }
  | {
      type: "host_glob";
      root: string;
      pattern: string;
      project_id?: string;
      host_id?: string;
      workspace_id?: string;
    }
  | { type: "public_https"; url: string }
  | { type: "directory_url"; url: string };

export type PersonalLibrarySource =
  | {
      kind: "local_blob";
      origin: "upload" | "job_redirect" | "tool_capture" | "agent_literal";
      origin_session_id?: string;
      origin_execution_id?: string;
    }
  | {
      kind: "shortcut";
      target: PersonalLibraryShortcutTarget;
    };

export interface PersonalLibraryObject {
  id: string;
  title: string;
  source_kind: string;
  source: PersonalLibrarySource;
  media_type: string;
  byte_length?: number;
  sha256?: string;
  width?: number;
  height?: number;
  revision: string;
  read_only: boolean;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
  mounted_sessions: string[];
  mounted_projects: string[];
  subjects?: unknown[];
}

export interface PersonalLibraryListResponse {
  items: PersonalLibraryObject[];
  quota: PersonalLibraryQuota;
}

export function isRasterLibraryMime(mediaType: string): boolean {
  return (
    mediaType === "image/png" ||
    mediaType === "image/jpeg" ||
    mediaType === "image/gif" ||
    mediaType === "image/webp"
  );
}

export function libraryContentPath(
  apiBase: string,
  userId: string,
  refId: string,
  hint?: { sessionId?: string; projectId?: string },
): string {
  const cleanBase = apiBase.replace(/\/+$/, "");
  const query = new URLSearchParams();
  if (hint?.sessionId) query.set("session_id", hint.sessionId);
  if (hint?.projectId) query.set("project_id", hint.projectId);
  const qs = query.toString();
  const rel = `api/v1/users/${encodeURIComponent(userId)}/library/objects/${encodeURIComponent(refId)}/content${qs ? `?${qs}` : ""}`;
  return cleanBase ? `${cleanBase}/${rel}` : `/${rel}`;
}

export function formatLibraryBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function sourceKindLabel(kind: string): string {
  switch (kind) {
    case "upload":
      return "用户上传";
    case "job_redirect":
      return "Job 输出重定向";
    case "tool_capture":
      return "工具捕获";
    case "agent_literal":
      return "智能体写入";
    case "shortcut_host_path":
      return "快捷方式 · 工作区文件";
    case "shortcut_host_glob":
      return "快捷方式 · 工作区匹配";
    case "shortcut_public_https":
      return "快捷方式 · 公网 HTTPS";
    case "shortcut_directory_url":
      return "快捷方式 · 目录索引";
    default:
      return kind;
  }
}
