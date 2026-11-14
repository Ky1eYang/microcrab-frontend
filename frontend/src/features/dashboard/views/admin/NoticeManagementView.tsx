import React, { useState } from "react";
import type { NoticeItem } from "../../types";
import { mockNotices } from "../../mockData";
import { ModalContainer } from "../../components/ModalContainer";

export const NoticeManagementView: React.FC = () => {
  const [notices, setNotices] = useState<NoticeItem[]>(mockNotices);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newLevel, setNewLevel] = useState<
    "info" | "warning" | "alert" | "maintenance"
  >("info");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  const toggleNotice = (id: string) => {
    setNotices((prev) =>
      prev.map((n) => {
        if (n.id === id) {
          const next = !n.active;
          showToast(`公告已${next ? "启用" : "隐藏"}`);
          return { ...n, active: next };
        }
        return n;
      }),
    );
  };

  const handleCreateNotice = () => {
    if (!newTitle.trim()) return;
    const newNotice: NoticeItem = {
      id: `notice_${Date.now()}`,
      title: newTitle.trim(),
      contentMarkdown: newContent.trim(),
      level: newLevel,
      active: true,
      targetAudience: "all",
      publishedAt: new Date().toISOString().replace("T", " ").substring(0, 19),
    };
    setNotices([newNotice, ...notices]);
    setNewTitle("");
    setNewContent("");
    setIsModalOpen(false);
    showToast("全局公告发布成功");
  };

  return (
    <div className="sb-view-container space-y-4">
      <div className="sb-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold text-neutral-200">
            公告管理 (System Notices)
          </h2>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            发布网关维护预告、模型上线通知与控制台广播横幅
          </p>
        </div>
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => setIsModalOpen(true)}
        >
          <span>+ 发布新公告</span>
        </button>
      </div>

      {toastMessage && (
        <div className="sb-toast-inline">
          <span className="sb-role-dot" />
          <span>{toastMessage}</span>
        </div>
      )}

      <div className="space-y-3">
        {notices.map((n) => {
          const badgeClass =
            n.level === "alert"
              ? "text-rose-400 bg-rose-500/10 border-rose-500/20"
              : n.level === "warning"
                ? "text-amber-400 bg-amber-500/10 border-amber-500/20"
                : n.level === "maintenance"
                  ? "text-purple-400 bg-purple-500/10 border-purple-500/20"
                  : "text-cyan-400 bg-cyan-500/10 border-cyan-500/20";

          return (
            <div
              key={n.id}
              className="sb-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
              <div className="space-y-1.5 flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] uppercase font-mono border ${badgeClass}`}
                  >
                    {n.level}
                  </span>
                  <h3 className="text-xs font-semibold text-neutral-200 truncate">
                    {n.title}
                  </h3>
                </div>
                <p className="text-[11px] text-neutral-400 leading-relaxed font-sans">
                  {n.contentMarkdown}
                </p>
                <div className="text-[10px] text-neutral-500 font-mono">
                  发布时间: {n.publishedAt} · 受众: {n.targetAudience}
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <label className="sb-switch">
                  <input
                    type="checkbox"
                    checked={n.active}
                    onChange={() => toggleNotice(n.id)}
                  />
                  <span className="sb-switch-slider" />
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <ModalContainer
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="发布全局公告"
        confirmText="立即发布"
        onConfirm={handleCreateNotice}
        confirmDisabled={!newTitle.trim()}
      >
        <div className="space-y-3.5 text-xs">
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              公告标题
            </label>
            <input
              type="text"
              className="sb-input w-full"
              placeholder="例如: 平台常规例行维护通知"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              级别分类
            </label>
            <select
              className="sb-select w-full"
              value={newLevel}
              onChange={(e) => setNewLevel(e.target.value as any)}
            >
              <option value="info">常规消息 (Info)</option>
              <option value="warning">重要预警 (Warning)</option>
              <option value="alert">紧急警报 (Alert)</option>
              <option value="maintenance">系统维护 (Maintenance)</option>
            </select>
          </div>
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              公告正文 (支持 Markdown)
            </label>
            <textarea
              className="sb-input w-full h-24 font-sans leading-relaxed"
              placeholder="请详细描述维护窗口或新模型上线注意事项..."
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
            />
          </div>
        </div>
      </ModalContainer>
    </div>
  );
};
