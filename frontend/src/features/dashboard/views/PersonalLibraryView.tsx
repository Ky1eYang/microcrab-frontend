import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  formatLibraryBytes,
  isRasterLibraryMime,
  libraryContentPath,
  sourceKindLabel,
  type PersonalLibraryObject,
  type PersonalLibraryQuota,
  type PersonalLibraryShortcutTarget,
} from "../../../client/library";
import { useApp, useAppStore } from "../../../state";
import { ModalContainer } from "../components/ModalContainer";

type FilterKind = "all" | "local_blob" | "shortcut" | "current_session";

export const PersonalLibraryView: React.FC<{ refreshSignal?: number }> = ({
  refreshSignal = 0,
}) => {
  const { state, dispatch } = useApp();
  const store = useAppStore();
  const api = store.api;
  const userId = state.authSession?.authenticated
    ? state.authSession.principal?.owner
    : undefined;

  const [items, setItems] = useState<PersonalLibraryObject[]>([]);
  const [quota, setQuota] = useState<PersonalLibraryQuota | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [filterKind, setFilterKind] = useState<FilterKind>("all");

  // Upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [mountOnUpload, setMountOnUpload] = useState(true);
  const [uploading, setUploading] = useState(false);

  // Shortcut creation modal/panel
  const [showShortcutForm, setShowShortcutForm] = useState(false);
  const [shortcutType, setShortcutType] =
    useState<PersonalLibraryShortcutTarget["type"]>("public_https");
  const [shortcutTitle, setShortcutTitle] = useState("");
  const [shortcutPath, setShortcutPath] = useState("");
  const [shortcutRoot, setShortcutRoot] = useState(".");
  const [shortcutPattern, setShortcutPattern] = useState("");
  const [shortcutUrl, setShortcutUrl] = useState("");
  const [shortcutMountSession, setShortcutMountSession] = useState(true);

  // Inline rename + preview + mount targets
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [previewItem, setPreviewItem] = useState<PersonalLibraryObject | null>(
    null,
  );
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [mountSessionChoice, setMountSessionChoice] = useState<
    Record<string, string>
  >({});
  const [mountProjectChoice, setMountProjectChoice] = useState<
    Record<string, string>
  >({});

  const load = async () => {
    if (!userId) return;
    setLoading(true);
    setError("");
    try {
      const response = await api.libraryList(userId);
      setItems(response.items);
      setQuota(response.quota);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [userId, refreshSignal]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      if (filterKind === "local_blob" && item.source.kind !== "local_blob") {
        return false;
      }
      if (filterKind === "shortcut" && item.source.kind !== "shortcut") {
        return false;
      }
      if (
        filterKind === "current_session" &&
        (!state.sessionId || !item.mounted_sessions.includes(state.sessionId))
      ) {
        return false;
      }
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q) ||
        item.media_type.toLowerCase().includes(q) ||
        item.source_kind.toLowerCase().includes(q)
      );
    });
  }, [items, search, filterKind, state.sessionId]);

  const quotaPct = useMemo(() => {
    if (!quota || quota.max_bytes <= 0) return 0;
    return Math.min(100, Math.round((quota.used_bytes / quota.max_bytes) * 100));
  }, [quota]);

  const toast = (text: string, kind: "info" | "warn" = "info") => {
    setNotice(text);
    void dispatch({ type: "ShowToast", text, kind });
  };

  const handleUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !userId) return;
    setUploading(true);
    setError("");
    try {
      const created = await api.libraryUpload(userId, file, {
        title: uploadTitle.trim() || file.name,
        mountSessionId:
          mountOnUpload && state.sessionId ? state.sessionId : undefined,
      });
      setUploadTitle("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      toast(`已上传到个人内容库：${created.title} (${created.id})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleCreateShortcut = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!userId) return;
    setError("");
    let target: PersonalLibraryShortcutTarget;
    if (shortcutType === "host_path") {
      if (!shortcutPath.trim()) {
        setError("请填写工作区文件路径");
        return;
      }
      target = {
        type: "host_path",
        path: shortcutPath.trim(),
        ...(state.projectId ? { project_id: state.projectId } : {}),
      };
    } else if (shortcutType === "host_glob") {
      if (!shortcutPattern.trim()) {
        setError("请填写工作区匹配模式");
        return;
      }
      target = {
        type: "host_glob",
        root: shortcutRoot.trim() || ".",
        pattern: shortcutPattern.trim(),
        ...(state.projectId ? { project_id: state.projectId } : {}),
      };
    } else if (shortcutType === "directory_url") {
      if (!shortcutUrl.trim()) {
        setError("请填写 HTTPS 目录地址");
        return;
      }
      target = { type: "directory_url", url: shortcutUrl.trim() };
    } else {
      if (!shortcutUrl.trim()) {
        setError("请填写公网 HTTPS 地址");
        return;
      }
      target = { type: "public_https", url: shortcutUrl.trim() };
    }

    try {
      setUploading(true);
      const created = await api.libraryCreateJson(userId, {
        title: shortcutTitle.trim() || undefined,
        target,
        mount_session_id:
          shortcutMountSession && state.sessionId ? state.sessionId : undefined,
      });
      setShortcutTitle("");
      setShortcutPath("");
      setShortcutPattern("");
      setShortcutUrl("");
      setShowShortcutForm(false);
      toast(`已添加快捷方式：${created.title} (${created.id})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (item: PersonalLibraryObject) => {
    if (!userId) return;
    setBusyId(item.id);
    setError("");
    try {
      const res = await api.libraryDelete(userId, item.id);
      setQuota(res.quota);
      setItems((prev) => prev.filter((row) => row.id !== item.id));
      if (previewItem?.id === item.id) setPreviewItem(null);
      toast(`已删除 ${item.title}，并释放存储配额`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleRename = async (item: PersonalLibraryObject) => {
    if (!userId || !editingTitle.trim()) return;
    setBusyId(item.id);
    setError("");
    try {
      const updated = await api.libraryUpdate(userId, item.id, {
        expected_revision: item.revision,
        title: editingTitle.trim(),
      });
      setItems((prev) =>
        prev.map((row) => (row.id === item.id ? updated : row)),
      );
      setEditingId(null);
      toast(`已重命名为 ${updated.title}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleMountSession = async (
    item: PersonalLibraryObject,
    sessionId: string,
    mount: boolean,
  ) => {
    if (!userId || !sessionId) return;
    setBusyId(item.id);
    setError("");
    try {
      const updated = await api.libraryMountSession(
        userId,
        item.id,
        sessionId,
        mount,
      );
      setItems((prev) =>
        prev.map((row) => (row.id === item.id ? updated : row)),
      );
      toast(
        mount
          ? `已分享挂载到会话 ${sessionId.slice(0, 8)}`
          : `已从会话 ${sessionId.slice(0, 8)} 取消挂载`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleMountProject = async (
    item: PersonalLibraryObject,
    projectId: string,
    mount: boolean,
  ) => {
    if (!userId || !projectId) return;
    setBusyId(item.id);
    setError("");
    try {
      const updated = await api.libraryMountProject(
        userId,
        item.id,
        projectId,
        mount,
      );
      setItems((prev) =>
        prev.map((row) => (row.id === item.id ? updated : row)),
      );
      toast(mount ? `已挂载到项目 ${projectId}` : `已从项目 ${projectId} 取消挂载`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const openPreview = async (item: PersonalLibraryObject) => {
    if (!userId) return;
    setPreviewItem(item);
    setPreviewText(null);
    if (isRasterLibraryMime(item.media_type)) return;
    if (
      item.source_kind === "shortcut_host_glob" ||
      item.source_kind === "shortcut_directory_url"
    ) {
      setPreviewText("目录/匹配集合快捷方式可在会话中使用 reference(action=\"expand\") 按章节 ID 展开查看。");
      return;
    }
    if (
      item.media_type.startsWith("text/") ||
      item.media_type === "application/json"
    ) {
      setPreviewLoading(true);
      try {
        const blob = await api.libraryReadBlob(userId, item.id, {
          sessionId: item.mounted_sessions[0] ?? state.sessionId ?? undefined,
          projectId: item.mounted_projects[0] ?? state.projectId ?? undefined,
        });
        setPreviewText(await blob.text());
      } catch (err) {
        setPreviewText(
          `读取失败：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setPreviewLoading(false);
      }
    }
  };

  const copyRefText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制 ${label}`);
    } catch {
      toast("复制失败", "warn");
    }
  };

  const counts = useMemo(() => {
    let blobs = 0;
    let shortcuts = 0;
    let mounted = 0;
    for (const item of items) {
      if (item.source.kind === "local_blob") blobs++;
      else shortcuts++;
      if (state.sessionId && item.mounted_sessions.includes(state.sessionId)) {
        mounted++;
      }
    }
    return { all: items.length, blobs, shortcuts, mounted };
  }, [items, state.sessionId]);

  const hasActiveFilters = search.trim() !== "" || filterKind !== "all";
  const quotaTone = quotaPct >= 90 ? "danger" : quotaPct >= 75 ? "warn" : "ok";

  if (!userId) {
    return (
      <div className="sb-view-container">
        <div className="sb-empty-state">
          <p className="sb-empty-title">请先登录以管理参考库</p>
          <p className="sb-empty-desc">
            登录后可统一管理托管文件、外部快捷方式以及跨会话共享挂载。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="sb-view-container space-y-4"
      data-testid="personal-library-view"
    >
      {/* Header & Quota Card */}
      <div className="sb-card p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <h2 className="text-base font-semibold text-white">
              个人内容库（参考库）
            </h2>
            <p className="text-xs text-neutral-400">
              托管图片、脚本重定向输出与外部快捷方式均归属于当前账号，可跨会话零拷贝挂载与预览；超出配额时可随时手动清理。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              className="sb-btn sb-btn-secondary"
              onClick={() => setShowShortcutForm((v) => !v)}
            >
              {showShortcutForm ? "收起快捷方式" : "+ 添加快捷方式"}
            </button>
            <label className="sb-btn sb-btn-primary cursor-pointer">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                disabled={uploading}
                onChange={(e) => void handleUpload(e.target.files)}
              />
              {uploading ? "上传中…" : "+ 上传文件"}
            </label>
          </div>
        </div>

        {/* Recessed Quota Meter */}
        {quota && (
          <div className="sb-terminal-box p-3.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium text-neutral-200">存储配额</span>
                <span className="sb-tag-pill font-mono">
                  {formatLibraryBytes(quota.used_bytes)} /{" "}
                  {formatLibraryBytes(quota.max_bytes)}
                </span>
                <span className="text-neutral-400 font-mono">
                  ({quotaPct}%)
                </span>
              </div>
              <span className="text-neutral-400 font-mono">
                条目数 {quota.object_count} / {quota.max_entries}
              </span>
            </div>
            <div className="sb-quota-bar" aria-label={`存储占用 ${quotaPct}%`}>
              <div
                className="sb-quota-fill"
                data-tone={quotaTone}
                style={{ width: `${quotaPct}%` }}
              />
            </div>
          </div>
        )}

        {/* Upload Metadata Options */}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <input
            type="text"
            className="sb-input flex-1 min-w-[200px]"
            placeholder="上传可选自定义标题（默认使用原文件名）"
            value={uploadTitle}
            onChange={(e) => setUploadTitle(e.target.value)}
          />
          {state.sessionId && (
            <label className="sb-tag-pill cursor-pointer select-none">
              <input
                type="checkbox"
                className="accent-ink"
                checked={mountOnUpload}
                onChange={(e) => setMountOnUpload(e.target.checked)}
              />
              <span>上传后挂载到当前会话 ({state.sessionId.slice(0, 8)})</span>
            </label>
          )}
        </div>
      </div>

      {/* Shortcut Creation Drawer Card */}
      {showShortcutForm && (
        <form
          className="sb-card p-5 space-y-3.5"
          onSubmit={(e) => void handleCreateShortcut(e)}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-neutral-200">
              新建外部快捷方式
            </div>
            <span className="sb-tag-pill">不占用托管字节配额</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <select
              className="sb-select"
              value={shortcutType}
              onChange={(e) =>
                setShortcutType(
                  e.target.value as PersonalLibraryShortcutTarget["type"],
                )
              }
            >
              <option value="public_https">公网 HTTPS (public_https)</option>
              <option value="host_path">工作区文件 (host_path)</option>
              <option value="host_glob">工作区匹配 (host_glob)</option>
              <option value="directory_url">HTTPS 目录 (directory_url)</option>
            </select>
            <input
              type="text"
              className="sb-input"
              placeholder="标题（可选）"
              value={shortcutTitle}
              onChange={(e) => setShortcutTitle(e.target.value)}
            />
          </div>
          {shortcutType === "host_path" && (
            <input
              type="text"
              className="sb-input w-full font-mono"
              placeholder="工作区相对路径或受控路径，如 docs/spec.md"
              value={shortcutPath}
              onChange={(e) => setShortcutPath(e.target.value)}
            />
          )}
          {shortcutType === "host_glob" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input
                type="text"
                className="sb-input font-mono"
                placeholder="根目录，如 docs"
                value={shortcutRoot}
                onChange={(e) => setShortcutRoot(e.target.value)}
              />
              <input
                type="text"
                className="sb-input font-mono"
                placeholder="匹配模式，如 **/*.md"
                value={shortcutPattern}
                onChange={(e) => setShortcutPattern(e.target.value)}
              />
            </div>
          )}
          {(shortcutType === "public_https" ||
            shortcutType === "directory_url") && (
            <input
              type="url"
              className="sb-input w-full font-mono"
              placeholder="https://example.com/resource"
              value={shortcutUrl}
              onChange={(e) => setShortcutUrl(e.target.value)}
            />
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {state.sessionId ? (
              <label className="flex items-center gap-2 cursor-pointer text-xs text-neutral-300">
                <input
                  type="checkbox"
                  className="accent-ink"
                  checked={shortcutMountSession}
                  onChange={(e) => setShortcutMountSession(e.target.checked)}
                />
                <span>创建后挂载到当前会话</span>
              </label>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="sb-btn sb-btn-ghost sb-btn-sm"
                onClick={() => setShowShortcutForm(false)}
              >
                取消
              </button>
              <button
                type="submit"
                className="sb-btn sb-btn-primary sb-btn-sm"
                disabled={uploading}
              >
                创建快捷方式
              </button>
            </div>
          </div>
        </form>
      )}

      {error && (
        <div
          role="alert"
          className="sb-card p-3.5 border border-rose-500/20 bg-rose-500/10 text-rose-400 text-xs"
        >
          {error}
        </div>
      )}
      {notice && !error && (
        <div role="status" className="sb-toast-inline">
          {notice}
        </div>
      )}

      {/* Modern Command Search & Segmented Filter Toolbar */}
      <search aria-label="筛选参考库内容">
        <div className="sb-toolbar">
          <div className="sb-search-wrap">
            <svg
              className="sb-search-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="search"
              className="sb-input"
              aria-label="搜索标题、ref_ID 或 MIME 类型"
              placeholder="搜索标题、ref_ID 或 MIME 类型…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="sb-search-clear"
                aria-label="清空搜索"
                onClick={() => setSearch("")}
              >
                ×
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="sb-filter-pills" role="group" aria-label="来源筛选">
              <button
                type="button"
                className="sb-filter-pill"
                aria-pressed={filterKind === "all"}
                onClick={() => setFilterKind("all")}
              >
                <span>全部</span>
                <span className="sb-pill-count">{counts.all}</span>
              </button>
              <button
                type="button"
                className="sb-filter-pill"
                aria-pressed={filterKind === "local_blob"}
                onClick={() => setFilterKind("local_blob")}
              >
                <span>托管对象</span>
                <span className="sb-pill-count">{counts.blobs}</span>
              </button>
              <button
                type="button"
                className="sb-filter-pill"
                aria-pressed={filterKind === "shortcut"}
                onClick={() => setFilterKind("shortcut")}
              >
                <span>快捷方式</span>
                <span className="sb-pill-count">{counts.shortcuts}</span>
              </button>
              {state.sessionId && (
                <button
                  type="button"
                  className="sb-filter-pill"
                  aria-pressed={filterKind === "current_session"}
                  onClick={() => setFilterKind("current_session")}
                >
                  <span>当前会话</span>
                  <span className="sb-pill-count">{counts.mounted}</span>
                </button>
              )}
            </div>

            <button
              type="button"
              className="sb-btn sb-btn-ghost sb-btn-sm"
              disabled={loading}
              onClick={() => void load()}
            >
              {loading ? "加载中…" : "刷新"}
            </button>
          </div>
        </div>
      </search>

      {/* Library Items / Modern Empty States */}
      <div className="space-y-3">
        {loading && items.length === 0 ? (
          <div className="sb-card p-6 text-xs text-neutral-400" role="status">
            正在加载个人内容库…
          </div>
        ) : filtered.length === 0 ? (
          <div className="sb-empty-state" role="status">
            <div className="sb-empty-icon" aria-hidden="true">
              {hasActiveFilters ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
                </svg>
              )}
            </div>
            <h3 className="sb-empty-title">
              {hasActiveFilters ? "当前筛选条件下没有内容" : "参考库暂无任何对象"}
            </h3>
            <p className="sb-empty-desc">
              {hasActiveFilters
                ? search.trim()
                  ? `未找到匹配「${search.trim()}」的参考对象，请调整关键词或重置来源筛选。`
                  : "当前来源分组下暂无对象，可切换回全部分组查看。"
                : "上传图片、文档或创建外部快捷方式后，即可在多个会话间零拷贝挂载并在对话中用 ref: 引用。"}
            </p>
            <div className="sb-empty-actions">
              {hasActiveFilters ? (
                <button
                  type="button"
                  className="sb-btn sb-btn-secondary"
                  onClick={() => {
                    setSearch("");
                    setFilterKind("all");
                  }}
                >
                  重置筛选与搜索
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="sb-btn sb-btn-primary"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    + 上传首个文件
                  </button>
                  <button
                    type="button"
                    className="sb-btn sb-btn-secondary"
                    onClick={() => setShowShortcutForm(true)}
                  >
                    + 添加快捷方式
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          filtered.map((item) => {
            const isRaster = isRasterLibraryMime(item.media_type);
            const selectedSess =
              mountSessionChoice[item.id] ?? state.sessionId ?? "";
            const selectedProj =
              mountProjectChoice[item.id] ?? state.projectId ?? "";
            const busy = busyId === item.id;
            return (
              <div
                key={item.id}
                className="sb-card p-4 space-y-3"
                data-testid={`library-item-${item.id}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className="sb-lib-icon-badge" aria-hidden="true">
                      {item.source.kind === "shortcut" ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                        </svg>
                      ) : isRaster ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <rect width="18" height="18" x="3" y="3" rx="2" />
                          <circle cx="9" cy="9" r="2" />
                          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                        </svg>
                      )}
                    </div>

                    <div className="space-y-1.5 min-w-0 flex-1">
                      {editingId === item.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            className="sb-input flex-1"
                            value={editingTitle}
                            onChange={(e) => setEditingTitle(e.target.value)}
                          />
                          <button
                            type="button"
                            className="sb-btn sb-btn-primary sb-btn-sm"
                            disabled={busy}
                            onClick={() => void handleRename(item)}
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            className="sb-btn sb-btn-ghost sb-btn-sm"
                            onClick={() => setEditingId(null)}
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-white text-sm truncate">
                            {item.title}
                          </span>
                          <span className="sb-tag-pill">
                            {sourceKindLabel(item.source_kind)}
                          </span>
                          <span className="sb-tag-pill font-mono">
                            {item.media_type}
                          </span>
                          {item.byte_length !== undefined && (
                            <span className="sb-tag-pill font-mono">
                              {formatLibraryBytes(item.byte_length)}
                            </span>
                          )}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-neutral-400 font-mono">
                        <button
                          type="button"
                          className="hover:text-white transition-colors"
                          title="复制对象 ID"
                          onClick={() => void copyRefText(item.id, "对象 ID")}
                        >
                          ref:{item.id}
                        </button>
                        {item.source.kind === "shortcut" && (
                          <span className="truncate max-w-full">
                            ·{" "}
                            {"url" in item.source.target
                              ? item.source.target.url
                              : "path" in item.source.target
                                ? item.source.target.path
                                : `${item.source.target.root}/${item.source.target.pattern}`}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      className="sb-btn sb-btn-secondary sb-btn-sm"
                      onClick={() => void openPreview(item)}
                    >
                      {isRaster ? "预览图片" : "查看内容"}
                    </button>
                    <button
                      type="button"
                      className="sb-btn sb-btn-ghost sb-btn-sm"
                      onClick={() =>
                        void copyRefText(
                          isRaster
                            ? `![${item.title}](ref:${item.id})`
                            : `[${item.title}](ref:${item.id})`,
                          "Markdown ref 链接",
                        )
                      }
                    >
                      复制 ref:
                    </button>
                    <button
                      type="button"
                      className="sb-btn sb-btn-ghost sb-btn-sm"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(item.id);
                        setEditingTitle(item.title);
                      }}
                    >
                      重命名
                    </button>
                    <button
                      type="button"
                      className="sb-btn sb-btn-danger sb-btn-sm"
                      disabled={busy}
                      onClick={() => void handleDelete(item)}
                    >
                      移除并释放配额
                    </button>
                  </div>
                </div>

                {/* Mount Sharing Strip */}
                <div className="flex flex-wrap items-center gap-3 pt-2.5 border-t border-dash-line text-[11px]">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-neutral-400">已挂载会话：</span>
                    {item.mounted_sessions.length === 0 ? (
                      <span className="text-neutral-500">无（仅个人库可见）</span>
                    ) : (
                      item.mounted_sessions.map((sid) => {
                        const sessTitle =
                          state.sessions.find((s) => s.id === sid)?.title ||
                          sid.slice(0, 8);
                        return (
                          <span key={sid} className="sb-mount-chip">
                            {sessTitle}
                            <button
                              type="button"
                              title="取消挂载此会话"
                              aria-label={`取消挂载会话 ${sessTitle}`}
                              disabled={busy}
                              onClick={() =>
                                void handleMountSession(item, sid, false)
                              }
                            >
                              ×
                            </button>
                          </span>
                        );
                      })
                    )}
                    {state.sessions.length > 0 && (
                      <span className="inline-flex items-center gap-1.5 ml-1">
                        <select
                          className="sb-select py-0.5 text-[11px]"
                          value={selectedSess}
                          onChange={(e) =>
                            setMountSessionChoice((prev) => ({
                              ...prev,
                              [item.id]: e.target.value,
                            }))
                          }
                        >
                          <option value="">选择会话…</option>
                          {state.sessions.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.title || s.id.slice(0, 10)}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="sb-btn sb-btn-ghost sb-btn-sm"
                          disabled={busy || !selectedSess}
                          onClick={() =>
                            void handleMountSession(item, selectedSess, true)
                          }
                        >
                          挂载到会话
                        </button>
                      </span>
                    )}
                  </div>

                  {state.projects.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-neutral-400">项目挂载：</span>
                      {item.mounted_projects.map((pid) => (
                        <span
                          key={pid}
                          className="sb-tag-pill sb-tag-pill-project"
                        >
                          {pid}
                          <button
                            type="button"
                            className="hover:text-white ml-0.5"
                            disabled={busy}
                            onClick={() =>
                              void handleMountProject(item, pid, false)
                            }
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      <select
                        className="sb-select py-0.5 text-[11px]"
                        value={selectedProj}
                        onChange={(e) =>
                          setMountProjectChoice((prev) => ({
                            ...prev,
                            [item.id]: e.target.value,
                          }))
                        }
                      >
                        <option value="">选择项目…</option>
                        {state.projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name || p.id}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="sb-btn sb-btn-ghost sb-btn-sm"
                        disabled={busy || !selectedProj}
                        onClick={() =>
                          void handleMountProject(item, selectedProj, true)
                        }
                      >
                        挂载到项目
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Preview Native Dialog */}
      <ModalContainer
        isOpen={!!previewItem}
        onClose={() => setPreviewItem(null)}
        title={previewItem ? `${previewItem.title} (${previewItem.id})` : ""}
        maxWidth="max-w-3xl"
        footer={
          <button
            type="button"
            className="sb-btn sb-btn-secondary"
            onClick={() => setPreviewItem(null)}
          >
            关闭
          </button>
        }
      >
        {previewItem && (
          <div>
            {isRasterLibraryMime(previewItem.media_type) ? (
              <img
                src={libraryContentPath(state.apiBase, userId, previewItem.id, {
                  sessionId:
                    previewItem.mounted_sessions[0] ??
                    state.sessionId ??
                    undefined,
                  projectId:
                    previewItem.mounted_projects[0] ??
                    state.projectId ??
                    undefined,
                })}
                alt={previewItem.title}
                className="max-w-full max-h-[65vh] mx-auto rounded"
              />
            ) : previewLoading ? (
              <p className="text-xs text-neutral-400" role="status">
                正在加载内容…
              </p>
            ) : previewText !== null ? (
              <pre className="text-xs font-mono text-neutral-200 whitespace-pre-wrap break-all">
                {previewText}
              </pre>
            ) : (
              <div className="space-y-3 text-xs text-neutral-300">
                <p>非光栅图或文本二进制对象（{previewItem.media_type}）。</p>
                <a
                  href={libraryContentPath(
                    state.apiBase,
                    userId,
                    previewItem.id,
                    {
                      sessionId:
                        previewItem.mounted_sessions[0] ??
                        state.sessionId ??
                        undefined,
                    },
                  )}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sb-btn sb-btn-primary inline-flex"
                >
                  安全下载原始内容
                </a>
              </div>
            )}
          </div>
        )}
      </ModalContainer>
    </div>
  );
};
