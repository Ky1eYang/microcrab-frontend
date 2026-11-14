import React, { useState } from "react";
import type { ChannelItem, ChannelStatus } from "../../types";
import { mockChannels } from "../../mockData";
import { ModalContainer } from "../../components/ModalContainer";

export const ChannelManagementView: React.FC = () => {
  const [channels, setChannels] = useState<ChannelItem[]>(mockChannels);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Form states
  const [newName, setNewName] = useState("");
  const [newProvider, setNewProvider] = useState("OpenAI");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [newWeight, setNewWeight] = useState("10");
  const [newPriority, setNewPriority] = useState("1");

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  const handleTestLatency = (channelId: string) => {
    setTestingId(channelId);
    setTimeout(() => {
      const simulatedLatency = Math.floor(180 + Math.random() * 240);
      setChannels((prev) =>
        prev.map((c) =>
          c.id === channelId
            ? {
                ...c,
                latencyMs: simulatedLatency,
                status: "healthy" as ChannelStatus,
                lastCheckedAt: "刚刚",
              }
            : c,
        ),
      );
      setTestingId(null);
      showToast(`渠道测速完成，当前往返延迟: ${simulatedLatency}ms`);
    }, 600);
  };

  const handleToggleEnable = (channelId: string) => {
    setChannels((prev) =>
      prev.map((c) => {
        if (c.id === channelId) {
          const next = !c.enabled;
          showToast(`渠道 ${c.name} 已${next ? "启用" : "禁用"}`);
          return { ...c, enabled: next };
        }
        return c;
      }),
    );
  };

  const handleDelete = (channelId: string) => {
    if (window.confirm("确定要删除此上游渠道吗？相关的路由规则将失效。")) {
      setChannels((prev) => prev.filter((c) => c.id !== channelId));
      showToast("渠道已删除");
    }
  };

  const handleCreateChannel = () => {
    if (!newName.trim() || !newBaseUrl.trim()) return;
    const newChan: ChannelItem = {
      id: `chan_${Date.now()}`,
      name: newName.trim(),
      provider: newProvider,
      baseUrl: newBaseUrl.trim(),
      models: [newProvider === "Anthropic" ? "claude-3-7-sonnet" : "gpt-4o"],
      weight: parseInt(newWeight, 10) || 10,
      priority: parseInt(newPriority, 10) || 1,
      latencyMs: 210,
      status: "healthy",
      enabled: true,
      balance: 1000.0,
      lastCheckedAt: "刚刚",
    };
    setChannels([...channels, newChan]);
    setNewName("");
    setNewBaseUrl("");
    setIsModalOpen(false);
    showToast(`渠道 ${newChan.name} 创建成功`);
  };

  return (
    <div className="sb-view-container space-y-4">
      {/* Header */}
      <div className="sb-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold text-neutral-200">
            渠道管理 (Upstream Channels)
          </h2>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            配置 OpenAI、Anthropic、Grok
            及第三方中转服务商，支持权重分流与智能故障转移
          </p>
        </div>
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => setIsModalOpen(true)}
        >
          <span>+ 添加渠道</span>
        </button>
      </div>

      {toastMessage && (
        <div className="sb-toast-inline">
          <span className="sb-role-dot" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Channels Table */}
      <div className="sb-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-dash-line bg-dash-terminal text-[11px] text-neutral-400 font-medium">
                <th className="py-3 px-4">渠道名称</th>
                <th className="py-3 px-4">提供商</th>
                <th className="py-3 px-4">Base URL</th>
                <th className="py-3 px-4 text-center">优先级 / 权重</th>
                <th className="py-3 px-4 text-center">往返延迟</th>
                <th className="py-3 px-4">状态</th>
                <th className="py-3 px-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dash-line font-mono">
              {channels.map((ch) => {
                const isTesting = testingId === ch.id;
                return (
                  <tr
                    key={ch.id}
                    className="hover:bg-dash-soft transition-colors"
                  >
                    <td className="py-3 px-4 font-sans font-medium text-neutral-200">
                      {ch.name}
                    </td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded text-[10px] bg-dash-terminal text-neutral-300 border border-dash-line">
                        {ch.provider}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-neutral-400 max-w-[200px] truncate">
                      {ch.baseUrl}
                    </td>
                    <td className="py-3 px-4 text-center text-neutral-300">
                      P{ch.priority} / W{ch.weight}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span
                        className={`font-semibold ${
                          ch.latencyMs < 300
                            ? "text-emerald-400"
                            : ch.latencyMs < 600
                              ? "text-amber-400"
                              : "text-rose-400"
                        }`}
                      >
                        {ch.latencyMs}ms
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <label className="sb-switch">
                        <input
                          type="checkbox"
                          checked={ch.enabled}
                          onChange={() => handleToggleEnable(ch.id)}
                        />
                        <span className="sb-switch-slider" />
                      </label>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          className="sb-btn sb-btn-ghost sb-btn-sm"
                          onClick={() => handleTestLatency(ch.id)}
                          disabled={isTesting}
                        >
                          {isTesting ? "测速中..." : "测速"}
                        </button>
                        <button
                          type="button"
                          className="sb-btn sb-btn-danger sb-btn-sm"
                          onClick={() => handleDelete(ch.id)}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Channel Modal */}
      <ModalContainer
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="添加上游模型渠道"
        confirmText="保存渠道"
        onConfirm={handleCreateChannel}
        confirmDisabled={!newName.trim() || !newBaseUrl.trim()}
      >
        <div className="space-y-3.5 text-xs">
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              渠道名称
            </label>
            <input
              type="text"
              className="sb-input w-full"
              placeholder="例如: OpenAI-Direct-Official"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-neutral-400 mb-1 font-medium">
                提供商协议
              </label>
              <select
                className="sb-select w-full"
                value={newProvider}
                onChange={(e) => setNewProvider(e.target.value)}
              >
                <option value="OpenAI">OpenAI</option>
                <option value="Anthropic">Anthropic</option>
                <option value="Grok">Grok (xAI)</option>
                <option value="Azure">Azure OpenAI</option>
                <option value="Cloudflare">Cloudflare AI</option>
              </select>
            </div>
            <div>
              <label className="block text-neutral-400 mb-1 font-medium">
                优先级 (1-10)
              </label>
              <input
                type="number"
                className="sb-input w-full font-mono"
                value={newPriority}
                onChange={(e) => setNewPriority(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              Base URL
            </label>
            <input
              type="text"
              className="sb-input w-full font-mono"
              placeholder="https://api.openai.com/v1"
              value={newBaseUrl}
              onChange={(e) => setNewBaseUrl(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              分流权重 (Weight)
            </label>
            <input
              type="number"
              className="sb-input w-full font-mono"
              value={newWeight}
              onChange={(e) => setNewWeight(e.target.value)}
            />
          </div>
        </div>
      </ModalContainer>
    </div>
  );
};
