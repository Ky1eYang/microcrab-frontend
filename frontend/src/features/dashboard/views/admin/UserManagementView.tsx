import React, { useState } from "react";
import type { UserItem, UserRole } from "../../types";
import { mockUsers } from "../../mockData";
import { ModalContainer } from "../../components/ModalContainer";

export const UserManagementView: React.FC = () => {
  const [users, setUsers] = useState<UserItem[]>(mockUsers);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<UserItem | null>(null);
  const [isQuotaModalOpen, setIsQuotaModalOpen] = useState(false);
  const [editBalance, setEditBalance] = useState("");
  const [editQuotaLimit, setEditQuotaLimit] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  const filteredUsers = users.filter((u) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      u.username.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      u.id.toLowerCase().includes(q) ||
      u.group.toLowerCase().includes(q)
    );
  });

  const toggleUserStatus = (userId: string) => {
    setUsers((prev) =>
      prev.map((u) => {
        if (u.id === userId) {
          const nextStatus = u.status === "active" ? "suspended" : "active";
          showToast(`用户 ${u.username} 状态已更新为：${nextStatus}`);
          return { ...u, status: nextStatus };
        }
        return u;
      }),
    );
  };

  const handleRoleChange = (userId: string, newRole: UserRole) => {
    setUsers((prev) =>
      prev.map((u) => {
        if (u.id === userId) {
          showToast(`已将用户 ${u.username} 权限调整为 ${newRole}`);
          return { ...u, role: newRole };
        }
        return u;
      }),
    );
  };

  const openQuotaModal = (user: UserItem) => {
    setSelectedUser(user);
    setEditBalance(user.balanceUsd.toString());
    setEditQuotaLimit(user.quotaLimitUsd.toString());
    setIsQuotaModalOpen(true);
  };

  const handleSaveQuota = () => {
    if (!selectedUser) return;
    const nextBal = parseFloat(editBalance) || 0;
    const nextLimit = parseFloat(editQuotaLimit) || 0;
    setUsers((prev) =>
      prev.map((u) =>
        u.id === selectedUser.id
          ? { ...u, balanceUsd: nextBal, quotaLimitUsd: nextLimit }
          : u,
      ),
    );
    showToast(`已成功保存用户 ${selectedUser.username} 的额度与余额`);
    setIsQuotaModalOpen(false);
  };

  return (
    <div className="sb-view-container space-y-4">
      {/* Header Bar */}
      <div className="sb-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold text-neutral-200">
            用户管理 (User Accounts)
          </h2>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            管控平台多租户用户清单、RBAC 角色权限、可用余额充值与封禁策略
          </p>
        </div>
        <div className="w-full sm:w-64">
          <input
            type="text"
            className="sb-input w-full text-xs"
            placeholder="搜索用户名 / 邮箱 / 分组..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {toastMessage && (
        <div className="sb-toast-inline">
          <span className="sb-role-dot" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Users Table */}
      <div className="sb-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-dash-line bg-dash-terminal text-[11px] text-neutral-400 font-medium">
                <th className="py-3 px-4">用户 / 邮箱</th>
                <th className="py-3 px-4">分组</th>
                <th className="py-3 px-4">角色授权</th>
                <th className="py-3 px-4 text-right">可用余额 / 限额</th>
                <th className="py-3 px-4">密钥数</th>
                <th className="py-3 px-4">状态</th>
                <th className="py-3 px-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dash-line font-mono">
              {filteredUsers.map((user) => {
                const isActive = user.status === "active";
                return (
                  <tr
                    key={user.id}
                    className="hover:bg-dash-soft transition-colors"
                  >
                    <td className="py-3 px-4">
                      <div className="font-sans font-medium text-neutral-200">
                        {user.username}
                      </div>
                      <div className="text-[11px] text-neutral-500 font-mono">
                        {user.email}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded text-[10px] bg-dash-terminal text-neutral-300 border border-dash-line">
                        {user.group}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <select
                        className="sb-select text-xs py-1"
                        value={user.role}
                        onChange={(e) =>
                          handleRoleChange(user.id, e.target.value as UserRole)
                        }
                      >
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                        <option value="super_admin">SuperAdmin</option>
                      </select>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="text-emerald-400 font-bold">
                        ${user.balanceUsd.toFixed(2)}
                      </div>
                      <div className="text-[10px] text-neutral-500">
                        上限: ${user.quotaLimitUsd.toFixed(2)}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-neutral-400">
                      {user.activeKeysCount} 把
                    </td>
                    <td className="py-3 px-4">
                      <button
                        type="button"
                        onClick={() => toggleUserStatus(user.id)}
                        className={`px-2 py-0.5 rounded text-[10px] border font-mono transition-colors ${
                          isActive
                            ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20 hover:bg-emerald-500/20"
                            : "text-rose-400 bg-rose-500/10 border-rose-500/20 hover:bg-rose-500/20"
                        }`}
                      >
                        {isActive ? "启用中" : "已封禁"}
                      </button>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        type="button"
                        className="sb-btn sb-btn-secondary sb-btn-sm"
                        onClick={() => openQuotaModal(user)}
                      >
                        调整配额
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Adjust Quota Modal */}
      <ModalContainer
        isOpen={isQuotaModalOpen}
        onClose={() => setIsQuotaModalOpen(false)}
        title={`调整用户配额: ${selectedUser?.username}`}
        confirmText="保存调整"
        onConfirm={handleSaveQuota}
      >
        <div className="space-y-3.5 text-xs">
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              可用余额 (USD)
            </label>
            <input
              type="number"
              step="0.01"
              className="sb-input w-full font-mono"
              value={editBalance}
              onChange={(e) => setEditBalance(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              消费额度上限 (USD)
            </label>
            <input
              type="number"
              step="0.01"
              className="sb-input w-full font-mono"
              value={editQuotaLimit}
              onChange={(e) => setEditQuotaLimit(e.target.value)}
            />
          </div>
          <div className="sb-terminal-box p-3 text-neutral-500 text-[11px] leading-relaxed">
            余额修改将立即体现在用户发起调用时的扣费预检机制中。
          </div>
        </div>
      </ModalContainer>
    </div>
  );
};
