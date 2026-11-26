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

  if (!userId) {
    return (
      <div className="sb-view-container p-4">
        <div className="sb-card p-4 text-xs text-neutral-400">
          请先登录后再管理个人内容库。
        </div>
      </div>
    );
  }

  return (
    <div
      className="sb-view-container space-y-4"
      data-testid="personal-library-view"
    >
      {/* Quota & Action Header */}
      <div className="sb-card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-white">
              个人内容库（Personal Content Library）
            </h2>
            <p className="text-xs text-neutral-400 mt-0.5">
              托管图片、脚本重定向输出与外部快捷方式均归属于当前账号，可跨会话零拷贝分享挂载与预览。超出容量时请在此手动删除不需要的对象（无静默淘汰）。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="sb-btn sb-btn-ghost sb-btn-sm"
              onClick={() => setShowShortcutForm((v) => !v)}
            >
              {showShortcutForm ? "收起快捷方式" : "+ 添加快捷方式"}
            </button>
            <label className="sb-btn sb-btn-primary sb-btn-sm cursor-pointer">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                disabled={uploading}
                onChange={(e) => void handleUpload(e.target.files)}
              />
              {uploading ? "上传中..." : "+ 上传文件"}
            </label>
          </div>
        </div>

        {/* Quota Progress */}
        {quota && (
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-300">
                空间配额：{formatLibraryBytes(quota.used_bytes)} /{" "}
                {formatLibraryBytes(quota.max_bytes)}（{quotaPct}%）
              </span>
              <span className="text-neutral-400 font-mono">
                条目：{quota.object_count} / {quota.max_entries}
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-neutral-800 overflow-hidden">
              <div
                className={`h-full transition-all ${
                  quotaPct >= 90
                    ? "bg-rose-500"
                    : quotaPct >= 75
                      ? "bg-amber-400"
                      : "bg-emerald-500"
                }`}
                style={{ width: `${quotaPct}%` }}
              />
            </div>
          </div>
        )}

        {/* Upload Options Row */}
        <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-300 pt-1 border-t border-dash-line">
          <input
            type="text"
            className="settings-input flex-1 min-w-[180px]"
            placeholder="上传可选标题（默认使用文件名）"
            value={uploadTitle}
            onChange={(e) => setUploadTitle(e.target.value)}
          />
          {state.sessionId && (
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={mountOnUpload}
                onChange={(e) => setMountOnUpload(e.target.checked)}
              />
              <span>同时挂载到当前会话 ({state.sessionId.slice(0, 8)})</span>
            </label>
          )}
        </div>
      </div>

      {/* Shortcut Form */}
      {showShortcutForm && (
        <form
          className="sb-card p-4 space-y-3 text-xs"
          onSubmit={(e) => void handleCreateShortcut(e)}
        >
          <div className="font-semibold text-neutral-200">
            新建外部快捷方式（不占用托管字节配额）
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <select
              className="settings-input"
              value={shortcutType}
              onChange={(e) =>
                setShortcutType(
                  e.target.value as PersonalLibraryShortcutTarget["type"],
                )
              }
            >
              <option value="public_https">公网 HTTPS (public_https)</option>
              <option value="host_path">
                工作区文件 (host_path)
              </option>
              <option value="host_glob">
                工作区匹配 (host_glob)
              </option>
              <option value="directory_url">
                HTTPS 目录 (directory_url)
              </option>
            </select>
            <input
              type="text"
              className="settings-input"
              placeholder="标题（可选）"
              value={shortcutTitle}
              onChange={(e) => setShortcutTitle(e.target.value)}
            />
          </div>
          {shortcutType === "host_path" && (
            <input
              type="text"
              className="settings-input w-full monospace-text"
              placeholder="工作区相对路径或受控路径，如 docs/spec.md"
              value={shortcutPath}
              onChange={(e) => setShortcutPath(e.target.value)}
            />
          )}
          {shortcutType === "host_glob" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input
                type="text"
                className="settings-input monospace-text"
                placeholder="根目录，如 docs"
                value={shortcutRoot}
                onChange={(e) => setShortcutRoot(e.target.value)}
              />
              <input
                type="text"
                className="settings-input monospace-text"
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
              className="settings-input w-full monospace-text"
              placeholder="https://example.com/resource"
              value={shortcutUrl}
              onChange={(e) => setShortcutUrl(e.target.value)}
            />
          )}
          <div className="flex items-center justify-between gap-2">
            {state.sessionId ? (
              <label className="flex items-center gap-1.5 cursor-pointer text-neutral-300">
                <input
                  type="checkbox"
                  checked={shortcutMountSession}
                  onChange={(e) => setShortcutMountSession(e.target.checked)}
                />
                <span>挂载到当前会话</span>
              </label>
            ) : (
              <span />
            )}
            <button
              type="submit"
              className="sb-btn sb-btn-primary sb-btn-sm"
              disabled={uploading}
            >
              创建快捷方式
            </button>
          </div>
        </form>
      )}

      {error && (
        <div
          role="alert"
          className="sb-card p-3 border border-rose-500/40 text-rose-300 text-xs"
        >
          {error}
        </div>
      )}
      {notice && !error && (
        <div
          role="status"
          className="sb-card p-2.5 text-emerald-300 text-xs border border-emerald-500/30"
        >
          {notice}
        </div>
      )}

      {/* Search & Filter */}
      <div className="sb-card p-3 flex flex-wrap items-center gap-3 text-xs">
        <input
          type="search"
          className="settings-input flex-1 min-w-[200px]"
          placeholder="搜索标题、ref_ID 或 MIME 类型..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="settings-input"
          value={filterKind}
          onChange={(e) => setFilterKind(e.target.value as FilterKind)}
        >
          <option value="all">全部来源 ({items.length})</option>
          <option value="local_blob">仅托管内容 (local_blob)</option>
          <option value="shortcut">仅快捷方式 (shortcut)</option>
          {state.sessionId && (
            <option value="current_session">已挂载到当前会话</option>
          )}
        </select>
        <button
          type="button"
          className="sb-btn sb-btn-ghost sb-btn-sm"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "加载中..." : "刷新列表"}
        </button>
      </div>

      {/* Library Items */}
      <div className="space-y-2.5">
        {filtered.length === 0 ? (
          <div className="sb-card p-6 text-center text-xs text-neutral-400">
            {loading ? "正在加载个人内容库..." : "当前筛选条件下没有内容。"}
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
                className="sb-card p-4 space-y-2.5 text-xs"
                data-testid={`library-item-${item.id}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0 flex-1">
                    {editingId === item.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          className="settings-input flex-1"
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                        />
                        <button
                          type="button"
                          className="sb-btn sb-btn-primary sb-btn-sm"
                          disabled={busy}
                          onClick={() => void handleRename(item)}
                        >
                          确定
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
                        <span className="px-2 py-0.5 rounded bg-neutral-800 text-neutral-300 border border-dash-line">
                          {sourceKindLabel(item.source_kind)}
                        </span>
                        <span className="px-2 py-0.5 rounded bg-neutral-900 text-neutral-400 font-mono">
                          {item.media_type}
                        </span>
                        {item.byte_length !== undefined && (
                          <span className="text-neutral-400 font-mono">
                            {formatLibraryBytes(item.byte_length)}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="text-[11px] text-neutral-400 font-mono truncate">
                      ID: {item.id}
                      {item.source.kind === "shortcut" &&
                        " · " +
                          ("url" in item.source.target
                            ? item.source.target.url
                            : "path" in item.source.target
                              ? item.source.target.path
                              : `${item.source.target.root}/${item.source.target.pattern}`)}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      className="sb-btn sb-btn-ghost sb-btn-sm"
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
                      className="sb-btn sb-btn-ghost sb-btn-sm text-rose-400"
                      disabled={busy}
                      onClick={() => void handleDelete(item)}
                    >
                      移除并释放配额
                    </button>
                  </div>
                </div>

                {/* Mount Sharing Bar */}
                <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-dash-line text-[11px]">
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
                          <span
                            key={sid}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/25"
                          >
                            {sessTitle}
                            <button
                              type="button"
                              className="hover:text-white ml-0.5"
                              title="取消挂载此会话"
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
                      <span className="inline-flex items-center gap-1 ml-1">
                        <select
                          className="settings-input py-0.5 text-[11px]"
                          value={selectedSess}
                          onChange={(e) =>
                            setMountSessionChoice((prev) => ({
                              ...prev,
                              [item.id]: e.target.value,
                            }))
                          }
                        >
                          <option value="">选择会话...</option>
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
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-sky-500/10 text-sky-300 border border-sky-500/25"
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
                        className="settings-input py-0.5 text-[11px]"
                        value={selectedProj}
                        onChange={(e) =>
                          setMountProjectChoice((prev) => ({
                            ...prev,
                            [item.id]: e.target.value,
                          }))
                        }
                      >
                        <option value="">选择项目...</option>
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

      {/* Preview Modal */}
      {previewItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setPreviewItem(null)}
        >
          <div
            className="sb-card max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-dash-line">
              <div className="text-sm font-semibold text-white truncate">
                {previewItem.title} ({previewItem.id})
              </div>
              <button
                type="button"
                className="sb-btn sb-btn-ghost sb-btn-sm"
                onClick={() => setPreviewItem(null)}
              >
                关闭
              </button>
            </div>
            <div className="p-4 overflow-auto flex-1">
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
                <p className="text-xs text-neutral-400">正在加载内容...</p>
              ) : previewText !== null ? (
                <pre className="text-xs font-mono text-neutral-200 whitespace-pre-wrap break-all">
                  {previewText}
                </pre>
              ) : (
                <div className="space-y-3 text-xs text-neutral-300">
                  <p>非光栅图/文本二进制对象（{previewItem.media_type}）。</p>
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
                    className="sb-btn sb-btn-primary sb-btn-sm inline-block"
                  >
                    安全下载原始内容
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
