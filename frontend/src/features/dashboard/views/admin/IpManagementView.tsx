import React, { useState } from "react";
import type { IpRuleItem } from "../../types";
import { mockIpRules } from "../../mockData";
import { ModalContainer } from "../../components/ModalContainer";

export const IpManagementView: React.FC = () => {
  const [rules, setRules] = useState<IpRuleItem[]>(mockIpRules);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newIp, setNewIp] = useState("");
  const [newType, setNewType] = useState<"allow" | "deny">("deny");
  const [newReason, setNewReason] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  const toggleRule = (id: string) => {
    setRules((prev) =>
      prev.map((r) => {
        if (r.id === id) {
          const next = !r.enabled;
          showToast(`规则 ${r.ipOrCidr} 已${next ? "启用" : "禁用"}`);
          return { ...r, enabled: next };
        }
        return r;
      }),
    );
  };

  const handleDelete = (id: string) => {
    if (window.confirm("确定要删除此 IP 规则吗？")) {
      setRules((prev) => prev.filter((r) => r.id !== id));
      showToast("IP 规则已删除");
    }
  };

  const handleCreateRule = () => {
    if (!newIp.trim()) return;
    const newRule: IpRuleItem = {
      id: `ip_${Date.now()}`,
      ipOrCidr: newIp.trim(),
      type: newType,
      reason: newReason.trim() || "管理员手动配置",
      hitsCount: 0,
      createdAt: "刚刚",
      enabled: true,
    };
    setRules([newRule, ...rules]);
    setNewIp("");
    setNewReason("");
    setIsModalOpen(false);
    showToast(`已添加规则：${newRule.ipOrCidr}`);
  };

  return (
    <div className="sb-view-container space-y-4">
      <div className="sb-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold text-neutral-200">
            IP 访问控制 (IP Management)
          </h2>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            配置客户端 IP 黑白名单、CIDR 网段拦截与异常频次自动封禁规则
          </p>
        </div>
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => setIsModalOpen(true)}
        >
          <span>+ 添加规则</span>
        </button>
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
                <th className="py-3 px-4">IP / CIDR</th>
                <th className="py-3 px-4">规则策略</th>
                <th className="py-3 px-4">原因备注</th>
                <th className="py-3 px-4 text-center">拦截 / 命中计数</th>
                <th className="py-3 px-4">状态</th>
                <th className="py-3 px-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dash-line font-mono">
              {rules.map((rule) => {
                const isDeny = rule.type === "deny";
                return (
                  <tr
                    key={rule.id}
                    className="hover:bg-dash-soft transition-colors"
                  >
                    <td className="py-3 px-4 font-bold text-neutral-200">
                      {rule.ipOrCidr}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] uppercase font-mono border ${
                          isDeny
                            ? "text-rose-400 bg-rose-500/10 border-rose-500/20"
                            : "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                        }`}
                      >
                        {rule.type}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-sans text-neutral-400">
                      {rule.reason}
                    </td>
                    <td className="py-3 px-4 text-center text-neutral-300">
                      {rule.hitsCount.toLocaleString()} 次
                    </td>
                    <td className="py-3 px-4">
                      <label className="sb-switch">
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          onChange={() => toggleRule(rule.id)}
                        />
                        <span className="sb-switch-slider" />
                      </label>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        type="button"
                        className="sb-btn sb-btn-danger sb-btn-sm"
                        onClick={() => handleDelete(rule.id)}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <ModalContainer
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="添加 IP / CIDR 规则"
        confirmText="保存规则"
        onConfirm={handleCreateRule}
        confirmDisabled={!newIp.trim()}
      >
        <div className="space-y-3.5 text-xs">
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              IP 地址或 CIDR 块
            </label>
            <input
              type="text"
              className="sb-input w-full font-mono"
              placeholder="例如: 192.168.1.100 或 10.0.0.0/8"
              value={newIp}
              onChange={(e) => setNewIp(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              动作策略
            </label>
            <select
              className="sb-select w-full"
              value={newType}
              onChange={(e) => setNewType(e.target.value as any)}
            >
              <option value="deny">Deny (拦截拒绝访问)</option>
              <option value="allow">Allow (白名单直接放行)</option>
            </select>
          </div>
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              备注说明
            </label>
            <input
              type="text"
              className="sb-input w-full"
              placeholder="例如: 某异常流量攻击网段封禁"
              value={newReason}
              onChange={(e) => setNewReason(e.target.value)}
            />
          </div>
        </div>
      </ModalContainer>
    </div>
  );
};
