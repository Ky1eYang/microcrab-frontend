import React, { useState } from "react";
import { useApp } from "../../../state";
import { ModalContainer } from "../components/ModalContainer";
import { mockApiKeys } from "../mockData";

export const ApiKeysView: React.FC = () => {
  const { state, dispatch } = useApp();
  const board = state.board;
  const isAdmin = board.role === "admin" || board.role === "super_admin";

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [quickKeyName, setQuickKeyName] = useState("");
  const [newKeyRole, setNewKeyRole] = useState<"user" | "admin">("user");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // If real keys from backend exist, use them. Otherwise fallback to mock keys.
  const backendKeys = board.keys || [];
  const displayRealKeys = backendKeys.length > 0;

  const handleCopy = (text: string, id: string) => {
    dispatch({ type: "CopyText", value: text });
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleQuickCreate = () => {
    if (!quickKeyName.trim()) return;
    dispatch({
      type: "CreateUserKey",
      value: quickKeyName.trim(),
    });
    setQuickKeyName("");
  };

  const handleCreateKey = () => {
    if (!newKeyName.trim()) return;
    if (isAdmin && newKeyRole === "admin") {
      dispatch({
        type: "CreatePrivilegedKey",
        name: newKeyName.trim(),
        role: "admin",
      });
    } else {
      dispatch({
        type: "CreateUserKey",
        value: newKeyName.trim(),
      });
    }
    setNewKeyName("");
    setIsModalOpen(false);
  };

  const handleRevoke = (keyId: string) => {
    if (window.confirm("确定要吊销此 API 密钥吗？吊销后将无法继续发起请求。")) {
      dispatch({ type: "RevokeKey", id: keyId, admin: isAdmin });
    }
  };

  return (
    <div className="sb-view-container space-y-4">
      {/* Top Header Card */}
      <div className="sb-card p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-xs font-semibold text-neutral-200">
              API 密钥管理
            </h2>
            <p className="text-[11px] text-neutral-500 mt-0.5">
              管理各令牌的调用权限、速率限制、Token 消耗与吊销状态
            </p>
          </div>
          <button
            type="button"
            className="sb-btn sb-btn-ghost sb-btn-sm"
            onClick={() => setIsModalOpen(true)}
          >
            <span>+ 模态窗新建</span>
          </button>
        </div>

        <div className="flex items-center gap-2 pt-2 border-t border-dash-line">
          <input
            type="text"
            className="sb-input flex-1 text-xs"
            placeholder="密钥名称"
            value={quickKeyName}
            onChange={(e) => setQuickKeyName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleQuickCreate();
            }}
          />
          <button
            type="button"
            className="sb-btn sb-btn-primary text-xs shrink-0"
            onClick={handleQuickCreate}
          >
            创建 User 密钥
          </button>
        </div>
      </div>

      {/* Secret Banner for Newly Created Key */}
      {board.revealed && (
        <div className="sb-card p-4 border-amber-500/40 bg-amber-500/5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-400">
              <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>请妥善保存新密钥（仅显示一次）</span>
            </div>
            <button
              type="button"
              className="text-xs text-neutral-400 hover:text-white"
              onClick={() => dispatch({ type: "DismissRevealed" })}
            >
              ✕ 我已保存
            </button>
          </div>
          <div className="flex items-center gap-2">
            <code className="sb-terminal-box p-2.5 flex-1 font-mono text-xs text-emerald-400 break-all select-all board-secret">
              {board.revealed}
            </code>
            <button
              type="button"
              className="sb-btn sb-btn-secondary"
              onClick={() => handleCopy(board.revealed!, "revealed")}
            >
              {copiedId === "revealed" ? "已复制 ✓" : "复制密钥"}
            </button>
          </div>
        </div>
      )}

      {/* Keys Table Card */}
      <div className="sb-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-dash-line bg-dash-terminal text-[11px] text-neutral-400 font-medium">
                <th className="py-3 px-4">名称</th>
                <th className="py-3 px-4">密钥前缀 / 令牌</th>
                <th className="py-3 px-4">权限角色</th>
                <th className="py-3 px-4">状态</th>
                <th className="py-3 px-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dash-line font-mono">
              {displayRealKeys
                ? backendKeys.map((key: any) => {
                    const isCurrent = key.id === board.keyId;
                    const isRevoked = !!key.revoked;
                    return (
                      <tr
                        key={key.id}
                        className="hover:bg-dash-soft transition-colors"
                      >
                        <td className="py-3 px-4 font-sans text-neutral-200 font-medium">
                          {key.name || "未命名密钥"}
                          {isCurrent && (
                            <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20 font-mono">
                              当前使用
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-neutral-400">
                          <span className="text-neutral-300 font-mono">
                            {key.keyPrefix ? `${key.keyPrefix}...` : key.id}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <span className="px-2 py-0.5 rounded text-[10px] bg-neutral-800 text-neutral-300 border border-neutral-700 font-mono uppercase">
                            {key.role || "user"}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          {isRevoked ? (
                            <span className="text-rose-400 text-[11px]">
                              已吊销
                            </span>
                          ) : (
                            <span className="text-emerald-400 text-[11px]">
                              有效
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              className="sb-btn sb-btn-ghost sb-btn-sm"
                              onClick={() =>
                                handleCopy(key.keyPrefix || key.id, key.id)
                              }
                            >
                              {copiedId === key.id ? "已复制" : "复制"}
                            </button>
                            <button
                              type="button"
                              className="sb-btn sb-btn-danger sb-btn-sm"
                              disabled={isRevoked || isCurrent}
                              onClick={() => handleRevoke(key.id)}
                            >
                              吊销
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                : mockApiKeys.map((k) => (
                    <tr
                      key={k.id}
                      className="hover:bg-dash-soft transition-colors"
                    >
                      <td className="py-3 px-4 font-sans text-neutral-200 font-medium">
                        {k.name}
                      </td>
                      <td className="py-3 px-4 text-neutral-400">
                        <span className="text-neutral-300 font-mono">
                          {k.key}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className="px-2 py-0.5 rounded text-[10px] bg-neutral-800 text-neutral-300 border border-neutral-700 font-mono uppercase">
                          {k.platform}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        {k.active ? (
                          <span className="text-emerald-400 text-[11px]">
                            有效
                          </span>
                        ) : (
                          <span className="text-rose-400 text-[11px]">
                            已吊销
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            className="sb-btn sb-btn-ghost sb-btn-sm"
                            onClick={() => handleCopy(k.key, k.id)}
                          >
                            {copiedId === k.id ? "已复制" : "复制"}
                          </button>
                          <button
                            type="button"
                            className="sb-btn sb-btn-danger sb-btn-sm"
                            disabled={!k.active}
                            onClick={() => handleRevoke(k.id)}
                          >
                            吊销
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Key Modal */}
      <ModalContainer
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="新建 API 密钥"
        confirmText={
          isAdmin && newKeyRole === "admin"
            ? "创建 Admin 密钥"
            : "创建 User 密钥"
        }
        onConfirm={handleCreateKey}
        confirmDisabled={!newKeyName.trim()}
      >
        <div className="space-y-3.5 text-xs">
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              密钥名称 / 标识
            </label>
            <input
              type="text"
              className="sb-input w-full"
              placeholder="密钥名称"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
            />
          </div>

          {isAdmin && (
            <div>
              <label className="block text-neutral-400 mb-1 font-medium">
                权限角色
              </label>
              <select
                className="sb-select w-full"
                value={newKeyRole}
                onChange={(e) =>
                  setNewKeyRole(e.target.value as "user" | "admin")
                }
              >
                <option value="user">普通用户 (User) - 仅限推理调用</option>
                <option value="admin">管理员 (Admin) - 支持控制台管控</option>
              </select>
            </div>
          )}

          <div className="sb-terminal-box p-3 text-neutral-500 text-[11px] leading-relaxed">
            新建的 API 密钥将在生成后立即展示一次明文，请确保您已安全留存。
          </div>
        </div>
      </ModalContainer>
    </div>
  );
};
