import React, { useState } from "react";
import type { AccountItem } from "../../types";
import { mockAccounts } from "../../mockData";

export const AccountManagementView: React.FC = () => {
  const [accounts, setAccounts] = useState<AccountItem[]>(mockAccounts);
  const [searchQuery, setSearchQuery] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  const filtered = accounts.filter((a) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      a.boundUser.toLowerCase().includes(q) ||
      a.email.toLowerCase().includes(q) ||
      a.identityId.toLowerCase().includes(q)
    );
  });

  const handleUnlink = (accountId: string) => {
    if (window.confirm("确定要解绑此外部账号与本地用户的关联吗？")) {
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId ? { ...a, status: "unlinked" as const } : a,
        ),
      );
      showToast("已解绑外部凭据关联");
    }
  };

  return (
    <div className="sb-view-container space-y-4">
      <div className="sb-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold text-neutral-200">
            账号管理 (SSO & Credential Pool)
          </h2>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            管理 GitHub、Google、AuthPortal OIDC 外部身份绑定与凭据池映射
          </p>
        </div>
        <div className="w-full sm:w-64">
          <input
            type="text"
            className="sb-input w-full text-xs"
            placeholder="搜索身份 / 绑定用户 / 邮箱..."
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

      <div className="sb-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-dash-line bg-dash-terminal text-[11px] text-neutral-400 font-medium">
                <th className="py-3 px-4">提供商</th>
                <th className="py-3 px-4">外部身份 ID</th>
                <th className="py-3 px-4">绑定本地用户</th>
                <th className="py-3 px-4">凭据池引用</th>
                <th className="py-3 px-4">状态</th>
                <th className="py-3 px-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dash-line font-mono">
              {filtered.map((acc) => {
                const isLinked = acc.status === "linked";
                return (
                  <tr
                    key={acc.id}
                    className="hover:bg-dash-soft transition-colors"
                  >
                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded text-[10px] bg-dash-terminal text-neutral-300 border border-dash-line uppercase">
                        {acc.provider}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="text-neutral-200">{acc.identityId}</div>
                      <div className="text-[10px] text-neutral-500">
                        {acc.email}
                      </div>
                    </td>
                    <td className="py-3 px-4 font-sans text-neutral-300">
                      {acc.boundUser}
                    </td>
                    <td className="py-3 px-4 text-neutral-400">
                      {acc.credentialPoolRef || "无"}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] ${
                          isLinked
                            ? "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20"
                            : "text-neutral-400 bg-neutral-800"
                        }`}
                      >
                        {isLinked ? "已绑定" : "未关联"}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      {isLinked && (
                        <button
                          type="button"
                          className="sb-btn sb-btn-danger sb-btn-sm"
                          onClick={() => handleUnlink(acc.id)}
                        >
                          解绑
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
