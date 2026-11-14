import React, { useState } from "react";
import type { RedeemCodeItem, RedeemStatus } from "../../types";
import { mockRedeemCodes } from "../../mockData";
import { ModalContainer } from "../../components/ModalContainer";

export const RedeemCodeView: React.FC = () => {
  const [redeems, setRedeems] = useState<RedeemCodeItem[]>(mockRedeemCodes);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [batchAmount, setBatchAmount] = useState("50");
  const [batchCount, setBatchCount] = useState("5");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  const handleGenerateBatch = () => {
    const count = parseInt(batchCount, 10) || 1;
    const amount = parseFloat(batchAmount) || 10;
    const batchId = `BATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.floor(Math.random() * 900 + 100)}`;

    const newCodes: RedeemCodeItem[] = [];
    for (let i = 0; i < count; i++) {
      const codeStr = `RC-${Math.random().toString(36).substring(2, 6).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
      newCodes.push({
        id: `rc_${Date.now()}_${i}`,
        code: codeStr,
        batchId,
        amountUsd: amount,
        status: "unused" as RedeemStatus,
        expiresAt: "2026-12-31 23:59:59",
        createdAt: "刚刚",
      });
    }

    setRedeems([...newCodes, ...redeems]);
    setIsModalOpen(false);
    showToast(`成功批量生成 ${count} 张 $${amount} 兑换码`);
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard?.writeText(code);
    showToast(`已复制卡密: ${code}`);
  };

  return (
    <div className="sb-view-container space-y-4">
      <div className="sb-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold text-neutral-200">
            兑换码充值卡 (Redeem Codes)
          </h2>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            批量生成额度充值点卡、查询核销记录与作废失效控制
          </p>
        </div>
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => setIsModalOpen(true)}
        >
          <span>+ 批量生成兑换码</span>
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
                <th className="py-3 px-4">卡密码 (Code)</th>
                <th className="py-3 px-4">批次号</th>
                <th className="py-3 px-4 text-right">面额 (USD)</th>
                <th className="py-3 px-4">状态</th>
                <th className="py-3 px-4">核销人 / 核销时间</th>
                <th className="py-3 px-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dash-line font-mono">
              {redeems.map((r) => {
                const isUnused = r.status === "unused";
                return (
                  <tr
                    key={r.id}
                    className="hover:bg-dash-soft transition-colors"
                  >
                    <td className="py-3 px-4 font-bold text-neutral-200">
                      {r.code}
                    </td>
                    <td className="py-3 px-4 text-neutral-400 text-[11px]">
                      {r.batchId}
                    </td>
                    <td className="py-3 px-4 text-right text-emerald-400 font-bold">
                      ${r.amountUsd.toFixed(2)}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono border ${
                          isUnused
                            ? "text-cyan-400 bg-cyan-500/10 border-cyan-500/20"
                            : r.status === "redeemed"
                              ? "text-neutral-400 bg-neutral-800 border-neutral-700"
                              : "text-rose-400 bg-rose-500/10 border-rose-500/20"
                        }`}
                      >
                        {r.status === "unused"
                          ? "未核销"
                          : r.status === "redeemed"
                            ? "已核销"
                            : "已作废"}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {r.redeemedBy ? (
                        <div>
                          <span className="text-neutral-300 font-sans">
                            {r.redeemedBy}
                          </span>
                          <div className="text-[10px] text-neutral-500">
                            {r.redeemedAt}
                          </div>
                        </div>
                      ) : (
                        <span className="text-neutral-600">-</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {isUnused && (
                        <button
                          type="button"
                          className="sb-btn sb-btn-ghost sb-btn-sm"
                          onClick={() => handleCopyCode(r.code)}
                        >
                          复制
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

      <ModalContainer
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="批量生成充值兑换码"
        confirmText="立即生成"
        onConfirm={handleGenerateBatch}
      >
        <div className="space-y-3.5 text-xs">
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              单个兑换码面额 (USD)
            </label>
            <input
              type="number"
              step="1"
              className="sb-input w-full font-mono"
              value={batchAmount}
              onChange={(e) => setBatchAmount(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="block text-neutral-400 mb-1 font-medium">
              生成数量 (张)
            </label>
            <input
              type="number"
              step="1"
              max="100"
              className="sb-input w-full font-mono"
              value={batchCount}
              onChange={(e) => setBatchCount(e.target.value)}
            />
          </div>
          <div className="sb-terminal-box p-3 text-neutral-500 text-[11px] leading-relaxed">
            生成的卡密将自动加入当前可用卡密池，用户可在个人控制台或充值入口直接兑换。
          </div>
        </div>
      </ModalContainer>
    </div>
  );
};
