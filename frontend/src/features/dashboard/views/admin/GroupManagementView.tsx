import React, { useState } from "react";
import type { GroupItem } from "../../types";
import { mockGroups } from "../../mockData";
import { ModalContainer } from "../../components/ModalContainer";

export const GroupManagementView: React.FC = () => {
  const [groups, setGroups] = useState<GroupItem[]>(mockGroups);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDesc, setNewGroupDesc] = useState("");
  const [newRpm, setNewRpm] = useState("120");
  const [newTpm, setNewTpm] = useState("200000");
  const [feedback, setFeedback] = useState<string | null>(null);

  const showFeedback = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 2500);
  };

  const handleCreateGroup = () => {
    if (!newGroupName.trim()) return;
    const newGroup: GroupItem = {
      id: `group_${Date.now()}`,
      name: newGroupName.trim(),
      desc: newGroupDesc.trim() || "自定义租户分组",
      rpmLimit: parseInt(newRpm, 10) || 60,
      tpmLimit: parseInt(newTpm, 10) || 100000,
      dailyQuotaUsd: 50.0,
      allowedChannels: ["OpenAI-Official", "Anthropic-Main"],
      modelRateMultipliers: {},
      userCount: 0,
    };
    setGroups([...groups, newGroup]);
    setNewGroupName("");
    setNewGroupDesc("");
    setIsModalOpen(false);
    showFeedback(`分组 ${newGroup.name} 创建成功`);
  };

  return (
    <div className="sb-view-container space-y-4">
      <div className="sb-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold text-neutral-200">
            分组管理 (Tenant Groups)
          </h2>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            配置不同用户等级的速率限制 (RPM/TPM)、渠道绑定与模型计费倍率
          </p>
        </div>
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => setIsModalOpen(true)}
        >
          <span>+ 新建分组</span>
        </button>
      </div>

      {feedback && (
        <div className="sb-toast-inline">
          <span className="sb-role-dot" />
          <span>{feedback}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {groups.map((group) => (
          <div key={group.id} className="sb-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-neutral-200 text-xs">
                  {group.name}
                </span>
                {group.isDefault && (
                  <span className="px-1.5 py-0.2 rounded text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20 font-mono">
                    默认
                  </span>
                )}
              </div>
              <span className="text-[11px] text-neutral-400 font-mono">
                {group.userCount} 用户
              </span>
            </div>

            <p className="text-[11px] text-neutral-500 line-clamp-2">
              {group.desc}
            </p>

            <div className="sb-terminal-box p-3 space-y-2 text-xs font-mono">
              <div className="flex items-center justify-between text-neutral-400">
                <span>RPM 限制:</span>
                <span className="text-emerald-400 font-semibold">
                  {group.rpmLimit} req/min
                </span>
              </div>
              <div className="flex items-center justify-between text-neutral-400">
                <span>TPM 限制:</span>
                <span className="text-cyan-400 font-semibold">
                  {(group.tpmLimit / 1000).toFixed(0)}K tok/min
                </span>
              </div>
              <div className="flex items-center justify-between text-neutral-400">
                <span>单日限额:</span>
                <span className="text-purple-400 font-semibold">
                  ${group.dailyQuotaUsd.toFixed(2)}
                </span>
              </div>
            </div>

            <div className="pt-2 border-t border-dash-line">
              <div className="text-[10px] text-neutral-500 mb-1">
                已绑定渠道:
              </div>
              <div className="flex flex-wrap gap-1">
                {group.allowedChannels.map((c) => (
                  <span
                    key={c}
                    className="px-1.5 py-0.5 rounded text-[10px] bg-dash-terminal text-neutral-300 border border-dash-line font-mono"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      <ModalContainer
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="新建用户分组"
        confirmText="保存分组"
        onConfirm={handleCreateGroup}
        confirmDisabled={!newGroupName.trim()}
      >
        <div className="space-y-3.5 text-xs">
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              分组名称
            </label>
            <input
              type="text"
              className="sb-input w-full"
              placeholder="例如: VIP-Pro"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              描述说明
            </label>
            <input
              type="text"
              className="sb-input w-full"
              placeholder="高优先级 VIP 租户分组"
              value={newGroupDesc}
              onChange={(e) => setNewGroupDesc(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-neutral-400 mb-1 font-medium">
                RPM 限额
              </label>
              <input
                type="number"
                className="sb-input w-full font-mono"
                value={newRpm}
                onChange={(e) => setNewRpm(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-neutral-400 mb-1 font-medium">
                TPM 限额
              </label>
              <input
                type="number"
                className="sb-input w-full font-mono"
                value={newTpm}
                onChange={(e) => setNewTpm(e.target.value)}
              />
            </div>
          </div>
        </div>
      </ModalContainer>
    </div>
  );
};
